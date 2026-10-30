import { type Capability, parseAtBoundary } from "../../contracts/src/index.js";
import { type Adapter, type InvocationResult, type OutboundInvocation, executeOutbound } from "./adapter.js";
import { type CapabilityCall, callSchemaFor } from "./call.js";
import { type ConformanceFailure, runConformanceSuite } from "./conformance.js";
import { RegistryEntry } from "./entry.js";
import { type InterpreterInEnum, reviewProgramEnum } from "./review.js";

/**
 * The capability registry (spec §2.1, §2.3–2.5). A capability can be invoked
 * only once it is registered, and registration requires all of:
 *   - the definition parses as a registry entry (§2.1, §2.2 roles and rules);
 *   - every program in its enum passes the interpreter test (§2.3 rule 3);
 *   - every provider it lists has an adapter, and every adapter passes the
 *     conformance suite (§2.4).
 * Any failure refuses the whole registration and nothing is stored
 * (DECISIONS.md D-032).
 *
 * An adapter observed at runtime constructing a parsed string from a `data`
 * field forfeits its registration and quarantines its capability (§2.5). The
 * enforcement boundary makes that observation (Increment 4) and calls
 * `quarantine`; a quarantined adapter is never planned or invoked again.
 */

/** Thrown when a capability that is not registered, or has no adapter, is invoked. */
export class RegistryError extends Error {
  override readonly name = "RegistryError";
}

export type RegistrationRefusal =
  | { readonly kind: "invalid_definition"; readonly message: string }
  | { readonly kind: "already_registered"; readonly id: string }
  | InterpreterInEnum
  | { readonly kind: "no_provider" }
  | { readonly kind: "duplicate_adapter"; readonly adapter: string }
  | { readonly kind: "adapter_missing"; readonly provider: string }
  | { readonly kind: "adapter_not_listed"; readonly adapter: string }
  | { readonly kind: "nonconforming_adapter"; readonly adapter: string; readonly failures: readonly ConformanceFailure[] };

export type RegistrationResult =
  | { readonly registered: true; readonly id: string }
  | { readonly registered: false; readonly refusals: readonly RegistrationRefusal[] };

type Registered = {
  readonly entry: RegistryEntry;
  readonly adapters: ReadonlyMap<string, Adapter>;
};

/** Why an adapter was quarantined, kept as the record of the observation (§2.5). */
export type QuarantineEvidence = {
  readonly capability: string;
  readonly adapter: string;
  readonly observation: string;
};

/** The adapter that serves a capability's calls, and the one invocation it planned for a call. */
export type PlannedInvocation = {
  readonly adapter: string;
  readonly call: CapabilityCall;
  readonly invocation: OutboundInvocation;
};

export class CapabilityRegistry {
  readonly #registered = new Map<string, Registered>();
  readonly #quarantined = new Map<string, QuarantineEvidence>();

  register(definition: unknown, adapters: readonly Adapter[]): RegistrationResult {
    const parsed = RegistryEntry.safeParse(definition);
    if (!parsed.success) {
      return { registered: false, refusals: [{ kind: "invalid_definition", message: parsed.error.message }] };
    }
    const entry = parsed.data;
    const { id, providers } = entry.capability;
    const refusals: RegistrationRefusal[] = [];

    if (this.#registered.has(id)) refusals.push({ kind: "already_registered", id });
    refusals.push(...reviewProgramEnum(entry));

    if (providers.length === 0) refusals.push({ kind: "no_provider" });
    const byId = new Map<string, Adapter>();
    for (const adapter of adapters) {
      if (byId.has(adapter.id)) refusals.push({ kind: "duplicate_adapter", adapter: adapter.id });
      else if (!providers.includes(adapter.id)) refusals.push({ kind: "adapter_not_listed", adapter: adapter.id });
      byId.set(adapter.id, adapter);
    }
    for (const provider of providers) {
      const adapter = byId.get(provider);
      if (adapter === undefined) {
        refusals.push({ kind: "adapter_missing", provider });
        continue;
      }
      const result = runConformanceSuite(entry.capability, adapter);
      if (!result.conforming) refusals.push({ kind: "nonconforming_adapter", adapter: provider, failures: result.failures });
    }

    if (refusals.length > 0) return { registered: false, refusals };
    this.#registered.set(id, { entry, adapters: byId });
    return { registered: true, id };
  }

  /** Every registered capability definition, in registration order. Reading a definition runs nothing. */
  capabilities(): readonly Capability[] {
    return [...this.#registered.values()].map((registered) => registered.entry.capability);
  }

  isRegistered(id: string): boolean {
    return this.#registered.has(id);
  }

  capability(id: string): Capability | undefined {
    return this.#registered.get(id)?.entry.capability;
  }

  /** The registered entry, for the per-call checks of the enforcement boundary (D-038). */
  entry(id: string): RegistryEntry | undefined {
    return this.#registered.get(id)?.entry;
  }

  /** The provider that serves calls to `id`: the first one its definition lists (D-032). */
  servingAdapter(id: string): string | undefined {
    return this.#registered.get(id)?.entry.capability.providers[0];
  }

  /** Records that `adapter` forfeited its registration for `capability` (§2.4, §2.5). Permanent for this registry. */
  quarantine(evidence: QuarantineEvidence): void {
    const key = quarantineKey(evidence.capability, evidence.adapter);
    if (!this.#quarantined.has(key)) this.#quarantined.set(key, evidence);
  }

  /** The recorded observation when `adapter` is quarantined for `capability`, else undefined. */
  quarantined(capability: string, adapter: string): QuarantineEvidence | undefined {
    return this.#quarantined.get(quarantineKey(capability, adapter));
  }

  /**
   * Parses one call against the interface and has the serving adapter plan its
   * outbound invocation, without running it. Refuses an unregistered capability
   * and a quarantined adapter.
   */
  plan(id: string, call: unknown): PlannedInvocation {
    const registered = this.#registered.get(id);
    if (registered === undefined) throw new RegistryError(`capability ${id} is not registered`);
    const { capability } = registered.entry;
    const parsedCall = parseAtBoundary(`${id} call`, callSchemaFor(capability.interface), call);
    const provider = capability.providers[0];
    const adapter = provider === undefined ? undefined : registered.adapters.get(provider);
    if (adapter === undefined) throw new RegistryError(`capability ${id} has no adapter`);
    if (this.quarantined(id, adapter.id) !== undefined) {
      throw new RegistryError(`adapter ${adapter.id} is quarantined for capability ${id} (spec §2.5)`);
    }
    return { adapter: adapter.id, call: parsedCall, invocation: adapter.plan(parsedCall) };
  }

  /**
   * Runs one call through the capability's first listed provider. The call is
   * parsed against the interface first. This performs no enforcement check:
   * the enforcement boundary (`packages/enforcement`) authorizes a call first.
   */
  async invoke(id: string, call: unknown): Promise<InvocationResult> {
    return executeOutbound(this.plan(id, call).invocation);
  }
}

function quarantineKey(capability: string, adapter: string): string {
  return JSON.stringify([capability, adapter]);
}
