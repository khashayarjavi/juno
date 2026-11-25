import { readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AbsolutePath } from "../../contracts/src/index.js";
import { LOCK_FILE, TAKEOVER_FILE, commandText, lockFileOf, ownerName, removeIfNoJunoRuns, serviceCommand, takeoverFileOf } from "./operator-names.js";

/**
 * One runner per journal (DECISIONS.md D-025 Increment 5, D-064, amended by
 * D-069 and D-243). The lock is a file in the journal root created exclusively:
 * a second runner finds it and refuses to start. A lock left by a runner that
 * crashed is cleared only when its owner is provably dead: the same host, and
 * either the host has rebooted since, or (in the same PID namespace) the
 * recorded process is not running, or the process now holding its PID is a
 * different one (it started at another time, or it is this very process, which
 * holds no such lock). Every other case refuses, naming the lock's real path
 * and how to remove it (§0.2 D8: when unsure, stop and ask).
 */

export { LOCK_FILE, TAKEOVER_FILE };

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
  /**
   * When the process with this PID started, in clock ticks since boot (`/proc/<pid>/stat` field 22); null when it
   * cannot be read, or when `/proc` is not this PID namespace's (D-243).
   */
  startTime(pid: number): number | null;
};

/** Field 22 of a `/proc/<pid>/stat` line, read after the last `)` so a command name holding spaces or `)` is skipped. */
export function startTimeOfStat(line: string): { readonly pid: number; readonly start: number } | null {
  const open = line.indexOf(" (");
  const close = line.lastIndexOf(")");
  if (open <= 0 || close < open) return null;
  const pid = Number(line.slice(0, open));
  // After ")": state is field 3, so starttime (field 22) is the 20th word.
  const words = line.slice(close + 1).trim().split(/\s+/);
  const start = Number(words[19]);
  if (!Number.isSafeInteger(pid) || pid < 1 || words.length < 20 || !/^\d+$/.test(words[19] ?? "") || !Number.isSafeInteger(start)) return null;
  return { pid, start };
}

const readStat = (pid: number | "self"): { readonly pid: number; readonly start: number } | null => {
  try {
    return startTimeOfStat(readFileSync(`/proc/${String(pid)}/stat`, "utf8"));
  } catch {
    return null;
  }
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
  startTime(pid: number): number | null {
    // `/proc` must be this PID namespace's: its view of this process must carry this process's own PID.
    const self = readStat("self");
    if (self?.pid !== process.pid) return null;
    const other = readStat(pid);
    return other?.pid === pid ? other.start : null;
  },
};

/** A pid of 0 or below names a process group, never one process. */
const Pid = z.number().int().min(1).max(4_194_304);

const LockRecord = z.strictObject({
  pid: Pid,
  host: z.string().min(1).nullable(),
  boot: z.string().min(1).nullable(),
  pid_ns: z.string().min(1).nullable(),
  /** The owner's start time in clock ticks since boot (D-243); null when it could not be read; absent in a lock written before D-243. */
  pid_start: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  started_at: z.iso.datetime(),
  nonce: z.string().min(1),
});
export type LockRecord = z.infer<typeof LockRecord>;

export type StaleReason = "host_rebooted" | "owner_not_running" | "owner_pid_reused";
export type Judgement = { readonly dead: true; readonly reason: StaleReason } | { readonly dead: false; readonly reason: string };

/**
 * Whether the lock's owner is provably dead. Anything short of proof is "not dead" (D-069, D-243).
 *
 * In one PID namespace a PID names one live process at a time, and a namespace's name (`pid:[N]`) names one live
 * namespace: Linux gives a torn-down namespace's number to the next one made, and that one's PIDs start again from 1
 * (as when WSL tears its instance down). So, on the same host and boot and under the same namespace name, the owner is
 * dead when its PID is not running; when the process holding that PID started at a different time than the owner did;
 * or when that process is this one, which judges the lock only because it does not hold it.
 */
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
  if (lock.pid_ns === null || namespace === null) return { dead: false, reason: "pid_namespace_unknown" };
  if (lock.pid_ns !== namespace) return { dead: false, reason: "pid_namespace_differs" };
  // The lock's PID is this process's own. A lock this process wrote records its start time, so a lock with none (written
  // by a JUNO before D-243) or with another start time is not this process's: its owner held this PID before, and is gone.
  if (lock.pid === probe.pid) {
    if (lock.pid_start === undefined) return { dead: true, reason: "owner_pid_reused" };
    const mine = probe.startTime(probe.pid);
    if (lock.pid_start === null || mine === null) return { dead: false, reason: "liveness_unknown" };
    return lock.pid_start === mine ? { dead: false, reason: "owner_running" } : { dead: true, reason: "owner_pid_reused" };
  }
  const running = probe.isRunning(lock.pid);
  if (running === false) return { dead: true, reason: "owner_not_running" };
  if (running === null) return { dead: false, reason: "liveness_unknown" };
  // A process holds the PID. It is the owner unless it provably started at another time.
  if (lock.pid_start === undefined || lock.pid_start === null) return { dead: false, reason: "owner_running" };
  const start = probe.startTime(lock.pid);
  if (start === null) return { dead: false, reason: "liveness_unknown" };
  return start === lock.pid_start ? { dead: false, reason: "owner_running" } : { dead: true, reason: "owner_pid_reused" };
}

