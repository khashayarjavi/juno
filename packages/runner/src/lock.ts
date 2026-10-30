import { readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AbsolutePath } from "../../contracts/src/index.js";

/**
 * One runner per journal (DECISIONS.md D-025 Increment 5, D-064, amended by
 * D-069). The lock is a file in the journal root created exclusively: a second
 * runner finds it and refuses to start. A lock left by a runner that crashed
 * is cleared only when its owner is provably dead: the same host, and either
 * the host has rebooted since or the recorded process is not running (in the
 * same PID namespace). Every other case refuses, and the operator removes the
 * lock (§0.2 D8: when unsure, stop and ask).
 */

export const LOCK_FILE = "runner.lock";
/** Held only while a stale lock is cleared, so two runners never clear one lock together. */
export const TAKEOVER_FILE = "runner.lock.takeover";

export class RunnerLockError extends Error {
  override readonly name = "RunnerLockError";
}

/** What a new runner can learn about this host and its processes. */
export type HostProbe = {
  readonly pid: number;
  /** The machine id and the host name; null when either cannot be read. */
  hostId(): string | null;
  /** Changes on every boot; null when it cannot be read. */
  bootId(): string | null;
  /** The PID namespace this process runs in; null when it cannot be read. */
  pidNamespace(): string | null;
  /** true running, false not running, null unknown. */
  isRunning(pid: number): boolean | null;
};

const readTrimmed = (path: string, pattern: RegExp): string | null => {
  try {
    const value = readFileSync(path, "utf8").trim();
    return pattern.test(value) ? value : null;
  } catch {
    return null;
  }
};

export const systemProbe: HostProbe = {
  pid: process.pid,
  hostId(): string | null {
    const machine = readTrimmed("/etc/machine-id", /^[0-9a-f]{32}$/);
    const name = hostname();
    return machine === null || name === "" ? null : `${machine}/${name}`;
  },
  bootId(): string | null {
    return readTrimmed("/proc/sys/kernel/random/boot_id", /^[0-9a-f-]{36}$/);
  },
  pidNamespace(): string | null {
    try {
      return readlinkSync("/proc/self/ns/pid");
    } catch {
      return null;
    }
  },
  isRunning(pid: number): boolean | null {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: unknown) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ESRCH") return false;
      // EPERM: the process exists but belongs to someone else.
      if (code === "EPERM") return true;
      return null;
    }
  },
};

/** A pid of 0 or below names a process group, never one process. */
const Pid = z.number().int().min(1).max(4_194_304);

const LockRecord = z.strictObject({
  pid: Pid,
  host: z.string().min(1).nullable(),
  boot: z.string().min(1).nullable(),
  pid_ns: z.string().min(1).nullable(),
  started_at: z.iso.datetime(),
  nonce: z.string().min(1),
});
export type LockRecord = z.infer<typeof LockRecord>;

export type StaleReason = "host_rebooted" | "owner_not_running";
export type Judgement = { readonly dead: true; readonly reason: StaleReason } | { readonly dead: false; readonly reason: string };

/** Whether the lock's owner is provably dead. Anything short of proof is "not dead". */
export function judgeLock(content: string, probe: HostProbe): Judgement {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { dead: false, reason: "lock_unreadable" };
  }
  const record = LockRecord.safeParse(parsed);
  if (!record.success) return { dead: false, reason: "lock_unreadable" };
  const lock = record.data;
  const host = probe.hostId();
  if (lock.host === null || host === null) return { dead: false, reason: "host_unknown" };
  if (lock.host !== host) return { dead: false, reason: "other_host" };
  const boot = probe.bootId();
  if (lock.boot === null || boot === null) return { dead: false, reason: "boot_unknown" };
  if (lock.boot !== boot) return { dead: true, reason: "host_rebooted" };
  const namespace = probe.pidNamespace();
  if (lock.pid_ns === null || namespace === null || lock.pid_ns !== namespace) return { dead: false, reason: "pid_namespace_differs" };
  const running = probe.isRunning(lock.pid);
  if (running === false) return { dead: true, reason: "owner_not_running" };
  return { dead: false, reason: running === true ? "owner_running" : "liveness_unknown" };
}

export type ClearedLock = { readonly holder: LockRecord; readonly reason: StaleReason };
export type RunnerLock = { readonly path: string; readonly cleared: ClearedLock | null; release(): void };

const isCode = (error: unknown, code: string): boolean => error instanceof Error && "code" in error && error.code === code;

export function acquireRunnerLock(root: AbsolutePath, clock: () => Date = () => new Date(), probe: HostProbe = systemProbe): RunnerLock {
  const path = join(root, LOCK_FILE);
  const record: LockRecord = {
    pid: probe.pid,
    host: probe.hostId(),
    boot: probe.bootId(),
    pid_ns: probe.pidNamespace(),
    started_at: clock().toISOString(),
    nonce: Math.random().toString(36).slice(2),
  };
  const token = JSON.stringify(record);
  const create = (): boolean => {
    try {
      writeFileSync(path, token, { flag: "wx", mode: 0o600 });
      return true;
    } catch (error: unknown) {
      if (isCode(error, "EEXIST")) return false;
      throw error;
    }
  };
  const refuse = (holder: string, reason: string): never => {
    throw new RunnerLockError(
      `another runner holds the journal at ${root} (${LOCK_FILE}: ${holder}; ${reason}); one runner per journal. If no runner is running, remove ${path}`,
    );
  };

  let cleared: ClearedLock | null = null;
  if (!create()) {
    let holder: string;
    try {
      holder = readFileSync(path, "utf8");
    } catch {
      return refuse("unknown", "lock_unreadable");
    }
    const judgement = judgeLock(holder, probe);
    if (!judgement.dead) return refuse(holder, judgement.reason);
    cleared = clearStale(root, path, holder, judgement.reason, create, refuse);
  }
  let held = true;
  return {
    path,
    cleared,
    release(): void {
      if (!held) return;
      held = false;
      // Only our own lock is removed.
      if (readFileSync(path, "utf8") === token) unlinkSync(path);
    },
  };
}

/**
 * Clears a lock whose owner is provably dead, holding the takeover file so no
 * other runner clears it at the same time. The lock must still be the one that
 * was judged; then it is removed and ours created exclusively. A takeover file
 * left by a crash refuses every runner until the operator removes it.
 */
function clearStale(
  root: AbsolutePath,
  path: string,
  holder: string,
  reason: StaleReason,
  create: () => boolean,
  refuse: (holder: string, reason: string) => never,
): ClearedLock {
  const takeover = join(root, TAKEOVER_FILE);
  try {
    writeFileSync(takeover, holder, { flag: "wx", mode: 0o600 });
  } catch (error: unknown) {
    if (isCode(error, "EEXIST")) return refuse(holder, `another runner is clearing this lock, or crashed doing so; if none is, remove ${takeover}`);
    throw error;
  }
  try {
    let current: string;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      return refuse(holder, "lock_changed");
    }
    if (current !== holder) return refuse(current, "lock_changed");
    unlinkSync(path);
    if (!create()) return refuse("unknown", "lock_taken");
  } finally {
    unlinkSync(takeover);
  }
  return { holder: LockRecord.parse(JSON.parse(holder)), reason };
}
