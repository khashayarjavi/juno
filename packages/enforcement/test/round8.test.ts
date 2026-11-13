import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeOutbound } from "../../registry/src/index.js";
import { readTrajectory } from "../../journal/src/index.js";
import { type AnchoringConfig, SessionLayer, type SessionLimits, anchoringState, gitAnchoring } from "../src/index.js";
import { ordinaryHost } from "./layer.js";

/**
 * Review round 8 on PR #52, note 2, as the operator ruled (DECISIONS.md D-214 item 5; D-216): the read-back itself. A
 * push that git reports as a success but that never reaches the pinned repository must stop every session (D-211
 * item 1, D-213 F2 item 3). The stand-in git below is the real git for everything except `push`, which, once the
 * test switches it on, answers "done" (exit 0, nothing printed) and sends nothing.
 */

const GIT = "/usr/bin/git";
const LIMITS: SessionLimits = { rejection_limit: 3, ttl: 3_600_000, budget: { tokens: 1, currency: 1, wall_clock_ms: 3_600_000, turns: 10 }, metered: ["turns", "wall_clock_ms"], clock: "from_admission" };
const CLASS = { sensitivity: "internal" as const, integrity: "operator" as const };

async function git(args: readonly string[]): Promise<string> {
  const result = await executeOutbound({ file: GIT, args: ["-c", "user.name=o", "-c", "user.email=o@o", "-c", "init.defaultBranch=main", ...args] });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8"));
  return result.stdout.toString("utf8");
}

/**
 * A git that drops pushes while `<switch>` exists. Node, run by this test's own node; it runs the real git with
 * `execFile` and an argument array (CLAUDE.md rule 8), passing standard output, standard error and the exit code on.
 */
function silentPushGit(path: string, switchFile: string): void {
  const source = [
    `#!${process.execPath}`,
    `import { execFile } from "node:child_process";`,
    `import { existsSync } from "node:fs";`,
    `const args = process.argv.slice(2);`,
    `if (existsSync(${JSON.stringify(switchFile)}) && args.includes("push")) process.exit(0);`,
    `execFile(${JSON.stringify(GIT)}, args, { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {`,
    `  process.stdout.write(stdout);`,
    `  process.stderr.write(stderr);`,
    `  process.exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : 1;`,
    `});`,
    ``,
  ].join("\n");
  writeFileSync(path, source, { mode: 0o755 });
  chmodSync(path, 0o755);
}

let dir: string;
let remote: string;
let work: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "juno-round8-"));
  remote = join(dir, "pinned.git");
  await git(["init", "--bare", "--quiet", remote]);
  const seed = join(dir, "seed");
  await git(["clone", "--quiet", remote, seed]);
  writeFileSync(join(seed, "README.md"), "the operator's anchor repository\n");
  await git(["-C", seed, "add", "README.md"]);
  await git(["-C", seed, "commit", "--quiet", "-m", "seed"]);
  await git(["-C", seed, "push", "--quiet", "origin", "HEAD:main"]);
  work = join(dir, "work");
  mkdirSync(work);
  mkdirSync(join(dir, "root-owned"), { mode: 0o755 });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const admit = (layer: SessionLayer, id: string): void => {
  layer.admit(id, LIMITS, { dataClass: CLASS, actor: "test", payload: { admitted_at: new Date().toISOString(), task: { grants: ["g"] } } });
};

describe("D-214 item 5 (round 8 note 2): the read-back catches a push that never arrived", () => {
  // proves D-211 item 1 with §3.4.1: when git says a push succeeded but the pinned repository did not receive it, the
  // read-back finds the pinned branch is not the clone's commit, the anchor is not counted, and every session stops,
  // each stop journalled (D-203), not only the session whose anchor was being pushed
  it("a push that reports success but never reaches the pinned repository stops every session", async () => {
    mkdirSync(join(dir, "state"), { mode: 0o700 });
    const journal = join(dir, "state", "journal");
    const switchFile = join(dir, "drop-pushes");
    const program = join(dir, "root-owned", "git");
    silentPushGit(program, switchFile);
    const pin = join(dir, "root-owned", "anchors.json");
    writeFileSync(pin, JSON.stringify({ url: remote, branch: "main", host_key_fingerprint: null, known_hosts: null, push_key: null, git: program, journals: [{ path: journal, recovery_epoch: "2020-01-01T00:00:00Z" }] }), { mode: 0o644 });
    chmodSync(pin, 0o644);
    const config: AnchoringConfig = { journalKeyDir: join(dir, "state", "journal-key"), anchorClone: join(dir, "state", "juno-anchors"), intervalMs: 60_000, pin };
    const open = (): Promise<SessionLayer> => SessionLayer.open({ service: "hook", journal, workspaces: [work], state: anchoringState(config), anchor: null }, { host: ordinaryHost(), anchoring: (root, verified) => gitAnchoring(config, root, verified) });

    // While pushes arrive, everything anchors through the stand-in, as through the real git.
    const running = await open();
    admit(running, "session-1");
    expect(await running.anchorPending()).toEqual([]);
    const pinnedBefore = (await git(["--git-dir", remote, "rev-parse", "main"])).trim();
    const commitsBefore = (await git(["--git-dir", remote, "rev-list", "--count", "main"])).trim();
    expect(Number(commitsBefore)).toBeGreaterThan(1);

    // From now on every push "succeeds" and sends nothing.
    writeFileSync(switchFile, "on\n");
    admit(running, "session-2");
    const failed = await running.anchorPending();
    expect(failed.length).toBeGreaterThan(0);
    for (const id of ["session-1", "session-2"]) {
      expect(running.session(id)?.stopped, id).toBe("anchor_unavailable");
      expect(readTrajectory(running.root, id).length, id).toBeGreaterThan(0);
    }
    // A stopped session stays stopped: a call is not admitted to run.
    expect(running.session("session-1")?.stopped).toBe("anchor_unavailable");
    expect(await running.close()).not.toEqual([]);
    // The pinned repository never received anything after the switch.
    expect((await git(["--git-dir", remote, "rev-parse", "main"])).trim()).toBe(pinnedBefore);
    expect((await git(["--git-dir", remote, "rev-list", "--count", "main"])).trim()).toBe(commitsBefore);

    // And the next start, still unable to push, refuses rather than serving on what was never anchored.
    expect(existsSync(switchFile)).toBe(true);
    await expect(open()).rejects.toThrow();
  }, 120_000);
});