/** What each refusal means, in plain words, for the operator (D-243). */
function explain(reason: string, holder: LockRecord | null, probe: HostProbe): string {
  const pid = holder === null ? "?" : String(holder.pid);
  switch (reason) {
    case "owner_running":
      return holder !== null && holder.pid_start !== undefined && holder.pid_start !== null
        ? `process ${pid}, which took the lock, is still running`
        : `a process with the lock's PID ${pid} is running, and the lock does not record when its owner started, so JUNO cannot tell whether that process is its owner`;
    case "liveness_unknown":
      return `JUNO cannot tell whether process ${pid}, which took the lock, is still running`;
    case "pid_namespace_differs":
      return `the lock was taken in another PID namespace (${holder?.pid_ns ?? "?"}; this process is in ${probe.pidNamespace() ?? "?"}), where JUNO cannot see whether its owner still runs`;
    case "pid_namespace_unknown":
      return `the PID namespace ${holder?.pid_ns === null ? "the lock was taken in was not recorded" : "this process runs in cannot be read"}, so JUNO cannot tell whether process ${pid} is its owner`;
    case "other_host":
      return "the lock was taken on another machine";
    case "host_unknown":
      return "this machine's identity, or the lock's, is not known";
    case "boot_unknown":
      return "whether this machine has restarted since the lock was taken is not known";
    case "lock_unreadable":
      return "the lock cannot be read";
    case "takeover_in_progress":
      return "another JUNO process is clearing this lock, or one crashed while doing so (its take-over file is there)";
    case "lock_changed":
      return "the lock changed while it was being taken over: another JUNO process took it";
    case "lock_taken":
      return "another JUNO process took the lock while this one was taking it over";
    default:
      return "JUNO cannot tell whether the process that took the lock still runs";
  }
}

export type ClearedLock = { readonly holder: LockRecord; readonly reason: StaleReason };
export type RunnerLock = { readonly path: string; readonly cleared: ClearedLock | null; release(): void };

export type LockOptions = {
  /** The journal's path as the operator knows it, for messages; `root` may be a handle (`/proc/self/fd/<n>`, D-213). */
  readonly shown?: string;
  /** false: a lock whose owner is provably dead is not cleared, and refuses with reason `owner_dead` (D-243). */
  readonly reclaim?: boolean;
};

/** Why the lock refused, for a caller that answers each case in its own words (D-243). */
export class RunnerLockRefused extends RunnerLockError {
  constructor(
    message: string,
    readonly reason: string,
    readonly lockPath: string,
  ) {
    super(message);
  }
}

const isCode = (error: unknown, code: string): boolean => error instanceof Error && "code" in error && error.code === code;

export function acquireRunnerLock(root: AbsolutePath, clock: () => Date = () => new Date(), probe: HostProbe = systemProbe, options: LockOptions = {}): RunnerLock {
  const path = join(root, LOCK_FILE);
  // Every name a message gives is built by the one shared helper from the journal folder the code opened: as given, and
  // never the handle this process holds it by (D-243, D-247).
  const journal = options.shown ?? root;
  const shown = lockFileOf(journal);
  const shownTakeover = takeoverFileOf(journal);
  const record: LockRecord = {
    pid: probe.pid,
    host: probe.hostId(),
    boot: probe.bootId(),
    pid_ns: probe.pidNamespace(),
    pid_start: probe.startTime(probe.pid),
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
    let parsed: LockRecord | null;
    try {
      const read = LockRecord.safeParse(JSON.parse(holder));
      parsed = read.success ? read.data : null;
    } catch {
      parsed = null;
    }
    const why = reason === "owner_dead" ? "the process that took the lock is no longer running" : explain(reason, parsed, probe);
    const proven = reason === "owner_running" && parsed !== null && parsed.pid_start !== undefined && parsed.pid_start !== null;
    // The user to act as: the owner of the files to remove (the lock's, else the journal folder's), by name (D-247).
    const owner = ownerName(path) ?? ownerName(root);
    const remedy =
      reason === "owner_dead"
        ? "a start of JUNO's service takes such a lock over, records it in the journal and checks the journal"
        : proven
          ? `stop that JUNO process first (the hook service: ${commandText(serviceCommand("stop"))}, as ${owner ?? "the user that runs it"}; the gateway: Ctrl+C in its terminal; a checkpoint restore: let it finish)`
          : reason === "takeover_in_progress"
            ? removeIfNoJunoRuns([shownTakeover, shown], owner)
            : removeIfNoJunoRuns([shown], owner);
    throw new RunnerLockRefused(`the journal's lock ${shown} is held (${reason}): ${why}; one JUNO process writes a journal at a time; ${remedy}. The lock: ${holder}`, reason, shown);
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
    if (options.reclaim === false) return refuse(holder, "owner_dead");
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
    // Named by reason; the message names the file by its real path, never the handle this process holds it by (D-243).
    if (isCode(error, "EEXIST")) return refuse(holder, "takeover_in_progress");
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
