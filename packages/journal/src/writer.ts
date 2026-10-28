import { statSync } from "node:fs";
import {
  type AbsolutePath,
  type ContentHash,
  TrajectoryEntry,
  parseAtBoundary,
} from "../../contracts/src/index.js";
import { putBlob } from "./blobs.js";
import { contentAddress } from "./canonical.js";
import { type ChainFailure, type ChainHead, encodeEntry, encodeHead, entryHash, verifyChain } from "./chain.js";
import { appendDurably, ensureDir, isNotFound, readOptional, replaceDurably } from "./files.js";
import { blobsDir, entriesFile, headFile, journalRoot, taskDir, tasksDir } from "./layout.js";

/**
 * The journal writer (spec §3.4.1–3.4.2). It lives in the runner, the
 * enforcement boundary, and writes to the journal volume, which no workload
 * container mounts. It can only append: there is no update or delete.
 *
 * The writer assigns everything that makes the chain: `seq`, `task_id`,
 * `payload_ref`, `hash_prev` and `timestamp`. The caller supplies the rest of
 * the entry and the payload bytes, and the whole entry is checked against the
 * TrajectoryEntry contract before anything is written.
 */

/** The part of an entry the caller supplies. */
export type EntryDraft = Omit<TrajectoryEntry, "seq" | "task_id" | "payload_ref" | "hash_prev" | "timestamp">;

export type JournalWriterOptions = {
  /** The clock that stamps `timestamp`. Defaults to the system clock. */
  readonly clock?: () => Date;
};

/** Raised when a task's stored chain fails verification. Nothing is appended to a broken chain. */
export class JournalIntegrityError extends Error {
  readonly taskId: string;
  readonly failure: ChainFailure;

  constructor(taskId: string, failure: ChainFailure) {
    super(`journal for task ${JSON.stringify(taskId)} failed verification: ${failure.code} at line ${String(failure.line)} (${failure.message})`);
    this.name = "JournalIntegrityError";
    this.taskId = taskId;
    this.failure = failure;
  }
}

/** What the writer last left on disk for a task, so it can tell whether anything else changed it. */
type TaskState = {
  readonly head: ChainHead | null;
  readonly entriesSize: number;
  readonly headText: string | null;
};

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return 0;
    }
    throw error;
  }
}

export class JournalWriter {
  readonly root: AbsolutePath;
  private readonly clock: () => Date;
  private readonly tasks = new Map<string, TaskState>();

  private constructor(root: AbsolutePath, clock: () => Date) {
    this.root = root;
    this.clock = clock;
  }

  /** Opens (and if needed creates) a journal at `root`, which must lie outside the capability namespace. */
  static open(root: unknown, options: JournalWriterOptions = {}): JournalWriter {
    const checked = journalRoot(root);
    ensureDir(checked);
    ensureDir(tasksDir(checked));
    ensureDir(blobsDir(checked));
    return new JournalWriter(checked, options.clock ?? (() => new Date()));
  }

  /** Appends one entry to a task's trajectory and returns it as written. */
  append(taskId: string, draft: EntryDraft, payload: Uint8Array): TrajectoryEntry {
    const state = this.current(taskId);
    const payloadRef: ContentHash = contentAddress(payload);
    const entry = parseAtBoundary("journal append", TrajectoryEntry, {
      ...draft,
      seq: state.head === null ? 0 : state.head.seq + 1,
      task_id: taskId,
      payload_ref: payloadRef,
      hash_prev: state.head?.hash ?? null,
      timestamp: this.clock().toISOString(),
    });

    // The blob first, so no entry ever names a payload that was not stored.
    putBlob(this.root, payload);
    ensureDir(taskDir(this.root, taskId));
    const line = encodeEntry(entry);
    appendDurably(entriesFile(this.root, taskId), line);
    const head: ChainHead = { task_id: taskId, seq: entry.seq, hash: entryHash(entry) };
    const headText = encodeHead(head);
    replaceDurably(headFile(this.root, taskId), headText);

    this.tasks.set(taskId, { head, entriesSize: state.entriesSize + Buffer.byteLength(line, "utf8"), headText });
    return entry;
  }

  /**
   * The task's verified state. The stored chain is verified in full the first
   * time, and again whenever the files differ from what this writer last left.
   */
  private current(taskId: string): TaskState {
    const cached = this.tasks.get(taskId);
    const headText = readOptional(headFile(this.root, taskId))?.toString("utf8") ?? null;
    const entriesSize = fileSize(entriesFile(this.root, taskId));
    if (cached !== undefined && cached.headText === headText && cached.entriesSize === entriesSize) {
      return cached;
    }
    const entriesText = readOptional(entriesFile(this.root, taskId))?.toString("utf8") ?? "";
    const verdict = verifyChain(taskId, entriesText, headText);
    if (!verdict.ok) {
      throw new JournalIntegrityError(taskId, verdict.failure);
    }
    const state: TaskState = { head: verdict.head, entriesSize: Buffer.byteLength(entriesText, "utf8"), headText };
    this.tasks.set(taskId, state);
    return state;
  }
}
