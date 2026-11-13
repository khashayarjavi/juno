import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, ftruncateSync, openSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { TrajectoryEntry } from "../../contracts/src/index.js";
import { canonicalJson } from "./canonical.js";
import { type ChainVerdict, verifyChain } from "./chain.js";
import { readOptional, removeDurably, replaceDurably } from "./files.js";
import { journalRoot, tasksDir } from "./layout.js";

/**
 * A torn final write (operator ruling D-206 item 1; DECISIONS.md D-207).
 *
 * The writer appends an entry in two durable steps: the entry's line onto `entries.jsonl`, then the head record
 * (writer.ts). A power loss can stop it at two points, and only at the end of one record:
 *   - `partial_line`: the last line was cut short (no closing newline); the head still names the entry before it;
 *   - `unheaded_entry`: the last line is complete and continues the chain, but the head record was never replaced: it
 *     still names the entry before it (or does not exist, for a record's first entry).
 * In both, everything before the last line must verify against the head record exactly as it stands (§3.4.2). Nothing
 * else is a torn write: a head that names any other entry, a last line that does not continue the chain, a break
 * anywhere earlier, are verification failures and stay so.
 *
 * `tornTail` only reads. `dropTornTail` cuts the file back to the kept length, and is called only after everything kept
 * has also been compared with the off-host anchors (session-layer.ts).
 */

export type TornTail = {
  /** The record's folder name (the digest of its id). */
  readonly digest: string;
  /** The record's id, read from the entries kept or the head; null when nothing complete was ever written in it. */
  readonly taskId: string | null;
  readonly how: "partial_line" | "unheaded_entry";
  /** The verified chain of what is kept. */
  readonly kept: ChainVerdict & { readonly ok: true };
  /** Bytes of `entries.jsonl` that are kept. */
  readonly keptBytes: number;
  readonly droppedBytes: number;
  /** SHA-256 of the dropped bytes, so the record of the recovery names exactly what was removed. */
  readonly droppedSha256: string;
};

