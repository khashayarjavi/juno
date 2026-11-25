import { execFile } from "node:child_process";
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AbsolutePath } from "../../contracts/src/index.js";
import { readTrajectory } from "../../journal/src/index.js";
import { type HostProbe, LOCK_FILE, RunnerLockError, RunnerLockRefused, TAKEOVER_FILE, acquireRunnerLock, judgeLock, startTimeOfStat, systemProbe } from "../src/lock.js";
import { RUNNER_RECORD } from "../src/runner.js";
import { type Harness, harness } from "./helpers.js";

const HOST = `${"a".repeat(32)}/juno-host`;
const BOOT = "11111111-2222-3333-4444-555555555555";
const NS = "pid:[4026531836]";
const OWNER = 4242;
const OWNER_START = 777_000;

/** A host where only `running` decides whether OWNER is alive. */
const probe = (overrides: Partial<HostProbe> = {}, running: boolean | null = true): HostProbe => ({
  pid: 9999,
  hostId: () => HOST,
  bootId: () => BOOT,
  pidNamespace: () => NS,
  isRunning: (pid) => (pid === OWNER ? running : true),
  startTime: (pid) => (pid === OWNER ? OWNER_START : 5),
  ...overrides,
});

const holder = (fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ pid: OWNER, host: HOST, boot: BOOT, pid_ns: NS, pid_start: OWNER_START, started_at: "2026-10-29T09:00:00.000Z", nonce: "dead", ...fields });
/** A lock as JUNO wrote it before D-243 (commit bef25fe and earlier): no start time. */
const oldHolder = (fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ pid: OWNER, host: HOST, boot: BOOT, pid_ns: NS, started_at: "2026-10-29T09:00:00.000Z", nonce: "old", ...fields });

let root: AbsolutePath;
let lockPath: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "juno-lock-")) as AbsolutePath;
  lockPath = join(root, LOCK_FILE);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The lock refused to start, and the file it found is byte-for-byte unchanged. */
const expectRefused = (p: HostProbe, reason: RegExp): void => {
  const before = readFileSync(lockPath);
  expect(() => acquireRunnerLock(root, () => new Date(), p)).toThrow(RunnerLockError);
  expect(() => acquireRunnerLock(root, () => new Date(), p)).toThrow(reason);
  expect(readFileSync(lockPath).equals(before)).toBe(true);
  expect(existsSync(join(root, TAKEOVER_FILE))).toBe(false);
};

