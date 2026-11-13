import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ContentHash, type TrajectoryEntry, parseAtBoundary } from "../../contracts/src/index.js";
import { taskDigest } from "./anchor.js";
import { type BlobRead, getBlob } from "./blobs.js";
import { type ChainVerdict, verifyChain } from "./chain.js";
import { isNotFound, readOptional } from "./files.js";
import { entriesFile, headFile, journalRoot, tasksDir } from "./layout.js";
import { JournalIntegrityError } from "./writer.js";

/**
 * The journal read interface (spec §3.4.1). These are plain functions. They
 * are not a Capability, they have no capability id, and no Grant can name
 * them, so no task-held authority reaches them. Who may call them is a
 * property of the principal and the Surface (§3.6), which arrive with the
 * console after Slice 1; in Slice 1 only the runner calls them.
 */

/** Verifies a task's stored chain without throwing. */
export function verifyTrajectory(root: unknown, taskId: string): ChainVerdict {
  const checked = journalRoot(root);
  const headText = readOptional(headFile(checked, taskId))?.toString("utf8") ?? null;
  const entriesText = readOptional(entriesFile(checked, taskId))?.toString("utf8") ?? "";
  return verifyChain(taskId, entriesText, headText);
}

/**
 * A task's trajectory, in `seq` order, readable while the task runs. Entries
 * are returned only when the whole chain verifies; otherwise this throws
 * JournalIntegrityError, so a reader never sees an unverified record.
 */
export function readTrajectory(root: unknown, taskId: string): readonly TrajectoryEntry[] {
  const verdict = verifyTrajectory(root, taskId);
  if (!verdict.ok) {
    throw new JournalIntegrityError(taskId, verdict.failure);
  }
  return verdict.entries;
}

/** An entry's payload, by its `payload_ref`. Bytes are returned only when they still match the address. */
export function readPayload(root: unknown, ref: unknown): BlobRead {
  return getBlob(journalRoot(root), parseAtBoundary("payload ref", ContentHash, ref));
}

/** One record as the journal stores it: its folder's name (the digest of its id), its id, and its chain's verdict. */
export type StoredRecord = {
  readonly digest: string;
  /** The record's id, read from its own entries; null when the folder holds nothing, or nothing that names an id whose digest is the folder's name. */
  readonly taskId: string | null;
  readonly verdict: ChainVerdict;
};

function namedTask(text: string | null): string | null {
  if (text === null || text === "") return null;
  try {
    const first: unknown = JSON.parse(text.split("\n", 1)[0] ?? "");
    const id = typeof first === "object" && first !== null ? (first as { task_id?: unknown }).task_id : undefined;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/**
 * Every record the journal stores, each with its chain verified (§3.4.2; DECISIONS.md D-202). A record's folder is named
 * by the digest of its id, so the id is read from the record itself and must hash to the folder's name; a folder whose
 * content names another id, or none, is reported as a failed chain. An empty folder (a record never written) is
 * reported with no id and an empty chain. Nothing is thrown for a broken record: the caller decides.
 */
export function listRecords(root: unknown): StoredRecord[] {
  const checked = journalRoot(root);
  let names: string[];
  try {
    names = readdirSync(tasksDir(checked)).sort();
  } catch (error: unknown) {
    if (isNotFound(error)) return [];
    throw error;
  }
  return names.map((digest): StoredRecord => {
    const dir = join(tasksDir(checked), digest);
    const entriesText = readOptional(join(dir, "entries.jsonl"))?.toString("utf8") ?? "";
    const headText = readOptional(join(dir, "head.json"))?.toString("utf8") ?? null;
    if (entriesText === "" && headText === null) return { digest, taskId: null, verdict: { ok: true, entries: [], head: null } };
    const taskId = namedTask(entriesText) ?? namedTask(headText);
    if (taskId === null || taskDigest(taskId) !== digest) {
      return { digest, taskId: null, verdict: { ok: false, failure: { code: "wrong_task", line: 1, message: "the record's folder is not named by the digest of the id its entries carry" } } };
    }
    return { digest, taskId, verdict: verifyChain(taskId, entriesText, headText) };
  });
}
