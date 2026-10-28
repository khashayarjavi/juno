import {
  BoundaryError,
  type Capability,
  type DataClass,
  type EntryCost,
  type Integrity,
  type ProvenanceClass,
  type Sensitivity,
  compareIntegrity,
  compareSensitivity,
  join,
  minIntegrity,
  parseAtBoundary,
} from "../../contracts/src/index.js";
import { type EntryDraft, type JournalWriter, canonicalJson, readPayload, readTrajectory } from "../../journal/src/index.js";
import {
  type CallScalar,
  type CallValue,
  type CapabilityCall,
  type CapabilityRegistry,
  type FloorViolation,
  type InvocationResult,
  type OutboundInvocation,
  type PlannedInvocation,
  type RegistryEntry,
  RegistryError,
  callSchemaFor,
  checkInstructionFloors,
  executeOutbound,
} from "../../registry/src/index.js";
import { type ResolutionFailureCode, resolveReference } from "./binding.js";
import { type DeliveryFailure, deliveryFailures } from "./delivery.js";
import type { GrantRefusal, GrantStore } from "./grants.js";
import { type ArgumentSource, ProposedCall, type TaskContext } from "./proposal.js";
import { type ScopeViolation, scopeViolations } from "./scope.js";

/**
 * The enforcement boundary (spec §2.6–2.7, §3.2; build plan Increment 4;
 * DECISIONS.md D-041 to D-045). It runs in the runner, holds the grants and
 * writes the journal; the model only proposes. For each proposed call:
 *
 *   1. Resolve every `bound` reference against the task's own trajectory and
 *      record a `binding_resolution` entry for each, with the candidate set
 *      when the reference's path matches more than one entry.
 *   2. Compute each argument's provenance class and data class (§2.6).
 *   3. `checkInstructionFloors` (D-038): any instruction value, including an
 *      argv element promoted under §2.3 rule 2, below its floor parks
 *      `integrity_floor`. Not overridable (§8.3).
 *   G. No grant covers the call: park `awaiting_grant`.
 *   4. A data field outside every covering grant's scope: park `scope_violation`.
 *   5. Aggregate input sensitivity above `max_input_sensitivity`: park `sensitivity_ceiling`.
 *   6. The serving adapter is quarantined, or is observed now not delivering a
 *      data value structurally (and is quarantined for it): park `adapter_quarantined`.
 *
 * The first check that fails decides the verdict. Every proposal that gets
 * past parsing leaves exactly one `capability_call` entry, carrying the
 * per-argument provenance (D-022) and the verdict. A call proceeds only when
 * every check passes; it is then charged to the grant that covers it, and
 * `perform` runs exactly the invocation that was inspected.
 */

export const ENFORCEMENT_ACTOR = "juno.enforcement";

/** The park reasons this boundary produces (§6.2), in the order its checks run. */
export const ENFORCEMENT_PARK_REASONS = [
  "integrity_floor",
  "awaiting_grant",
  "scope_violation",
  "sensitivity_ceiling",
  "adapter_quarantined",
] as const;
export type EnforcementParkReason = (typeof ENFORCEMENT_PARK_REASONS)[number];

export type ParkDetail =
  | { readonly reason: "integrity_floor"; readonly violations: readonly FloorViolation[] }
  | { readonly reason: "awaiting_grant"; readonly refused: readonly GrantRefusal[] }
  | { readonly reason: "scope_violation"; readonly grants: readonly { readonly grant: string; readonly outside: readonly ScopeViolation[] }[] }
  | { readonly reason: "sensitivity_ceiling"; readonly aggregate: Sensitivity; readonly ceiling: Sensitivity }
  | {
      readonly reason: "adapter_quarantined";
      readonly adapter: string;
      readonly observation: string;
      readonly failures: readonly DeliveryFailure[];
    };

export type UnresolvedArgument = {
  readonly argument: string;
  readonly class: "bound" | "constant";
  readonly code: ResolutionFailureCode | "unknown_slot";
  readonly message: string;
};

