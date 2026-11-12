import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeOutbound } from "../../registry/src/index.js";
import { AnchorExistsError, GitAnchorSink, anchorOf, readAnchorDirectory, taskDigest } from "../src/index.js";

/**
 * §3.4.1 (v0.6.1, D-094, D-098; D-122): the real destination is a public git repository whose history is protected
 * against force-push and deletion. Here a local bare repository stands for it, with git's own equivalents of that
 * protection (`receive.denyNonFastForwards`, `receive.denyDeletes`), so the test needs no network and no account.
 * The runner's sink adds one file per anchor and pushes it; a push that would rewrite history is refused by the
 * destination, whatever the host holds.
 */

let dir: string;
let remote: string;
let clone: string;
const key = generateKeyPairSync("ed25519");
const head = (n: number): { seq: number; hash: string } => ({ seq: n, hash: `sha256:${String(n).repeat(64).slice(0, 64)}` });

async function git(args: readonly string[]): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
  const result = await executeOutbound({ file: "git", args: ["-c", "user.name=test", "-c", "user.email=test@localhost", "-c", "init.defaultBranch=main", ...args] });
  return { exitCode: result.exitCode, stderr: result.stderr.toString("utf8"), stdout: result.stdout.toString("utf8") };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "juno-git-sink-"));
  remote = join(dir, "juno-anchors.git");
  clone = join(dir, "clone");
  expect((await git(["init", "--bare", "--quiet", remote])).exitCode).toBe(0);
  await git(["-C", remote, "config", "receive.denyNonFastForwards", "true"]);
  await git(["-C", remote, "config", "receive.denyDeletes", "true"]);
  // The operator's one-time set-up: a first commit, then the runner's clone.
  const seed = join(dir, "seed");
  await git(["clone", "--quiet", remote, seed]);
  writeFileSync(join(seed, "README.md"), "JUNO journal anchors\n");
  await git(["-C", seed, "add", "README.md"]);
  await git(["-C", seed, "commit", "--quiet", "-m", "start"]);
  expect((await git(["-C", seed, "push", "--quiet", "origin", "main"])).exitCode).toBe(0);
  expect((await git(["clone", "--quiet", remote, clone])).exitCode).toBe(0);
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("§3.4.1: the git anchor destination (D-122)", () => {
  // proves §3.4.1: each anchor is pushed as its own commit and can be listed back from any clone
  it("pushes anchors and lists them back from a fresh clone", async () => {
    const sink = new GitAnchorSink({ clone });
    await sink.append(anchorOf("task-git", head(1), new Date("2026-11-04T10:00:00Z"), key.privateKey));
    await sink.append(anchorOf("task-git", head(4), new Date("2026-11-04T10:05:00Z"), key.privateKey));
    expect(((await sink.list(taskDigest("task-git"))) as { seq: number }[]).map((anchor) => anchor.seq)).toEqual([1, 4]);
    const reader = join(dir, "reader");
    await git(["clone", "--quiet", remote, reader]);
    expect((readAnchorDirectory(reader, taskDigest("task-git")) as { seq: number }[]).map((anchor) => anchor.seq)).toEqual([1, 4]);
  });

  // proves §3.4.1 V6-4: an anchor at a seq already stored is never replaced
  it("refuses to replace an anchor", async () => {
    const sink = new GitAnchorSink({ clone });
    await expect(sink.append(anchorOf("task-git", { ...head(1), hash: `sha256:${"f".repeat(64)}` }, new Date(), key.privateKey))).rejects.toBeInstanceOf(AnchorExistsError);
  });

  // proves §3.4.1 with two services of one runner (the hook and the gateway, D-198, D-199): each anchors through its own
  // clone of the same repository at the same time; every anchor reaches the destination, and none is forced
  it("lets two clones anchor to the same repository at once, without forcing", async () => {
    const other = join(dir, "clone-gateway");
    await git(["clone", "--quiet", remote, other]);
    const hook = new GitAnchorSink({ clone });
    const gateway = new GitAnchorSink({ clone: other });
    for (let round = 0; round < 3; round += 1) {
      await Promise.all([
        hook.append(anchorOf("task-hook", head(10 + round), new Date(), key.privateKey)),
        gateway.append(anchorOf("task-gateway", head(20 + round), new Date(), key.privateKey)),
      ]);
    }
    const reader = join(dir, "reader-both");
    await git(["clone", "--quiet", remote, reader]);
    expect((readAnchorDirectory(reader, taskDigest("task-hook")) as { seq: number }[]).map((anchor) => anchor.seq)).toEqual([10, 11, 12]);
    expect((readAnchorDirectory(reader, taskDigest("task-gateway")) as { seq: number }[]).map((anchor) => anchor.seq)).toEqual([20, 21, 22]);
    // Each clone lists what the destination holds, the other service's anchors included.
    expect(((await hook.list(taskDigest("task-gateway"))) as { seq: number }[]).map((anchor) => anchor.seq)).toEqual([20, 21, 22]);
  });

  // proves §3.4.1: the destination refuses a push that rewrites or deletes history, so the host cannot undo an anchor
  it("is protected against force-push and deletion at the destination", async () => {
    expect((await git(["-C", clone, "reset", "--quiet", "--hard", "HEAD~1"])).exitCode).toBe(0);
    const forced = await git(["-C", clone, "push", "--force", "--quiet", "origin", "main"]);
    expect(forced.exitCode).not.toBe(0);
    const deleted = await git(["-C", clone, "push", "--quiet", "origin", "--delete", "main"]);
    expect(deleted.exitCode).not.toBe(0);
    const reader = join(dir, "reader-2");
    await git(["clone", "--quiet", remote, reader]);
    expect((readAnchorDirectory(reader, taskDigest("task-git")) as { seq: number }[]).map((anchor) => anchor.seq)).toEqual([1, 4]);
  });

  // proves §3.4.1 (D-204): the destination keeps every commit, but an ordinary commit can still remove an anchor file,
  // and the push is accepted. The sink reads the history too, so such a repository no longer vouches for anything: the
  // listing a service's start-up check depends on fails, for every task, and stays failed
  it("refuses a repository whose history removes or changes an anchor, even by an ordinary accepted push", async () => {
    const fresh = join(dir, "clone-intact");
    await git(["clone", "--quiet", remote, fresh]);
    const sink = new GitAnchorSink({ clone: fresh });
    await sink.append(anchorOf("task-kept", head(1), new Date("2026-11-04T11:00:00Z"), key.privateKey));
    await sink.append(anchorOf("task-gone", head(1), new Date("2026-11-04T11:01:00Z"), key.privateKey));
    // Positive control: an intact history lists.
    expect((await sink.listMany([taskDigest("task-kept"), taskDigest("task-gone")])).get(taskDigest("task-gone"))).toHaveLength(1);
    // Whoever holds the push key removes one task's anchors with a normal commit; the protected destination accepts it.
    const attacker = join(dir, "attacker");
    await git(["clone", "--quiet", remote, attacker]);
    expect((await git(["-C", attacker, "rm", "-r", "--quiet", taskDigest("task-gone")])).exitCode).toBe(0);
    expect((await git(["-C", attacker, "commit", "--quiet", "-m", "tidy"])).exitCode).toBe(0);
    expect((await git(["-C", attacker, "push", "--quiet", "origin", "main"])).exitCode).toBe(0);
    await expect(sink.listMany([taskDigest("task-gone")])).rejects.toThrow(/history removes or changes 1 anchor file/);
    await expect(sink.list(taskDigest("task-kept"))).rejects.toThrow(/history removes or changes/);
    // Putting the file back does not undo it: the removal is in the history for good.
    await git(["-C", attacker, "revert", "--no-edit", "HEAD"]);
    expect((await git(["-C", attacker, "push", "--quiet", "origin", "main"])).exitCode).toBe(0);
    await expect(sink.list(taskDigest("task-gone"))).rejects.toThrow(/history removes or changes/);
  });
});
