import type { CanonicalPaths } from "./canonical.js";
import { z } from "zod";
import { CapabilityId, type DataClass, type Integrity, type NonEmpty, type Sensitivity, type Task } from "../../contracts/src/index.js";
import type { CallScalar } from "../../registry/src/index.js";

/**
 * What reaches the enforcement boundary for one capability call (spec §2.6,
 * §2.7; DECISIONS.md D-041).
 *
 * Every argument value arrives with its provenance class stated by mechanism,
 * never inferred from the value (invariant 7):
 *   - `constant`: names a slot whose value the runtime fixed at admission.
 *   - `bound`: a `${<seq>.<path>}` reference the runtime resolves from the
 *     task's own trajectory. The value never round-trips through the model.
 *   - `synthesized`: free text the model composed.
 * A list field carries one source per element, so each element has its own
 * provenance, named `<field>[<index>]` (D-022).
 */

const Scalar = z.union([z.string(), z.number().finite(), z.boolean()]);

export const ArgumentSource = z.discriminatedUnion("class", [
  z.strictObject({ class: z.literal("constant"), slot: z.string().min(1).max(256) }),
  z.strictObject({ class: z.literal("bound"), reference: z.string() }),
  z.strictObject({ class: z.literal("synthesized"), value: Scalar }),
]);
export type ArgumentSource = z.infer<typeof ArgumentSource>;

export const ProposedCall = z.strictObject({
  capability: CapabilityId,
  /** Keyed by interface field name; a list element is never a key of its own, so `<field>[<index>]` names cannot collide. */
  arguments: z.record(z.string().regex(/^[a-z_][a-z0-9_]*$/), z.union([ArgumentSource, z.array(ArgumentSource)])),
});
export type ProposedCall = z.infer<typeof ProposedCall>;

/**
 * The least a proposal must be for the boundary to judge it: a capability id
 * and an object of arguments. Nothing else about its shape is required here.
 * Every value under an instruction field is judged on its provenance, in
 * whatever shape it arrives, before the proposal is checked against
 * `ProposedCall` or the interface (DECISIONS.md D-052, D-054). A proposal
 * that is not `ProposedCall` is rejected `malformed_call`, but only after that.
 */
export const ProposalEnvelope = z.object({
  capability: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});
export type ProposalEnvelope = z.infer<typeof ProposalEnvelope>;

/** A value the runtime fixed at admission, with the data class admission gave it (§2.6 `constant`). */
export type Constant = {
  readonly value: CallScalar;
  /** Integrity is the admitting source's (normally `operator`), set by admission. */
  readonly data_class: DataClass;
};

/**
 * The turn whose output carries the synthesized values (§2.6). Admission and
 * the turn loop (Increment 5) supply it.
 */
export type Synthesis = {
  /** The producing turn's sensitivity; a synthesized value is never less sensitive than the turn it came from (§1.2). */
  readonly sensitivity: Sensitivity;
  /** Under `owned` context: the integrity of every entry in the volatile region (§2.6). Ignored under `native`. */
  readonly volatile_region?: NonEmpty<Integrity>;
};

/** Everything the boundary needs to know about the calling task. */
export type TaskContext = {
  readonly task: Task;
  readonly constants: Readonly<Record<string, Constant>>;
  readonly synthesis: Synthesis;
  /**
   * The canonical form of each raw path the call names (§2.7.1 C4, D-113), resolved by the caller where the effect will
   * run, for the paths `EnforcementBoundary.pathsToResolve` listed. Absent or incomplete: every path it lacks is outside
   * every scope (fail-closed).
   */
  readonly canonical?: CanonicalPaths;
  /**
   * The canonical roots of the task's reversible workspaces (§2.2.2, D-135): scopes checkpointed before the task's first
   * effect, whose restore is an operator action recorded in the journal. Absent: none, so every `write` is judged as
   * `irreversible`.
   */
  readonly reversible?: readonly string[];
  /**
   * Mediated modes only (§4.3 V6-7, D-150): the class of what the call would read, and the session provider's declared
   * clearance. Judged at step 5, after integrity, scope and effects, so a park that cannot be overridden always wins.
   */
  readonly readGate?: { readonly reads: Sensitivity; readonly clearance: Sensitivity };
};