/**
 * A proposal that is not a call at all. Nothing runs and the task is not
 * parked: the spec rejects such references (O9) and no operator decision can
 * repair them (D-045).
 */
export type RejectDetail =
  | { readonly reason: "unresolved_argument"; readonly failures: readonly UnresolvedArgument[] }
  | { readonly reason: "unknown_capability" }
  | { readonly reason: "malformed_call"; readonly message: string };

/** Permission to run one inspected invocation once. Only `perform` on the boundary that issued it accepts it. */
export type Authorization = {
  readonly task_id: string;
  readonly call_seq: number;
  readonly capability: string;
  readonly grant: string;
  readonly adapter: string;
  readonly call: CapabilityCall;
  readonly invocation: OutboundInvocation;
  /** The join of every argument's data class; the result's class is computed from it (§2.1 `output_class`). */
  readonly input_class: DataClass;
};

export type Verdict =
  | { readonly outcome: "proceed"; readonly call_seq: number; readonly authorization: Authorization }
  | { readonly outcome: "park"; readonly call_seq: number; readonly detail: ParkDetail }
  | { readonly outcome: "reject"; readonly call_seq: number; readonly detail: RejectDetail };

export class EnforcementError extends Error {
  override readonly name = "EnforcementError";
}

export type EnforcementBoundaryOptions = {
  readonly registry: CapabilityRegistry;
  readonly grants: GrantStore;
  readonly journal: JournalWriter;
  /** The clock grants are judged by. Defaults to the system clock. */
  readonly clock?: () => Date;
};

type Origin =
  | { readonly class: "constant"; readonly slot: string }
  | { readonly class: "bound"; readonly reference: string; readonly bound_to: number; readonly binding_entry: number }
  | { readonly class: "synthesized" };

type ArgumentRecord = {
  readonly argument: string;
  readonly class: ProvenanceClass;
  readonly data_class: DataClass;
  readonly value: CallScalar;
  readonly origin: Origin;
};

type Named = { readonly argument: string; readonly source: ArgumentSource };

const NO_COST: EntryCost = { tokens_in: 0, tokens_out: 0, tokens_cached: 0, currency: 0, duration_ms: 0 };

/** Names each source as `argument_provenance` names it: a field, or `<field>[<index>]` for a list element (D-022). */
function named(sources: ProposedCall["arguments"]): Named[] {
  return Object.entries(sources).flatMap(([field, value]) =>
    Array.isArray(value) ? value.map((source, index) => ({ argument: `${field}[${String(index)}]`, source })) : [{ argument: field, source: value }],
  );
}

/** The call's argument values, shaped as the proposal shaped them. */
function assemble(sources: ProposedCall["arguments"], values: ReadonlyMap<string, CallScalar>): Record<string, CallValue> {
  const call: Record<string, CallValue> = {};
  for (const [field, value] of Object.entries(sources)) {
    call[field] = Array.isArray(value)
      ? value.map((_source, index) => values.get(`${field}[${String(index)}]`) ?? "")
      : (values.get(field) ?? "");
  }
  return call;
}

/** The data class of what the model composed in this turn (§2.6 `synthesized`). */
function synthesizedClass({ task, synthesis }: TaskContext): DataClass {
  if (task.context_ownership !== "owned") {
    // Under native context JUNO cannot enumerate the volatile region: untrusted, unconditionally (§2.6).
    return { sensitivity: synthesis.sensitivity, integrity: "untrusted" };
  }
  if (synthesis.volatile_region === undefined) {
    throw new EnforcementError("an owned-context task must supply its volatile region; synthesized integrity is min() over it (spec §2.6)");
  }
  const [first, ...rest] = synthesis.volatile_region;
  return { sensitivity: synthesis.sensitivity, integrity: rest.reduce<Integrity>(minIntegrity, first) };
}

type FloorOutcome =
  | { readonly kind: "proceed" }
  | { readonly kind: "park"; readonly violations: readonly FloorViolation[] }
  | { readonly kind: "malformed"; readonly message: string };

