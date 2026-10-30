import { readFileSync } from "node:fs";
import { z } from "zod";
import { Count, Currency, DurationMs, Ref, parseAtBoundary } from "../../contracts/src/index.js";

/**
 * The Provider Capability Profile (spec §13.1): configuration data, not code.
 * Adding a provider never requires a release. Slice 1 has exactly one
 * provider and one profile (§18, build plan Increment 5), kept as a JSON file
 * under `packages/runner/providers/` (DECISIONS.md D-059).
 *
 * Beyond §13.1's fields a profile carries its `id` (what `model_policy`
 * permits), the `model` identifier and `model_version` string recorded on
 * every turn (§3.4.3), and the inference `posture` it serves, matched exactly
 * against a task's `model_policy.posture`.
 */

export const CONVERSATION_STATES = ["stateless", "server_held"] as const;
export const TURN_CONTROLS = ["client", "server"] as const;

export const ProviderProfile = z.strictObject({
  id: Ref,
  model: Ref,
  model_version: Ref,
  posture: z.string().min(1),
  mid_stream_cancellation: z.boolean(),
  prompt_cache: z.strictObject({
    supported: z.boolean(),
    granularity: z.string().min(1).nullable(),
    ttl_ms: DurationMs.nullable(),
  }),
  conversation_state: z.enum(CONVERSATION_STATES),
  turn_control: z.enum(TURN_CONTROLS),
  server_interrupt: z.boolean(),
  replay_fidelity: z.enum(["full", "partial", "none"]),
  native_tool_calling: z.strictObject({ supported: z.boolean(), parallel: z.boolean() }),
  native_context_management: z.boolean(),
  /** In tokens. */
  context_window: Count,
  /** Currency per token. The runner computes each turn's currency from the tokens the provider reports. */
  cost: z.strictObject({ per_token_in: Currency, per_token_out: Currency, per_token_cached: Currency }),
  jurisdiction: z.string().min(1),
});
export type ProviderProfile = z.infer<typeof ProviderProfile>;

/** The profile file of the one Slice 1 provider. */
export const SCRIPTED_PROFILE_FILE = new URL("../providers/scripted.json", import.meta.url);

export function loadProviderProfile(file: URL | string): ProviderProfile {
  return parseAtBoundary(`provider profile ${String(file)}`, ProviderProfile, JSON.parse(readFileSync(file, "utf8")));
}
