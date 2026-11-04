import { type KeyObject, createHash, createPublicKey, sign, verify } from "node:crypto";
import { z } from "zod";
import { ContentHash, Count, Timestamp, type TrajectoryEntry } from "../../contracts/src/index.js";
import { canonicalJson } from "./canonical.js";
import { type ChainFailure, type ChainVerdict, entryHash } from "./chain.js";

/**
 * The anchored head (spec §3.4.1, v0.6 C1, v0.6.1 V6-4; DECISIONS.md D-122).
 *
 * The hash chain detects partial edits, not a wholesale rewrite by something that can write journal storage and
 * recompute every hash. So the runner copies each task's head hash off the host, at a recorded interval, to an
 * append-only destination the host cannot rewrite. A rewrite then contradicts an anchor the attacker cannot reach.
 *
 * An anchor holds only hashes, a sequence number, a time and a signature (§3.4.1: "publishing it reveals nothing"):
 *   - `task`: the SHA-256 of the task id (the journal's own directory name for it), never the id itself;
 *   - `seq` and `head`: the anchored entry's sequence number and hash;
 *   - `at`: when it was taken;
 *   - `signature`: Ed25519, base64, by the runner's journal key, over the canonical JSON of the other four fields.
 * The signature only says which runner wrote the anchor; the protection is the copy (§3.4.1).
 */

export const TaskDigest = z.string().regex(/^[0-9a-f]{64}$/, "a task digest is 64 lowercase hex digits");

export const AnchorFields = z.strictObject({
  task: TaskDigest,
  seq: Count,
  head: ContentHash,
  at: Timestamp,
});
export type AnchorFields = z.infer<typeof AnchorFields>;

export const Anchor = z.strictObject({
  ...AnchorFields.shape,
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, "a signature is base64"),
});
export type Anchor = z.infer<typeof Anchor>;

/** The digest that names a task in anchors and in the journal's layout. */
export function taskDigest(taskId: string): string {
  return createHash("sha256").update(taskId, "utf8").digest("hex");
}

/** An anchor's place in every destination: `<task digest>/<seq, 12 digits>.json`. One anchor per task and seq. */
export function anchorPath(task: string, seq: number): string {
  return `${TaskDigest.parse(task)}/${String(Count.parse(seq)).padStart(12, "0")}.json`;
}

/** The stored form of an anchor. */
export function encodeAnchor(anchor: Anchor): string {
  return `${canonicalJson(anchor)}\n`;
}

function anchorBytes(fields: AnchorFields): Uint8Array {
  return new TextEncoder().encode(canonicalJson(AnchorFields.parse(fields)));
}

/** Signs an anchor with the runner's journal key (an Ed25519 private key). */
export function signAnchor(fields: AnchorFields, journalKey: KeyObject): Anchor {
  if (journalKey.asymmetricKeyType !== "ed25519" || journalKey.type !== "private") throw new TypeError("an anchor is signed with an Ed25519 private key");
  return { ...AnchorFields.parse(fields), signature: sign(null, anchorBytes(fields), journalKey).toString("base64") };
}

/** The anchor of a task's current head. */
export function anchorOf(taskId: string, head: { readonly seq: number; readonly hash: string }, at: Date, journalKey: KeyObject): Anchor {
  return signAnchor({ task: taskDigest(taskId), seq: head.seq, head: ContentHash.parse(head.hash), at: at.toISOString() }, journalKey);
}

/** Whether an anchor's signature verifies against the journal key's public half. */
export function anchorSignatureValid(anchor: Anchor, journalPublicKey: KeyObject): boolean {
  try {
    const { signature, ...fields } = anchor;
    return verify(null, anchorBytes(fields), journalPublicKey, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/** Reads a journal public key from PEM. Refuses anything but an Ed25519 public key. */
export function journalPublicKeyFromPem(pem: string): KeyObject {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError("the journal key must be an Ed25519 public key");
  return key;
}

/** What `juno journal check` finds (§3.4.1). */
export type AnchorCheck =
  | {
      readonly ok: true;
      /** The latest anchored seq, or `null` when the task has no anchor. */
      readonly anchored_seq: number | null;
      /** Entries after the latest anchor: appended since, not a rewrite, and not yet protected. */
      readonly unanchored: number;
      readonly anchors: number;
    }
  | { readonly ok: false; readonly failure: AnchorFailure };

export type AnchorFailure =
  /** The chain does not verify on its own (§3.4.2); the anchors were not needed to see it. */
  | { readonly code: "chain_broken"; readonly chain: ChainFailure }
  /** A stored anchor is not a valid anchor of this task, or its signature does not verify. */
  | { readonly code: "anchor_invalid"; readonly anchor: number; readonly reason: string }
  /**
   * The chain contradicts an anchor: something at or before the anchored head was rewritten. An anchor holds the hash
   * of one entry, so the first changed entry is known to lie after `after_seq` (the latest anchor that still matches,
   * or -1) and at or before `anchor_seq`.
   */
  | { readonly code: "rewritten"; readonly anchor_seq: number; readonly after_seq: number; readonly first_changed_at_or_before: number }
  /** The chain is shorter than an anchor: entries at or before the anchored head were removed. */
  | { readonly code: "truncated"; readonly anchor_seq: number; readonly chain_length: number };

/**
 * Compares a task's chain with every anchor stored for it (§3.4.1). The chain is checked first; then every anchor must
 * be well formed, name this task, carry a valid journal-key signature, and agree with the entry at its seq. Every
 * anchor is checked, not only the latest, so an anchor signed later with a stolen journal key cannot hide an earlier
 * one that the rewritten chain contradicts.
 */
export function checkAnchors(taskId: string, chain: ChainVerdict, stored: readonly unknown[], journalPublicKey: KeyObject): AnchorCheck {
  if (!chain.ok) return { ok: false, failure: { code: "chain_broken", chain: chain.failure } };
  const digest = taskDigest(taskId);
  const anchors: Anchor[] = [];
  for (const [index, raw] of stored.entries()) {
    const parsed = Anchor.safeParse(raw);
    if (!parsed.success) return { ok: false, failure: { code: "anchor_invalid", anchor: index, reason: "not a valid anchor" } };
    if (parsed.data.task !== digest) return { ok: false, failure: { code: "anchor_invalid", anchor: index, reason: "the anchor names another task" } };
    if (!anchorSignatureValid(parsed.data, journalPublicKey)) return { ok: false, failure: { code: "anchor_invalid", anchor: index, reason: "the signature does not verify against the journal key" } };
    anchors.push(parsed.data);
  }
  anchors.sort((a, b) => a.seq - b.seq);
  const entries: readonly TrajectoryEntry[] = chain.entries;
  let matched = -1;
  for (const anchor of anchors) {
    const entry = entries[anchor.seq];
    if (entry === undefined) return { ok: false, failure: { code: "truncated", anchor_seq: anchor.seq, chain_length: entries.length } };
    if (entryHash(entry) !== anchor.head) return { ok: false, failure: { code: "rewritten", anchor_seq: anchor.seq, after_seq: matched, first_changed_at_or_before: anchor.seq } };
    matched = anchor.seq;
  }
  const latest = anchors.at(-1)?.seq ?? null;
  return { ok: true, anchored_seq: latest, unanchored: entries.length - 1 - (latest ?? -1), anchors: anchors.length };
}
