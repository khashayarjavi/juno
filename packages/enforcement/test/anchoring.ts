import { generateKeyPairSync } from "node:crypto";
import { type Anchor, anchorPath } from "../../journal/src/index.js";
import { AnchorExistsError, type AnchorSink, type JournalKey } from "../../journal/src/index.js";
import type { Anchoring } from "../src/index.js";

/**
 * Test-only (§3.4.1, D-122): an append-only destination in memory, with the same rule as every real one: an anchor at
 * a task and seq already stored is refused, never replaced. It protects nothing; the container stand-in and the real
 * repository are where the protection is tested.
 */
export class MemoryAnchorSink implements AnchorSink {
  readonly stored = new Map<string, Anchor>();
  /** When set, every append fails with this message (a destination that cannot be reached). */
  unreachable: string | null = null;

  append(anchor: Anchor): Promise<void> {
    if (this.unreachable !== null) return Promise.reject(new Error(this.unreachable));
    const path = anchorPath(anchor.task, anchor.seq);
    if (this.stored.has(path)) return Promise.reject(new AnchorExistsError("an anchor at this seq already exists"));
    this.stored.set(path, { ...anchor });
    return Promise.resolve();
  }

  list(task: string): Promise<unknown[]> {
    if (this.unreachable !== null) return Promise.reject(new Error(this.unreachable));
    return Promise.resolve([...this.stored.entries()].filter(([path]) => path.startsWith(`${task}/`)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, anchor]) => ({ ...anchor })));
  }

  async listMany(tasks: readonly string[]): Promise<Map<string, unknown[]>> {
    const listed = new Map<string, unknown[]>();
    for (const task of tasks) listed.set(task, await this.list(task));
    return listed;
  }
}

/** A journal key generated in memory for one test file; never written to disk (D-093, D-122). */
export function testJournalKey(): JournalKey {
  const pair = generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

/** Anchoring for a test runner: an in-memory sink, a fresh journal key, and a long interval unless one is given. */
export function testAnchoring(options: { readonly sink?: AnchorSink; readonly journalKey?: JournalKey; readonly intervalMs?: number } = {}): Anchoring {
  return { sink: options.sink ?? new MemoryAnchorSink(), journalKey: options.journalKey ?? testJournalKey(), intervalMs: options.intervalMs ?? 3_600_000 };
}
