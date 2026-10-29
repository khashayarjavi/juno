import { z } from "zod";
import {
  Attendance,
  type Budget,
  CapabilityId,
  type ContextOwnership,
  Count,
  Criterion,
  Currency,
  DataClass,
  DurationMs,
  type Grant,
  type Integrity,
  ModelPolicy,
  type ProviderProfile,
  Ref,
  ResourceSelector,
  Sensitivity,
  type SteerCapability,
  Task,
  compareSensitivity,
  parseAtBoundary,
  selectorWithin,
} from "../../contracts/src/index.js";
import type { Constant } from "../../enforcement/src/index.js";
import type { GrantStore } from "../../enforcement/src/index.js";
import { type CallScalar, type CapabilityCall, type CapabilityRegistry, callSchemaFor } from "../../registry/src/index.js";

/**
 * Admission (spec §5; build plan Increment 5; DECISIONS.md D-058, D-059).
 *
 * Admission turns an operator's request into an admitted Task, or rejects it.
 * It runs the eleven §5.4 checks, derives `context_ownership` (§10.2) and
 * `steer_capability` (§7.8), records `criterion_integrity` (§5.2), and fixes
 * the constant slots (§2.6). It decides; the runner journals the decision.
 * Nothing here has a default for a missing budget axis or ttl: absence is a
 * rejection (§0.2 D8).
 */

/** The one verification method Slice 1 knows: run the criterion's command and compare its exit code (D-063). */
export const VERIFY_EXIT_CODE = "juno.verify.exit_code";

/** The strategies Slice 1 can run. Planning logic is out of scope (CLAUDE.md rule 9, §14), so `direct` only (D-058). */
export const SLICE_1_STRATEGIES: readonly string[] = ["direct"];

/** A constant slot name: printable, no whitespace (D-016 `Ref` shape). */
const SlotName = Ref;
const ConstantValue = z.union([z.string(), z.number().finite(), z.boolean()]);

/**
 * A registered source and its declared class (§1.3, §1.4). `unclassified` is a
 * distinct marker, never a default (§1.5). Operator-authored configuration.
 */
export const SourceRegistration = z.strictObject({
  id: Ref,
  selector: ResourceSelector,
  data_class: z.union([DataClass, z.literal("unclassified")]),
});
export type SourceRegistration = z.infer<typeof SourceRegistration>;

/**
 * The criterion as Slice 1 admits it (D-063): a command, given as a call to a
 * registered capability, and the exit code that means done. Every argument is
 * a plain value; admission fixes each as a constant slot.
 */
export const CommandCriterion = z.strictObject({
  capability: CapabilityId,
  arguments: z.record(z.string(), z.union([ConstantValue, z.array(ConstantValue)])),
  exit_code: z.int(),
});
export type CommandCriterion = z.infer<typeof CommandCriterion>;

/**
 * What the operator submits. Fields whose absence a §5.4 check decides
 * (objective, criterion, verification, budget axes, ttl) are optional here so
 * that their absence is a recorded rejection, not a parse error. Everything
 * else must parse, or the request is not a request (it throws).
 */
export const AdmissionRequest = z.strictObject({
  id: Ref,
  principal: Ref,
  objective: z.string().optional(),
  criterion: Criterion.nullable().optional(),
  /** Who wrote the criterion (§5.2). Required when a criterion is given. */
  criterion_author: z.enum(["operator", "model"]).optional(),
  verification: Ref.nullable().optional(),
  attendance: Attendance,
  strategy: Ref,
  sensitivity_floor: Sensitivity,
  model_policy: ModelPolicy,
  budget: z
    .strictObject({
      tokens: Count.optional(),
      currency: Currency.optional(),
      wall_clock_ms: DurationMs.optional(),
      turns: Count.optional(),
    })
    .optional(),
  ttl: z.int().positive().optional(),
  grants: z.array(Ref),
  requires_live_steer: z.boolean().optional(),
  /** Literals the operator fixes with the objective, by slot name (§2.6 `constant`). */
  constants: z.record(SlotName, ConstantValue).optional(),
});
export type AdmissionRequest = z.infer<typeof AdmissionRequest>;

