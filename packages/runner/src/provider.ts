import { readFileSync } from "node:fs";
import { z } from "zod";
import { Count, ProviderProfile, Ref, parseAtBoundary } from "../../contracts/src/index.js";

/**
 * The provider adapter (spec §13.1, build plan Increment 5: "one provider
 * adapter, one Provider Capability Profile"; DECISIONS.md D-057).
 *
 * A provider serves turns. It never holds a credential the runner did not
 * give it, never sees a grant, and never performs an effect: its output is a
 * proposal at most (invariant 1). Its response is a boundary input and is
 * parsed before anything reads it.
 */

/** What the runner tells the model at the start of a turn (§10.1 volatile region under `native` context). */
export type TurnInput =
  | {
      readonly kind: "objective";
      readonly objective: string;
      /** Constant slots fixed at admission, by name, with their values (§2.6 `constant`). */
      readonly constants: Readonly<Record<string, string | number | boolean>>;
    }
  | {
      readonly kind: "result";
      readonly call_seq: number;
      /** The `capability_result` entry; `${<result_seq>.stdout_lines[0]}` binds into it (§2.6 `bound`). */
      readonly result_seq: number;
      readonly exit_code: number | null;
      readonly stdout: string;
    }
  | { readonly kind: "rejected"; readonly call_seq: number | null; readonly reason: string }
  | { readonly kind: "no_action" };

/** A capability the task may call, described to the model so it can propose a call (§14: tool-call parsing is the provider's). */
export type ToolDescription = {
  readonly capability: string;
  readonly fields: Readonly<Record<string, { readonly role: string; readonly type: string }>>;
};

export type TurnRequest = {
  readonly task_id: string;
  /** 1 for the first turn. */
  readonly turn: number;
  readonly input: readonly TurnInput[];
  readonly tools: readonly ToolDescription[];
};

export const ModelOutput = z.discriminatedUnion("kind", [
  /** A proposed capability call. `input` is whatever the model wrote; the runner reads it by mechanism (D-060). */
  z.strictObject({ kind: z.literal("tool_call"), capability: z.string(), input: z.unknown() }),
  /** The model says the work is done. That is a claim, never a closure (invariant 3). */
  z.strictObject({ kind: z.literal("done"), summary: z.string() }),
  z.strictObject({ kind: z.literal("text"), text: z.string() }),
]);
export type ModelOutput = z.infer<typeof ModelOutput>;

export const TurnResponse = z.strictObject({
  /** The model identifier: the turn's actor (§3.4.2). */
  model: Ref,
  /** Its version string (§3.4.3). */
  model_version: z.string().min(1),
  output: ModelOutput,
  usage: z.strictObject({ tokens_in: Count, tokens_out: Count, tokens_cached: Count }),
});
export type TurnResponse = z.infer<typeof TurnResponse>;

export interface ModelProvider {
  readonly profile: ProviderProfile;
  turn(request: TurnRequest): Promise<unknown>;
}

/** Reads a Provider Capability Profile from its JSON file (§13.1: configuration data, not code). */
export function loadProviderProfile(file: string): ProviderProfile {
  return parseAtBoundary(`provider profile ${file}`, ProviderProfile, JSON.parse(readFileSync(file, "utf8")));
}
