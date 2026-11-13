import { z } from "zod";
import {
  DataClass as DataClassSchema,
  ResourceSelector,
  Sensitivity as SensitivitySchema,
  type TrajectoryEntry,
  type DataClass,
  type FieldType,
  type Integrity,
  type Sensitivity,
  type Task,
  Task as TaskSchema,
  type TaskState,
  TaskState as TaskStateSchema,
  closureSchemaFor,
  compareIntegrity,
  compareSensitivity,
  join,
  maxSensitivity,
  minIntegrity,
  parseAtBoundary,
  pathWithin,
  raiseSensitivityFloor,
} from "../../contracts/src/index.js";
import {
  type Authorization,
  ENFORCEMENT_ACTOR,
  EnforcementBoundary,
  type GrantStore,
  type ParkDetail,
  type PathResolver,
  type RejectDetail,
  type TaskContext,
  type Verdict,
} from "../../enforcement/src/index.js";
import { type EntryDraft, JournalIntegrityError, canonicalJson, contentAddress, readPayload, readTrajectory } from "../../journal/src/index.js";
import { sameKey } from "../../journal/src/index.js";
import { type CapabilityRegistry, type InvocationResult, type RegistryEntry, programShape } from "../../registry/src/index.js";
import {
  type AdmissionResult,
  type AdmittedConstant,
  type AdmittedTask,
  type ConstantActor,
  ConstantActors,
  CriterionStatement,
  DEFAULT_REJECTION_LIMIT,
  RESERVED_ID_PREFIX,
  RejectionLimit,
  type SourceRegistration,
  admit,
  PROTECTED_LISTING,
  criterionSlots,
  grantChecks,
  hashSlots,
  pinFileSlot,
  protectedSlots,
  routable,
  verificationScope,
} from "./admission.js";
import { BUDGET_AXES, type CheckpointStore, type ContainerRuntime, type GovernedSession, ManifestEntry, SessionLayer, type SessionLimits, type Workspace, checkpointId, runtimeRefusal } from "../../enforcement/src/index.js";
import { type RestoreOutcome, restoreCheckpoint } from "./restore.js";
import { MAX_PINNED_FILES, PIN_HASH_BATCH, type Pin, changedPins, filesToHash, parseHashes, parseListing, pinsOf, within } from "./pins.js";
import { type BudgetAxis, NO_SPEND, type Spend } from "./budget.js";
import { type RunnerLock, acquireRunnerLock } from "./lock.js";
import { ProviderProfile } from "./profile.js";
import { type ContextItem, type Provider, type ProviderRequest, ProviderResponse, type ToolDefinition } from "./provider.js";
import { toProposal } from "./translate.js";

/**
 * The runner (spec §5, §6.1–6.2, §3.4.4; build plan Increment 5;
 * DECISIONS.md D-059 to D-064). It admits a task, then runs its turn loop:
 * assemble the context, call the provider, hand every capability call the
 * model proposes to the enforcement boundary, journal everything, repeat.
 *
 * The runner causes an effect only through the boundary: `authorize`, then
 * `perform` on the Authorization it returns. It never invokes or plans a
 * capability itself, so every effect passes the checks of §2.7.
 *
 * It parks on `awaiting_grant`, `integrity_floor`, `scope_violation`,
 * `sensitivity_ceiling`, `adapter_quarantined` (from the boundary),
 * `budget_exceeded` (any of the four axes) and `routing_unavailable`. TTL
 * expiry moves the task to `failed` with `ttl_expired` (§6.4, D-063).
 *
 * The model may claim the task is done; it cannot confer it (§6.1). On that
 * claim the runner runs the criterion's command and writes the closure
 * itself. The closure's `verifier_identity` must be none of the actors that
 * took part in executing the task, checked by the schema at write time.
 */

export const RUNNER_ACTOR = "juno.runner";
export const VERIFIER_ACTOR = "juno.verifier";
/** The runner's own record of adapter quarantines, so they survive a restart (D-064). */
export const REGISTRY_RECORD = `${RESERVED_ID_PREFIX}registry`;
/** The runner's own record of grant charges and of tasks it failed because their journal does not verify (D-066). */
export const RUNNER_RECORD = `${RESERVED_ID_PREFIX}runner`;

/** Parks the boundary produces and the runner adds (§6.2). */
export type ParkReason = ParkDetail["reason"] | "budget_exceeded" | "routing_unavailable" | "rejection_limit";

/** §8.3: a park is not overridable when the operator cannot observe the consequence of proceeding. */
export const NON_OVERRIDABLE: ReadonlySet<ParkReason> = new Set<ParkReason>(["integrity_floor", "adapter_quarantined"]);

export type RunOutcome = {
  readonly task_id: string;
  readonly state: TaskState;
  /** The park reason, or why the task ended. */
  readonly reason: string | null;
};

export type RunnerOptions = {
  /**
   * The shared session layer (D-193, D-194), opened by the shared start-up check for the runner service: it holds the
   * journal, and every admission, budget, rejection limit, park and journal record of every task goes through it. A
   * host resolver's root must be one of its workspaces.
   */
  readonly layer: SessionLayer;
  readonly registry: CapabilityRegistry;
  readonly grants: GrantStore;
  readonly providers: readonly Provider[];
  readonly sources: readonly SourceRegistration[];
  readonly clock?: () => Date;
  /** Who verifies. Defaults to `juno.verifier`; a closure naming an executing actor is refused (§3.4.4). */
  readonly verifierIdentity?: string;
  /** Resolves the paths a call names to their canonical forms where the effect will run (§2.7.1 C4, D-113). */
  readonly resolver: PathResolver;
  /**
   * Reversible workspaces (§2.2.2, D-136): where checkpoints are taken and restored (the workload, by the fixed scripts),
   * and the store outside every mount that keeps their content. Without them a task naming a reversible workspace fails
   * before its first turn.
   */
  readonly checkpoints?: { readonly workspace: Workspace; readonly store: CheckpointStore };
  /**
   * The container runtime the workloads run on, as `probeContainerRuntime` reports it (D-131, D-149). When given, a
   * runtime that would ignore the workload's limits stops the runner from starting. Every runner that starts real
   * workloads passes it.
   */
  readonly containerRuntime?: ContainerRuntime;
};

/** How the runner anchors journal heads off the host: its session layer's anchoring (§3.4.1, D-122, D-198). */
export type { Anchoring } from "../../enforcement/src/index.js";

export class RunnerError extends Error {
  override readonly name = "RunnerError";
}

/** A context item, its class, and the `seq` of the journal note that recorded it (§11.1 "possible sources"). */
type Contextual = { readonly item: ContextItem; readonly data_class: DataClass; readonly seq: number };

type TaskRun = {
  task: Task;
  readonly admission: AdmittedTask;
  /** `null` when a rebuilt task names a provider this runner does not serve; it cannot run until one does. */
  readonly provider: Provider | null;
  readonly admissionClass: DataClass;
  /** The shared session layer's session: its spend, budget, rejection count and journal (D-194). */
  readonly session: GovernedSession;
  readonly context: Contextual[];
  /** Every actor that took part in executing the task; none may verify it (§3.4.4, invariant 3). */
  readonly executingActors: Set<string>;
  turns: number;
  /**
   * The files the verifier hashes, found by the admission listing and fixed then as verifier constants, one slot each
   * (§2.6 "a template slot filled by the runtime", §5.1, D-112), with the listing result's class. `null` until taken.
   */
  pinFiles: { readonly files: readonly string[]; readonly data_class: DataClass } | null;
  /** The checkpoints of the task's reversible workspaces (§2.2.2, D-136), by root; empty until taken. */
  readonly checkpoints: Map<string, string>;
};

const QuarantineRecord = z.strictObject({ type: z.literal("quarantine"), capability: z.string(), adapter: z.string(), observation: z.string() });

const SpendRecord = z.strictObject({ tokens: z.number(), currency: z.number(), wall_clock_ms: z.number(), turns: z.number() });

/** What a rebuild reads from the runner's own notes, park and resume entries. Unknown fields are ignored. */
const Replayed = z.object({
  type: z.string().optional(),
  to: z.string().optional(),
  spent: SpendRecord.optional(),
  item: z.object({ role: z.enum(["system", "user", "assistant", "tool"]), content: z.unknown() }).optional(),
  data_class: DataClassSchema.optional(),
  added_grants: z.array(z.string()).optional(),
  removed_grants: z.array(z.string()).optional(),
});

const ParkRecord = z
  .object({
    reason: z.string(),
    tool_call: z.string().optional(),
    overridable: z.boolean().optional(),
    remedy: z.string().optional(),
    capability: z.string().optional(),
    detail: z.object({ grants: z.array(z.object({ outside: z.array(z.object({ path: z.string(), unresolved: z.string().optional() })) })).optional() }).optional(),
  })
  .transform((park) => ({ ...park, reason: park.reason as ParkReason }));

/** The park as resume reads it (§6.3, §8.2). */
type LastPark = {
  readonly seq: number;
  readonly reason: ParkReason;
  readonly tool_call: string | null;
  /** As recorded; `true` for a journal written before v0.6 that did not record it and whose reason is overridable. */
  readonly overridable: boolean;
  /** §8.2 (A2): `grant` when the park is cleared only by a grant covering the out-of-scope values, never by a plain resume. */
  readonly remedy: string | null;
  readonly capability: string | null;
  /** The out-of-scope paths of a `scope_violation`, over every candidate grant. */
  readonly outside: readonly { readonly path: string; readonly unresolved: boolean }[];
};

const AdmissionRecord = z.object({
  type: z.literal("admission"),
  outcome: z.literal("admitted"),
  admitted_at: z.iso.datetime(),
  task: TaskSchema,
  // A journal written before v0.6 records no actors: a criterion slot was the verifier's, every other constant the
  // executing actor's (§2.6 B1, D-111). Recorded actors are read as written.
  constants: z
    .record(z.string(), z.strictObject({ value: z.union([z.string(), z.number(), z.boolean()]), data_class: DataClassSchema, actors: ConstantActors.optional() }))
    .transform((constants) =>
      Object.fromEntries(
        Object.entries(constants).map(([slot, constant]) => [
          slot,
          { ...constant, actors: constant.actors ?? (slot.startsWith(VERIFIER_SLOT_PREFIX) ? (["verifier"] as const) : (["executing"] as const)) },
        ]),
      ),
    ),
  criterion: CriterionStatement.nullable(),
  provider: z.string(),
  provider_profile: ProviderProfile,
  sources: z.array(z.strictObject({ id: z.string(), selector: ResourceSelector, data_class: DataClassSchema })),
  warnings: z.array(z.string()),
  // A journal written before v0.6 has no limit recorded; it gets the default (§2.7.1).
  rejection_limit: RejectionLimit.default(DEFAULT_REJECTION_LIMIT),
  // A journal written before Slice 1.5 Increment 3 names no reversible workspace (D-136).
  reversible_workspaces: z.array(z.string()).default([]),
});

