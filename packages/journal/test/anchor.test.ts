import { generateKeyPairSync } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Anchor,
  AnchorExistsError,
  type AnchorSink,
  type EntryDraft,
  JournalWriter,
  anchorOf,
  anchorPath,
  checkAnchors,
  taskDigest,
  verifyTrajectory,
} from "../src/index.js";
import { entriesFile, headFile, journalRoot } from "../src/layout.js";

/**
 * §3.4.1 anchored head (v0.6 C1, v0.6.1 V6-4; D-122): the chain alone cannot see a wholesale rewrite with every hash
 * recomputed; an anchor copied off the host can.
 */

const TASK = "task-anchor";
const journalKey = generateKeyPairSync("ed25519");
const at = new Date("2026-11-04T10:00:00Z");

const note = (): EntryDraft => ({
  kind: "note",
  actor: "runner",
  provider: null,
  data_class: { sensitivity: "internal", integrity: "operator" },
  cost: { tokens_in: 0, tokens_out: 0, tokens_cached: 0, currency: 0, duration_ms: 0 },
});
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "juno-anchor-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes a task journal whose payloads are `texts`, in a fresh root; returns the root. */
function journalOf(name: string, texts: readonly string[]): string {
  const writer = JournalWriter.open(join(dir, name), { clock: () => at });
  for (const text of texts) writer.append(TASK, note(), bytes(text));
  return writer.root;
}

/** The anchor of the task's head in `root` as it stands now. */
function anchorNow(root: string, key = journalKey.privateKey): Anchor {
  const verdict = verifyTrajectory(root, TASK);
  if (!verdict.ok || verdict.head === null) throw new Error("no head");
  return anchorOf(TASK, verdict.head, at, key);
}

/** Replaces `root`'s task journal with another chain, every hash recomputed: what an attacker with storage access can do. */
function rewriteWith(root: string, texts: readonly string[]): void {
  const forged = journalOf("forged", texts);
  copyFileSync(entriesFile(journalRoot(forged), TASK), entriesFile(journalRoot(root), TASK));
  copyFileSync(headFile(journalRoot(forged), TASK), headFile(journalRoot(root), TASK));
}