/**
 * §2.7 step 3 is `checkInstructionFloors` (D-038). When the call does not parse
 * against the interface, its argv cannot be read, but each scalar instruction
 * field that was supplied can still be judged on its own provenance: an
 * instruction from untrusted content parks whether or not its value is valid
 * (D-045). Otherwise the call is malformed.
 */
function instructionFloors(entry: RegistryEntry, call: CapabilityCall, records: readonly ArgumentRecord[]): FloorOutcome {
  const provenance = records.map(({ argument, class: kind, data_class }) => ({ argument, class: kind, integrity: data_class.integrity }));
  try {
    const verdict = checkInstructionFloors(entry, call, provenance);
    return verdict.outcome === "park" ? { kind: "park", violations: verdict.violations } : { kind: "proceed" };
  } catch (error: unknown) {
    if (!(error instanceof BoundaryError)) throw error;
    const { capability } = entry;
    const violations: FloorViolation[] = [];
    for (const [name, field] of Object.entries(capability.interface)) {
      const record = records.find((candidate) => candidate.argument === name);
      if (field.role !== "instruction" || record === undefined) continue;
      if (compareIntegrity(record.data_class.integrity, capability.min_argument_integrity) < 0) {
        violations.push({
          argument: name,
          floor: capability.min_argument_integrity,
          integrity: record.data_class.integrity,
          source: { kind: "instruction_field" },
        });
      }
    }
    return violations.length > 0 ? { kind: "park", violations } : { kind: "malformed", message: error.message };
  }
}

export class EnforcementBoundary {
  readonly #registry: CapabilityRegistry;
  readonly #grants: GrantStore;
  readonly #journal: JournalWriter;
  readonly #clock: () => Date;
  readonly #issued = new WeakSet<Authorization>();

  constructor(options: EnforcementBoundaryOptions) {
    this.#registry = options.registry;
    this.#grants = options.grants;
    this.#journal = options.journal;
    this.#clock = options.clock ?? (() => new Date());
  }

  /** Judges one proposed call by a running task, records it, and returns the verdict. Nothing runs here. */
  authorize(context: TaskContext, input: unknown): Verdict {
    const { task } = context;
    if (task.state !== "running") throw new EnforcementError(`task ${task.id} is ${task.state}; only a running task makes capability calls (spec §6)`);
    const proposal = parseAtBoundary("capability call proposal", ProposedCall, input);
    const synthesized = synthesizedClass(context);

    // Step 1 and step 2: resolve and classify every argument.
    const { records, failures } = this.#resolve(context, proposal, synthesized);
    const record = (verdict: Readonly<Record<string, unknown>>, grant: string | null): number =>
      this.#recordCall(task.id, proposal.capability, records, synthesized, verdict, grant);
    const park = (detail: ParkDetail): Verdict => ({ outcome: "park", call_seq: record({ outcome: "park", ...detail }, null), detail });
    const reject = (detail: RejectDetail): Verdict => ({ outcome: "reject", call_seq: record({ outcome: "reject", ...detail }, null), detail });

    if (failures.length > 0) return reject({ reason: "unresolved_argument", failures });
    const entry = this.#registry.entry(proposal.capability);
    if (entry === undefined) return reject({ reason: "unknown_capability" });
    const { capability } = entry;
    const call = assemble(proposal.arguments, new Map(records.map((item) => [item.argument, item.value])));

    // Step 3.
    const floors = instructionFloors(entry, call, records);
    if (floors.kind === "park") return park({ reason: "integrity_floor", violations: floors.violations });
    if (floors.kind === "malformed") return reject({ reason: "malformed_call", message: floors.message });
    const parsedCall = callSchemaFor(capability.interface).parse(call);

    // The grant check, then step 4 against the grants that cover the call.
    const coverage = this.#grants.coverage(task, capability.id, this.#clock());
    if (coverage.covering.length === 0) return park({ reason: "awaiting_grant", refused: coverage.refused });
    const scoped = coverage.covering.map((grant) => ({ grant, outside: scopeViolations(capability, parsedCall, grant) }));
    const chosen = scoped.find((candidate) => candidate.outside.length === 0)?.grant;
    if (chosen === undefined) {
      return park({ reason: "scope_violation", grants: scoped.map(({ grant, outside }) => ({ grant: grant.id, outside })) });
    }

    // Step 5.
    const exceeding = records.filter((item) => compareSensitivity(item.data_class.sensitivity, capability.max_input_sensitivity) > 0);
    const [firstExceeding, ...moreExceeding] = exceeding;
    if (firstExceeding !== undefined) {
      const aggregate = join([firstExceeding.data_class, ...moreExceeding.map((item) => item.data_class)]).sensitivity;
      return park({ reason: "sensitivity_ceiling", aggregate, ceiling: capability.max_input_sensitivity });
    }

    // Step 6.
    const planned = this.#plan(capability, parsedCall);
    if (!planned.ok) return park(planned.detail);

    this.#grants.charge(chosen.id);
    const [firstRecord, ...restRecords] = records;
    const inputClass = firstRecord === undefined ? synthesized : join([firstRecord.data_class, ...restRecords.map((item) => item.data_class)]);
    const callSeq = record({ outcome: "proceed" }, chosen.id);
    const authorization: Authorization = {
      task_id: task.id,
      call_seq: callSeq,
      capability: capability.id,
      grant: chosen.id,
      adapter: planned.planned.adapter,
      call: planned.planned.call,
      invocation: planned.planned.invocation,
      input_class: inputClass,
    };
    this.#issued.add(authorization);
    return { outcome: "proceed", call_seq: callSeq, authorization };
  }

