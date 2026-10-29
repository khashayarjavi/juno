import { z } from "zod";
import { Count, Currency, DurationMs, Ref } from "./common.js";
import { ReplayFidelity } from "./closure.js";

/**
 * Provider Capability Profile (spec §13.1). Configuration data, not code:
 * adding a provider must never require a release. A profile is read from a
 * JSON file and parsed here (DECISIONS.md D-057).
 */

export const CONVERSATION_STATES = ["stateless", "server_held"] as const;
export const ConversationState = z.enum(CONVERSATION_STATES);
export type ConversationState = z.infer<typeof ConversationState>;

export const TURN_CONTROLS = ["client", "server"] as const;
export const TurnControl = z.enum(TURN_CONTROLS);
export type TurnControl = z.infer<typeof TurnControl>;

/** Price per token, in the operator's billing currency (D-016). */
export const TokenCost = z.strictObject({
  input: Currency,
  output: Currency,
  cached: Currency,
});
export type TokenCost = z.infer<typeof TokenCost>;

export const ProviderProfile = z.strictObject({
  /** The provider id a task's `model_policy.permitted_providers` names. */
  id: Ref,
  /** Whether `abort` can stop an in-flight generation. */
  mid_stream_cancellation: z.boolean(),
  prompt_cache: z.strictObject({
    supported: z.boolean(),
    granularity: z.string().min(1).nullable(),
    ttl_ms: DurationMs.nullable(),
  }),
  /** Gates `confidential`+ work (§10.3). */
  conversation_state: ConversationState,
  /** Who initiates the next turn; determines steer deliverability (§7.8). */
  turn_control: TurnControl,
  /** Whether a server-driven loop can be interrupted mid-run; relevant only when `turn_control` is `server`. */
  server_interrupt: z.boolean(),
  /** A routing input, and recorded in closure (§3.4.3). */
  replay_fidelity: ReplayFidelity,
  native_tool_calling: z.strictObject({ supported: z.boolean(), parallel: z.boolean() }),
  /** Whether §10.2 `native` context ownership is available. */
  native_context_management: z.boolean(),
  /** Budget ceiling, in tokens. */
  context_window: Count,
  cost: TokenCost,
  /** Data residency. */
  jurisdiction: z.string().min(1),
});
export type ProviderProfile = z.infer<typeof ProviderProfile>;