/** Which check refused, by its §5.4 number, or the rule outside the numbered list that did (D-058). */
export type AdmissionCheck = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | "strategy" | "grant_bounds" | "constants";

export type AdmissionFailure = { readonly check: AdmissionCheck; readonly message: string };

/** The criterion as admitted: its content address and the constant slots its command uses. */
export type AdmittedCriterion = {
  readonly capability: string;
  /** The proposal arguments, each a `constant` source naming a slot fixed here. */
  readonly arguments: Readonly<Record<string, { class: "constant"; slot: string } | readonly { class: "constant"; slot: string }[]>>;
  readonly exit_code: number;
};

export type Admitted = {
  readonly admitted: true;
  readonly task: Task;
  readonly constants: Readonly<Record<string, Constant>>;
  readonly criterion: AdmittedCriterion | null;
  readonly warnings: readonly string[];
};

export type Rejected = { readonly admitted: false; readonly failures: readonly AdmissionFailure[] };

export type AdmissionEnvironment = {
  readonly registry: CapabilityRegistry;
  readonly grants: GrantStore;
  readonly provider: ProviderProfile;
  readonly sources: readonly SourceRegistration[];
};

const BUDGET_AXES = ["tokens", "currency", "wall_clock_ms", "turns"] as const;

/**
 * §10.2, as Slice 1 can evaluate it (D-059). A task "may synthesize
 * instruction-field arguments" when a capability its grants select has a
 * scalar instruction field that is not enum-constrained: a free-text
 * instruction such as a command string, which only a model could compose.
 * Every value of an enum field comes from an operator-authored set and is
 * passed as a constant or a bound reference. No Slice 1 input requires
 * `replay_fidelity: full`.
 */
export function deriveContextOwnership(capabilityInterfaces: readonly { readonly [field: string]: { readonly role: string; readonly type: { readonly kind: string } } }[]): ContextOwnership {
  const synthesizes = capabilityInterfaces.some((fields) =>
    Object.values(fields).some((field) => field.role === "instruction" && field.type.kind !== "enum"),
  );
  return synthesizes ? "owned" : "native";
}

/** §7.8's table. */
export function deriveSteerCapability(ownership: ContextOwnership, provider: Pick<ProviderProfile, "conversation_state" | "turn_control" | "server_interrupt">): SteerCapability {
  if (ownership === "owned") return "full";
  if (provider.conversation_state === "stateless") return "full";
  if (provider.turn_control === "client") return "full";
  return provider.server_interrupt ? "checkpoint_only" : "none";
}

/** §5.4 check 5 with §10.3: the provider is permitted and can hold this task's material. */
function routingFailure(request: AdmissionRequest, provider: ProviderProfile): string | null {
  if (!request.model_policy.permitted_providers.includes(provider.id)) {
    return `no registered provider is permitted: the policy permits ${request.model_policy.permitted_providers.join(", ")}; registered is ${provider.id}`;
  }
  const needsStateless = request.model_policy.conversation_state === "stateless" || compareSensitivity(request.sensitivity_floor, "confidential") >= 0;
  if (needsStateless && provider.conversation_state !== "stateless") {
    return `the task needs a stateless provider (§10.3); ${provider.id} holds conversation state server-side`;
  }
  return null;
}

function slotsFor(field: string, value: CallScalar | readonly CallScalar[]): { slots: [string, CallScalar][]; source: AdmittedCriterion["arguments"][string] } {
  if (Array.isArray(value)) {
    const slots = value.map((item, index): [string, CallScalar] => [`criterion.${field}[${String(index)}]`, item]);
    return { slots, source: slots.map(([slot]) => ({ class: "constant" as const, slot })) };
  }
  const slot = `criterion.${field}`;
  return { slots: [[slot, value as CallScalar]], source: { class: "constant", slot } };
}

/**
 * Runs admission. Throws BoundaryError when the request does not parse at all;
 * otherwise returns the admitted task or every failed check.
 */