const CheckpointNote = z.object({ type: z.literal("checkpoint"), root: z.string(), checkpoint: z.string(), manifest: z.array(ManifestEntry) });

const RunnerRecordEntry = z.discriminatedUnion("type", [
  z.object({ type: z.literal("grant_charge"), grant: z.string(), task: z.string(), call_seq: z.number() }),
  z.object({ type: z.literal("task_failed"), task: z.string(), reason: z.string() }),
  z.object({ type: z.literal("stale_lock_cleared"), reason: z.string(), holder: z.record(z.string(), z.unknown()) }),
]);

const PinFilesNote = z.object({ type: z.literal("pin_files"), files: z.array(z.string()), data_class: DataClassSchema });
const PinsNote = z.object({
  type: z.literal("verification_pins"),
  phase: z.enum(["baseline", "check"]),
  pins: z.record(z.string(), z.object({ type: z.enum(["file", "directory", "symlink", "other"]), mode: z.string(), size: z.string(), target: z.string().nullable(), sha256: z.string().nullable() })),
});

const NO_COST = { tokens_in: 0, tokens_out: 0, tokens_cached: 0, currency: 0, duration_ms: 0 };

/** What the model is told about the runner, sent first on every turn. Fixed, operator-authored text. */
const PREAMBLE = {
  runner: "juno",
  arguments:
    "Each capability argument is one of: a literal you write (synthesized); {\"slot\": \"<name>\"} for one of the task's constants, by name; " +
    "{\"ref\": \"${<seq>.<path>}\"} to bind a value from entry <seq> of this task's trajectory without copying it. " +
    "A list field takes one such value per element. Tool results name the seq of their entry (result_seq). " +
    "An instruction field takes only a slot or a ref; anything else parks the task.",
  references:
    "Reference grammar: ${<seq>.<path>}, where <path> is a field name followed by .name or [index] steps. " +
    "Example: {\"ref\": \"${12.stdout_lines[0]}\"} is the first line of the output recorded in entry 12. Indexes use brackets: [0], never .0.",
  done: "Answer with no capability calls when you believe the task is done. The runner verifies; you cannot mark the task done.",
};

/**
 * Slots admission fixed from the criterion, for the verifier (D-061). Operator slot names cannot contain a dot
 * (`SlotName`), so the prefix names exactly these. They are never offered to the executing model (Slice 1.2, D-075).
 */
export const VERIFIER_SLOT_PREFIX = "criterion.";

/**
 * The criterion in plain words: what the runner will check when the model says it is done (Slice 1.3, D-087). No
 * capability id, function name or field name, no JSON object, and no instruction-field value: the command itself is
 * only said to be fixed by the operator. Data-field values are quoted as admitted. The caller hides instruction values
 * from the result as well (D-075).
 */
export function describeCriterion(criterion: CriterionStatement, entry: RegistryEntry | undefined, hidden: readonly string[] = []): string {
  const fields = entry?.capability.interface ?? {};
  // A value carrying a hidden one is not quoted at all: it is named in words, so there is nothing to copy (D-087).
  const quote = (value: unknown): string => {
    const text = JSON.stringify(value) ?? String(value);
    return hidden.some((item) => text.includes(item)) ? CRITERION_HIDDEN_WORDS : text;
  };
  const words = [
    "When you answer with no capability calls, the runner checks the work itself by running a check command that the operator fixed for this task.",
    "You do not run the check yourself, and you cannot see or change its command.",
  ];
  for (const [field, value] of Object.entries(criterion.command.arguments)) {
    if (fields[field]?.role !== "data") continue;
    if (entry !== undefined && field === programShape(entry)?.argv && Array.isArray(value)) {
      words.push(value.length === 0 ? "The check is given no arguments." : `The check is given ${value.length === 1 ? "the argument" : "the arguments"} ${value.map(quote).join(", ")}.`);
    } else if (entry !== undefined && field === programShape(entry)?.cwd) {
      words.push(`It runs in the folder ${quote(value)}.`);
    } else {
      words.push(`It is also given the value ${quote(value)}.`);
    }
  }
  words.push(`It passes when that command exits with code ${String(criterion.expect_exit_code)}.`);
  if (criterion.protected_paths.length > 0) {
    words.push(`These paths must be left exactly as they were when the task started, or the check fails: ${criterion.protected_paths.map(quote).join(", ")}.`);
  }
  // Fail-closed: anything hidden that is still in the text (a value in a sentence of its own) is replaced in words too.
  return hidden.reduce((text, item) => text.split(item).join(CRITERION_HIDDEN_WORDS), words.join(" "));
}

/** How the plain-words criterion names a hidden value: words, never a quoted placeholder that could be copied (D-087). */
export const CRITERION_HIDDEN_WORDS = "a value the operator fixed, which you are not shown";

const decoder = new TextDecoder("utf-8", { fatal: true });

function decodeOutput(bytes: Buffer): { text: string | null; base64: string | null } {
  try {
    return { text: decoder.decode(bytes), base64: null };
  } catch {
    return { text: null, base64: bytes.toString("base64") };
  }
}

