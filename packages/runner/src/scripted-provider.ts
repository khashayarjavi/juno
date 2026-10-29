import type { ProviderProfile } from "../../contracts/src/index.js";
import type { ModelOutput, ModelProvider, TurnRequest, TurnResponse } from "./provider.js";

/**
 * The scripted fake provider (DECISIONS.md D-002, D-057). It returns
 * predetermined model outputs, one per turn, so that tests prove the runner
 * and the enforcement boundary whatever a model would choose to do. It holds
 * no key and reaches no network. A step may be a function of the request, so
 * a script can bind to an entry whose `seq` it only learns at run time.
 */

export type ScriptStep = ModelOutput | ((request: TurnRequest) => ModelOutput);

export type ScriptedProviderOptions = {
  readonly profile: ProviderProfile;
  readonly script: readonly ScriptStep[];
  readonly model?: string;
  readonly modelVersion?: string;
  /** Tokens reported per turn. */
  readonly usage?: TurnResponse["usage"];
};

export class ScriptedProvider implements ModelProvider {
  readonly profile: ProviderProfile;
  /** Every request received, in order. */
  readonly requests: TurnRequest[] = [];
  readonly #script: readonly ScriptStep[];
  readonly #model: string;
  readonly #modelVersion: string;
  readonly #usage: TurnResponse["usage"];

  constructor(options: ScriptedProviderOptions) {
    this.profile = options.profile;
    this.#script = options.script;
    this.#model = options.model ?? "scripted-model";
    this.#modelVersion = options.modelVersion ?? "scripted-1";
    this.#usage = options.usage ?? { tokens_in: 100, tokens_out: 20, tokens_cached: 0 };
  }

  turn(request: TurnRequest): Promise<TurnResponse> {
    this.requests.push(request);
    const step = this.#script[this.requests.length - 1];
    if (step === undefined) return Promise.reject(new Error(`the script has no step for turn ${String(request.turn)}`));
    const output = typeof step === "function" ? step(request) : step;
    return Promise.resolve({ model: this.#model, model_version: this.#modelVersion, output, usage: { ...this.#usage } });
  }
}
