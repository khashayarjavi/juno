import { createHash } from "node:crypto";
import { join } from "node:path";
import { AbsolutePath, type ContentHash, WORK_NAMESPACE, parseAtBoundary, pathsOverlap } from "../../contracts/src/index.js";

/**
 * Where the journal keeps things on disk (DECISIONS.md D-027):
 *
 *   <root>/tasks/<sha256 of task id>/entries.jsonl   one canonical entry per line
 *   <root>/tasks/<sha256 of task id>/head.json       the last entry's seq and hash
 *   <root>/blobs/sha256/<2 hex>/<62 hex>             payload bytes, by content address
 *
 * A task id may contain `/` or `..`, so it never becomes a file name itself;
 * its digest does.
 */

/**
 * A journal root, checked: absolute, normalised, and outside the capability
 * namespace. A path selector can name only `WORK_NAMESPACE` and what is under
 * it, so a root that overlaps it in neither direction can never be named by
 * any selector (§3.2, §3.4.1). A root inside the namespace is refused here,
 * so the journal cannot be opened in addressable storage by any caller.
 */
export function journalRoot(root: unknown): AbsolutePath {
  const path = parseAtBoundary("journal root", AbsolutePath, root);
  if (pathsOverlap(path, WORK_NAMESPACE)) {
    throw new JournalLocationError(path);
  }
  return path;
}

export class JournalLocationError extends Error {
  readonly root: string;

  constructor(root: string) {
    super(
      `journal root ${JSON.stringify(root)} overlaps the capability namespace ${WORK_NAMESPACE}; ` +
        "journal storage must lie outside every name a selector can reach (spec §3.4.1)",
    );
    this.name = "JournalLocationError";
    this.root = root;
  }
}

export function tasksDir(root: AbsolutePath): string {
  return join(root, "tasks");
}

export function taskDir(root: AbsolutePath, taskId: string): string {
  return join(tasksDir(root), createHash("sha256").update(taskId, "utf8").digest("hex"));
}

export function entriesFile(root: AbsolutePath, taskId: string): string {
  return join(taskDir(root, taskId), "entries.jsonl");
}

export function headFile(root: AbsolutePath, taskId: string): string {
  return join(taskDir(root, taskId), "head.json");
}

export function blobsDir(root: AbsolutePath): string {
  return join(root, "blobs", "sha256");
}

export function blobFile(root: AbsolutePath, ref: ContentHash): string {
  const hex = ref.slice("sha256:".length);
  return join(blobsDir(root), hex.slice(0, 2), hex.slice(2));
}