function linesOf(text: string | null): string[] | null {
  if (text === null) return null;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export class Runner {
  readonly #layer: SessionLayer;
  readonly #registry: CapabilityRegistry;
  readonly #grants: GrantStore;
  readonly #providers: readonly Provider[];
  readonly #sources: readonly SourceRegistration[];
  readonly #clock: () => Date;
  readonly #verifier: string;
  readonly #boundary: EnforcementBoundary;
  readonly #resolver: PathResolver;
  readonly #checkpoints: RunnerOptions["checkpoints"];
  readonly #lock: RunnerLock;
  readonly #runs = new Map<string, TaskRun>();
  readonly #recordedQuarantines = new Set<string>();
  /** Tasks failed because their journal does not verify; never resumed (D-056). */
  readonly #unverifiable = new Map<string, string>();
  #active: string | null = null;

  /** Takes the journal's runner lock (one runner per journal) and reapplies the recorded quarantines. */
  constructor(options: RunnerOptions) {
    // D-194: only through the shared session layer, opened by the shared start-up check for the runner.
    this.#layer = SessionLayer.require(options.layer, "runner");
    this.#layer.requireGrants(options.grants);
    if (typeof options.resolver.hostRoot === "string") this.#layer.requireWorkspace("the resolver's host root", options.resolver.hostRoot);
    if (options.checkpoints !== undefined) {
      if (options.checkpoints.workspace.viewRoot !== "/work") this.#layer.requireWorkspace("the checkpointed workspace", options.checkpoints.workspace.viewRoot);
      this.#layer.requireState("the checkpoint store", options.checkpoints.store.root);
    }
    this.#registry = options.registry;
    this.#grants = options.grants;
    this.#providers = options.providers;
    this.#sources = options.sources;
    this.#clock = options.clock ?? (() => new Date());
    this.#verifier = options.verifierIdentity ?? VERIFIER_ACTOR;
    if (options.containerRuntime !== undefined) {
      const refusal = runtimeRefusal(options.containerRuntime);
      if (refusal !== null) throw new RunnerError(`the runner will not start: ${refusal}`);
    }
    this.#resolver = options.resolver;
    this.#checkpoints = options.checkpoints;
    // §3.4.1 V6-4: the operator key never enters the runner, so the journal key can never be it. The layer's anchoring
    // was checked when it opened (D-198); the grant store's key is checked here too.
    if (sameKey(this.#layer.anchoring.journalKey.publicKey, options.grants.trustAnchor)) throw new RunnerError("the journal key is the operator's grant-signing key; the runner must hold its own (§3.4.1)");
    this.#lock = acquireRunnerLock(this.#layer.root, this.#clock);
    try {
      this.#reapplyQuarantines();
      this.#rebuildRunnerRecord();
      // A lock cleared because its owner was provably dead is on the record (D-069).
      const cleared = this.#lock.cleared;
      if (cleared !== null) this.#append(RUNNER_RECORD, "note", { sensitivity: "internal", integrity: "derived" }, { type: "stale_lock_cleared", reason: cleared.reason, holder: { ...cleared.holder } });
    } catch (error: unknown) {
      this.#lock.release();
      throw error;
    }
    // The runner reaches capabilities only through this boundary.
    this.#boundary = this.#layer.boundary(this.#registry, this.#grants, this.#clock);
  }

  /** Releases the journal's runner lock. */
  close(): void {
    this.#lock.release();
  }

  task(id: string): Task | undefined {
    return this.#runs.get(id)?.task;
  }

  /** Spend so far, with the running time up to now. */
  spent(id: string): Spend | undefined {
    const run = this.#runs.get(id);
    return run?.session.spent();
  }

  /** Admission (§5). Every outcome is journalled under the task's id; a rejected task can never be admitted again under it. */
  admit(input: unknown): AdmissionResult {
    const id = typeof input === "object" && input !== null && "id" in input && typeof input.id === "string" ? input.id : null;
    const now = this.#clock();
    let result = admit(input, { registry: this.#registry, grants: this.#grants, providers: this.#providers.map((p) => p.profile), sources: this.#sources, now });
    if (id === null || id.startsWith(RESERVED_ID_PREFIX)) return result;
    let existing: boolean;
    try {
      existing = this.#runs.has(id) || readTrajectory(this.#layer.root, id).length > 0;
    } catch {
      existing = true;
    }
    if (existing) {
      const failure = { check: "id", message: `task ${id} already has a trajectory; an id is admitted once` };
      // Nothing is written to a trajectory that already exists.
      return { admitted: false, failures: [...(result.admitted ? [] : result.failures), failure] };
    }
    if (!result.admitted) {
      // Never run, never referenced: recorded at the most restrictive class.
      this.#layer.refuse(id, { failures: result.failures, request: input }, RUNNER_ACTOR);
      return result;
    }
    const { admission } = result;
    const provider = this.#providers.find((candidate) => candidate.profile.id === admission.provider.id);
    if (provider === undefined) throw new RunnerError(`provider ${admission.provider.id} vanished during admission`);
    const { task } = admission;
    // Everything admission records is operator input, except a model-drafted criterion (§5.2).
    const admissionClass: DataClass = {
      sensitivity: task.sensitivity_floor,
      integrity: admission.criterion === null ? "operator" : minIntegrity("operator", task.criterion_integrity),
    };
    const session = this.#layer.admit(task.id, this.#limits(task, admission.rejection_limit), { dataClass: admissionClass, actor: RUNNER_ACTOR, now: () => this.#clock().getTime(), payload: {
      admitted_at: now.toISOString(),
      task,
      criterion: admission.criterion,
      criterion_ref: admission.criterion === null ? null : contentAddress(canonicalJson(admission.criterion)),
      constants: admission.constants,
      provider: admission.provider.id,
      provider_profile: admission.provider,
      sources: admission.sources,
      warnings: admission.warnings,
      rejection_limit: admission.rejection_limit,
      reversible_workspaces: admission.reversible_workspaces,
    } });
    this.#runs.set(task.id, {
      task,
      admission,
      provider,
      admissionClass,
      session,
      context: [],
      executingActors: new Set([RUNNER_ACTOR, ENFORCEMENT_ACTOR]),
      turns: 0,
      pinFiles: null,
      checkpoints: new Map(),
    });
    result = { admitted: true, admission };
    return result;
  }

  /** Starts an admitted task and runs its turn loop until it parks or ends; its head is anchored when it stops (§3.4.1). */
  async run(id: string): Promise<RunOutcome> {
    return this.#anchoredOutcome(id, await this.#start(id));
  }

  async #start(id: string): Promise<RunOutcome> {
    const run = this.#runs.get(id);
    if (run === undefined) throw new RunnerError(`task ${id} was not admitted by this runner`);
    if (run.task.state !== "admitted") throw new RunnerError(`task ${id} is ${run.task.state}; only an admitted task starts (resume is Increment 6)`);
    // Slice 1 runs one task at a time (§18; concurrent tasks are out of scope).
    if (this.#active !== null) throw new RunnerError(`task ${this.#active} is running; this runner runs one task at a time`);
    this.#active = id;
    this.#setState(run, "running", "start");
    this.#pushContext(run, { role: "system", content: PREAMBLE }, { sensitivity: run.task.sensitivity_floor, integrity: "operator" });
    // The model is shown the constants by name only, and the criterion in plain words with its instruction-field values
    // hidden: a value it can read is a value it can copy as a literal, which parks (Slice 1.2, D-075), and a criterion
    // shown as a call invites the model to send it as one (Slice 1.3, D-087).
    this.#pushContext(
      run,
      {
        role: "user",
        content: {
          task_id: run.task.id,
          objective: run.task.objective,
          how_the_task_is_checked: this.#shownCriterion(run),
          constants: offeredConstants(run.admission.constants),
        },
      },
      run.admissionClass,
    );
    // §3.4.1 (D-122): the interval is recorded in the journal, and a task whose head cannot be anchored does not start.
    // The shared session layer journals the `anchoring` note and anchors the head, as in every mode (D-198).
    if (!(await run.session.anchor(this.#runnerClass(run), { force: true })) || !(await this.#layer.anchorHead(RUNNER_RECORD, { sensitivity: "internal", integrity: "derived" }))) {
      // The task never ran; the runner is free for the next one, as it is after a restart (D-203).
      this.#active = null;
      return this.#fail(run, "anchor_unavailable");
    }
    return this.#continue(run);
  }

  /**
   * Resumes a parked task (§6.3). A task this runner does not hold is rebuilt
   * from its journal first (§3.4.5: derived state is rebuildable from the
   * journal). On resume the task's grants are re-evaluated (expired, revoked or
   * otherwise unusable: re-park `awaiting_grant`), its model policy and
   * sensitivity floor against the provider (unservable: re-park
   * `routing_unavailable`), and its TTL, which counts parked time (expired:
   * `failed`). A `resume` entry records what was found. The operator may add
   * grants issued while the task was parked; each must pass admission's grant
   * rules, and may drop grants (which only narrows authority). A task parked on a park that is not overridable (§8.3) is never
   * resumed, and nor is one whose journal does not verify (D-056).
   */
  async resume(id: string, options: { readonly grants?: readonly string[]; readonly remove_grants?: readonly string[] } = {}): Promise<RunOutcome> {
    const outcome = await this.#resume(id, options);
    return outcome.reason === "journal_unverifiable" ? outcome : this.#anchoredOutcome(id, outcome);
  }

  async #resume(id: string, options: { readonly grants?: readonly string[]; readonly remove_grants?: readonly string[] }): Promise<RunOutcome> {
    if (this.#active !== null) throw new RunnerError(`task ${this.#active} is running; this runner runs one task at a time`);
    const failure = this.#unverifiable.get(id);
    if (failure !== undefined) return { task_id: id, state: "failed", reason: "journal_unverifiable" };
    const held = this.#runs.get(id);
    let run: TaskRun;
    if (held === undefined) {
      const loaded = this.#load(id);
      if (!loaded.ok) return { task_id: id, state: "failed", reason: loaded.reason };
      run = loaded.run;
    } else run = held;
    if (run.task.state !== "parked") throw new RunnerError(`task ${id} is ${run.task.state}; only a parked task resumes`);
    // TTL first (§6.4): an expired task fails whatever it is parked on, a non-overridable park included.
    if (this.#ttlExpired(run)) return this.#fail(run, "ttl_expired");
    const park = this.#lastPark(run);
    // §8.2: only a scope violation is cleared by a grant; any other park recorded not overridable is never resumed (§8.3).
    const grantRemedy = park !== null && park.reason === "scope_violation" && park.remedy === "grant";
    if (park !== null && !park.overridable && !grantRemedy) {
      throw new RunnerError(`task ${id} is parked ${park.reason}, which is not overridable (§8.3); it is never resumed. Remedy the cause and start a new task`);
    }

    const added = options.grants ?? [];
    if (added.length > 0) {
      const env = { registry: this.#registry, grants: this.#grants, providers: this.#providers.map((p) => p.profile), sources: this.#sources, now: this.#clock() };
      const problems = added.flatMap((grantId) => {
        const grant = this.#grants.signed(grantId);
        if (grant === undefined) {
          // §3.2 C1: an unsigned or forged grant does not exist (D-125).
          const message = this.#grants.get(grantId) === undefined ? `grant ${grantId} is not stored` : this.#grants.issuedBeforeRecovery(grantId) ? `grant ${grantId} was issued before this journal's recovery epoch, so it is refused; sign a new grant (D-206)` : `grant ${grantId} has no valid operator signature, so it does not exist (§3.2)`;
          return [{ check: "3.2", message }];
        }
        return grantChecks(grant, run.task.principal, env, run.admission.sources);
      });
      if (problems.length > 0) throw new RunnerError(`the grants added on resume do not pass admission's grant rules: ${JSON.stringify(problems)}`);
    }
    // Dropping a grant only narrows the task's authority, so it is always allowed (§7.4 rule 2's direction).
    const removed = options.remove_grants ?? [];
    const strays = removed.filter((grantId) => !run.task.grants.includes(grantId) || added.includes(grantId));
    if (strays.length > 0) throw new RunnerError(`grants to remove must be on the task and not also added: ${strays.join(", ")}`);
    const grants = [...run.task.grants, ...added.filter((grantId) => !run.task.grants.includes(grantId))].filter((grantId) => !removed.includes(grantId));
    if (park !== null && !park.overridable && grantRemedy) {
      // §8.2 (A2): no plain resume. The task must now hold a usable grant for the capability whose scope covers every
      // out-of-scope path the park recorded (D-109).
      const uncovered = await this.#uncoveredByGrants(run, grants, park);
      if (uncovered.length > 0) {
        throw new RunnerError(
          `task ${id} is parked scope_violation on an untrusted value, which is not overridden (§8.2): issue or widen a grant covering ${uncovered.join(", ")} and add it on resume`,
        );
      }
    }
    run.task = TaskSchema.parse({ ...run.task, grants });

    const now = this.#clock();
    const refused = this.#grants.validity(run.task, now);
    const provider = run.provider;
    const routing = provider !== null && routable(run.task.model_policy, run.task.sensitivity_floor, provider.profile);
    const status = run.task.grants.map((grantId) => ({
      grant: grantId,
      refused: refused.find((item) => item.grant === grantId)?.reason ?? null,
      invocations: this.#grants.invocations(grantId),
      expires_at: this.#grants.get(grantId)?.expires_at ?? null,
    }));
    // Everything up to the loop is synchronous; the task claims the runner only when it runs again (so a re-park leaves it free).
    this.#append(run.task.id, "resume", this.#runnerClass(run), {
      resumed_park_seq: park?.seq ?? null,
      parked_reason: park?.reason ?? null,
      added_grants: added,
      removed_grants: removed,
      grants: status,
      provider: provider?.profile.id ?? run.admission.provider.id,
      provider_available: provider !== null,
      routable: routing,
      sensitivity_floor: run.task.sensitivity_floor,
      ttl_remaining_ms: run.task.ttl - (now.getTime() - run.session.admittedAt),
      spent: run.session.spent(),
    });
    if (refused.length > 0) return this.#park(run, "awaiting_grant", this.#runnerClass(run), { phase: "resume", refused });
    if (!routing) {
      return this.#park(run, "routing_unavailable", this.#runnerClass(run), { phase: "resume", provider: run.admission.provider.id, sensitivity_floor: run.task.sensitivity_floor });
    }
    run.task = TaskSchema.parse({ ...run.task, state: "running", runtime_substate: "active" });
    run.session.startClock();
    // §2.7.1: the rejection count resets on resume.
    run.session.clearRejections();
    if (park !== null && park.tool_call !== null) {
      this.#pushContext(run, { role: "tool", content: { tool_call: park.tool_call, outcome: "parked", reason: park.reason, park_seq: park.seq, resumed: true } }, this.#runnerClass(run));
    }
    return this.#continue(run);
  }

  async #continue(run: TaskRun): Promise<RunOutcome> {
    if (this.#active !== null && this.#active !== run.task.id) throw new RunnerError(`task ${this.#active} is running; this runner runs one task at a time`);
    this.#active = run.task.id;
    try {
      // §2.2.2 (D-136): every reversible workspace is checkpointed before the task's first turn, so before its first
      // effect. A workspace that cannot be checkpointed is not reversible, and the task fails before any turn.
      for (const root of run.admission.reversible_workspaces) {
        if (run.checkpoints.has(root)) continue;
        const failure = await this.#checkpoint(run, root);
        if (failure !== null) return this.#fail(run, failure);
      }
      // §3.4.4 B2 / §5.1 (D-112): before the first turn of a task the verifier will check, pin its verification scope.
      // A task whose pinning parked has no pins yet, so they are taken when the task runs again (D-067).
      if (run.task.closure_mode === "verified" && run.admission.criterion !== null && this.#baselinePins(run) === null) {
        const baseline = await this.#pin(run, "baseline");
        if (!baseline.ok) return baseline.outcome;
        // Pins that were not taken protect nothing: the task fails before any turn (D-067, D-112).
        if (baseline.pins === null) return this.#fail(run, baseline.failure);
      }
      return await this.#loop(run);
    } finally {
      run.session.stopClock();
      this.#active = null;
    }
  }

  /**
   * Checkpoints one reversible workspace (§2.2.2, D-136): the root must be its own canonical form (a root reached through
   * a symlink is refused); every file's bytes go to the store; the manifest is journalled. Returns why it failed, or null.
   */
  async #checkpoint(run: TaskRun, root: string): Promise<string | null> {
    if (this.#checkpoints === undefined) return "checkpoint_unavailable";
    const resolved = (await this.#resolver.resolve([root])).get(root);
    if (resolved === undefined || !resolved.ok || resolved.canonical !== root) return "checkpoint_failed";
    const taken = await this.#checkpoints.workspace.list(root, true);
    if (!taken.ok) {
      this.#append(run.task.id, "note", this.#runnerClass(run), { type: "checkpoint_failed", root, reason: taken.reason });
      return "checkpoint_failed";
    }
    for (const bytes of taken.snapshot.contents.values()) this.#checkpoints.store.put(bytes);
    const checkpoint = checkpointId(root, taken.snapshot.manifest);
    this.#append(run.task.id, "note", this.#runnerClass(run), { type: "checkpoint", root, checkpoint, manifest: taken.snapshot.manifest });
    run.checkpoints.set(root, checkpoint);
    return null;
  }

  /**
   * The operator restores one of a task's checkpoints (§2.2.2, D-138): never while the task is running here. The outcome
   * is journalled in the task's trajectory, with the operator as its actor.
   */
  async restoreCheckpoint(id: string, checkpoint: string, principal: string): Promise<RestoreOutcome> {
    if (this.#active === id) throw new RunnerError(`task ${id} is running; a checkpoint is restored only while it is not (§2.2.2)`);
    if (this.#checkpoints === undefined) return { ok: false, reason: "no checkpoint store is configured" };
    return restoreCheckpoint(this.#layer, this.#checkpoints, id, checkpoint, principal);
  }

  /** The operator closes a task that completed unverified (§6, §6.1): `accepted`, the weakest closure; then anchors it. */
  async accept(id: string, principal: string): Promise<RunOutcome> {
    const run = this.#runs.get(id);
    if (run === undefined) throw new RunnerError(`task ${id} was not admitted by this runner`);
    if (run.task.state !== "complete_unverified") throw new RunnerError(`task ${id} is ${run.task.state}; only a complete_unverified task can be accepted`);
    if (principal !== run.task.principal) throw new RunnerError(`only the task's principal ${run.task.principal} can accept it`);
    this.#writeClosure(run, "accepted", "inconclusive", principal);
    this.#setState(run, "accepted", "operator_accepted");
    return this.#anchoredOutcome(id, this.#outcome(run, "operator_accepted"));
  }

  /**
   * Anchors the task's and the runner record's heads when a run stops (park or end, §3.4.1, D-122). A failure is
   * recorded in the journal by `#anchor` and leaves the outcome unchanged: the task has already stopped, and
   * `juno journal check` reports the entries after the last anchor as not yet protected.
   */
  async #anchoredOutcome(id: string, outcome: RunOutcome): Promise<RunOutcome> {
    await this.#anchorRecords(id);
    return outcome;
  }

  /** Anchors a task's head and the runner record's head; false when either could not be anchored. */
  async #anchorRecords(taskId: string): Promise<boolean> {
    const task = await this.#anchor(taskId);
    const record = await this.#anchor(RUNNER_RECORD);
    return task && record;
  }

  /** Copies one journal record's head off the host through the shared session layer (§3.4.1, D-122, D-198). */
  #anchor(recordId: string): Promise<boolean> {
    const dataClass = recordId === RUNNER_RECORD ? { sensitivity: "internal" as const, integrity: "derived" as const } : this.#recordClass(recordId);
    return this.#layer.anchorHead(recordId, dataClass);
  }

  /** Whether a running task is due an anchor: its interval has passed since the last one (§3.4.1). */
  #anchorDue(taskId: string): boolean {
    return this.#layer.anchorDue(taskId);
  }

  #recordClass(taskId: string): DataClass {
    const run = this.#runs.get(taskId);
    return run === undefined ? { sensitivity: "internal", integrity: "derived" } : this.#runnerClass(run);
  }

  async #loop(run: TaskRun): Promise<RunOutcome> {
    for (;;) {
      if (this.#ttlExpired(run)) return this.#fail(run, "ttl_expired");
      // §3.4.1 (D-122): at most one interval passes between anchors; a running task whose head cannot be anchored stops.
      if (this.#anchorDue(run.task.id) && !(await this.#anchorRecords(run.task.id))) return this.#fail(run, "anchor_unavailable");
      const before = run.session.exhausted();
      if (before.length > 0) return this.#budgetPark(run, before);
      const provider = run.provider;
      if (provider === null || !routable(run.task.model_policy, run.task.sensitivity_floor, provider.profile)) {
        return this.#park(run, "routing_unavailable", this.#runnerClass(run), { provider: run.admission.provider.id, sensitivity_floor: run.task.sensitivity_floor });
      }

      const request = this.#assemble(run, provider);
      const turnClass = join([{ sensitivity: run.task.sensitivity_floor, integrity: "derived" }, ...run.context.map((entry) => entry.data_class)]);
      run.session.charge({ turns: 1 });
      run.turns += 1;
      const started = this.#clock().getTime();
      let raw: unknown;
      try {
        raw = await provider.complete(request);
      } catch (error: unknown) {
        return this.#park(run, "routing_unavailable", this.#runnerClass(run), {
          provider: provider.profile.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const duration = Math.max(0, this.#clock().getTime() - started);
      const parsed = ProviderResponse.safeParse(raw);
      const usage = parsed.success ? parsed.data.usage : { tokens_in: 0, tokens_out: 0, tokens_cached: 0 };
      const { cost } = provider.profile;
      const currency = usage.tokens_in * cost.per_token_in + usage.tokens_out * cost.per_token_out + usage.tokens_cached * cost.per_token_cached;
      run.session.charge({ tokens: usage.tokens_in + usage.tokens_out + usage.tokens_cached, currency });
      run.executingActors.add(provider.profile.model);
      const turnSeq = this.#append(
        run.task.id,
        "turn",
        turnClass,
        {
          turn: run.turns,
          provider: provider.profile.id,
          model: provider.profile.model,
          model_version: provider.profile.model_version,
          request,
          request_hash: contentAddress(canonicalJson(request)),
          response: parsed.success ? parsed.data : null,
          malformed: parsed.success ? null : parsed.error.message,
          // What the provider returned when it could not be read, for example its refusal of the turn (D-077). The
          // provider adapter scrubs its key from everything it returns (D-073); the text is bounded.
          unread: parsed.success ? null : unreadText(raw),
        },
        { tokens_in: usage.tokens_in, tokens_out: usage.tokens_out, tokens_cached: usage.tokens_cached, currency, duration_ms: duration },
        provider.profile.model,
        provider.profile.id,
      );
      if (!parsed.success) {
        this.#pushContext(run, { role: "user", content: { turn_seq: turnSeq, error: "the runner could not read that turn", detail: parsed.error.message } }, turnClass);
        // A turn the runner cannot read counts as one rejection and never resets the count (§2.7.1, D-102).
        const counted = run.session.reject({ kind: "unreadable_turn", seq: turnSeq }, (marks) => this.#rejectionPark(run, marks, turnClass, { turn_seq: turnSeq, not_acted_on: [] }));
        if (counted.parked) return counted.result;
        continue;
      }
      const response = parsed.data;
      this.#pushContext(run, { role: "assistant", content: { turn_seq: turnSeq, text: response.text, tool_calls: response.tool_calls } }, turnClass);

      const overrun = run.session.overrun();
      if (overrun.length > 0) return this.#budgetPark(run, overrun, { turn_seq: turnSeq, not_acted_on: response.tool_calls.map((call) => call.id) });
      if (response.tool_calls.length === 0) return this.#complete(run, turnSeq);

      for (const [index, call] of response.tool_calls.entries()) {
        const rest = response.tool_calls.slice(index + 1).map((later) => later.id);
        if (this.#ttlExpired(run)) return this.#fail(run, "ttl_expired");
        const clock = run.session.exhausted(["wall_clock_ms"]);
        if (clock.length > 0) return this.#budgetPark(run, clock, { turn_seq: turnSeq, not_acted_on: [call.id, ...rest] });

        const verdict = await this.#authorize(run, toProposal(call), turnClass.sensitivity, "executing");
        if (verdict.outcome === "park") return this.#boundaryPark(run, verdict, call.capability, { tool_call: call.id, not_acted_on: rest });
        if (verdict.outcome === "reject") {
          // The rejection's text can name an instruction field's allowed values (for example a registry message listing
          // the program enum); the model is shown it with those values hidden (D-075). The journal keeps the full detail.
          const shown = hideValues(rejection(call.id, verdict.call_seq, verdict.detail), this.#instructionValues(run));
          this.#pushContext(run, { role: "tool", content: shown }, this.#entryClass(run.task.id, verdict.call_seq));
          const counted = run.session.reject({ kind: "call", seq: verdict.call_seq }, (marks) => this.#rejectionPark(run, marks, this.#entryClass(run.task.id, verdict.call_seq), { call_seq: verdict.call_seq, tool_call: call.id, not_acted_on: rest }));
          if (counted.parked) return counted.result;
          continue;
        }
        // §2.7.1: the rejection count resets when a call proceeds.
        run.session.clearRejections();
        const { seq, dataClass, payload } = await this.#perform(run, verdict.authorization);
        for (const actor of [verdict.authorization.adapter]) run.executingActors.add(actor);
        this.#pushContext(run, { role: "tool", content: { tool_call: call.id, call_seq: verdict.call_seq, result_seq: seq, ...payload } }, dataClass);
      }
    }
  }

  /** The model claims the task is done. It cannot confer completion (§6.1): the runner verifies, or records it unverified. */
  async #complete(run: TaskRun, turnSeq: number): Promise<RunOutcome> {
    const criterion = run.admission.criterion;
    if (run.task.closure_mode !== "verified" || criterion === null) {
      this.#setState(run, "complete_unverified", "model_claimed_done", { turn_seq: turnSeq });
      return this.#outcome(run, "model_claimed_done");
    }
    return this.#verify(run, criterion, turnSeq);
  }

  /**
   * Runs the criterion's command (§3.4.4, D-062). Every argument is a constant
   * slot the criterion fixed at admission, so the call goes through the same
   * boundary as any other, under the task's grants.
   */
  async #verify(run: TaskRun, criterion: CriterionStatement, turnSeq: number): Promise<RunOutcome> {
    if (this.#ttlExpired(run)) return this.#fail(run, "ttl_expired");
    const args: Record<string, unknown> = {};
    for (const { slot, field, index } of criterionSlots(criterion)) {
      const source = { class: "constant", slot };
      if (index === null) args[field] = source;
      else ((args[field] ??= []) as unknown[])[index] = source;
    }
    for (const [field, value] of Object.entries(criterion.command.arguments)) if (Array.isArray(value) && value.length === 0) args[field] = [];
    this.#append(run.task.id, "note", this.#runnerClass(run), { type: "verification", phase: "start", method: run.task.verification, claimed_at_turn: turnSeq });

    const verdict = await this.#authorize(run, { capability: criterion.command.capability, arguments: args }, run.task.sensitivity_floor, "verifier");
    if (verdict.outcome === "park") {
      return this.#boundaryPark(run, verdict, criterion.command.capability, { phase: "verification" });
    }
    let result: "pass" | "fail" | "inconclusive" = "inconclusive";
    let resultSeq: number | null = null;
    let exitCode: number | null = null;
    let protectedPaths: "unchanged" | "changed" | null = null;
    let inputs: "unchanged" | "changed" | null = null;
    let changedPaths: string[] = [];
    if (verdict.outcome === "proceed") {
      const performed = await this.#perform(run, verdict.authorization);
      resultSeq = performed.seq;
      exitCode = performed.exitCode;
      if (performed.exitCode !== null) result = performed.exitCode === criterion.expect_exit_code ? "pass" : "fail";
    }
    if (result === "pass") {
      // §3.4.4 B2 (D-112): verification fails if any pinned path changed: a verification input, or anything under a
      // protected path (D-057).
      const check = await this.#pin(run, "check");
      if (!check.ok) return check.outcome;
      const baseline = this.#baselinePins(run);
      if (check.pins === null || baseline === null) {
        // Pins that were not taken cannot show anything is unchanged (D-067).
        result = "inconclusive";
      } else {
        changedPaths = changedPins(baseline, check.pins);
        inputs = changedPaths.length === 0 ? "unchanged" : "changed";
        protectedPaths = changedPaths.some((path) => criterion.protected_paths.some((prefix) => within(path, prefix))) ? "changed" : "unchanged";
        if (inputs === "changed") result = "fail";
      }
    }
    this.#append(run.task.id, "note", this.#runnerClass(run), {
      type: "verification",
      phase: "result",
      result,
      call_seq: verdict.call_seq,
      result_seq: resultSeq,
      exit_code: exitCode,
      expected_exit_code: criterion.expect_exit_code,
      protected_paths: protectedPaths,
      inputs,
      changed_paths: changedPaths,
      rejected: verdict.outcome === "reject" ? verdict.detail.reason : null,
    });
    if (result !== "pass") return this.#fail(run, `verification_${result}`);
    try {
      this.#writeClosure(run, "verified", "pass", this.#verifier);
    } catch (error: unknown) {
      // The closure was refused (§3.4.4): the task never becomes verified, and its trajectory ends in a terminal state.
      this.#setState(run, "failed", "closure_refused", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    this.#setState(run, "verified", "verification_pass");
    return this.#outcome(run, "verification_pass");
  }

  /**
   * Lists the criterion's protected paths through the boundary, every argument a constant the criterion fixed
   * (D-057, D-067). A park parks the task; a rejection fails it, since the verifier then cannot check them.
   */
  async #listProtected(
    run: TaskRun,
    phase: "baseline" | "check",
  ): Promise<{ ok: true; listing: Record<string, unknown>; result_seq: number } | { ok: false; outcome: RunOutcome }> {
    const criterion = run.admission.criterion;
    if (criterion === null) throw new RunnerError(`task ${run.task.id} has no criterion`);
    const args: Record<string, unknown> = {};
    for (const { slot, field, index } of protectedSlots(criterion, this.#registry.entry(criterion.command.capability))) {
      const source = { class: "constant", slot };
      if (index === null) args[field] = source;
      else ((args[field] ??= []) as unknown[])[index] = source;
    }
    const verdict = await this.#authorize(run, { capability: PROTECTED_LISTING.capability, arguments: args }, run.task.sensitivity_floor, "verifier");
    if (verdict.outcome === "park") {
      return { ok: false, outcome: this.#boundaryPark(run, verdict, PROTECTED_LISTING.capability, { phase: ["protected", phase].join("_") }) };
    }
    if (verdict.outcome === "reject") return { ok: false, outcome: this.#fail(run, "protected_listing_rejected") };
    const performed = await this.#perform(run, verdict.authorization);
    const listing = listingOf(performed.payload);
    this.#append(run.task.id, "note", this.#runnerClass(run), { type: "protected_listing", phase, call_seq: verdict.call_seq, result_seq: performed.seq });
    return { ok: true, listing, result_seq: performed.seq };
  }

  /**
   * Pins the verification scope (§3.4.4 B2, D-097, D-112): the listing, then `sha256sum -z` over the pinned files in
   * batches, every argument a verifier constant. At the baseline the files to hash are fixed from the listing; at the
   * check the same files are hashed again, and the listing shows anything added or removed. Returns the pins, or `null`
   * with the reason the task fails when they could not be taken; a park parks the task.
   */
  async #pin(
    run: TaskRun,
    phase: "baseline" | "check",
  ): Promise<{ ok: true; pins: Record<string, Pin>; failure?: undefined } | { ok: true; pins: null; failure: string } | { ok: false; outcome: RunOutcome }> {
    const criterion = run.admission.criterion;
    if (criterion === null) throw new RunnerError(`task ${run.task.id} has no criterion`);
    const listed_ = await this.#listProtected(run, phase);
    if (!listed_.ok) return listed_;
    if (!listed(listed_.listing)) return { ok: true, pins: null, failure: "protected_listing_failed" };
    const roots = verificationScope(criterion, this.#registry.entry(criterion.command.capability));
    const parsed = parseListing(String(listed_.listing["stdout"]), roots);
    if (!parsed.ok) return this.#pinsFailed(run, phase, parsed.reason);
    if (phase === "baseline") {
      const files = filesToHash(parsed.entries, criterion.outputs);
      if (files.length > MAX_PINNED_FILES) return this.#pinsFailed(run, phase, `the verification scope has more than ${String(MAX_PINNED_FILES)} files to pin`);
      // Fixed now, before the first turn, as part of admission's pins (§5.1); journalled so a rebuilt task hashes the same files.
      run.pinFiles = { files, data_class: this.#entryClass(run.task.id, listed_.result_seq) };
      this.#append(run.task.id, "note", this.#runnerClass(run), { type: "pin_files", files, data_class: run.pinFiles.data_class });
    }
    const files = run.pinFiles?.files ?? [];
    const hashes = new Map<string, string>();
    for (let start = 0; start < files.length; start += PIN_HASH_BATCH) {
      const argv: unknown[] = hashSlots(criterion, this.#registry.entry(criterion.command.capability))
        .filter((slot) => slot.field === "argv")
        .map((slot) => ({ class: "constant", slot: slot.slot }));
      for (let index = start; index < Math.min(files.length, start + PIN_HASH_BATCH); index += 1) argv.push({ class: "constant", slot: pinFileSlot(index) });
      const args = { program: { class: "constant", slot: "criterion.pin.program" }, argv, cwd: { class: "constant", slot: "criterion.pin.cwd" } };
      const verdict = await this.#authorize(run, { capability: PROTECTED_LISTING.capability, arguments: args }, run.task.sensitivity_floor, "verifier");
      if (verdict.outcome === "park") {
        return { ok: false, outcome: this.#boundaryPark(run, verdict, PROTECTED_LISTING.capability, { phase: ["pin", phase].join("_") }) };
      }
      if (verdict.outcome === "reject") return this.#pinsFailed(run, phase, `the hashing call was rejected: ${verdict.detail.reason}`);
      const performed = await this.#perform(run, verdict.authorization);
      this.#append(run.task.id, "note", this.#runnerClass(run), { type: "pin_hash", phase, call_seq: verdict.call_seq, result_seq: performed.seq });
      const stdout = performed.payload["stdout"];
      if (typeof stdout === "string") for (const [path, hash] of parseHashes(stdout)) hashes.set(path, hash);
    }
    const pins = pinsOf(parsed.entries, hashes, criterion.outputs);
    this.#append(run.task.id, "note", this.#runnerClass(run), { type: "verification_pins", phase, roots, outputs: criterion.outputs, pins });
    return { ok: true, pins };
  }

  #pinsFailed(run: TaskRun, phase: "baseline" | "check", reason: string): { ok: true; pins: null; failure: string } {
    this.#append(run.task.id, "note", this.#runnerClass(run), { type: "verification_pins", phase, failed: reason });
    return { ok: true, pins: null, failure: "verification_pins_failed" };
  }

  /** The pins taken at admission, read back from the journal so a rebuilt task is checked against the same record. */
  #baselinePins(run: TaskRun): Record<string, Pin> | null {
    let pins: Record<string, Pin> | null = null;
    for (const entry of readTrajectory(this.#layer.root, run.task.id)) {
      if (entry.kind !== "note") continue;
      const note = PinsNote.safeParse(this.#payloadOf(entry.payload_ref));
      if (note.success && note.data.phase === "baseline") pins = note.data.pins;
    }
    return pins;
  }

  /** The closure (§3.4.4), written by the runner and checked against its executing actors at write time. */
  #writeClosure(run: TaskRun, mode: "verified" | "accepted", result: "pass" | "inconclusive", verifier: string): void {
    const { task, admission } = run;
    const closure = parseAtBoundary("closure", closureSchemaFor([...run.executingActors]), {
      task_id: task.id,
      criterion_ref: admission.criterion === null ? null : contentAddress(canonicalJson(admission.criterion)),
      criterion_integrity: task.criterion_integrity,
      verification_method: task.verification,
      verification_result: result,
      closure_mode: mode,
      verifier_identity: verifier,
      replay_fidelity: run.provider?.profile.replay_fidelity ?? "none",
      artifacts: [],
      cost_actual: { ...run.session.spent() },
    });
    this.#append(task.id, "note", this.#runnerClass(run), { type: "closure", closure });
  }

  /**
   * Judges one call through the boundary. Only the constants fixed for `actor` are resolvable (§2.6, v0.6 B1): the
   * executing model naming a verifier constant is an unresolved reference, a rejection (§2.7.1).
   */
  async #authorize(run: TaskRun, proposal: unknown, sensitivity: Sensitivity, actor: ConstantActor): Promise<Verdict> {
    const constants: Record<string, AdmittedConstant> = Object.fromEntries(Object.entries(run.admission.constants).filter(([, constant]) => constant.actors.includes(actor)));
    if (actor === "verifier" && run.pinFiles !== null) {
      for (const [index, path] of run.pinFiles.files.entries()) constants[pinFileSlot(index)] = { value: path, data_class: run.pinFiles.data_class, actors: ["verifier"] };
    }
    // §2.2.2 (D-135): the task's checkpointed workspaces are the only reversible ones.
    const base: TaskContext = { task: run.task, constants, synthesis: { sensitivity }, reversible: [...run.checkpoints.keys()] };
    // §2.7.1 C4 (D-113): the paths the call names are resolved where the effect will run, then the boundary judges them.
    const canonical = await this.#resolver.resolve(this.#boundary.pathsToResolve(base, proposal));
    const context: TaskContext = { ...base, canonical };
    const verdict = this.#boundary.authorize(context, proposal);
    this.#recordQuarantines();
    return verdict;
  }

  /** Performs an authorized call through the boundary and journals its result (§2.1 `output_class`). */
  async #perform(run: TaskRun, authorization: Authorization): Promise<{ seq: number; dataClass: DataClass; exitCode: number | null; payload: Record<string, unknown> }> {
    const capability = this.#registry.capability(authorization.capability);
    if (capability === undefined) throw new RunnerError(`capability ${authorization.capability} is no longer registered`);
    // The charge is made durable before the effect, so a restart never under-counts a grant (D-066).
    this.#append(RUNNER_RECORD, "note", { sensitivity: "internal", integrity: "derived" }, { type: "grant_charge", grant: authorization.grant, task: run.task.id, call_seq: authorization.call_seq });
    const started = this.#clock().getTime();
    let result: InvocationResult | null = null;
    let error: string | null = null;
    try {
      result = await this.#boundary.perform(authorization);
    } catch (failure: unknown) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    const duration = Math.max(0, this.#clock().getTime() - started);
    const rule = capability.output_class;
    let sensitivity = rule.sensitivity === "input" ? authorization.input_class.sensitivity : rule.sensitivity;
    // The output carries what was read: every source the task references (§1.3, D-063).
    for (const source of run.admission.sources) sensitivity = maxSensitivity(sensitivity, source.data_class.sensitivity);
    const integrity: Integrity = compareIntegrity(rule.integrity, authorization.input_class.integrity) <= 0 ? rule.integrity : authorization.input_class.integrity;
    const dataClass: DataClass = { sensitivity, integrity };
    const stdout = result === null ? null : decodeOutput(result.stdout);
    const stderr = result === null ? null : decodeOutput(result.stderr);
    const payload: Record<string, unknown> =
      result === null
        ? { capability: authorization.capability, adapter: authorization.adapter, error }
        : {
            capability: authorization.capability,
            adapter: authorization.adapter,
            exit_code: result.exitCode,
            signal: result.signal,
            stdout: stdout?.text ?? null,
            stdout_lines: linesOf(stdout?.text ?? null),
            stdout_base64: stdout?.base64 ?? null,
            stderr: stderr?.text ?? null,
            stderr_base64: stderr?.base64 ?? null,
          };
    const seq = this.#append(
      run.task.id,
      "capability_result",
      dataClass,
      { call_seq: authorization.call_seq, ...payload },
      { ...NO_COST, duration_ms: duration },
      authorization.adapter,
      authorization.adapter,
    );
    this.#raiseFloor(run, sensitivity, seq);
    return { seq, dataClass, exitCode: result?.exitCode ?? null, payload };
  }

  /** §1.2: reading material raises the task's sensitivity floor, permanently. */
  #raiseFloor(run: TaskRun, exposure: Sensitivity, causeSeq: number): void {
    const from = run.task.sensitivity_floor;
    const to = raiseSensitivityFloor(from, exposure);
    if (to === from) return;
    run.task = TaskSchema.parse({ ...run.task, sensitivity_floor: to });
    this.#append(run.task.id, "note", this.#runnerClass(run), { type: "sensitivity_floor", from, to, cause_seq: causeSeq });
  }

  /**
   * Parks on a boundary verdict, whoever made the call: the executing model, or the verifier checking the criterion,
   * listing or hashing (§6.2). §8.2 (A2): a scope violation caused by an untrusted value is cleared only by a grant,
   * never by a plain resume, on every one of these paths (D-109). The park names the capability, so a resume can check
   * a grant covers the parked paths, and the source of each value that caused it (§11.1).
   */
  #boundaryPark(run: TaskRun, verdict: Extract<Verdict, { outcome: "park" }>, capability: string, extra: Record<string, unknown>): RunOutcome {
    const grantOnly = verdict.detail.reason === "scope_violation" && verdict.detail.untrusted.length > 0;
    return this.#park(
      run,
      verdict.detail.reason,
      this.#entryClass(run.task.id, verdict.call_seq),
      { call_seq: verdict.call_seq, capability, ...extra, detail: verdict.detail, sources: this.#parkSources(run, verdict.call_seq, verdict.detail) },
      grantOnly ? "grant" : null,
    );
  }

  /** §2.7.1 (A4): the limit's worth of consecutive rejections parks `rejection_limit` (overridable, §6.2), naming each one. */
  #rejectionPark(run: TaskRun, marks: readonly { readonly kind: string; readonly seq: number | null }[], dataClass: DataClass, extra: Record<string, unknown>): RunOutcome {
    return this.#park(run, "rejection_limit", dataClass, { limit: run.admission.rejection_limit, rejections: [...marks], ...extra });
  }

  #budgetPark(run: TaskRun, axes: readonly BudgetAxis[], extra: Record<string, unknown> = {}): RunOutcome {
    return this.#park(run, "budget_exceeded", this.#runnerClass(run), { axes, spent: run.session.spent(), budget: run.task.budget, ...extra });
  }

  #park(run: TaskRun, reason: ParkReason, dataClass: DataClass, detail: Record<string, unknown>, remedy: "grant" | null = null): RunOutcome {
    run.session.stopClock();
    const entryClass = join([dataClass, this.#runnerClass(run)]);
    // §8.2 (A2): a park whose only remedy is a grant is not overridden; §8.3: some reasons never are (the shared layer
    // applies them). The layer journals the park and resets the rejection count (§2.7.1; the task stops either way).
    run.session.park(reason, remedy === null, entryClass, RUNNER_ACTOR, { ...(remedy === null ? {} : { remedy }), from: run.task.state, ...detail, spent: run.session.spent() });
    run.task = TaskSchema.parse({ ...run.task, state: "parked", runtime_substate: null });
    return this.#outcome(run, reason);
  }

  /** The limits the shared layer enforces for a task in JUNO's own loop: all four budget axes, wall clock only while running (§3.1, D-025). */
  #limits(task: Task, rejectionLimit: number): SessionLimits {
    return { rejection_limit: rejectionLimit, ttl: task.ttl, budget: task.budget, metered: BUDGET_AXES, clock: "while_running" };
  }

  #fail(run: TaskRun, reason: string): RunOutcome {
    this.#setState(run, "failed", reason);
    return this.#outcome(run, reason);
  }

  #setState(run: TaskRun, to: TaskState, reason: string, extra: Record<string, unknown> = {}): void {
    const from = run.task.state;
    if (to !== "running") run.session.stopClock();
    this.#append(run.task.id, "note", this.#runnerClass(run), { type: "state", from, to, reason, ...extra, spent: run.session.spent() });
    run.task = TaskSchema.parse({ ...run.task, state: to, runtime_substate: to === "running" ? "active" : null });
    if (to === "running") run.session.startClock();
  }

  #outcome(run: TaskRun, reason: string | null): RunOutcome {
    return { task_id: run.task.id, state: run.task.state, reason };
  }

  #assemble(run: TaskRun, provider: Provider): ProviderRequest {
    const tools: ToolDefinition[] = this.#registry
      .capabilities()
      .map((capability) => ({ capability: capability.id, interface: capability.interface, slots: slotOffers(capability.interface, run.admission.constants, this.#declaredInstructionValues()) }));
    return { model: provider.profile.model, context: run.context.map((entry) => entry.item), tools };
  }

  /**
   * The instruction-field values the model must not be shown in the runner's own messages (D-075): every allowed value
   * of every registered instruction field that is an enum. If an instruction field takes free text, any constant could
   * fill it, so every constant's value is hidden too. Longest first, so no value is left half-hidden.
   */
  #instructionValues(run: TaskRun): string[] {
    const values = new Set<string>(this.#declaredInstructionValues());
    let freeText = false;
    for (const capability of this.#registry.capabilities()) {
      for (const field of Object.values(capability.interface)) if (field.role === "instruction" && field.type.kind !== "enum") freeText = true;
    }
    if (freeText) for (const constant of Object.values(run.admission.constants)) if (typeof constant.value === "string" && constant.value.length > 0) values.add(constant.value);
    return [...values].sort((a, b) => b.length - a.length);
  }

  /** Every allowed value of every registered instruction field that is an enum: what the registry declares as instruction values. */
  #declaredInstructionValues(): Set<string> {
    const values = new Set<string>();
    for (const capability of this.#registry.capabilities()) {
      for (const field of Object.values(capability.interface)) {
        if (field.role === "instruction" && field.type.kind === "enum") for (const value of field.type.values) values.add(value);
      }
    }
    return values;
  }

  /**
   * The criterion as the model is shown it: plain words saying what will be checked (D-087), never a call or anything
   * shaped like one, and never an instruction-field value (D-075). Data-field values appear as admitted.
   */
  #shownCriterion(run: TaskRun): string | null {
    const criterion = run.admission.criterion;
    if (criterion === null) return null;
    const entry = this.#registry.entry(criterion.command.capability);
    const fields = entry?.capability.interface ?? {};
    // The criterion's own non-data values are hidden too, whatever the registry declares (fail-closed).
    const own = Object.entries(criterion.command.arguments)
      .filter(([field]) => fields[field]?.role !== "data")
      .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const hidden = [...new Set([...this.#instructionValues(run), ...own])].sort((a, b) => b.length - a.length);
    return describeCriterion(criterion, entry, hidden);
  }

  /** TTL is wall time since admission, parked time included (§6.4, D-025). */
  #ttlExpired(run: TaskRun): boolean {
    return run.session.expired();
  }

  /** Runner-written facts: never more trusted than `derived`, so no bound reference can lift text into an instruction field through them. */
  #runnerClass(run: TaskRun): DataClass {
    return { sensitivity: run.task.sensitivity_floor, integrity: "derived" };
  }

  #entryClass(taskId: string, seq: number): DataClass {
    const entry = readTrajectory(this.#layer.root, taskId).find((candidate) => candidate.seq === seq);
    if (entry === undefined) throw new RunnerError(`task ${taskId} has no entry ${String(seq)}`);
    return entry.data_class;
  }

  #append(
    taskId: string,
    kind: EntryDraft["kind"],
    dataClass: DataClass,
    payload: unknown,
    cost: EntryDraft["cost"] = NO_COST,
    actor: string = RUNNER_ACTOR,
    provider: string | null = null,
  ): number {
    // Every record goes through the shared session layer (D-194).
    return this.#layer.append(taskId, kind, dataClass, payload, { actor, provider, cost });
  }

  /** Adds an item to the task's context and journals it, so a rebuilt task sends exactly the same context (D-066). */
  #pushContext(run: TaskRun, item: ContextItem, dataClass: DataClass): void {
    const seq = this.#append(run.task.id, "note", join([dataClass, this.#runnerClass(run)]), { type: "context", item, data_class: dataClass });
    run.context.push({ item, data_class: dataClass, seq });
  }

  /** The park entry the task is parked on, with the call it stopped at. */
  #lastPark(run: TaskRun): LastPark | null {
    const entry = readTrajectory(this.#layer.root, run.task.id).findLast((candidate) => candidate.kind === "park");
    if (entry === undefined) return null;
    const payload = ParkRecord.parse(this.#payloadOf(entry.payload_ref));
    return {
      seq: entry.seq,
      reason: payload.reason,
      tool_call: payload.tool_call ?? null,
      // Fail-closed: a park recorded as not overridable stays so, whatever its reason (§8.2, §8.3).
      overridable: payload.overridable !== false && !NON_OVERRIDABLE.has(payload.reason),
      remedy: payload.remedy ?? null,
      capability: payload.capability ?? null,
      outside: [
        ...new Map(
          (payload.detail?.grants ?? []).flatMap((item) => item.outside.map((violation) => [violation.path, { path: violation.path, unresolved: violation.unresolved !== undefined }] as const)),
        ).values(),
      ],
    };
  }

  /**
   * §11.1 (v0.6 A3, v0.6.1 V6-8): for every value that caused a boundary park, its provenance class, its integrity, and
   * where it came from (D-110). A `bound` value names the entry it was bound to; a `constant` names the admission entry
   * and its slot; a `synthesized` value cannot be traced without comparing contents (invariant 7), so it lists the
   * untrusted entries in the model's context since the last operator input as possible sources.
   */
  #parkSources(run: TaskRun, callSeq: number, detail: ParkDetail): Record<string, unknown>[] {
    const call = CallRecord.parse(this.#payloadOf(this.#entryAt(run.task.id, callSeq).payload_ref));
    const causing = causingArguments(detail, call.arguments);
    const admissionSeq = readTrajectory(this.#layer.root, run.task.id)[0]?.seq ?? null;
    const lastOperator = run.context.findLastIndex((entry) => entry.data_class.integrity === "operator");
    const possible = run.context
      .slice(lastOperator + 1)
      // Content the model read, not its own turns: those are what it composed, including the value being traced.
      .filter((entry) => entry.data_class.integrity === "untrusted" && entry.item.role !== "assistant")
      .map((entry) => ({ entry: sourceSeqOf(entry), context_entry: entry.seq, role: entry.item.role }));
    return causing.map((argument) => {
      const record = call.arguments.find((item) => item.argument === argument);
      const unresolved = call.unresolved.find((item) => item.argument === argument);
      if (record === undefined) {
        // No established value: an unresolved reference (judged untrusted, D-048) or a value with no provenance (D-054).
        return { argument, class: unresolved?.class ?? "none", integrity: "untrusted", source: { kind: unresolved === undefined ? "no_provenance" : "unresolved" } };
      }
      const base = { argument, class: record.class, integrity: record.integrity };
      if (record.origin.class === "bound") return { ...base, source: { kind: "entry", entry: record.origin.bound_to, binding_entry: record.origin.binding_entry } };
      if (record.origin.class === "constant") return { ...base, source: { kind: "admission", entry: admissionSeq, slot: record.origin.slot } };
      return { ...base, source: { kind: "possible_sources", since_operator_input: lastOperator < 0 ? null : (run.context[lastOperator]?.seq ?? null), entries: possible } };
    });
  }

  #entryAt(taskId: string, seq: number): TrajectoryEntry {
    const entry = readTrajectory(this.#layer.root, taskId).find((candidate) => candidate.seq === seq);
    if (entry === undefined) throw new RunnerError(`task ${taskId} has no entry ${String(seq)}`);
    return entry;
  }

  /**
   * The parked out-of-scope paths no usable grant among `grants` covers for the parked capability (§8.2, D-109). A path
   * that had no canonical form when it parked is resolved again now (§2.7.1 C4, D-114): a grant can cover only a
   * canonical path, so one that still cannot be resolved is never covered.
   */
  async #uncoveredByGrants(run: TaskRun, grants: readonly string[], park: LastPark): Promise<string[]> {
    if (park.capability === null || park.outside.length === 0) return ["the parked values (the park does not name them)"];
    const covering = this.#grants.coverage({ principal: run.task.principal, grants }, park.capability, this.#clock()).covering;
    const covered = (path: string): boolean => covering.some((grant) => grant.resource_scope.some((selector) => selector.kind === "path" && pathWithin(path, selector.prefix)));
    const unresolved = park.outside.filter((item) => item.unresolved).map((item) => item.path);
    const now = await this.#resolver.resolve(unresolved);
    return park.outside
      .filter((item) => {
        if (!item.unresolved) return !covered(item.path);
        const answer = now.get(item.path);
        return answer === undefined || !answer.ok || !covered(answer.canonical);
      })
      .map((item) => item.path);
  }

  #payloadOf(ref: string): unknown {
    const blob = readPayload(this.#layer.root, ref);
    if (blob.status !== "present") throw new RunnerError(`payload ${ref} is ${blob.status}`);
    return JSON.parse(decoder.decode(blob.bytes));
  }

  /**
   * Rebuilds a task from its journal alone (§3.4.5, D-066). A journal that does
   * not verify is never resumed: the task is failed, and the failure recorded
   * in the runner's own record, since nothing can be appended to a broken chain
   * (D-056). A task the journal shows still running was interrupted by a crash;
   * it is failed `runner_interrupted`, because an effect may have happened that
   * its trajectory does not show.
   */
  #load(id: string): { ok: true; run: TaskRun } | { ok: false; reason: string } {
    let entries: readonly TrajectoryEntry[];
    try {
      entries = readTrajectory(this.#layer.root, id);
    } catch (error: unknown) {
      if (!(error instanceof JournalIntegrityError)) throw error;
      this.#append(RUNNER_RECORD, "note", { sensitivity: "secret", integrity: "derived" }, { type: "task_failed", task: id, reason: "journal_unverifiable", failure: { ...error.failure } });
      this.#unverifiable.set(id, "journal_unverifiable");
      return { ok: false, reason: "journal_unverifiable" };
    }
    const [first] = entries;
    if (first === undefined) throw new RunnerError(`task ${id} has no trajectory`);
    const admitted = AdmissionRecord.safeParse(this.#payloadOf(first.payload_ref));
    if (first.kind !== "note" || !admitted.success) throw new RunnerError(`task ${id}'s trajectory does not start with its admission`);
    const record = admitted.data;
    const admission: AdmittedTask = {
      task: record.task,
      constants: record.constants,
      criterion: record.criterion,
      provider: record.provider_profile,
      sources: record.sources,
      warnings: record.warnings,
      rejection_limit: record.rejection_limit,
      reversible_workspaces: record.reversible_workspaces,
    };
    const run: TaskRun = {
      task: record.task,
      admission,
      provider: this.#providers.find((candidate) => candidate.profile.id === record.provider) ?? null,
      admissionClass: first.data_class,
      // §3.4.5: rebuilt from the journal; the shared layer reopens the session (D-194).
      session: this.#layer.restore(id, this.#limits(record.task, record.rejection_limit), { admittedAt: Date.parse(record.admitted_at), spent: { ...NO_SPEND }, now: () => this.#clock().getTime() }),
      context: [],
      executingActors: new Set([RUNNER_ACTOR, ENFORCEMENT_ACTOR]),
      turns: 0,
      pinFiles: null,
      checkpoints: new Map(),
    };
    let state: TaskState = "admitted";
    let floor = record.task.sensitivity_floor;
    const grants = [...record.task.grants];
    for (const entry of entries.slice(1)) {
      if (entry.kind === "turn") {
        run.turns += 1;
        run.executingActors.add(entry.actor);
        continue;
      }
      if (entry.kind === "capability_result") {
        run.executingActors.add(entry.actor);
        continue;
      }
      if (entry.kind !== "note" && entry.kind !== "park" && entry.kind !== "resume") continue;
      const body = Replayed.parse(this.#payloadOf(entry.payload_ref));
      if (body.spent !== undefined) run.session.setSpent({ ...body.spent });
      if (entry.kind === "park") state = "parked";
      else if (entry.kind === "resume") {
        state = "running";
        for (const grant of body.added_grants ?? []) if (!grants.includes(grant)) grants.push(grant);
        for (const grant of body.removed_grants ?? []) if (grants.includes(grant)) grants.splice(grants.indexOf(grant), 1);
      } else if (body.type === "state" && body.to !== undefined) state = TaskStateSchema.parse(body.to);
      else if (body.type === "sensitivity_floor" && body.to !== undefined) floor = SensitivitySchema.parse(body.to);
      else if (body.type === "context" && body.item !== undefined && body.data_class !== undefined) run.context.push({ item: body.item, data_class: body.data_class, seq: entry.seq });
      else if (body.type === "pin_files") {
        // Read from the note itself: the replay record keeps only the fields every note shares.
        const pinned = PinFilesNote.parse(this.#payloadOf(entry.payload_ref));
        run.pinFiles = { files: pinned.files, data_class: pinned.data_class };
      } else if (body.type === "checkpoint") {
        const taken = CheckpointNote.parse(this.#payloadOf(entry.payload_ref));
        run.checkpoints.set(taken.root, taken.checkpoint);
      }
    }
    run.task = TaskSchema.parse({ ...record.task, state, runtime_substate: state === "running" ? "active" : null, sensitivity_floor: floor, grants });
    this.#runs.set(id, run);
    if (state === "running") {
      this.#fail(run, "runner_interrupted");
      return { ok: false, reason: "runner_interrupted" };
    }
    return { ok: true, run };
  }

  /**
   * Failed tasks survive a restart (D-066). Grant charges do too, through the
   * shared session layer (D-201).
   */
  #rebuildRunnerRecord(): void {
    for (const entry of readTrajectory(this.#layer.root, RUNNER_RECORD)) {
      const record = RunnerRecordEntry.safeParse(this.#payloadOf(entry.payload_ref));
      if (!record.success) throw new RunnerError(`the runner record at ${RUNNER_RECORD} entry ${String(entry.seq)} is not readable`);
      // D-201: every grant's use count is rebuilt by the shared session layer, for every mode, from the calls the journal
      // shows each grant authorized (`requireGrants`, in the constructor). The `grant_charge` notes stay as the runner's
      // record that a charge was durable before its effect (D-066); they are no longer a second count.
      if (record.data.type === "task_failed") this.#unverifiable.set(record.data.task, record.data.reason);
    }
  }

  /** Records every quarantine the registry holds that the runner has not yet recorded (D-064). */
  #recordQuarantines(): void {
    for (const capability of this.#registry.capabilities()) {
      for (const adapter of capability.providers) {
        const evidence = this.#registry.quarantined(capability.id, adapter);
        const key = JSON.stringify([capability.id, adapter]);
        if (evidence === undefined || this.#recordedQuarantines.has(key)) continue;
        this.#append(REGISTRY_RECORD, "note", { sensitivity: "internal", integrity: "derived" }, { type: "quarantine", ...evidence });
        this.#recordedQuarantines.add(key);
      }
    }
  }

  /** A quarantine is permanent: the ones recorded before a restart are applied again at start (D-064). */
  #reapplyQuarantines(): void {
    for (const entry of readTrajectory(this.#layer.root, REGISTRY_RECORD)) {
      const blob = readPayload(this.#layer.root, entry.payload_ref);
      if (blob.status !== "present") throw new RunnerError(`the quarantine record at ${REGISTRY_RECORD} entry ${String(entry.seq)} is ${blob.status}`);
      const record = QuarantineRecord.safeParse(JSON.parse(decoder.decode(blob.bytes)));
      if (!record.success) throw new RunnerError(`the quarantine record at ${REGISTRY_RECORD} entry ${String(entry.seq)} is not readable`);
      const { capability, adapter, observation } = record.data;
      this.#registry.quarantine({ capability, adapter, observation });
      this.#recordedQuarantines.add(JSON.stringify([capability, adapter]));
    }
  }
}

/**
 * What the protected-path comparison looks at: the listing itself (exit code and stdout, or the error when
 * the program could not start). Not stderr, which carries the container runtime's own messages and differs
 * on every run (D-067).
 */
function listingOf(payload: Record<string, unknown>): Record<string, unknown> {
  return { exit_code: payload["exit_code"] ?? null, stdout: payload["stdout"] ?? null, stdout_base64: payload["stdout_base64"] ?? null, error: payload["error"] ?? null };
}

/** Whether a listing actually listed the paths: the program ran, exited 0, and printed text. */
function listed(listing: Record<string, unknown>): boolean {
  return listing["error"] === null && listing["exit_code"] === 0 && typeof listing["stdout"] === "string";
}

type Constants = AdmittedTask["constants"];

/** The constant slots offered to the executing model: the operator's, never the verifier's (D-075). */
export function offeredConstants(constants: Constants): string[] {
  // Only constants fixed for the executing actor (§2.6, v0.6 B1); a criterion slot never is (D-075, D-111).
  return Object.entries(constants)
    .filter(([slot, constant]) => constant.actors.includes("executing") && !slot.startsWith(VERIFIER_SLOT_PREFIX))
    .map(([slot]) => slot)
    .sort();
}

/** Whether a constant's value fits a field's scalar type: the same kinds the call schema checks, a path being absolute. */
function fits(type: Exclude<FieldType, { kind: "list" | "map" }>, value: unknown): boolean {
  switch (type.kind) {
    case "enum":
      return typeof value === "string" && type.values.includes(value);
    case "path":
      return typeof value === "string" && value.startsWith("/");
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
  }
}

/**
 * The slot names offered for each field of a capability (D-075, D-077). A constant's role comes from the registry's
 * declarations: a constant whose value is an allowed value of a declared instruction field (a program) has the
 * instruction role; every other constant has the data role. An instruction field is offered the instruction-role
 * constants whose value fits it; a data field (or the items of a list, the values of a map) only the data-role
 * constants whose value fits it, so a program constant is never offered for argv. Offering is not permission: the
 * boundary judges whatever the model sends, named slot or not.
 */
export function slotOffers(
  fields: Readonly<Record<string, { readonly type: FieldType; readonly role: string }>>,
  constants: Constants,
  instructionValues: ReadonlySet<unknown>,
): Record<string, string[]> {
  const offered = offeredConstants(constants);
  return Object.fromEntries(
    Object.entries(fields).map(([field, { type, role }]) => {
      const scalar = type.kind === "list" ? type.items : type.kind === "map" ? type.values : type;
      const wanted = role === "instruction";
      return [field, offered.filter((slot) => instructionValues.has(constants[slot]?.value) === wanted && fits(scalar, constants[slot]?.value))];
    }),
  );
}

/** The most of an unreadable answer the journal keeps (D-077). */
export const MAX_UNREAD_CHARS = 16_384;

/** An unreadable provider answer as bounded text for the journal. */
export function unreadText(raw: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(raw) ?? String(raw);
  } catch {
    text = String(raw);
  }
  return text.length > MAX_UNREAD_CHARS ? `${text.slice(0, MAX_UNREAD_CHARS)}...(truncated, ${String(text.length)} characters)` : text;
}

/** What a hidden value is replaced with in the runner's messages (D-075). */
export const HIDDEN_VALUE = "(a value hidden by the runner; name a constant by slot)";

/** Replaces every occurrence of the given values in every string of a message (keys included). */
export function hideValues<T>(message: T, values: readonly string[]): T {
  const hide = (text: string): string => values.reduce((out, value) => out.split(value).join(HIDDEN_VALUE), text);
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return hide(value);
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, member]) => [hide(key), walk(member)]));
    return value;
  };
  return walk(message) as T;
}