export function admit(input: unknown, environment: AdmissionEnvironment): Admitted | Rejected {
  const request = parseAtBoundary("admission request", AdmissionRequest, input);
  const { registry, grants: store, provider, sources } = environment;
  const failures: AdmissionFailure[] = [];
  const fail = (check: AdmissionCheck, message: string): void => {
    failures.push({ check, message });
  };
  const warnings: string[] = [];

  // Check 1: objective present (§5.1: absent → reject).
  const objective = request.objective;
  if (objective === undefined || objective.trim() === "") fail(1, "no objective: an objective is required (spec §5.1)");

  if (!SLICE_1_STRATEGIES.includes(request.strategy)) {
    fail("strategy", `strategy ${request.strategy} is not available in Slice 1; only ${SLICE_1_STRATEGIES.join(", ")} is (no planning logic, CLAUDE.md rule 9)`);
  }

  // Check 3: criterion_integrity recorded (§5.2). No criterion has no author: the lowest integrity, which licenses nothing (D-058).
  const criterionGiven = request.criterion !== undefined && request.criterion !== null;
  let criterionIntegrity: Integrity = "untrusted";
  if (criterionGiven) {
    if (request.criterion_author === undefined) fail(3, "a criterion was given without its author; criterion_integrity cannot be recorded (spec §5.2)");
    else criterionIntegrity = request.criterion_author === "operator" ? "operator" : "derived";
  }

  // Check 2: criterion and verification present, or closure_mode set accordingly (§5.1).
  const constants: Record<string, Constant> = {};
  const operatorClass = { sensitivity: request.sensitivity_floor, integrity: "operator" as const };
  for (const [slot, value] of Object.entries(request.constants ?? {})) constants[slot] = { value, data_class: operatorClass };
  let criterion: AdmittedCriterion | null = null;
  if (criterionGiven) {
    const parsed = CommandCriterion.safeParse(request.criterion);
    const capability = parsed.success ? registry.capability(parsed.data.capability) : undefined;
    if (!parsed.success) {
      fail(2, `the criterion is not machine-evaluable: ${parsed.error.message}`);
    } else if (capability === undefined) {
      fail(2, `the criterion's command names capability ${parsed.data.capability}, which is not registered`);
    } else {
      const call = callSchemaFor(capability.interface).safeParse(parsed.data.arguments);
      if (!call.success) {
        fail(2, `the criterion's command does not parse against ${capability.id}: ${call.error.message}`);
      } else {
        const argumentsOut: Record<string, AdmittedCriterion["arguments"][string]> = {};
        for (const [field, value] of Object.entries(call.data as CapabilityCall)) {
          const { slots, source } = slotsFor(field, value as CallScalar | readonly CallScalar[]);
          argumentsOut[field] = source;
          for (const [slot, slotValue] of slots) {
            if (Object.hasOwn(constants, slot)) fail("constants", `constant slot ${slot} is reserved for the criterion`);
            // The criterion's literals carry its author's integrity (§2.6: integrity of the admitting source).
            constants[slot] = { value: slotValue, data_class: { sensitivity: request.sensitivity_floor, integrity: criterionIntegrity } };
          }
        }
        criterion = { capability: capability.id, arguments: argumentsOut, exit_code: parsed.data.exit_code };
      }
    }
  }
  const verification = request.verification ?? null;
  if (verification !== null && verification !== VERIFY_EXIT_CODE) fail(2, `verification method ${verification} is not known; Slice 1 knows ${VERIFY_EXIT_CODE}`);
  // §5.2, §3.4.4: only an operator-integrity criterion with a method licenses `verified`. Slice 1 has no second
  // actor, so `attested` is unreachable; every other task is `accepted` (D-058).
  const closureMode = criterionGiven && verification !== null && criterionIntegrity === "operator" ? "verified" : "accepted";

  // The task's grants: each must be stored and the task principal's (D-058, under check 9).
  const taskGrants: Grant[] = [];
  for (const id of request.grants) {
    const grant = store.get(id);
    if (grant === undefined) fail(9, `grant ${id} is not stored`);
    else if (grant.principal !== request.principal) fail(9, `grant ${id} belongs to ${grant.principal}, not ${request.principal}`);
    else taskGrants.push(grant);
  }
  if (new Set(request.grants).size !== request.grants.length) fail(9, "a grant is listed twice");

  // Check 4: every source the task's grants reach carries a declared class (§1.5: unclassified → reject).
  for (const grant of taskGrants) {
    for (const selector of grant.resource_scope) {
      const source = sources.find((registered) => selectorWithin(selector, registered.selector));
      if (source === undefined) fail(4, `grant ${grant.id} reaches ${JSON.stringify(selector)}, which no registered source covers`);
      else if (source.data_class === "unclassified") fail(4, `grant ${grant.id} reaches source ${source.id}, which is unclassified (spec §1.5)`);
    }
  }

  // Check 5: model_policy satisfiable against a registered provider (§10.3).
  const routing = routingFailure(request, provider);
  if (routing !== null) fail(5, routing);

  // Check 6: budget declared on all four axes. There is no default ceiling, for spend or any other axis (D-058).
  const missingAxes = BUDGET_AXES.filter((axis) => request.budget?.[axis] === undefined);
  if (missingAxes.length > 0) fail(6, `budget not declared on: ${missingAxes.join(", ")}; every axis needs an explicit ceiling (spec §5.4 check 6)`);

  // Check 7: ttl declared.
  if (request.ttl === undefined) fail(7, "no ttl declared (spec §5.4 check 7)");

  // Check 9: every capability in scope is registered, its serving adapter not quarantined (registration ran the §2.4 suite).
  const capabilityIds = [...new Set(taskGrants.flatMap((grant) => grant.capability_selector.capabilities))];
  const interfaces = [];
  for (const id of capabilityIds) {
    const capability = registry.capability(id);
    const adapter = registry.servingAdapter(id);
    if (capability === undefined || adapter === undefined) {
      fail(9, `capability ${id} is not registered`);
      continue;
    }
    if (registry.quarantined(id, adapter) !== undefined) fail(9, `capability ${id}: adapter ${adapter} is quarantined (spec §2.5)`);
    interfaces.push(capability.interface);
    // §5.3: invocation caps are required where the effect writes or leaves the machine.
    if (capability.side_effect !== "read") {
      for (const grant of taskGrants.filter((candidate) => candidate.capability_selector.capabilities.includes(id))) {
        if (grant.max_invocations === null) fail("grant_bounds", `grant ${grant.id} selects ${id} (${capability.side_effect}) with no max_invocations (spec §5.3)`);
      }
    }
  }
  if (criterion !== null && !capabilityIds.includes(criterion.capability)) interfaces.push(registry.capability(criterion.capability)?.interface ?? {});

  // Check 8: context_ownership derived; never silently degraded (§10.2).
  const contextOwnership = deriveContextOwnership(interfaces);
  if (contextOwnership === "native" && !provider.native_context_management) {
    fail(8, `context_ownership is native and provider ${provider.id} offers no native context management (spec §5.4 check 8)`);
  }
  if (contextOwnership === "owned") {
    fail(8, "context_ownership is owned, and owned context assembly is not built in Slice 1 (D-059); the task is refused rather than degraded");
  }

  // Check 10: steer_capability derived and surfaced (§7.8).
  const steerCapability = deriveSteerCapability(contextOwnership, provider);
  const requiresLiveSteer = request.requires_live_steer ?? request.attendance === "gated";
  if (requiresLiveSteer && steerCapability !== "full") {
    fail(10, `the task requires live steer and provider ${provider.id} offers steer_capability ${steerCapability} (spec §5.4 check 10)`);
  }

  // Check 11: warn, never refuse.
  if (request.attendance === "autonomous" && request.grants.length === 0) {
    warnings.push("autonomous task with zero pre-issued grants: it will park at its first capability call (spec §5.4 check 11)");
  }

  if (failures.length > 0) return { admitted: false, failures };
  const task = parseAtBoundary("admitted task", Task, {
    id: request.id,
    principal: request.principal,
    objective,
    criterion: request.criterion ?? null,
    criterion_integrity: criterionIntegrity,
    verification,
    closure_mode: closureMode,
    attendance: request.attendance,
    strategy: request.strategy,
    sensitivity_floor: request.sensitivity_floor,
    context_ownership: contextOwnership,
    model_policy: request.model_policy,
    budget: request.budget as Budget,
    ttl: request.ttl,
    grants: request.grants,
    parent: null,
    state: "admitted",
    runtime_substate: null,
    steer_capability: steerCapability,
    requires_live_steer: requiresLiveSteer,
    trajectory: request.id,
  });
  return { admitted: true, task, constants, criterion, warnings };
}