describe("§3.4.1 C1: the anchored head", () => {
  // proves §3.4.1: a rewrite with every later hash recomputed passes the chain check but fails the anchor check
  it("catches a rewrite that the chain check alone passes", () => {
    const root = journalOf("journal", ["a", "b", "c", "d"]);
    const anchors = [anchorNow(root)];
    rewriteWith(root, ["a", "B", "c", "d"]);
    const chain = verifyTrajectory(root, TASK);
    expect(chain.ok).toBe(true);
    expect(checkAnchors(TASK, chain, anchors, journalKey.publicKey)).toEqual({
      ok: false,
      failure: { code: "rewritten", anchor_seq: 3, after_seq: -1, first_changed_at_or_before: 3 },
    });
  });

  // proves §3.4.1: with several anchors the report narrows the first changed entry to between two anchors
  it("names the range in which the first changed entry lies", () => {
    const writer = JournalWriter.open(join(dir, "journal"), { clock: () => at });
    const anchors: Anchor[] = [];
    for (const text of ["a", "b", "c", "d", "e", "f"]) {
      writer.append(TASK, note(), bytes(text));
      if (text === "b" || text === "d" || text === "f") anchors.push(anchorNow(writer.root));
    }
    rewriteWith(writer.root, ["a", "b", "c", "D", "e", "f"]);
    expect(checkAnchors(TASK, verifyTrajectory(writer.root, TASK), anchors, journalKey.publicKey)).toMatchObject({
      ok: false,
      failure: { code: "rewritten", anchor_seq: 3, after_seq: 1, first_changed_at_or_before: 3 },
    });
  });

  // proves §3.4.1: an entry appended after the anchor is not reported as a rewrite
  it("does not report entries appended after the latest anchor", () => {
    const writer = JournalWriter.open(join(dir, "journal"), { clock: () => at });
    for (const text of ["a", "b"]) writer.append(TASK, note(), bytes(text));
    const anchors = [anchorNow(writer.root)];
    writer.append(TASK, note(), bytes("c"));
    writer.append(TASK, note(), bytes("d"));
    expect(checkAnchors(TASK, verifyTrajectory(writer.root, TASK), anchors, journalKey.publicKey)).toEqual({ ok: true, anchored_seq: 1, unanchored: 2, anchors: 1 });
  });

  // proves §3.4.1: removing entries at or before the anchored head is reported
  it("reports a chain cut short of an anchor", () => {
    const root = journalOf("journal", ["a", "b", "c"]);
    const anchors = [anchorNow(root)];
    rewriteWith(root, ["a", "b"]);
    expect(checkAnchors(TASK, verifyTrajectory(root, TASK), anchors, journalKey.publicKey)).toMatchObject({ ok: false, failure: { code: "truncated", anchor_seq: 2, chain_length: 2 } });
  });

  // proves §3.4.1 V6-4: an anchor signed with a stolen journal key cannot hide the earlier anchor the rewrite contradicts
  it("still reports the rewrite when a new anchor is signed with the stolen journal key", () => {
    const root = journalOf("journal", ["a", "b", "c"]);
    const earlier = anchorNow(root);
    rewriteWith(root, ["a", "B", "c", "d"]);
    const forged = anchorNow(root); // the attacker holds the journal key and signs the forged head (seq 3)
    expect(checkAnchors(TASK, verifyTrajectory(root, TASK), [earlier, forged], journalKey.publicKey)).toMatchObject({ ok: false, failure: { code: "rewritten", anchor_seq: 2 } });
  });

  // proves §3.4.1 V6-4: the destination never replaces an anchor, so a stolen key cannot overwrite the earlier one
  it("refuses, at an append-only destination, an anchor that would replace an earlier one", async () => {
    const stored = new Map<string, Anchor>();
    const sink: Pick<AnchorSink, "append"> = {
      append: (anchor) => {
        const path = anchorPath(anchor.task, anchor.seq);
        if (stored.has(path)) return Promise.reject(new AnchorExistsError("exists"));
        stored.set(path, anchor);
        return Promise.resolve();
      },
    };
    const root = journalOf("journal", ["a", "b", "c"]);
    const earlier = anchorNow(root);
    await sink.append(earlier);
    rewriteWith(root, ["a", "B", "c"]);
    await expect(sink.append(anchorNow(root))).rejects.toBeInstanceOf(AnchorExistsError);
    expect(stored.get(anchorPath(earlier.task, earlier.seq))).toEqual(earlier);
  });

  // proves §3.4.1: an anchor that does not verify against the journal key, or names another task, fails the check
  it("refuses an anchor signed by another key, or for another task", () => {
    const root = journalOf("journal", ["a"]);
    const chain = verifyTrajectory(root, TASK);
    const other = generateKeyPairSync("ed25519");
    expect(checkAnchors(TASK, chain, [anchorNow(root, other.privateKey)], journalKey.publicKey)).toMatchObject({ ok: false, failure: { code: "anchor_invalid", anchor: 0 } });
    const elsewhere = { ...anchorNow(root), task: taskDigest("another-task") };
    expect(checkAnchors(TASK, chain, [elsewhere], journalKey.publicKey)).toMatchObject({ ok: false, failure: { code: "anchor_invalid", reason: "the anchor names another task" } });
    expect(checkAnchors(TASK, chain, [{ ...anchorNow(root), seq: 7 }], journalKey.publicKey)).toMatchObject({ ok: false, failure: { code: "anchor_invalid" } });
  });

  // proves §3.4.1: an anchor holds only a hash, a sequence number, a time and a signature; no task id or content
  it("holds no task content", () => {
    const root = journalOf("journal", ["secret payload"]);
    const anchor = anchorNow(root);
    expect(Object.keys(anchor).sort()).toEqual(["at", "head", "seq", "signature", "task"]);
    expect(anchor.task).toBe(taskDigest(TASK));
    expect(JSON.stringify(anchor)).not.toContain(TASK);
    expect(JSON.stringify(anchor)).not.toContain("secret");
  });

  // proves §3.4.2 then §3.4.1: a chain that does not verify is reported as such before any anchor is consulted
  it("reports a broken chain first", () => {
    const root = journalOf("journal", ["a", "b"]);
    const anchors = [anchorNow(root)];
    copyFileSync(headFile(journalRoot(journalOf("other", ["a"])), TASK), headFile(journalRoot(root), TASK));
    expect(checkAnchors(TASK, verifyTrajectory(root, TASK), anchors, journalKey.publicKey)).toMatchObject({ ok: false, failure: { code: "chain_broken" } });
  });

  // proves §3.4.1 with D-126: a task with no anchor at all fails the check, so a wrong folder or a never-anchored task
  // cannot pass on no evidence
  it("fails when no anchor is found", () => {
    const root = journalOf("journal", ["a", "b", "c"]);
    expect(checkAnchors(TASK, verifyTrajectory(root, TASK), [], journalKey.publicKey)).toEqual({ ok: false, failure: { code: "no_anchor", chain_length: 3 } });
    expect(checkAnchors("never-ran", verifyTrajectory(root, "never-ran"), [], journalKey.publicKey)).toEqual({ ok: false, failure: { code: "no_anchor", chain_length: 0 } });
  });
});
