import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeOutbound } from "../../registry/src/index.js";
import { readTrajectory } from "../../journal/src/index.js";
import { type AnchoringConfig, SessionLayer, type SessionLimits, anchoringState, gitAnchoring, startupCheck } from "../src/index.js";
import { ordinaryHost } from "./layer.js";

/**
 * Review round 7 on PR #51 (DECISIONS.md D-210), fixed as the operator ruled (D-211 item 1; D-213). Each test is the
 * reviewer's reproduction (docs/evidence/d210-round7/), with the real git, the real start-up check and the real session
 * layer, asserting the safe outcome. The reviewer's originals failed on a47eab4 (docs/evidence/d210-round7/repro-output.txt).
 */

const GIT = "/usr/bin/git";
const LIMITS: SessionLimits = { rejection_limit: 3, ttl: 3_600_000, budget: { tokens: 1, currency: 1, wall_clock_ms: 3_600_000, turns: 10 }, metered: ["turns", "wall_clock_ms"], clock: "from_admission" };
const CLASS = { sensitivity: "internal" as const, integrity: "operator" as const };

async function git(args: readonly string[]): Promise<string> {
  const result = await executeOutbound({ file: GIT, args: ["-c", "user.name=o", "-c", "user.email=o@o", "-c", "init.defaultBranch=main", ...args] });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8"));
  return result.stdout.toString("utf8");
}

let dir: string;
let remote: string;
let work: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "juno-round7-"));
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

/** The operator's root-owned pin (D-208), naming the git program (D-211 item 1). */
function writePin(journal: string, gitProgram = GIT): string {
  const pin = join(dir, "root-owned", "anchors.json");
  writeFileSync(pin, JSON.stringify({ url: remote, branch: "main", host_key_fingerprint: null, known_hosts: null, push_key: null, git: gitProgram, journals: [{ path: journal, recovery_epoch: "2020-01-01T00:00:00Z" }] }), { mode: 0o644 });
  chmodSync(pin, 0o644);
  return pin;
}

function opener(service: "hook" | "gateway", journal: string, config: AnchoringConfig, between?: () => void): () => Promise<SessionLayer> {
  return () =>
    SessionLayer.open(
      { service, journal, workspaces: [work], state: anchoringState(config), anchor: null },
      {
        host: ordinaryHost(),
        // The factory runs after the start-up check and before the journal is opened: where round 7's F3 swap landed.
        anchoring: (root, pin) => {
          between?.();
          return gitAnchoring(config, root, pin);
        },
      },
    );
}

const admit = (layer: SessionLayer, id: string): void => {
  layer.admit(id, LIMITS, { dataClass: CLASS, actor: "test", payload: { admitted_at: new Date().toISOString(), task: { grants: ["g"] } } });
};