function idOf(line: string): string | null {
  try {
    const value: unknown = JSON.parse(line);
    const id = typeof value === "object" && value !== null ? (value as { task_id?: unknown }).task_id : undefined;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/** Whether the record stored under `digest` ends in a torn final write, and what would be kept. Null when it does not. */
export function tornTail(root: unknown, digest: string): TornTail | null {
  const dir = join(tasksDir(journalRoot(root)), digest);
  const entries = readOptional(join(dir, "entries.jsonl"));
  const headText = readOptional(join(dir, "head.json"))?.toString("utf8") ?? null;
  if (entries === null || entries.length === 0) return null;
  const text = entries.toString("utf8");
  // The stored bytes must be the text read: a tail that is not UTF-8 is cut at the byte where the last whole line ends.
  const lastNewline = entries.lastIndexOf(0x0a);
  const partial = entries[entries.length - 1] !== 0x0a;
  let keptBytes: number;
  if (partial) keptBytes = lastNewline + 1;
  else {
    const before = entries.lastIndexOf(0x0a, entries.length - 2);
    keptBytes = before + 1;
  }
  const keptText = entries.subarray(0, keptBytes).toString("utf8");
  if (Buffer.byteLength(keptText, "utf8") !== keptBytes) return null;
  const dropped = entries.subarray(keptBytes);
  let taskId = idOf(keptText.split("\n", 1)[0] ?? "") ?? (headText === null ? null : idOf(headText));
  // What is kept must verify against the head record exactly as it stands.
  let kept: ChainVerdict;
  if (taskId === null) kept = keptText === "" && headText === null ? { ok: true, entries: [], head: null } : { ok: false, failure: { code: "malformed_entry", line: 1, message: "no id" } };
  else kept = verifyChain(taskId, keptText, headText);
  if (!kept.ok) return null;
  if (taskId !== null && createHash("sha256").update(taskId, "utf8").digest("hex") !== digest) return null;
  if (!partial) {
    // A complete last line is a torn write only if it is the entry the writer would have appended next: canonical, of
    // this record, with the next seq, linked to the kept head.
    const line = dropped.subarray(0, dropped.length - 1).toString("utf8");
    let value: unknown;
    try {
      value = JSON.parse(line);
      if (canonicalJson(value) !== line) return null;
    } catch {
      return null;
    }
    const entry = TrajectoryEntry.safeParse(value);
    if (!entry.success) return null;
    if (taskId !== null && entry.data.task_id !== taskId) return null;
    if (createHash("sha256").update(entry.data.task_id, "utf8").digest("hex") !== digest) return null;
    if (entry.data.seq !== kept.entries.length || entry.data.hash_prev !== (kept.head?.hash ?? null)) return null;
    // With the head record already naming this entry the record would verify; this is reached only when it does not.
    if (verifyChain(entry.data.task_id, text, headText).ok) return null;
    taskId = entry.data.task_id;
  }
  return { digest, taskId, how: partial ? "partial_line" : "unheaded_entry", kept, keptBytes, droppedBytes: dropped.length, droppedSha256: createHash("sha256").update(dropped).digest("hex") };
}

/**
 * Cuts a record's entries back to what `torn` keeps, durably, and removes a head record's leftover temporary file. The
 * file must still be what `tornTail` read (the same size); otherwise nothing is changed and it throws.
 */
export function dropTornTail(root: unknown, torn: TornTail): void {
  const dir = join(tasksDir(journalRoot(root)), torn.digest);
  const path = join(dir, "entries.jsonl");
  const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const again = tornTail(root, torn.digest);
    if (again === null || again.keptBytes !== torn.keptBytes || again.droppedSha256 !== torn.droppedSha256) throw new Error("the record changed since it was read; nothing was dropped");
    ftruncateSync(fd, torn.keptBytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  for (const name of readdirSync(dir)) if (/^head\.json\.[0-9]+\.tmp$/.test(name)) rmSync(join(dir, name));
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/**
 * The repair's own record (operator ruling D-211 item 1; review round 7 finding F4; DECISIONS.md D-213).
 *
 * A repair is several file operations, and the power can be lost between any two of them. So before the incomplete
 * entry is removed, what the repair is about to do and every grant it exhausts is written to one file in the journal's
 * folder, `recovery-pending.json`, in one durable step (a temporary file, flushed, renamed over the name, the folder
 * flushed). Only then is the entry cut off; then the journal's `recovered_truncation` notes are written; and only when
 * those are durable is the file removed. Whenever the power is lost, the next start finds either the file or the notes
 * (or both), so the grants stay exhausted, and it finishes whatever of the repair is missing.
 */
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const PendingRepair = z.strictObject({
  /** The record that lost its incomplete entry, or null when nothing complete was ever written in it. */
  record: z.string().min(1).nullable(),
  record_digest: Sha256Hex,
  how: z.enum(["partial_line", "unheaded_entry"]),
  kept_entries: z.number().int().min(0),
  kept_bytes: z.number().int().min(0),
  dropped_bytes: z.number().int().min(1),
  dropped_sha256: Sha256Hex,
  open_sessions: z.array(z.string().min(1)),
  exhausted_grants: z.array(z.string().min(1)),
});
export type PendingRepair = z.infer<typeof PendingRepair>;

const PendingFile = z.strictObject({ type: z.literal("recovery_pending"), repairs: z.array(PendingRepair).min(1) });

const PENDING_FILE = "recovery-pending.json";

/** The repairs a start began and has not finished recording; empty when there is no such file. Throws when the file is not one JUNO wrote. */
export function readPendingRepairs(root: unknown): PendingRepair[] {
  const bytes = readOptional(join(journalRoot(root), PENDING_FILE));
  if (bytes === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${PENDING_FILE} in the journal folder is not JSON`);
  }
  const parsed = PendingFile.safeParse(raw);
  if (!parsed.success) throw new Error(`${PENDING_FILE} in the journal folder is not a record of a repair JUNO writes`);
  return parsed.data.repairs;
}

/** Writes the repairs, durably, in one step: after it returns they survive a power loss; before, the old file (or none) does. */
export function writePendingRepairs(root: unknown, repairs: readonly PendingRepair[]): void {
  replaceDurably(join(journalRoot(root), PENDING_FILE), canonicalJson(PendingFile.parse({ type: "recovery_pending", repairs })));
}

/** Removes the file, durably, once every repair it names is recorded in the journal itself. */
export function clearPendingRepairs(root: unknown): void {
  const dir = journalRoot(root);
  for (const name of readdirSync(dir)) if (name.startsWith(`${PENDING_FILE}.`) && name.endsWith(".tmp")) rmSync(join(dir, name), { force: true });
  removeDurably(join(dir, PENDING_FILE));
}
