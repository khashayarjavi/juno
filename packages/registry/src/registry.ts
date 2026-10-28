import { type Capability, parseAtBoundary } from "../../contracts/src/index.js";
import { type Adapter, type InvocationResult, executeOutbound } from "./adapter.js";
import { callSchemaFor } from "./call.js";
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

export class CapabilityRegistry {
  readonly #registered = new Map<string, Registered>();

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

  isRegistered(id: string): boolean {
    return this.#registered.has(id);
  }

  capability(id: string): Capability | undefined {
    return this.#registered.get(id)?.entry.capability;
  }

  /**
   * Runs one call through the capability's first listed provider. The call is
   * parsed against the interface first. Grants, provenance and the other
   * enforcement checks wrap this in Increment 4; this function performs none of them.
   */
  async invoke(id: string, call: unknown): Promise<InvocationResult> {
    const registered = this.#registered.get(id);
    if (registered === undefined) throw new RegistryError(`capability ${id} is not registered`);
    const { capability } = registered.entry;
    const parsedCall = parseAtBoundary(`${id} call`, callSchemaFor(capability.interface), call);
    const provider = capability.providers[0];
    const adapter = provider === undefined ? undefined : registered.adapters.get(provider);
    if (adapter === undefined) throw new RegistryError(`capability ${id} has no adapter`);
    return executeOutbound(adapter.plan(parsedCall));
  }
}
