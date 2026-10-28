import { z } from "zod";
import { ContentHash, Ref } from "./common.js";
import { Integrity } from "./lattice.js";
import { Budget, ClosureMode } from "./task.js";

/**
 * Closure (spec §3.4.4). Written by the runner, never the model (Increment 5).
 *
 * Two rules from the model are enforced by the schema:
 * - `verified` needs a passing deterministic method against a criterion of
 *   `operator` integrity. A model-drafted criterion cannot license it (§3.4.4, §5.2).
 * - `verifier_identity` must not equal the executing actor. The closure does
 *   not carry the executing actor, so `closureSchemaFor` builds the schema
 *   for a given task's executing actors.
 */

export const VERIFICATION_RESULTS = ["pass", "fail", "inconclusive"] as const;
export const VerificationResult = z.enum(VERIFICATION_RESULTS);
export type VerificationResult = z.infer<typeof VerificationResult>;

export const REPLAY_FIDELITIES = ["full", "partial", "none"] as const;
export const ReplayFidelity = z.enum(REPLAY_FIDELITIES);
export type ReplayFidelity = z.infer<typeof ReplayFidelity>;

export const Closure = z
  .strictObject({
    task_id: Ref,
    /** Content address of the criterion as admitted; `null` when the task was admitted without one (§5.1). */
    criterion_ref: ContentHash.nullable(),
    criterion_integrity: Integrity,
    verification_method: Ref.nullable(),
    verification_result: VerificationResult,
    closure_mode: ClosureMode,
    verifier_identity: Ref,
    replay_fidelity: ReplayFidelity,
    /** Content addresses of the artifacts produced. */
    artifacts: z.array(ContentHash),
    cost_actual: Budget,
  })
  .superRefine((closure, ctx) => {
    if (closure.closure_mode !== "verified") {
      return;
    }
    if (closure.criterion_ref === null || closure.verification_method === null) {
      ctx.addIssue({
        code: "custom",
        path: ["closure_mode"],
        message: "verified closure needs an admitted criterion and a verification method (spec §5.1)",
      });
    }
    if (closure.criterion_integrity !== "operator") {
      ctx.addIssue({
        code: "custom",
        path: ["criterion_integrity"],
        message: "verified closure requires criterion_integrity = operator (spec §3.4.4)",
      });
    }
    if (closure.verification_result !== "pass") {
      ctx.addIssue({
        code: "custom",
        path: ["verification_result"],
        message: "verified closure requires a passing verification (spec §3.4.4)",
      });
    }
  });
export type Closure = z.infer<typeof Closure>;

/** The closure schema for a task whose work was performed by `executingActors`. */
export function closureSchemaFor(executingActors: readonly string[]) {
  const actors = new Set(executingActors);
  return Closure.refine((closure) => !actors.has(closure.verifier_identity), {
    path: ["verifier_identity"],
    message: "verifier_identity must not equal the executing actor (spec §3.4.4, invariant 3)",
  });
}