  /** Runs an authorized invocation, exactly as inspected, once (§3.2: the task requests an effect, the boundary performs it). */
  perform(authorization: Authorization): Promise<InvocationResult> {
    if (!this.#issued.delete(authorization)) {
      return Promise.reject(new EnforcementError("not an authorization this boundary issued, or one already performed"));
    }
    return executeOutbound(authorization.invocation);
  }

  #resolve(
    context: TaskContext,
    proposal: ProposedCall,
    synthesized: DataClass,
  ): { records: ArgumentRecord[]; failures: UnresolvedArgument[] } {
    const { task, constants } = context;
    const root = this.#journal.root;
    // The task's own trajectory, and nothing else: a reference cannot reach another task (§2.6).
    const trajectory = readTrajectory(root, task.id);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const payloads = new Map<number, unknown>();
    const payloadOf = (entry: { readonly seq: number; readonly payload_ref: string }): unknown => {
      if (!payloads.has(entry.seq)) {
        const blob = readPayload(root, entry.payload_ref);
        let parsed: unknown;
        try {
          parsed = blob.status === "present" ? JSON.parse(decoder.decode(blob.bytes)) : undefined;
        } catch {
          parsed = undefined;
        }
        payloads.set(entry.seq, parsed);
      }
      return payloads.get(entry.seq);
    };

    const records: ArgumentRecord[] = [];
    const failures: UnresolvedArgument[] = [];
    for (const { argument, source } of named(proposal.arguments)) {
      if (source.class === "synthesized") {
        // Invariant 7: no comparison with prior values is made; only the reference mechanism confers `bound`.
        records.push({ argument, class: "synthesized", data_class: synthesized, value: source.value, origin: { class: "synthesized" } });
      } else if (source.class === "constant") {
        const constant = Object.hasOwn(constants, source.slot) ? constants[source.slot] : undefined;
        if (constant === undefined) {
          failures.push({ argument, class: "constant", code: "unknown_slot", message: `no constant slot ${JSON.stringify(source.slot)} was fixed at admission` });
        } else {
          records.push({ argument, class: "constant", data_class: constant.data_class, value: constant.value, origin: { class: "constant", slot: source.slot } });
        }
      } else {
        const resolution = resolveReference(source.reference, trajectory, payloadOf);
        const base = { capability: proposal.capability, argument, reference: source.reference };
        if (resolution.ok) {
          const candidates = resolution.candidates.length > 1 ? { binding_candidates: [...resolution.candidates] } : {};
          const bindingEntry = this.#append(
            task.id,
            { ...this.#draft("binding_resolution", join([synthesized, resolution.data_class])), ...candidates },
            { ...base, outcome: "resolved", bound_to: resolution.seq, value: resolution.value, candidates: [...resolution.candidates] },
          );
          records.push({
            argument,
            class: "bound",
            data_class: resolution.data_class,
            value: resolution.value,
            origin: { class: "bound", reference: source.reference, bound_to: resolution.seq, binding_entry: bindingEntry },
          });
        } else {
          this.#append(task.id, this.#draft("binding_resolution", synthesized), {
            ...base,
            outcome: "rejected",
            code: resolution.code,
            message: resolution.message,
          });
          failures.push({ argument, class: "bound", code: resolution.code, message: resolution.message });
        }
      }
    }
    return { records, failures };
  }

  /** Step 6: the quarantine check, then the runtime observation of the planned invocation (§2.4, §2.5). */
  #plan(definition: Capability, call: CapabilityCall): { ok: true; planned: PlannedInvocation } | { ok: false; detail: ParkDetail } {
    const capability = definition.id;
    const adapter = this.#registry.servingAdapter(capability);
    if (adapter === undefined) throw new EnforcementError(`capability ${capability} has no serving adapter`);
    const known = this.#registry.quarantined(capability, adapter);
    if (known !== undefined) return { ok: false, detail: { reason: "adapter_quarantined", adapter, observation: known.observation, failures: [] } };

    let planned: PlannedInvocation;
    try {
      planned = this.#registry.plan(capability, call);
    } catch (error: unknown) {
      if (error instanceof RegistryError || error instanceof BoundaryError) throw error;
      // An adapter that cannot carry a valid data value does not deliver it structurally (D-033, D-044).
      const observation = `the adapter refused a valid call: ${error instanceof Error ? error.message : String(error)}`;
      this.#registry.quarantine({ capability, adapter, observation });
      return { ok: false, detail: { reason: "adapter_quarantined", adapter, observation, failures: [] } };
    }
    const failures = deliveryFailures(definition, planned.call, planned.invocation);
    if (failures.length > 0) {
      const observation = `data not delivered as discrete argv elements: ${failures.map((failure) => failure.field).join(", ")}`;
      this.#registry.quarantine({ capability, adapter, observation });
      return { ok: false, detail: { reason: "adapter_quarantined", adapter, observation, failures } };
    }
    return { ok: true, planned };
  }

  #draft(kind: EntryDraft["kind"], dataClass: DataClass): EntryDraft {
    return { kind, actor: ENFORCEMENT_ACTOR, provider: null, data_class: dataClass, cost: NO_COST };
  }

  #append(taskId: string, draft: EntryDraft, payload: unknown): number {
    return this.#journal.append(taskId, draft, new TextEncoder().encode(canonicalJson(payload))).seq;
  }

  #recordCall(
    taskId: string,
    capability: string,
    records: readonly ArgumentRecord[],
    synthesized: DataClass,
    verdict: Readonly<Record<string, unknown>>,
    grant: string | null,
  ): number {
    const provenance = records.map(({ argument, class: kind, data_class }) => ({ argument, class: kind, integrity: data_class.integrity }));
    // The entry holds the proposal itself, which the model composed, and every argument value.
    const dataClass = join([synthesized, ...records.map((item) => item.data_class)]);
    const payload = {
      capability,
      arguments: records.map(({ argument, class: kind, data_class, value, origin }) => ({
        argument,
        class: kind,
        integrity: data_class.integrity,
        sensitivity: data_class.sensitivity,
        value,
        origin: { ...origin },
      })),
      grant,
      verdict,
    };
    return this.#append(taskId, { ...this.#draft("capability_call", dataClass), argument_provenance: provenance }, payload);
  }
}