describe("a stale runner lock is cleared only when its owner is provably dead (D-025, D-064 amended by D-069)", () => {
  // proves D-069 case 1: a live owner on the same host keeps the journal; the new runner refuses
  it("refuses when the recorded owner is running", () => {
    writeFileSync(lockPath, holder());
    expectRefused(probe({}, true), /owner_running/);
  });

  // proves D-069 case 1: liveness that cannot be read is not proof of death
  it("refuses when the owner's liveness is unknown", () => {
    writeFileSync(lockPath, holder());
    expectRefused(probe({}, null), /liveness_unknown/);
  });

  // proves D-069 case 1 on the real host: this process holds the lock, so a second acquire refuses
  it("refuses a second lock while this live process holds it", () => {
    const lock = acquireRunnerLock(root);
    expect(lock.cleared).toBeNull();
    expectRefused(systemProbe, /owner_running/);
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  // proves D-069 case 2: same host and boot, recorded PID not running, same PID namespace: cleared
  it("clears the lock of a dead owner on the same host", () => {
    writeFileSync(lockPath, holder());
    const lock = acquireRunnerLock(root, () => new Date(), probe({}, false));
    expect(lock.cleared).toMatchObject({ reason: "owner_not_running", holder: { pid: OWNER, nonce: "dead" } });
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ pid: 9999, host: HOST, boot: BOOT, pid_ns: NS });
    expect(existsSync(join(root, TAKEOVER_FILE))).toBe(false);
    // The new lock is held: a further runner refuses.
    expectRefused(probe({ pid: 1234 }), /owner_running/);
    lock.release();
  });

  // proves D-069 case 2: the same host has rebooted since the lock was written, so its owner cannot be running
  it("clears the lock when the same host has rebooted since", () => {
    writeFileSync(lockPath, holder({ boot: "99999999-2222-3333-4444-555555555555" }));
    const lock = acquireRunnerLock(root, () => new Date(), probe({}, true));
    expect(lock.cleared).toMatchObject({ reason: "host_rebooted" });
    lock.release();
  });

  // proves D-069 case 2 on the real host: a process that has exited, recorded with this host's identity, is cleared
  it("clears the lock of a real process that has exited", async () => {
    const pid = await new Promise<number>((resolve, reject) => {
      const child = execFile(process.execPath, ["-e", "0"]);
      child.on("error", reject);
      child.on("exit", () => {
        if (child.pid === undefined) reject(new Error("no pid"));
        else resolve(child.pid);
      });
    });
    expect(systemProbe.isRunning(pid)).toBe(false);
    writeFileSync(lockPath, holder({ pid, host: systemProbe.hostId(), boot: systemProbe.bootId(), pid_ns: systemProbe.pidNamespace(), pid_start: 1 }));
    const lock = acquireRunnerLock(root);
    expect(lock.cleared).toMatchObject({ reason: "owner_not_running", holder: { pid } });
    lock.release();
  });

  // proves D-069 case 3: a lock written on another host is never cleared, even if its PID is not running here
  it("refuses a lock from another host", () => {
    writeFileSync(lockPath, holder({ host: `${"b".repeat(32)}/juno-host` }));
    expectRefused(probe({}, false), /other_host/);
    // Another host's reboot proves nothing either.
    writeFileSync(lockPath, holder({ host: `${"b".repeat(32)}/other`, boot: "99999999-2222-3333-4444-555555555555" }));
    expectRefused(probe({}, false), /other_host/);
  });

  // proves D-069 case 3: no host identity on either side is never "the same host"
  it("refuses when either host identity is unknown", () => {
    writeFileSync(lockPath, holder({ host: null }));
    expectRefused(probe({}, false), /host_unknown/);
    writeFileSync(lockPath, holder());
    expectRefused(probe({ hostId: () => null }, false), /host_unknown/);
  });

  // proves D-069 case 3: a different PID namespace on the same host cannot prove the owner dead
  it("refuses when the owner ran in another PID namespace, or the boot is unknown", () => {
    writeFileSync(lockPath, holder({ pid_ns: "pid:[4026532000]" }));
    expectRefused(probe({}, false), /pid_namespace_differs/);
    writeFileSync(lockPath, holder({ boot: null }));
    expectRefused(probe({}, false), /boot_unknown/);
  });

  // proves D-069 case 4: a lock that cannot be read or parsed refuses, whatever it says
  it("refuses an unreadable lock", () => {
    const unreadable = [
      "",
      "not json",
      "[]",
      JSON.stringify({ pid: OWNER, started_at: "2026-10-29T09:00:00.000Z", nonce: "old-format" }),
      holder({ pid: 0 }),
      holder({ pid: -1 }),
      holder({ pid: 1.5 }),
      holder({ extra: true }),
    ];
    for (const content of unreadable) {
      writeFileSync(lockPath, content);
      expectRefused(probe({}, false), /lock_unreadable/);
    }
    // A lock path that cannot be read as a file.
    rmSync(lockPath);
    mkdirSync(lockPath);
    expect(() => acquireRunnerLock(root, () => new Date(), probe({}, false))).toThrow(/lock_unreadable/);
    expect(existsSync(lockPath)).toBe(true);
  });

  // proves D-069: a lock replaced after it was judged (another runner's fresh lock) is never removed
  it("refuses when the lock changed between judging and clearing", () => {
    writeFileSync(lockPath, holder());
    const fresh = holder({ pid: 777, nonce: "fresh" });
    const racing = probe({
      isRunning: () => {
        writeFileSync(lockPath, fresh);
        return false;
      },
    });
    expect(() => acquireRunnerLock(root, () => new Date(), racing)).toThrow(/lock_changed/);
    expect(readFileSync(lockPath, "utf8")).toBe(fresh);
    expect(existsSync(join(root, TAKEOVER_FILE))).toBe(false);
  });

  // proves D-069: only one runner clears a stale lock; a takeover in progress (or left by a crash) refuses
  it("refuses while another runner holds the takeover", () => {
    writeFileSync(lockPath, holder());
    writeFileSync(join(root, TAKEOVER_FILE), "other");
    const before = readFileSync(lockPath);
    expect(() => acquireRunnerLock(root, () => new Date(), probe({}, false))).toThrow(/clearing this lock/);
    expect(readFileSync(lockPath).equals(before)).toBe(true);
    expect(readFileSync(join(root, TAKEOVER_FILE), "utf8")).toBe("other");
  });
});

