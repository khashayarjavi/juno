import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeOutbound } from "../../registry/src/index.js";
import { AnchorExistsError, GitAnchorSink, type PinnedRepository, anchorOf, readAnchorDirectory, taskDigest } from "../src/index.js";

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

/** The anchor pin's view of a local bare repository standing for `juno-anchors` (D-208). */
const pinOf = (url: string): PinnedRepository => ({ url, branch: "main", transport: "local", knownHosts: null, pushKey: null });

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
    const sink = new GitAnchorSink({ clone, pin: pinOf(remote) });
    await sink.append(anchorOf("task-git", head(1), new Date("2026-11-04T10:00:00Z"), key.privateKey));
    await sink.append(anchorOf("task-git", head(4), new Date("2026-11-04T10:05:00Z"), key.privateKey));
    expect(((await sink.list(taskDigest("task-git"))) as { seq: number }[]).map((anchor) => anchor.seq)).toEqual([1, 4]);
    const reader = join(dir, "reader");
    await git(["clone", "--quiet", remote, reader]);
    expect((readAnchorDirectory(reader, taskDigest("task-git")) as { seq: number }[]).map((anchor) => anchor.seq)).toEqual([1, 4]);
  });

  // proves §3.4.1 V6-4: an anchor at a seq already stored is never replaced
  it("refuses to replace an anchor", async () => {
    const sink = new GitAnchorSink({ clone, pin: pinOf(remote) });
    await expect(sink.append(anchorOf("task-git", { ...head(1), hash: `sha256:${"f".repeat(64)}` }, new Date(), key.privateKey))).rejects.toBeInstanceOf(AnchorExistsError);
  });

  // proves §3.4.1 with two services of one runner (the hook and the gateway, D-198, D-199): each anchors through its own
  // clone of the same repository at the same time; every anchor reaches the destination, and none is forced
  it("lets two clones anchor to the same repository at once, without forcing", async () => {
    const other = join(dir, "clone-gateway");
    await git(["clone", "--quiet", remote, other]);
    const hook = new GitAnchorSink({ clone, pin: pinOf(remote) });
    const gateway = new GitAnchorSink({ clone: other, pin: pinOf(remote) });
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
    // The runner's clone no longer names a remote of its own (D-208), so whoever holds the push key tries from a clone
    // of theirs; the assertions are the same.
    const holder = join(dir, "push-key-holder");
    await git(["clone", "--quiet", remote, holder]);
    expect((await git(["-C", holder, "reset", "--quiet", "--hard", "HEAD~1"])).exitCode).toBe(0);
    const forced = await git(["-C", holder, "push", "--force", "--quiet", "origin", "main"]);
    expect(forced.exitCode).not.toBe(0);
    const deleted = await git(["-C", holder, "push", "--quiet", "origin", "--delete", "main"]);
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
    const sink = new GitAnchorSink({ clone: fresh, pin: pinOf(remote) });
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

  // proves §3.4.1 (D-205): an anchor file moved to another name, or its folder moved, is an anchor removed; git's rename
  // detection would list only the new name, so the history is read with it off
  it.each([
    ["one anchor file renamed", (task: string) => ["mv", `${task}/000000000001.json`, `${task}/000000000001.json.old`]],
    ["a task's folder renamed", (task: string) => ["mv", task, `old-${task}`]],
  ])("refuses a repository whose history hides an anchor by renaming: %s", async (name, move) => {
    const base = join(dir, `rename-${name.replace(/[^a-z]/g, "")}`);
    const bare = `${base}.git`;
    expect((await git(["init", "--bare", "--quiet", bare])).exitCode).toBe(0);
    await git(["-C", bare, "config", "receive.denyNonFastForwards", "true"]);
    await git(["-C", bare, "config", "receive.denyDeletes", "true"]);
    const seed = `${base}-seed`;
    await git(["clone", "--quiet", bare, seed]);
    writeFileSync(join(seed, "README.md"), "JUNO journal anchors\n");
    await git(["-C", seed, "add", "README.md"]);
    await git(["-C", seed, "commit", "--quiet", "-m", "start"]);
    expect((await git(["-C", seed, "push", "--quiet", "origin", "main"])).exitCode).toBe(0);
    const runner = `${base}-runner`;
    await git(["clone", "--quiet", bare, runner]);
    const sink = new GitAnchorSink({ clone: runner, pin: pinOf(bare) });
    const task = taskDigest("task-renamed");
    await sink.append(anchorOf("task-renamed", head(1), new Date("2026-11-04T12:00:00Z"), key.privateKey));
    expect(await sink.list(task)).toHaveLength(1);
    const attacker = `${base}-attacker`;
    await git(["clone", "--quiet", bare, attacker]);
    expect((await git(["-C", attacker, ...move(task)])).exitCode).toBe(0);
    expect((await git(["-C", attacker, "commit", "--quiet", "-m", "tidy"])).exitCode).toBe(0);
    expect((await git(["-C", attacker, "push", "--quiet", "origin", "main"])).exitCode).toBe(0);
    await expect(sink.listMany([task])).rejects.toThrow(/history removes or changes 1 anchor file/);
  });
});

