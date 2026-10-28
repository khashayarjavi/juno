import { z } from "zod";
import { ContentHash, Count, Ref, TrajectoryEntry } from "../../contracts/src/index.js";
import { canonicalJson, contentAddress } from "./canonical.js";

/**
 * The hash chain (spec §3.4.2), as pure functions over the stored text.
 *
 * Each entry is stored as one line of canonical JSON. An entry's hash is the
 * content address of that line, and the next entry's `hash_prev` is that
 * hash. The entry carries `payload_ref`, the payload's digest, never the
 * payload's bytes, so the chain commits to each payload through its digest
 * and a deleted blob leaves the chain verifiable (DECISIONS.md D-025).
 *
 * A chain alone cannot show that entries were cut off its end: the shorter
 * chain is still well linked. So the writer also keeps a head record naming
 * the last entry's `seq` and hash, and verification requires the chain to end
 * exactly there (DECISIONS.md D-027).
 */

/** The last entry of a task's chain, recorded apart from the entries. */
export const ChainHead = z.strictObject({
  task_id: Ref,
  seq: Count,
  hash: ContentHash,
});
export type ChainHead = z.infer<typeof ChainHead>;

export const CHAIN_FAILURE_CODES = [
  /** The entries text does not end with a newline: the last line was cut short. */
  "incomplete_entry",
  /** A line is not JSON, or not a valid trajectory entry. */
  "malformed_entry",
  /** A line parses but is not in canonical form, so it was not written by the journal. */
  "non_canonical_entry",
  /** An entry belongs to a different task. */
  "wrong_task",
  /** An entry's `seq` is not the next number: an entry was removed, inserted or moved. */
  "sequence_break",
  /** An entry's `hash_prev` does not match the hash of the entry before it. */
  "broken_link",
  /** Entries exist but no head record does. */
  "head_missing",
  /** A head record exists but no entries do. */
  "unexpected_head",
  /** The head record is not valid. */
  "head_malformed",
  /** The chain does not end at the head: entries were cut off the end, added, or the last entry changed. */
  "head_mismatch",
] as const;
export type ChainFailureCode = (typeof CHAIN_FAILURE_CODES)[number];

export type ChainFailure = {
  readonly code: ChainFailureCode;
  /** 1-based line of the entries text where the failure was found; 0 for a head failure. */
  readonly line: number;
  readonly message: string;
};

export type ChainVerdict =
  | { readonly ok: true; readonly entries: readonly TrajectoryEntry[]; readonly head: ChainHead | null }
  | { readonly ok: false; readonly failure: ChainFailure };

/** The hash of an entry: the content address of its canonical encoding. */
export function entryHash(entry: TrajectoryEntry): ContentHash {
  return contentAddress(canonicalJson(entry));
}

/** The stored form of an entry: its canonical encoding plus a newline. */
export function encodeEntry(entry: TrajectoryEntry): string {
  return `${canonicalJson(entry)}\n`;
}

/** The stored form of a head record. */
export function encodeHead(head: ChainHead): string {
  return `${canonicalJson(head)}\n`;
}

function fail(code: ChainFailureCode, line: number, message: string): ChainVerdict {
  return { ok: false, failure: { code, line, message } };
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Walks a task's chain and checks every link (§3.4.2). Any mutation,
 * truncation or reordering of the entries, and any change to the head record,
 * makes the verdict a failure naming where it was found.
 *
 * `entriesText` is the stored entries ("" when there are none). `headText` is
 * the stored head record, or `null` when there is none. A task with neither
 * has an empty trajectory.
 */
export function verifyChain(taskId: string, entriesText: string, headText: string | null): ChainVerdict {
  if (entriesText !== "" && !entriesText.endsWith("\n")) {
    return fail("incomplete_entry", entriesText.split("\n").length, "the last entry is cut short (no closing newline)");
  }
  const lines = entriesText === "" ? [] : entriesText.slice(0, -1).split("\n");
  const entries: TrajectoryEntry[] = [];
  let previousHash: ContentHash | null = null;

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const json = parseJson(line);
    if (!json.ok) {
      return fail("malformed_entry", lineNumber, "the line is not JSON");
    }
    let canonical: string;
    try {
      canonical = canonicalJson(json.value);
    } catch {
      return fail("malformed_entry", lineNumber, "the line holds a value with no canonical encoding");
    }
    if (canonical !== line) {
      return fail("non_canonical_entry", lineNumber, "the line is not in canonical form");
    }
    const parsed = TrajectoryEntry.safeParse(json.value);
    if (!parsed.success) {
      return fail("malformed_entry", lineNumber, `not a valid trajectory entry: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    }
    const entry = parsed.data;
    if (entry.task_id !== taskId) {
      return fail("wrong_task", lineNumber, `the entry belongs to task ${JSON.stringify(entry.task_id)}, not ${JSON.stringify(taskId)}`);
    }
    if (entry.seq !== index) {
      return fail("sequence_break", lineNumber, `expected seq ${String(index)}, found ${String(entry.seq)}`);
    }
    if (entry.hash_prev !== previousHash) {
      return fail(
        "broken_link",
        lineNumber,
        previousHash === null ? "the first entry must have hash_prev null" : `hash_prev does not match the hash of entry ${String(index - 1)}`,
      );
    }
    previousHash = contentAddress(line);
    entries.push(entry);
  }

  const last = entries.at(-1);
  if (headText === null) {
    return last === undefined ? { ok: true, entries, head: null } : fail("head_missing", 0, "entries exist but the head record is missing");
  }
  if (last === undefined) {
    return fail("unexpected_head", 0, "a head record exists but there are no entries");
  }
  const headJson = headText.endsWith("\n") ? parseJson(headText.slice(0, -1)) : { ok: false as const };
  const head = headJson.ok ? ChainHead.safeParse(headJson.value) : undefined;
  if (head?.success !== true || encodeHead(head.data) !== headText) {
    return fail("head_malformed", 0, "the head record is not a valid canonical head");
  }
  if (head.data.task_id !== taskId || head.data.seq !== last.seq || head.data.hash !== previousHash) {
    return fail(
      "head_mismatch",
      0,
      `the chain ends at seq ${String(last.seq)} but the head names seq ${String(head.data.seq)}; entries were removed, added or changed`,
    );
  }
  return { ok: true, entries, head: head.data };
}
