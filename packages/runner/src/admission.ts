import { z } from "zod";
import {
  ATTENDANCES,
  Budget,
  CapabilityId,
  type ClosureMode,
  type ContextOwnership,
  type DataClass,
  DataClass as DataClassSchema,
  type Grant,
  type Integrity,
  ModelPolicy,
  Ref,
  ResourceSelector,
  Sensitivity,
  type SteerCapability,
  Task,
  WORK_NAMESPACE,
  WorkPath,
  compareSensitivity,
  maxSensitivity,
  selectorWithin,
} from "../../contracts/src/index.js";
import type { GrantStore } from "../../enforcement/src/index.js";
import { type CapabilityRegistry, callSchemaFor } from "../../registry/src/index.js";
import type { ProviderProfile } from "./profile.js";

/**
 * Admission (spec §5; build plan Increment 5; DECISIONS.md D-061). The
 * operator's admission request is a boundary input. Admission runs every
 * check of §5.4 and reports every failure together; a request that fails any
 * check is rejected and nothing runs. It produces the Task, the constants
 * table the enforcement boundary resolves `constant` arguments from (§2.6),
 * and the provider the task is routed to.
 */

/** The only strategy in Slice 1. It permits only `constant` and `bound` arguments in instruction fields (§10.2, D-061). */
export const DIRECT_STRATEGY = "direct";

/** The one verification method in Slice 1: run the criterion's command and compare its exit code (§3.4.4, D-062). */
export const COMMAND_EXIT_METHOD = "command_exit";

/** Ids under this prefix name the runner's own records; no task may take one. */
export const RESERVED_ID_PREFIX = "juno.";

const SlotName = z.string().regex(/^[a-z][a-z0-9_-]*$/, "must be a lower-case name");
const Scalar = z.union([z.string(), z.number().finite(), z.boolean()]);

/**
 * A machine-evaluable statement of done (§3.1, D-021 left its contents to
 * Increment 5): the task is done when this capability call exits with this
 * code. Every argument is a literal fixed now, so each becomes a constant slot
 * named `criterion.<field>` or `criterion.<field>.<index>`, with the
 * criterion's integrity (§2.6 "fixed at admission — in the criterion").
 */
export const CriterionStatement = z.strictObject({
  command: z.strictObject({
    capability: CapabilityId,
    arguments: z.record(z.string(), z.union([Scalar, z.array(Scalar)])),
  }),
  expect_exit_code: z.int().min(0).max(255),
  /** Paths the task must not write under (D-025 Inc 7, D-057). Verification fails if their listing changed. */
  protected_paths: z.array(WorkPath).min(1).max(32),
});
export type CriterionStatement = z.infer<typeof CriterionStatement>;

export const AdmissionRequest = z.strictObject({
  id: Ref,
  principal: Ref,
  objective: z.string(),
  /** Who wrote the criterion decides its integrity (§5.2). */
  criterion: z.strictObject({ author: z.enum(["operator", "model"]), statement: CriterionStatement }).nullable(),
  verification: Ref.nullable(),
  /** The closure the operator asks for. Admission lowers it when it is not licensed (§5.1, §3.4.4). */
  closure_mode: z.enum(["verified", "accepted"]).default("verified"),
  attendance: z.enum(ATTENDANCES),
  strategy: Ref,
  /** Ids of the registered sources this task reads (§5.4 check 4). */
  sources: z.array(Ref),
  sensitivity_floor: Sensitivity,
  model_policy: ModelPolicy,
  budget: Budget,
  ttl: z.int().positive(),
  grants: z.array(Ref),
  parent: Ref.nullable(),
  requires_live_steer: z.boolean().optional(),
  /** Literals the operator fixes now, each a `constant` slot of `operator` integrity (§2.6). */
  constants: z.record(SlotName, z.strictObject({ value: Scalar, sensitivity: Sensitivity.optional() })).default({}),
});
export type AdmissionRequest = z.input<typeof AdmissionRequest>;

/** A source the operator registered, with its declared class (§1.3, §1.4). `unclassified` is a defect, never a default (§1.5). */
export const SourceRegistration = z.strictObject({
  id: Ref,
  selector: ResourceSelector,
  data_class: z.union([DataClassSchema, z.literal("unclassified")]),
});
export type SourceRegistration = z.infer<typeof SourceRegistration>;

/** One failed admission check: the §5.4 check number (or the rule it extends) and why. */
export type AdmissionFailure = { readonly check: string; readonly message: string };

export type AdmittedTask = {
  readonly task: Task;
  readonly constants: Readonly<Record<string, { readonly value: string | number | boolean; readonly data_class: DataClass }>>;
  readonly criterion: CriterionStatement | null;
  readonly provider: ProviderProfile;
  /** The registered sources the task reads, with their declared classes. */
  readonly sources: readonly { readonly id: string; readonly selector: ResourceSelector; readonly data_class: DataClass }[];
  readonly warnings: readonly string[];
};

