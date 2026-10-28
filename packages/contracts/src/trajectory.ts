import { z } from "zod";
import { ContentHash, Count, Currency, DurationMs, Ref, Timestamp } from "./common.js";
import { DataClass, Integrity } from "./lattice.js";
import { ProvenanceClass } from "./provenance.js";

/**
 * Trajectory entry (spec §3.4.2). Append-only and hash-chained; the chain
 * itself is built and verified by the journal (Increment 2). Encodings are
 * fixed in DECISIONS.md D-022.
 */

export const ENTRY_KINDS = [
  "turn",
  "capability_call",
  "capability_result",
  "binding_resolution",
  "steer",
  "park",
  "resume",
  "block",
  "unblock",
  "override",
  "gate",
  "note",
  "abandon",
  "classification_proposal",
  "classification_contradiction",
] as const;
export const EntryKind = z.enum(ENTRY_KINDS);
export type EntryKind = z.infer<typeof EntryKind>;

/** Per-argument provenance class and computed integrity, on `capability_call` (§3.4.2, §2.6). */
export const ArgumentProvenance = z
  .array(
    z.strictObject({
      /** The interface field, with an index for list elements, e.g. `argv[1]`. */
      argument: z.string().min(1),
      class: ProvenanceClass,
      integrity: Integrity,
    }),
  )
  .refine((entries) => new Set(entries.map((entry) => entry.argument)).size === entries.length, "each argument appears once");
export type ArgumentProvenance = z.infer<typeof ArgumentProvenance>;

/** The `seq` numbers of every entry the reference shape matched, when it matched more than one (§2.7 step 1). */
export const BindingCandidates = z
  .array(Count)
  .min(2)
  .refine((seqs) => new Set(seqs).size === seqs.length, "each candidate appears once");
export type BindingCandidates = z.infer<typeof BindingCandidates>;

export const EntryCost = z.strictObject({
  tokens_in: Count,
  tokens_out: Count,
  tokens_cached: Count,
  currency: Currency,
  duration_ms: DurationMs,
});
export type EntryCost = z.infer<typeof EntryCost>;

export const TrajectoryEntry = z
  .strictObject({
    /** Monotonic within task. */
    seq: Count,
    task_id: Ref,
    kind: EntryKind,
    /** Which model or component produced this. */
    actor: Ref,
    /** Which provider served it; `null` for entries no provider served (DECISIONS.md D-022). */
    provider: Ref.nullable(),
    /** Content-addressed; the payload lives in the blob store. */
    payload_ref: ContentHash,
    data_class: DataClass,
    argument_provenance: ArgumentProvenance.optional(),
    binding_candidates: BindingCandidates.optional(),
    cost: EntryCost,
    /** Chain link; `null` only on a task's first entry (Increment 2 enforces the chain). */
    hash_prev: ContentHash.nullable(),
    timestamp: Timestamp,
  })
  .superRefine((entry, ctx) => {
    if ((entry.kind === "capability_call") !== (entry.argument_provenance !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["argument_provenance"],
        message: "argument_provenance is required on capability_call entries and absent on every other kind",
      });
    }
    if (entry.binding_candidates !== undefined && entry.kind !== "binding_resolution") {
      ctx.addIssue({
        code: "custom",
        path: ["binding_candidates"],
        message: "binding_candidates appear only on binding_resolution entries",
      });
    }
    if (entry.binding_candidates !== undefined && entry.binding_candidates.some((seq) => seq >= entry.seq)) {
      ctx.addIssue({
        code: "custom",
        path: ["binding_candidates"],
        message: "a binding candidate must be a prior entry",
      });
    }
  });
export type TrajectoryEntry = z.infer<typeof TrajectoryEntry>;