describe("the runner records a cleared lock (D-069)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => {
    h.cleanup();
  });

  // proves D-069 / §3.4: a runner that clears a dead owner's lock starts, and the clearing is in its journal record
  it("starts over a dead owner's lock and journals the clearing", async () => {
    const pid = await new Promise<number>((resolve, reject) => {
      const child = execFile(process.execPath, ["-e", "0"]);
      child.on("error", reject);
      child.on("exit", () => (child.pid === undefined ? reject(new Error("no pid")) : resolve(child.pid)));
    });
    writeFileSync(join(h.journal.root, LOCK_FILE), holder({ pid, host: systemProbe.hostId(), boot: systemProbe.bootId(), pid_ns: systemProbe.pidNamespace(), pid_start: 1 }));
    const { runner } = h.runner([]);
    const notes = readTrajectory(h.journal.root, RUNNER_RECORD).map(h.payload);
    expect(notes).toEqual([expect.objectContaining({ type: "stale_lock_cleared", reason: "owner_not_running", holder: expect.objectContaining({ pid }) })]);
    runner.close();
    // The record reads back at the next start.
    expect(() => h.runner([])).not.toThrow();
  });
});

describe("a lock left by a service killed without a stop is taken over; one JUNO cannot prove dead refuses in plain words (D-243)", () => {
  // proves D-243: an unreadable namespace is not reported as a different one, and still refuses (restrictive)
  it("refuses with pid_namespace_unknown when either namespace cannot be read, never pid_namespace_differs", () => {
    writeFileSync(lockPath, holder({ pid_ns: null }));
    expectRefused(probe({}, false), /pid_namespace_unknown/);
    writeFileSync(lockPath, holder());
    expectRefused(probe({ pidNamespace: () => null }, false), /pid_namespace_unknown/);
    // Different, readable namespaces still refuse as before (D-069 case 3).
    writeFileSync(lockPath, holder({ pid_ns: "pid:[4026532000]" }));
    expectRefused(probe({}, false), /pid_namespace_differs/);
  });

  // proves D-243: in the same namespace, a PID now held by a process that started at another time is not the owner
  it("takes over a lock whose PID now belongs to a different process, by start time", () => {
    writeFileSync(lockPath, holder());
    const lock = acquireRunnerLock(root, () => new Date(), probe({ startTime: (pid) => (pid === OWNER ? OWNER_START + 1 : 5) }, true));
    expect(lock.cleared).toMatchObject({ reason: "owner_pid_reused", holder: { pid: OWNER } });
    lock.release();
    // The same start time is the owner: refused.
    writeFileSync(lockPath, holder());
    expectRefused(probe({}, true), /owner_running/);
    // A start time that cannot be read proves nothing.
    expectRefused(probe({ startTime: () => null }, true), /liveness_unknown/);
  });

  // proves D-243: WSL's teardown gives the new instance the dead one's namespace name and, often, the service's PID again;
  // the lock's PID is then this very process, which holds no such lock
  it("takes over a lock whose PID is this process's own, written by an earlier process", () => {
    // A lock written before D-243 records no start time; this process always records one, so it is not this one's.
    writeFileSync(lockPath, oldHolder({ pid: 9999 }));
    const old = acquireRunnerLock(root, () => new Date(), probe());
    expect(old.cleared).toMatchObject({ reason: "owner_pid_reused", holder: { pid: 9999, nonce: "old" } });
    old.release();
    // A lock with another start time is an earlier process's.
    writeFileSync(lockPath, holder({ pid: 9999, pid_start: 3 }));
    const earlier = acquireRunnerLock(root, () => new Date(), probe());
    expect(earlier.cleared).toMatchObject({ reason: "owner_pid_reused" });
    earlier.release();
    // This process's own start time: it is this process's lock, held, so refused.
    writeFileSync(lockPath, holder({ pid: 9999, pid_start: 5 }));
    expectRefused(probe(), /owner_running/);
  });

  // proves D-243 against the real host: this process's own lock records its start time, and a second acquire by the same
  // process is refused as owner_running, never taken over as a reused PID
  it("records the real start time, and this live process's own lock is never taken over", () => {
    const mine = systemProbe.startTime(process.pid);
    expect(typeof mine).toBe("number");
    const lock = acquireRunnerLock(root);
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ pid: process.pid, pid_start: mine });
    expectRefused(systemProbe, /owner_running/);
    expect(judgeLock(readFileSync(lockPath, "utf8"), systemProbe)).toEqual({ dead: false, reason: "owner_running" });
    lock.release();
  });

  // proves D-243: a lock written by JUNO before D-243 (no start time) whose owner is not running is still taken over
  it("takes over an old-format lock whose owner is not running, and refuses one whose PID is in use", () => {
    writeFileSync(lockPath, oldHolder());
    const lock = acquireRunnerLock(root, () => new Date(), probe({}, false));
    expect(lock.cleared).toMatchObject({ reason: "owner_not_running", holder: { nonce: "old" } });
    lock.release();
    writeFileSync(lockPath, oldHolder());
    expectRefused(probe({}, true), /does not record when its owner started/);
  });

  // proves D-243: the refusal names the journal's real path (never the handle /proc/self/fd/<n>) and a command that works
  it("names the lock's real path and how to remove it, and never says to stop a service that is not provably running", () => {
    writeFileSync(lockPath, holder({ pid_ns: "pid:[4026532000]" }));
    let thrown: unknown;
    try {
      acquireRunnerLock(root, () => new Date(), probe({}, false), { shown: "/var/lib/juno-runner/journal" });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RunnerLockRefused);
    const refused = thrown as RunnerLockRefused;
    expect(refused.reason).toBe("pid_namespace_differs");
    expect(refused.lockPath).toBe("/var/lib/juno-runner/journal/runner.lock");
    expect(refused.message).toContain("rm /var/lib/juno-runner/journal/runner.lock");
    expect(refused.message).toContain("pgrep -af 'juno[.]js (hook serve|gateway serve|checkpoint restore)|runner/src/main[.]js'");
    expect(refused.message).not.toContain("/proc/self/fd");
    expect(refused.message).not.toMatch(/systemctl --user stop/);
  });

  // proves D-243: a caller that must not take a lock over (the checkpoint restore) is refused with owner_dead, the lock unchanged
  it("refuses with owner_dead, changing nothing, when taking over is not allowed", () => {
    writeFileSync(lockPath, holder());
    const before = readFileSync(lockPath);
    expect(() => acquireRunnerLock(root, () => new Date(), probe({}, false), { reclaim: false })).toThrow(/owner_dead/);
    expect(readFileSync(lockPath).equals(before)).toBe(true);
    expect(existsSync(join(root, TAKEOVER_FILE))).toBe(false);
  });

  // proves D-243 (review round 2 of PR #65): a take-over file left by a crash in the middle of a take-over is named by
  // its real path, never the handle /proc/self/fd/<n>, and the remedy removes it with the lock, after the same check
  it("names a leftover take-over file by its real path, and removes it in the remedy", () => {
    writeFileSync(lockPath, holder());
    writeFileSync(join(root, TAKEOVER_FILE), holder());
    // The folder held by a handle, as the hook and gateway services hold the journal (D-213).
    const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
    let thrown: unknown;
    try {
      acquireRunnerLock(`/proc/self/fd/${String(fd)}` as AbsolutePath, () => new Date(), probe({}, false), { shown: "/var/lib/juno-runner/journal" });
    } catch (error: unknown) {
      thrown = error;
    } finally {
      closeSync(fd);
    }
    expect(thrown).toBeInstanceOf(RunnerLockRefused);
    const refused = thrown as RunnerLockRefused;
    expect(refused.reason).toBe("takeover_in_progress");
    expect(refused.message).toContain("clearing this lock");
    expect(refused.message).toContain("rm /var/lib/juno-runner/journal/runner.lock.takeover /var/lib/juno-runner/journal/runner.lock");
    expect(refused.message).toContain("pgrep -af 'juno[.]js (hook serve|gateway serve|checkpoint restore)|runner/src/main[.]js'");
    expect(refused.message).not.toContain("/proc/self/fd");
    expect(refused.message).not.toContain(root);
    // Nothing was changed.
    expect(readFileSync(lockPath, "utf8")).toBe(holder());
    expect(readFileSync(join(root, TAKEOVER_FILE), "utf8")).toBe(holder());
  });

  // proves D-243: every refusal says why once, in words, never the bare reason twice
  it("explains every refusal reason in words", () => {
    for (const [content, p, reason] of [[holder({ pid_ns: null }), probe({}, false), "pid_namespace_unknown"], [holder(), probe({}, null), "liveness_unknown"], [holder({ host: `${"b".repeat(32)}/x` }), probe({}, false), "other_host"]] as const) {
      writeFileSync(lockPath, content);
      expect(() => acquireRunnerLock(root, () => new Date(), p)).toThrow(new RegExp(`is held \\(${reason}\\): (?!${reason})`));
    }
  });

  // proves D-243: neither form of the checkpoint restore takes a dead owner's lock over; it refuses, changing nothing
  it("never takes a lock over in a checkpoint restore, in the container form too", async () => {
    const { runCheckpointCli } = await import("../src/restore.js");
    const journalDir = join(root, "journal");
    mkdirSync(journalDir, { mode: 0o700 });
    const stale = holder({ pid: 4243, host: systemProbe.hostId(), boot: systemProbe.bootId(), pid_ns: systemProbe.pidNamespace(), pid_start: 1 });
    // A PID that is not running here: the owner is provably dead, so only the refusal to take over can stop the restore.
    expect(systemProbe.isRunning(4243)).toBe(false);
    writeFileSync(join(journalDir, LOCK_FILE), stale);
    const lines: string[] = [];
    const io = { readFile: () => "", out: (text: string) => lines.push(text), err: (text: string) => lines.push(text) };
    const code = await runCheckpointCli(["restore", "--journal", journalDir, "--checkpoints", join(root, "store"), "--compose", "/nonexistent/docker-compose.yml", "--project", "p", "--principal", "alireza", "task-1", "0".repeat(64)], io);
    expect(code).toBe(1);
    expect(lines.join("")).toContain("(owner_dead)");
    expect(readFileSync(join(journalDir, LOCK_FILE), "utf8")).toBe(stale);
  });

  // proves D-243: the start time is field 22 of /proc/<pid>/stat, read after the last ")" of the command name
  it("reads the start time from a stat line whose command name holds spaces and parentheses", () => {
    const tail = (start: string): string => ["S", ...Array.from({ length: 18 }, (_, i) => String(i + 1)), start, "0", "0"].join(" ");
    expect(startTimeOfStat(`123 (node) ${tail("4567")}`)).toEqual({ pid: 123, start: 4567 });
    expect(startTimeOfStat(`123 (a) (b c) ${tail("89")}`)).toEqual({ pid: 123, start: 89 });
    expect(startTimeOfStat("123 (node) S 1 2")).toBeNull();
    expect(startTimeOfStat(`x (node) ${tail("1")}`)).toBeNull();
    expect(startTimeOfStat(`123 (node) ${tail("-1")}`)).toBeNull();
    const self = startTimeOfStat(readFileSync("/proc/self/stat", "utf8"));
    expect(self?.pid).toBe(process.pid);
  });
});