function rejection(toolCall: string, callSeq: number, detail: RejectDetail): Record<string, unknown> {
  return { tool_call: toolCall, call_seq: callSeq, outcome: "rejected", ...detail };
}

/** What `#parkSources` reads from a `capability_call` entry the boundary wrote. Unknown fields are ignored. */
const CallRecord = z.object({
  arguments: z.array(
    z.object({
      argument: z.string(),
      class: z.string(),
      integrity: z.string(),
      sensitivity: z.string(),
      origin: z.discriminatedUnion("class", [
        z.object({ class: z.literal("bound"), bound_to: z.number(), binding_entry: z.number() }),
        z.object({ class: z.literal("constant"), slot: z.string() }),
        z.object({ class: z.literal("synthesized") }),
      ]),
    }),
  ),
  unresolved: z.array(z.object({ argument: z.string(), class: z.string() })),
});

/**
 * The arguments that caused a boundary park (§11.1, D-110): the values below a floor; the out-of-scope values; the
 * values above the ceiling that was exceeded (every argument when none is above it, since the composing context then
 * raised the class). Parks that no value caused (`awaiting_grant`, `adapter_quarantined`) name none.
 */
function causingArguments(detail: ParkDetail, args: readonly { readonly argument: string; readonly sensitivity: string }[]): string[] {
  const unique = (items: readonly string[]): string[] => [...new Set(items)];
  switch (detail.reason) {
    case "integrity_floor":
      return unique([
        ...detail.violations.map((item) => item.argument),
        ...detail.grants.flatMap((item) => item.violations.map((violation) => violation.argument)),
        ...(detail.effects ?? []).flatMap((item) => item.refused.map((refusal) => refusal.argument)),
      ]);
    case "scope_violation":
      return unique(detail.grants.flatMap((item) => item.outside.map((violation) => violation.argument)));
    case "sensitivity_ceiling": {
      const ceilings = compareSensitivity(detail.aggregate, detail.ceiling) > 0 ? [detail.ceiling] : detail.grants.map((item) => item.max_sensitivity);
      const lowest = ceilings.reduce<Sensitivity | null>((low, item) => (low === null || compareSensitivity(item, low) < 0 ? item : low), null);
      const above = args.filter((item) => lowest !== null && compareSensitivity(SensitivitySchema.parse(item.sensitivity), lowest) > 0).map((item) => item.argument);
      return unique(above.length > 0 ? above : args.map((item) => item.argument));
    }
    default:
      return [];
  }
}

/** The entry a context item's content came from: the result or turn it carries, else the context note itself. */
function sourceSeqOf(entry: Contextual): number {
  const content = entry.item.content;
  if (typeof content === "object" && content !== null) {
    const record = content as Record<string, unknown>;
    for (const key of ["result_seq", "turn_seq"]) if (typeof record[key] === "number") return record[key];
  }
  return entry.seq;
}