export type AdmissionResult =
  | { readonly admitted: true; readonly admission: AdmittedTask }
  | { readonly admitted: false; readonly failures: readonly AdmissionFailure[] };

export type AdmissionEnvironment = {
  readonly registry: CapabilityRegistry;
  readonly grants: GrantStore;
  readonly providers: readonly ProviderProfile[];
  readonly sources: readonly SourceRegistration[];
  readonly now: Date;
};

/** §7.8: what a task can receive, from its context mode and the provider's profile. */
export function deriveSteerCapability(ownership: ContextOwnership, profile: ProviderProfile): SteerCapability {
  if (ownership === "owned" || profile.conversation_state === "stateless" || profile.turn_control === "client") return "full";
  return profile.server_interrupt ? "checkpoint_only" : "none";
}

/**
 * §10.2: `native` when the strategy and capability set permit only `constant`
 * and `bound` arguments in instruction fields; `owned` when the task may
 * synthesize them or needs full replay. Slice 1's only strategy permits
 * neither, and no admission input requires full replay, so every Slice 1 task
 * is `native`: a synthesized value is `untrusted`, unconditionally (§2.6, D-061).
 */
export function deriveContextOwnership(strategy: string): ContextOwnership {
  if (strategy !== DIRECT_STRATEGY) throw new RangeError(`no context ownership is defined for strategy ${strategy}`);
  return "native";
}

/** §10.3: `sensitivity_floor ≥ confidential` needs a stateless provider, as does a policy that asks for one. */
export function routable(policy: ModelPolicy, floor: Sensitivity, profile: ProviderProfile): boolean {
  if (!policy.permitted_providers.includes(profile.id) || policy.posture !== profile.posture) return false;
  const needsStateless = policy.conversation_state === "stateless" || compareSensitivity(floor, "confidential") >= 0;
  return !needsStateless || profile.conversation_state === "stateless";
}

/** The constant slots a criterion fixes, by name. */
/**
 * How the verifier lists the protected paths (D-067): `ls` through `shell.run`, long format with
 * full timestamps, recursive, every entry. A write, a new file or a removed one changes the listing.
 */
export const PROTECTED_LISTING = { capability: "shell.run", program: "/usr/bin/ls", flags: ["-l", "-a", "-R", "--time-style=full-iso", "--"] } as const;

/** The constant slots of the protected-path listing, each fixed by the criterion. */
export function protectedSlots(statement: CriterionStatement): CriterionSlot[] {
  const cwd = statement.command.arguments["cwd"];
  const argv = [...PROTECTED_LISTING.flags, ...statement.protected_paths];
  return [
    { slot: "criterion.protected.program", field: "program", index: null, value: PROTECTED_LISTING.program },
    ...argv.map((value, index): CriterionSlot => ({ slot: `criterion.protected.argv.${String(index)}`, field: "argv", index, value })),
    { slot: "criterion.protected.cwd", field: "cwd", index: null, value: typeof cwd === "string" ? cwd : (statement.protected_paths[0] ?? WORK_NAMESPACE) },
  ];
}

export type CriterionSlot = { readonly slot: string; readonly field: string; readonly index: number | null; readonly value: string | number | boolean };

export function criterionSlots(statement: CriterionStatement): CriterionSlot[] {
  return Object.entries(statement.command.arguments).flatMap(([field, value]): CriterionSlot[] =>
    Array.isArray(value)
      ? value.map((element, index) => ({ slot: `criterion.${field}.${String(index)}`, field, index, value: element }))
      : [{ slot: `criterion.${field}`, field, index: null, value }],
  );
}

export function grantChecks(grant: Grant, principal: string, env: AdmissionEnvironment, sources: readonly SourceRegistration[]): AdmissionFailure[] {
  const failures: AdmissionFailure[] = [];
  if (grant.principal !== principal) failures.push({ check: "3.2", message: `grant ${grant.id} belongs to ${grant.principal}, not the task's principal` });
  for (const id of grant.capability_selector.capabilities) {
    const capability = env.registry.capability(id);
    if (capability !== undefined && capability.side_effect !== "read" && grant.max_invocations === null) {
      failures.push({ check: "5.3", message: `grant ${grant.id} selects ${id} (side effect ${capability.side_effect}) and must set max_invocations` });
    }
  }
  for (const selector of grant.resource_scope) {
    // §5.3: a whole-filesystem scope needs an Override, which Slice 1 does not have. The whole capability namespace is that scope (D-061).
    if (selector.kind === "path" && selector.prefix === WORK_NAMESPACE) {
      failures.push({ check: "5.3", message: `grant ${grant.id} scopes the whole capability namespace ${WORK_NAMESPACE}; that needs an Override (§8), which Slice 1 does not have` });
    }
    // §5.4 check 4: whatever a grant reaches must lie within a referenced source with a declared class.
    if (!sources.some((source) => selectorWithin(selector, source.selector))) {
      failures.push({ check: "4", message: `grant ${grant.id} reaches ${JSON.stringify(selector)}, which lies within no source the task references` });
    }
  }
  return failures;
}

