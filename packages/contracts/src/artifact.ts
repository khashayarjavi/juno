import { z } from "zod";
import { ContentHash, Count, Ref } from "./common.js";
import { DataClass } from "./lattice.js";

/**
 * Artifact (spec §3.5): the only cross-task data channel. Identity is the
 * content address, so a revision is a new artifact that names what it
 * supersedes, never a mutation. Input shapes are fixed in DECISIONS.md D-022.
 */

export const ArtifactInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("artifact"), hash: ContentHash }),
  z.strictObject({ kind: z.literal("trajectory_entry"), task_id: Ref, seq: Count }),
]);
export type ArtifactInput = z.infer<typeof ArtifactInput>;

export const Artifact = z
  .strictObject({
    hash: ContentHash,
    type: Ref,
    producing_task: Ref,
    data_class: DataClass,
    inputs: z.array(ArtifactInput),
    supersedes: ContentHash.nullable(),
  })
  .refine((artifact) => artifact.supersedes !== artifact.hash, {
    path: ["supersedes"],
    message: "an artifact cannot supersede itself; a revision is a new artifact (spec §3.5)",
  });
export type Artifact = z.infer<typeof Artifact>;
