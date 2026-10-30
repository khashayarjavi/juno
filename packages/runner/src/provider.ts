import { z } from "zod";
import { Count, Ref } from "../../contracts/src/index.js";
import type { ProviderProfile } from "./profile.js";

/**
 * The provider adapter (spec §13.1, §18 "one provider"). The runner assembles
 * the context, the provider answers one turn, and the runner parses the answer
 * at the boundary: model output is untrusted input (§1.1, invariant 1). The
 * model may propose capability calls; only the enforcement boundary decides
 * them.
 *
 * Slice 1 has one provider, the scripted provider of DECISIONS.md D-002: it
 * returns predetermined model outputs, so tests prove the boundary whatever a
 * model would choose (D-059).
 */

/** One item of the assembled context, in the order it is sent. */
export type ContextItem = {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: unknown;
};

/**
 * A capability offered to the model: its id and interface, so the model can name fields (§2.1), and for each field
 * the constant slots it may name there, by name only (Slice 1.2, D-075). Never a constant's value, and never a slot
 * fixed for the verifier.
 */
export type ToolDefinition = {
  readonly capability: string;
  readonly interface: unknown;
  readonly slots: Readonly<Record<string, readonly string[]>>;
};

/** Everything one provider call receives. Its canonical hash is the turn's prompt hash (§3.4.3). */
export type ProviderRequest = {
  readonly model: string;
  readonly context: readonly ContextItem[];
  readonly tools: readonly ToolDefinition[];
};

/** The most capability calls one turn may propose; more is a malformed turn. */
export const MAX_CALLS_PER_TURN = 32;

/** A provider's answer, as parsed at the boundary. Anything else is a malformed turn. */
export const ProviderResponse = z.strictObject({
  /** The model and version that actually served the turn, recorded for replay (§3.4.3). */
  model: Ref,
  model_version: Ref,
  text: z.string().max(65536).nullable(),
  /** Proposed capability calls. None means the model claims the task is done (§6.1: it cannot confer it). */
  tool_calls: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(128),
        capability: z.string().max(128),
        arguments: z.record(z.string().max(128), z.unknown()),
      }),
    )
    .max(MAX_CALLS_PER_TURN),
  usage: z.strictObject({ tokens_in: Count, tokens_out: Count, tokens_cached: Count }),
});
export type ProviderResponse = z.infer<typeof ProviderResponse>;

export interface Provider {
  /** The profile this provider serves under; admission routes on it (§5.4 checks 5, 8, 10). */
  readonly profile: ProviderProfile;
  /** One turn. The value is parsed by the runner; a provider is never trusted to return the right shape. */
  complete(request: ProviderRequest): Promise<unknown>;
}

/** One scripted turn: a fixed answer, or one computed from the request (to name a `seq` the run produced). */
export type ScriptStep = unknown | ((request: ProviderRequest, turn: number) => unknown);

export class ScriptExhausted extends Error {
  override readonly name = "ScriptExhausted";
}

/** The scripted provider (D-002): returns its steps in order and throws when they run out. */
export class ScriptedProvider implements Provider {
  readonly profile: ProviderProfile;
  readonly requests: ProviderRequest[] = [];
  readonly #steps: readonly ScriptStep[];

  constructor(profile: ProviderProfile, steps: readonly ScriptStep[]) {
    this.profile = profile;
    this.#steps = steps;
  }

  complete(request: ProviderRequest): Promise<unknown> {
    const turn = this.requests.length;
    this.requests.push(request);
    const step = this.#steps[turn];
    if (turn >= this.#steps.length) return Promise.reject(new ScriptExhausted(`the script has no turn ${String(turn)}`));
    return Promise.resolve(typeof step === "function" ? (step as (request: ProviderRequest, turn: number) => unknown)(request, turn) : step);
  }
}