/**
 * Operator ruling D-206 item 2 (DECISIONS.md D-208): which repository the anchors go to and come from is pinned outside
 * the runner's reach, and the local clone is a cache. Every start fetches from the pinned address and compares; a clone
 * that disagrees refuses the start. All of it with the real git, against a local bare repository standing for
 * `juno-anchors`.
 */
describe("D-206 item 2: the anchor repository is the pinned one, and the local clone is only a cache", () => {
  let base: string;
  let bare: string;
  let count = 0;

  /** A protected repository with a first commit, standing for the pinned `juno-anchors`. */
  async function repository(name: string, seedIt = true): Promise<string> {
    const path = join(base, `${name}.git`);
    expect((await git(["init", "--bare", "--quiet", path])).exitCode).toBe(0);
    await git(["-C", path, "config", "receive.denyNonFastForwards", "true"]);
    await git(["-C", path, "config", "receive.denyDeletes", "true"]);
    await git(["-C", path, "symbolic-ref", "HEAD", "refs/heads/main"]);
    if (seedIt) {
      const seed = join(base, `${name}-seed`);
      await git(["clone", "--quiet", path, seed]);
      writeFileSync(join(seed, "README.md"), `${name}\n`);
      await git(["-C", seed, "add", "README.md"]);
      await git(["-C", seed, "commit", "--quiet", "-m", "start"]);
      expect((await git(["-C", seed, "push", "--quiet", "origin", "HEAD:main"])).exitCode).toBe(0);
    }
    return path;
  }

  const seqs = async (sink: GitAnchorSink, task: string): Promise<number[]> => ((await sink.list(taskDigest(task))) as { seq: number }[]).map((anchor) => anchor.seq);
  const held = async (repo: string, task: string): Promise<number[]> => {
    const reader = join(base, `reader-${String((count += 1))}`);
    expect((await git(["clone", "--quiet", repo, reader])).exitCode).toBe(0);
    return (readAnchorDirectory(reader, taskDigest(task)) as { seq: number }[]).map((anchor) => anchor.seq);
  };

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "juno-git-pin-"));
    bare = await repository("pinned");
  });
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  // proves D-206 item 2: the clone is a cache. With no clone at all, a start fetches the pinned repository and lists
  // what it holds; with the clone deleted later, the next start lists the same
  it("builds the clone from the pinned repository, and builds it again when it is deleted", async () => {
    const clone = join(base, "cache-a");
    const first = new GitAnchorSink({ clone, pin: pinOf(bare) });
    await first.append(anchorOf("task-cache", head(1), new Date("2026-11-13T10:00:00Z"), key.privateKey));
    expect(await seqs(first, "task-cache")).toEqual([1]);
    rmSync(clone, { recursive: true });
    expect(await seqs(new GitAnchorSink({ clone, pin: pinOf(bare) }), "task-cache")).toEqual([1]);
    expect(await held(bare, "task-cache")).toEqual([1]);
  });

  // proves D-206 item 2: a clone of another repository put in the clone's place (with anchors of its own, signed or
  // not) is refused, and is left as it was found
  it("refuses a clone that was replaced by a clone of another repository", async () => {
    const clone = join(base, "cache-b");
    await new GitAnchorSink({ clone, pin: pinOf(bare) }).append(anchorOf("task-b", head(1), new Date(), key.privateKey));
    const other = await repository("someone-elses");
    rmSync(clone, { recursive: true });
    expect((await git(["clone", "--quiet", other, clone])).exitCode).toBe(0);
    const replaced = (await git(["-C", clone, "rev-parse", "HEAD"])).stdout;
    const sink = new GitAnchorSink({ clone, pin: pinOf(bare) });
    await expect(sink.listMany([taskDigest("task-b")])).rejects.toThrow(/disagrees with the pinned repository: it shares no history/);
    await expect(sink.append(anchorOf("task-b", head(2), new Date(), key.privateKey))).rejects.toThrow(/disagrees with the pinned repository/);
    expect((await git(["-C", clone, "rev-parse", "HEAD"])).stdout).toBe(replaced);
    expect(await held(bare, "task-b")).toEqual([1]);
  });

  // proves D-206 item 2: a brand-new, empty repository in the clone's place (the "start as new" clone) is refused too
  // when it holds a commit; one with nothing in it is only an empty cache and is rebuilt from the pinned repository
  it("refuses a freshly made repository with a commit of its own in the clone's place", async () => {
    const clone = join(base, "cache-c");
    await new GitAnchorSink({ clone, pin: pinOf(bare) }).append(anchorOf("task-c", head(1), new Date(), key.privateKey));
    rmSync(clone, { recursive: true });
    await git(["init", "--quiet", clone]);
    writeFileSync(join(clone, "README.md"), "new\n");
    await git(["-C", clone, "add", "README.md"]);
    await git(["-C", clone, "commit", "--quiet", "-m", "as new"]);
    await expect(new GitAnchorSink({ clone, pin: pinOf(bare) }).listMany([])).rejects.toThrow(/disagrees with the pinned repository/);
    rmSync(clone, { recursive: true });
    await git(["init", "--quiet", clone]);
    expect(await seqs(new GitAnchorSink({ clone, pin: pinOf(bare) }), "task-c")).toEqual([1]);
  });

  // proves D-206 item 2 with rule 13 (git's behaviour is shown, not assumed): the clone's own settings cannot move the
  // destination. Its `origin` and a `url.<other>.insteadOf` rewrite of the pinned address both point at another
  // repository, and so do the runner's own git settings (HOME, GIT_CONFIG_GLOBAL) and a GIT_DIR in the environment;
  // the anchors still go to, and come from, the pinned repository
  it("ignores every git setting of the clone and of the runner that names another repository", async () => {
    const clone = join(base, "cache-d");
    await new GitAnchorSink({ clone, pin: pinOf(bare) }).append(anchorOf("task-d", head(1), new Date(), key.privateKey));
    const other = await repository("redirect-target");
    await git(["-C", clone, "remote", "add", "origin", other]);
    await git(["-C", clone, "config", `url.${other}.insteadOf`, bare]);
    await git(["-C", clone, "config", `url.${other}.pushInsteadOf`, bare]);
    const home = join(base, "runner-home");
    await git(["init", "--quiet", home]);
    writeFileSync(join(home, ".gitconfig"), `[url "${other}"]\n\tinsteadOf = ${bare}\n\tpushInsteadOf = ${bare}\n`);
    const saved = { HOME: process.env["HOME"], GLOBAL: process.env["GIT_CONFIG_GLOBAL"], DIR: process.env["GIT_DIR"] };
    process.env["HOME"] = home;
    process.env["GIT_CONFIG_GLOBAL"] = join(home, ".gitconfig");
    process.env["GIT_DIR"] = join(other);
    try {
      // The same process (the redirecting settings were in place while it ran), then a restart.
      for (const seq of [2, 3]) {
        const sink = new GitAnchorSink({ clone, pin: pinOf(bare) });
        await sink.append(anchorOf("task-d", head(seq), new Date(), key.privateKey));
        expect(await seqs(sink, "task-d")).toEqual(seq === 2 ? [1, 2] : [1, 2, 3]);
      }
    } finally {
      if (saved.HOME === undefined) delete process.env["HOME"];
      else process.env["HOME"] = saved.HOME;
      if (saved.GLOBAL === undefined) delete process.env["GIT_CONFIG_GLOBAL"];
      else process.env["GIT_CONFIG_GLOBAL"] = saved.GLOBAL;
      if (saved.DIR === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = saved.DIR;
    }
    expect(await held(bare, "task-d")).toEqual([1, 2, 3]);
    expect(await held(other, "task-d")).toEqual([]);
  });

  // proves D-206 item 2 with D-198 and D-205: an anchor committed in the clone and never pushed (the repository could
  // not be reached, then the service stopped) is the one difference a clone may have. The next start pushes it, also
  // when another service anchored in between
  it("pushes anchors the clone held and the repository lacked, and nothing else", async () => {
    const clone = join(base, "cache-e");
    const sink = new GitAnchorSink({ clone, pin: pinOf(bare) });
    await sink.append(anchorOf("task-e", head(1), new Date(), key.privateKey));
    // A commit that adds one anchor, made in the clone and not pushed.
    const pending = anchorOf("task-e", head(2), new Date(), key.privateKey);
    writeFileSync(join(clone, taskDigest("task-e"), "000000000002.json"), `${JSON.stringify(pending)}\n`);
    await git(["-C", clone, "add", "."]);
    await git(["-C", clone, "commit", "--quiet", "-m", "anchor"]);
    // Meanwhile another service of the same runner anchors.
    await new GitAnchorSink({ clone: join(base, "cache-e-other"), pin: pinOf(bare) }).append(anchorOf("task-e-other", head(7), new Date(), key.privateKey));
    expect(await seqs(new GitAnchorSink({ clone, pin: pinOf(bare) }), "task-e")).toEqual([1, 2]);
    expect(await held(bare, "task-e")).toEqual([1, 2]);
    expect(await held(bare, "task-e-other")).toEqual([7]);
  });

  // proves D-206 item 2: a clone whose own commits do anything but add anchors disagrees with the repository
  it.each([
    ["changes an anchor", (clone: string, task: string) => writeFileSync(join(clone, taskDigest(task), "000000000001.json"), "{}\n")],
    ["removes an anchor", (clone: string, task: string) => rmSync(join(clone, taskDigest(task), "000000000001.json"))],
    ["adds a file that is not an anchor", (clone: string) => writeFileSync(join(clone, "notes.txt"), "x\n")],
  ])("refuses a clone with a commit of its own that %s", async (name, change) => {
    const slug = name.replace(/[^a-z]/g, "");
    const clone = join(base, `cache-f-${slug}`);
    await new GitAnchorSink({ clone, pin: pinOf(bare) }).append(anchorOf(`task-f-${slug}`, head(1), new Date(), key.privateKey));
    change(clone, `task-f-${slug}`);
    await git(["-C", clone, "add", "-A"]);
    expect((await git(["-C", clone, "commit", "--quiet", "-m", "local"])).exitCode).toBe(0);
    await expect(new GitAnchorSink({ clone, pin: pinOf(bare) }).listMany([taskDigest(`task-f-${slug}`)])).rejects.toThrow(/disagrees with the pinned repository: it holds a commit the repository lacks that does more than add an anchor/);
  });

  // proves D-206 item 2 with §3.4.1 V6-4: the clone holds, unpushed, an anchor at a seq where the repository holds
  // another: the repository's is never replaced, and the clone disagrees
  it("refuses a clone holding a different anchor at a seq the repository already holds", async () => {
    const clone = join(base, "cache-g");
    const sink = new GitAnchorSink({ clone, pin: pinOf(bare) });
    await sink.append(anchorOf("task-g", head(1), new Date(), key.privateKey));
    const mine = anchorOf("task-g", { ...head(2), hash: `sha256:${"a".repeat(64)}` }, new Date(), key.privateKey);
    writeFileSync(join(clone, taskDigest("task-g"), "000000000002.json"), `${JSON.stringify(mine)}\n`);
    await git(["-C", clone, "add", "."]);
    await git(["-C", clone, "commit", "--quiet", "-m", "anchor"]);
    await new GitAnchorSink({ clone: join(base, "cache-g-other"), pin: pinOf(bare) }).append(anchorOf("task-g", head(2), new Date(), key.privateKey));
    await expect(new GitAnchorSink({ clone, pin: pinOf(bare) }).list(taskDigest("task-g"))).rejects.toThrow(/holds an anchor at .* that differs from the repository's/);
  });

  // proves D-206 item 2: a pinned repository with nothing in it yet (its first start) works, and the first anchor makes
  // the pinned branch
  it("starts on an empty pinned repository", async () => {
    const empty = await repository("empty", false);
    const clone = join(base, "cache-h");
    const sink = new GitAnchorSink({ clone, pin: pinOf(empty) });
    expect(await sink.listMany([taskDigest("task-h")])).toEqual(new Map([[taskDigest("task-h"), []]]));
    await sink.append(anchorOf("task-h", head(1), new Date(), key.privateKey));
    expect(await seqs(new GitAnchorSink({ clone, pin: pinOf(empty) }), "task-h")).toEqual([1]);
    expect(await held(empty, "task-h")).toEqual([1]);
  });

  // proves D-206 item 2: a pinned repository that cannot be reached refuses the listing a start depends on
  it("fails when the pinned repository cannot be reached", async () => {
    const sink = new GitAnchorSink({ clone: join(base, "cache-i"), pin: pinOf(join(base, "no-such-repository.git")) });
    await expect(sink.listMany([])).rejects.toThrow(/pinned anchor repository could not be reached/);
  });
});