describe("D-211 item 1, round 7 F1: the git program is named only in the root-owned pin", () => {
  // proves D-211 item 1: a git program of the runner's own cannot be named; the pin's must be root's own
  it("refuses a pin that names a git program the runner's account owns", () => {
    const journal = join(dir, "state", "journal");
    mkdirSync(join(dir, "state"), { mode: 0o700 });
    mkdirSync(join(dir, "runner-owned"), { mode: 0o700 });
    const evil = join(dir, "runner-owned", "git");
    writeFileSync(evil, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const pin = writePin(journal, evil);
    const checked = startupCheck({ service: "hook", journal, workspaces: [work], state: [{ what: "the anchor pin", path: pin, kind: "pin" }], anchor: null }, ordinaryHost());
    expect(checked.ok).toBe(false);
    expect(checked.ok ? "" : checked.refusals.join("\n")).toMatch(/the git program the anchor pin names .* not root/);
    // The real one, root's own, is accepted.
    writePin(journal);
    expect(startupCheck({ service: "hook", journal, workspaces: [work], state: [{ what: "the anchor pin", path: pin, kind: "pin" }], anchor: null }, ordinaryHost())).toMatchObject({ ok: true });
  });

  // proves D-211 item 1 (the reviewer's reproduction): the service's settings can no longer name a git program, so
  // replacing the journal and the clone while a git of the runner's own is "configured" does not start the service as new
  it("the reproduction: settings naming a runner-owned git, with the journal and clone emptied, do not start as new", async () => {
    mkdirSync(join(dir, "state"), { mode: 0o700 });
    const journal = join(dir, "state", "journal");
    writePin(journal);
    const honest: AnchoringConfig = { journalKeyDir: join(dir, "state", "journal-key"), anchorClone: join(dir, "state", "juno-anchors"), intervalMs: 60_000, pin: join(dir, "root-owned", "anchors.json") };
    const first = await opener("hook", journal, honest)();
    admit(first, "session-1");
    expect(await first.close()).toEqual([]);
    mkdirSync(join(dir, "runner-owned"), { mode: 0o700 });
    const evil = join(dir, "runner-owned", "git");
    writeFileSync(evil, "#!/bin/sh\nexec /usr/bin/git \"$@\"\n", { mode: 0o755 });
    rmSync(journal, { recursive: true, force: true });
    rmSync(honest.anchorClone, { recursive: true, force: true });
    // A `git` setting is not part of the service's configuration any more; passing one changes nothing.
    const withGit = { ...honest, git: evil } as AnchoringConfig;
    await expect(opener("hook", journal, withGit)()).rejects.toThrow(/disagrees with its off-host anchors|could not be verified/);
  }, 60_000);
});

describe("D-211 item 1, round 7 F2: anchoring reads no git settings of the clone, and reads every anchor back", () => {
  // proves D-211 item 1 (the reviewer's reproduction): the clone's own settings changed while the service runs do not
  // redirect a single anchor; the change is found before git reads it, every session stops, and the pinned repository
  // keeps everything that was anchored, so rolling the journal back is refused at the next start
  it("a url.insteadOf put in the clone's settings while the service runs stops every session and sends nothing elsewhere", async () => {
    mkdirSync(join(dir, "state"), { mode: 0o700 });
    const journal = join(dir, "state", "journal");
    const config: AnchoringConfig = { journalKeyDir: join(dir, "state", "journal-key"), anchorClone: join(dir, "state", "juno-anchors"), intervalMs: 60_000, pin: writePin(journal) };
    const open = opener("hook", journal, config);
    const first = await open();
    admit(first, "session-1");
    expect(await first.close()).toEqual([]);
    const running = await open();
    admit(running, "session-2");
    expect(await running.anchorPending()).toEqual([]);
    const pinnedBefore = (await git(["--git-dir", remote, "log", "--oneline", "main"])).trim().split("\n").length;
    // The runner's account points the clone at a mirror of its own, and later sets an ssh command too.
    const mirror = join(dir, "mirror.git");
    await git(["clone", "--quiet", "--bare", remote, mirror]);
    await git(["-C", config.anchorClone, "config", `url.${mirror}.insteadOf`, remote]);
    await git(["-C", config.anchorClone, "config", "core.sshCommand", "/bin/false"]);
    const mirrorBefore = (await git(["--git-dir", mirror, "log", "--oneline", "main"])).trim();
    admit(running, "session-3");
    const failed = await running.anchorPending();
    expect(failed.length).toBeGreaterThan(0);
    // Every session stops, each stop journalled (D-203), not only the one whose anchor failed.
    for (const id of ["session-2", "session-3"]) {
      expect(running.session(id)?.stopped, id).toBe("anchor_unavailable");
      expect(readTrajectory(running.root, id).length).toBeGreaterThan(0);
    }
    expect(await running.close()).not.toEqual([]);
    // Nothing went to the mirror; the pinned repository still holds every anchor it had.
    expect((await git(["--git-dir", mirror, "log", "--oneline", "main"])).trim()).toBe(mirrorBefore);
    expect((await git(["--git-dir", remote, "log", "--oneline", "main"])).trim().split("\n").length).toBe(pinnedBefore);
  }, 60_000);

  // proves D-211 item 1: a journal rolled back to an earlier copy after a run is refused, because everything the run
  // anchored is read back from the pinned repository, not from the clone
  it("a journal rolled back to before the run, with the clone emptied, is refused", async () => {
    mkdirSync(join(dir, "state"), { mode: 0o700 });
    const journal = join(dir, "state", "journal");
    const config: AnchoringConfig = { journalKeyDir: join(dir, "state", "journal-key"), anchorClone: join(dir, "state", "juno-anchors"), intervalMs: 60_000, pin: writePin(journal) };
    const open = opener("hook", journal, config);
    const first = await open();
    admit(first, "session-1");
    expect(await first.close()).toEqual([]);
    cpSync(journal, join(dir, "journal-at-T1"), { recursive: true });
    const running = await open();
    admit(running, "session-2");
    expect(await running.close()).toEqual([]);
    rmSync(journal, { recursive: true, force: true });
    cpSync(join(dir, "journal-at-T1"), journal, { recursive: true });
    rmSync(config.anchorClone, { recursive: true, force: true });
    await expect(open()).rejects.toThrow(/disagrees with its off-host anchors/);
  }, 60_000);
});

describe("D-211 item 1, round 7 F3: the journal is opened from a directory handle, following no symbolic link", () => {
  function layout(): { journal: string; config: AnchoringConfig } {
    const journal = join(dir, "state", "svc", "journal");
    mkdirSync(join(dir, "state", "svc"), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, "keys"), { mode: 0o700 });
    return { journal, config: { journalKeyDir: join(dir, "keys", "journal-key"), anchorClone: join(dir, "keys", "juno-anchors"), intervalMs: 60_000, pin: writePin(journal) } };
  }

  // proves D-211 item 1 (the reviewer's reproduction): a folder above the journal swapped for a symbolic link between
  // the start-up check and the opening of the journal is refused; the service does not start as new
  it("a symbolic-link swap timed between the check and the opening is refused", async () => {
    const { journal, config } = layout();
    let swap = false;
    const open = opener("gateway", journal, config, () => {
      if (!swap) return;
      swap = false;
      renameSync(join(dir, "state"), join(dir, "state-kept-aside"));
      mkdirSync(join(dir, "state2", "svc"), { recursive: true, mode: 0o700 });
      symlinkSync(join(dir, "state2"), join(dir, "state"));
    });
    const first = await open();
    admit(first, "session-1");
    expect(await first.close()).toEqual([]);
    swap = true;
    await expect(open()).rejects.toThrow(/symbolic link/);
  }, 60_000);

  // proves D-211 item 1: the same swap with a real, empty folder instead of a link gives no new record either: the
  // journal's own record is named after the path the pin names, whose anchors the pinned repository holds
  it("a folder above the journal replaced by an empty one is refused", async () => {
    const { journal, config } = layout();
    let swap = false;
    const open = opener("gateway", journal, config, () => {
      if (!swap) return;
      swap = false;
      renameSync(join(dir, "state"), join(dir, "state-kept-aside"));
      mkdirSync(join(dir, "state", "svc"), { recursive: true, mode: 0o700 });
    });
    const first = await open();
    admit(first, "session-1");
    expect(await first.close()).toEqual([]);
    swap = true;
    await expect(open()).rejects.toThrow(/disagrees with its off-host anchors/);
  }, 60_000);

  // proves D-211 item 1: once open, the service keeps writing to the folder it opened, whatever is done to the path
  it("a running service keeps writing to the folder it opened when a folder above it is moved and linked", async () => {
    const { journal, config } = layout();
    const layer = await opener("gateway", journal, config)();
    renameSync(join(dir, "state"), join(dir, "state-moved"));
    mkdirSync(join(dir, "elsewhere", "svc"), { recursive: true, mode: 0o700 });
    symlinkSync(join(dir, "elsewhere"), join(dir, "state"));
    admit(layer, "session-after-move");
    expect(readTrajectory(join(dir, "state-moved", "svc", "journal"), "session-after-move").length).toBe(1);
    expect(existsSync(join(dir, "elsewhere", "svc", "journal"))).toBe(false);
    await layer.close();
  }, 60_000);

  // proves D-211 item 1: a symbolic link anywhere inside the journal's own layout is refused at start
  it("a symbolic link inside the journal folder is refused", async () => {
    const { journal, config } = layout();
    const first = await opener("gateway", journal, config)();
    admit(first, "session-1");
    expect(await first.close()).toEqual([]);
    const tasks = join(journal, "tasks");
    renameSync(tasks, join(dir, "tasks-elsewhere"));
    symlinkSync(join(dir, "tasks-elsewhere"), tasks);
    await expect(opener("gateway", journal, config)()).rejects.toThrow(/not a plain folder/);
    expect(readFileSync(join(dir, "tasks-elsewhere", readdirFirst(join(dir, "tasks-elsewhere")), "head.json"), "utf8")).toContain("seq");
  }, 60_000);
});

function readdirFirst(path: string): string {
  return readdirSync(path)[0] ?? "";
}
