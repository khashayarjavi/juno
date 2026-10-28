import { z } from "zod";

/**
 * Argument provenance classes (spec §2.6). Computing each class's integrity is
 * the enforcement boundary's job (§2.7, Increment 4); this is the vocabulary.
 *
 * - `constant`: a literal fixed at admission, in the objective, criterion, or a
 *   Strategy template slot filled by the runtime.
 * - `bound`: a reference expression (see `reference.ts`) resolved by the runtime
 *   from a prior trajectory entry of the same task. The value never round-trips
 *   through the model.
 * - `synthesized`: the model composed the value as free text. A literal equal
 *   to a prior value is still `synthesized` (invariant 7, §0.3).
 */
export const PROVENANCE_CLASSES = ["constant", "bound", "synthesized"] as const;
export const ProvenanceClass = z.enum(PROVENANCE_CLASSES);
export type ProvenanceClass = z.infer<typeof ProvenanceClass>;