/** Runs the §5.4 checks on an admission request. Nothing is recorded here; the runner journals the result. */
export function admit(input: unknown, env: AdmissionEnvironment): AdmissionResult {
  const parsed = AdmissionRequest.safeParse(input);
  // Checks 6 and 7 (budget on all four axes, ttl) and the shapes of every field are the request schema.
  if (!parsed.success) return { admitted: false, failures: [{ check: "schema", message: parsed.error.message }] };
  const request = parsed.data;
  const failures: AdmissionFailure[] = [];
  const warnings: string[] = [];
  const fail = (check: string, message: string): void => {
    failures.push({ check, message });
  };

  if (request.id.startsWith(RESERVED_ID_PREFIX)) fail("id", `task ids under ${RESERVED_ID_PREFIX} are reserved for the runner's own records`);
  if (request.parent !== null) fail("3.1", "Slice 1 has no delegation between tasks, so a task has no parent");
  if (request.strategy !== DIRECT_STRATEGY) fail("4.1", `strategy ${request.strategy} is not available; Slice 1 has only ${DIRECT_STRATEGY}`);

  // Check 1.
  if (request.objective.trim() === "") fail("1", "the objective is missing");

  // Checks 2 and 3: the criterion's integrity is its author's; only an operator criterion with a method licenses `verified`.
  const criterion = request.criterion?.statement ?? null;
  const criterionIntegrity: Integrity = request.criterion === null ? "untrusted" : request.criterion.author === "operator" ? "operator" : "derived";
  if (request.verification !== null && request.verification !== COMMAND_EXIT_METHOD) fail("2", `verification method ${request.verification} is not available; Slice 1 has only ${COMMAND_EXIT_METHOD}`);
  if (request.verification !== null && criterion === null) fail("2", "a verification method needs a criterion to establish");
  const licensed = criterion !== null && request.verification !== null && criterionIntegrity === "operator";
  if (criterion !== null) {
    // D-057: the protected paths must be content the task's sources classify, and, for a task the verifier will
    // check, reachable by the listing under one of its grants.
    for (const path of criterion.protected_paths) {
      const selector = { kind: "path" as const, prefix: path };
      if (!request.sources.some((id) => env.sources.some((source) => source.id === id && selectorWithin(selector, source.selector)))) {
        fail("D-057", `protected path ${path} lies within no source the task references`);
      }
      const listable = request.grants.some((id) => {
        const grant = env.grants.get(id);
        return grant !== undefined && grant.capability_selector.capabilities.includes(PROTECTED_LISTING.capability) && grant.resource_scope.some((scope) => selectorWithin(selector, scope));
      });
      if (licensed && !listable) fail("D-057", `protected path ${path} lies within no grant for ${PROTECTED_LISTING.capability}, so the verifier could not list it`);
    }
    const listing = env.registry.entry(PROTECTED_LISTING.capability);
    const programs = listing?.capability.interface[listing.program_field]?.type;
    if (licensed && (programs?.kind !== "enum" || !programs.values.includes(PROTECTED_LISTING.program))) {
      fail("D-057", `${PROTECTED_LISTING.capability} with ${PROTECTED_LISTING.program} must be registered to check protected paths`);
    }
  }
  const closureMode: ClosureMode = request.closure_mode === "verified" && licensed ? "verified" : "accepted";
  if (request.closure_mode === "verified" && !licensed) {
    warnings.push(
      criterion === null || request.verification === null
        ? "admitted with closure_mode accepted: no criterion or no verification method (§5.1)"
        : "admitted with closure_mode accepted: the criterion is model-drafted (derived integrity) and cannot license verified closure (§3.4.4, §5.2)",
    );
  }
  if (criterion !== null) {
    const capability = env.registry.capability(criterion.command.capability);
    if (capability === undefined) fail("2", `the criterion's command names ${criterion.command.capability}, which is not registered`);
    else {
      const checked = callSchemaFor(capability.interface).safeParse(criterion.command.arguments);
      if (!checked.success) fail("2", `the criterion's command does not parse against ${capability.id}: ${checked.error.message}`);
    }
  }

  // Check 4: every referenced source is registered with a declared class (§1.5: unclassified is rejected).
  const sources: { id: string; selector: ResourceSelector; data_class: DataClass }[] = [];
  const sourceRegistrations: SourceRegistration[] = [];
  for (const id of request.sources) {
    const source = env.sources.find((candidate) => candidate.id === id);
    if (source === undefined) fail("4", `source ${id} is not registered`);
    else if (source.data_class === "unclassified") fail("4", `source ${id} is unclassified (§1.5)`);
    else {
      sources.push({ id: source.id, selector: source.selector, data_class: source.data_class });
      sourceRegistrations.push(source);
    }
  }

  // Grants: each must exist and satisfy §3.2 and §5.3; check 9 covers the capabilities they select.
  const scope = new Set<string>();
  if (criterion !== null) scope.add(criterion.command.capability);
  for (const id of request.grants) {
    const grant = env.grants.get(id);
    if (grant === undefined) {
      fail("3.2", `grant ${id} is not stored`);
      continue;
    }
    for (const capability of grant.capability_selector.capabilities) scope.add(capability);
    failures.push(...grantChecks(grant, request.principal, env, sourceRegistrations));
  }

  // Check 9: every capability in scope is registered and none of its adapters is quarantined.
  for (const id of scope) {
    const capability = env.registry.capability(id);
    if (capability === undefined) fail("9", `capability ${id} is not registered`);
    else {
      for (const provider of capability.providers) {
        if (env.registry.quarantined(id, provider) !== undefined) fail("9", `adapter ${provider} of ${id} is quarantined (§2.5)`);
      }
    }
  }

  // The floor starts at what admission put in front of the model: the operator's floor and every constant's class.
  let floor = request.sensitivity_floor;
  for (const constant of Object.values(request.constants)) floor = maxSensitivity(floor, constant.sensitivity ?? floor);

  // Checks 5, 8 and 10: route to a provider the policy permits at this floor, that offers native context
  // management when the task is native, and that offers full steering when live steering is required.
  const ownership = request.strategy === DIRECT_STRATEGY ? deriveContextOwnership(request.strategy) : "native";
  const requiresLiveSteer = request.requires_live_steer ?? request.attendance === "gated";
  const permitted = env.providers.filter((profile) => routable(request.model_policy, floor, profile));
  if (permitted.length === 0) fail("5", "no registered provider satisfies the model policy at this sensitivity and conversation_state constraint (§10.3)");
  const managed = ownership === "native" ? permitted.filter((profile) => profile.native_context_management) : permitted;
  if (permitted.length > 0 && managed.length === 0) fail("8", "the task is native, and no permitted provider offers native context management");
  const steerable = requiresLiveSteer ? managed.filter((profile) => deriveSteerCapability(ownership, profile) === "full") : managed;
  if (managed.length > 0 && steerable.length === 0) fail("10", "the task requires live steering, and no permitted provider offers steer_capability full");

  // Check 11.
  if (request.attendance === "autonomous" && request.grants.length === 0) warnings.push("autonomous task admitted with zero pre-issued grants; it will park at its first capability call (§3.1)");

  for (const slot of Object.keys(request.constants)) {
    if (slot.startsWith("criterion")) fail("2.6", `constant slot ${slot} uses the name reserved for the criterion's slots`);
  }

  const provider = steerable[0];
  if (failures.length > 0 || provider === undefined) return { admitted: false, failures };

  const task = Task.parse({
    id: request.id,
    principal: request.principal,
    objective: request.objective,
    criterion: criterion as Record<string, unknown> | null,
    criterion_integrity: criterionIntegrity,
    verification: request.verification,
    closure_mode: closureMode,
    attendance: request.attendance,
    strategy: request.strategy,
    sensitivity_floor: floor,
    context_ownership: ownership,
    model_policy: request.model_policy,
    budget: request.budget,
    ttl: request.ttl,
    grants: request.grants,
    parent: null,
    state: "admitted",
    runtime_substate: null,
    steer_capability: deriveSteerCapability(ownership, provider),
    requires_live_steer: requiresLiveSteer,
    trajectory: request.id,
  });
  const constants: Record<string, { value: string | number | boolean; data_class: DataClass }> = {};
  for (const [slot, constant] of Object.entries(request.constants)) {
    constants[slot] = { value: constant.value, data_class: { sensitivity: constant.sensitivity ?? floor, integrity: "operator" } };
  }
  if (criterion !== null) {
    for (const { slot, value } of [...criterionSlots(criterion), ...protectedSlots(criterion)]) constants[slot] = { value, data_class: { sensitivity: floor, integrity: criterionIntegrity } };
  }
  return { admitted: true, admission: { task, constants, criterion, provider, sources, warnings } };
}
