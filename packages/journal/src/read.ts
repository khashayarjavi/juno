import { ContentHash, type TrajectoryEntry, parseAtBoundary } from "../../contracts/src/index.js";
import { type BlobRead, getBlob } from "./blobs.js";
import { type ChainVerdict, verifyChain } from "./chain.js";
import { readOptional } from "./files.js";
import { entriesFile, headFile, journalRoot } from "./layout.js";
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
