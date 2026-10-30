import { z } from "zod";
import {
  DataClass as DataClassSchema,
  ResourceSelector,
  Sensitivity as SensitivitySchema,
  type TrajectoryEntry,
  type DataClass,
  type Integrity,
  type Sensitivity,
  type Task,
  Task as TaskSchema,
  type TaskState,
  TaskState as TaskStateSchema,
  closureSchemaFor,
  compareIntegrity,
  join,
  maxSensitivity,
  minIntegrity,
  parseAtBoundary,
  raiseSensitivityFloor,
} from "../../contracts/src/index.js";
import {
  type Authorization,
  ENFORCEMENT_ACTOR,
  EnforcementBoundary,
  type GrantStore,
  type ParkDetail,
  type RejectDetail,
  type TaskContext,
  type Verdict,
} from "../../enforcement/src/index.js";
import { type EntryDraft, JournalIntegrityError, type JournalWriter, canonicalJson, contentAddress, readPayload, readTrajectory } from "../../journal/src/index.js";
import type { CapabilityRegistry, InvocationResult } from "../../registry/src/index.js";
import {
  type AdmissionResult,
  type AdmittedTask,
  CriterionStatement,
  RESERVED_ID_PREFIX,
  type SourceRegistration,
  admit,
  criterionSlots,
  grantChecks,
  routable,
} from "./admission.js";
import { type BudgetAxis, NO_SPEND, type Spend, exhaustedAxes, overrunAxes } from "./budget.js";
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
export type ParkReason = ParkDetail["reason"] | "budget_exceeded" | "routing_unavailable";

/** §8.3: a park is not overridable when the operator cannot observe the consequence of proceeding. */
export const NON_OVERRIDABLE: ReadonlySet<ParkReason> = new Set<ParkReason>(["integrity_floor", "adapter_quarantined"]);

export type RunOutcome = {
  readonly task_id: string;
  readonly state: TaskState;
  /** The park reason, or why the task ended. */
  readonly reason: string | null;
};

export type RunnerOptions = {
  readonly journal: JournalWriter;
  readonly registry: CapabilityRegistry;
  readonly grants: GrantStore;
  readonly providers: readonly Provider[];
  readonly sources: readonly SourceRegistration[];
  readonly clock?: () => Date;
  /** Who verifies. Defaults to `juno.verifier`; a closure naming an executing actor is refused (§3.4.4). */
  readonly verifierIdentity?: string;
};

export class RunnerError extends Error {
  override readonly name = "RunnerError";
}

type Contextual = { readonly item: ContextItem; readonly data_class: DataClass };

type TaskRun = {
  task: Task;
  readonly admission: AdmittedTask;
  /** `null` when a rebuilt task names a provider this runner does not serve; it cannot run until one does. */
  readonly provider: Provider | null;
  readonly admittedAt: number;
  readonly admissionClass: DataClass;
  spent: Spend;
  runningSince: number | null;
  readonly context: Contextual[];
  /** Every actor that took part in executing the task; none may verify it (§3.4.4, invariant 3). */
  readonly executingActors: Set<string>;
  turns: number;
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

const ParkRecord = z.object({ reason: z.string(), tool_call: z.string().optional() }).transform((park) => ({ ...park, reason: park.reason as ParkReason }));

const AdmissionRecord = z.object({
  type: z.literal("admission"),
  outcome: z.literal("admitted"),
  admitted_at: z.iso.datetime(),
  task: TaskSchema,
  constants: z.record(z.string(), z.strictObject({ value: z.union([z.string(), z.number(), z.boolean()]), data_class: DataClassSchema })),
  criterion: CriterionStatement.nullable(),
  provider: z.string(),
  provider_profile: ProviderProfile,
  sources: z.array(z.strictObject({ id: z.string(), selector: ResourceSelector, data_class: DataClassSchema })),
  warnings: z.array(z.string()),
});

const RunnerRecordEntry = z.discriminatedUnion("type", [
  z.object({ type: z.literal("grant_charge"), grant: z.string(), task: z.string(), call_seq: z.number() }),
  z.object({ type: z.literal("task_failed"), task: z.string(), reason: z.string() }),
]);

const NO_COST = { tokens_in: 0, tokens_out: 0, tokens_cached: 0, currency: 0, duration_ms: 0 };

/** What the model is told about the runner, sent first on every turn. Fixed, operator-authored text. */
const PREAMBLE = {
  runner: "juno",
  arguments:
    "Each capability argument is one of: a literal you write (synthesized); {\"slot\": \"<name>\"} for a constant fixed at admission; " +
    "{\"ref\": \"${<seq>.<path>}\"} to bind a value from entry <seq> of this task's trajectory without copying it. " +
    "A list field takes one such value per element. Tool results name the seq of their entry.",
  done: "Answer with no capability calls when you believe the task is done. The runner verifies; you cannot mark the task done.",
};

const encoder = new TextEncoder();
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
  readonly #journal: JournalWriter;
  readonly #registry: CapabilityRegistry;
  readonly #grants: GrantStore;
  readonly #providers: readonly Provider[];
  readonly #sources: readonly SourceRegistration[];
  readonly #clock: () => Date;
  readonly #verifier: string;
  readonly #boundary: EnforcementBoundary;
  readonly #lock: RunnerLock;
  readonly #runs = new Map<string, TaskRun>();
  readonly #recordedQuarantines = new Set<string>();
  /** Tasks failed because their journal does not verify; never resumed (D-056). */
  readonly #unverifiable = new Map<string, string>();
  #active: string | null = null;

  /** Takes the journal's runner lock (one runner per journal) and reapplies the recorded quarantines. */
  constructor(options: RunnerOptions) {
    this.#journal = options.journal;
    this.#registry = options.registry;
    this.#grants = options.grants;
    this.#providers = options.providers;
    this.#sources = options.sources;
    this.#clock = options.clock ?? (() => new Date());
    this.#verifier = options.verifierIdentity ?? VERIFIER_ACTOR;
    this.#lock = acquireRunnerLock(this.#journal.root, this.#clock);
    try {
      this.#reapplyQuarantines();
      this.#rebuildRunnerRecord();
    } catch (error: unknown) {
      this.#lock.release();
      throw error;
    }
    // The runner reaches capabilities only through this boundary.
    this.#boundary = new EnforcementBoundary({ registry: this.#registry, grants: this.#grants, journal: this.#journal, clock: this.#clock });
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
    return run === undefined ? undefined : this.#spentNow(run);
  }

  /** Admission (§5). Every outcome is journalled under the task's id; a rejected task can never be admitted again under it. */
  admit(input: unknown): AdmissionResult {
    const id = typeof input === "object" && input !== null && "id" in input && typeof input.id === "string" ? input.id : null;
    const now = this.#clock();
    let result = admit(input, { registry: this.#registry, grants: this.#grants, providers: this.#providers.map((p) => p.profile), sources: this.#sources, now });
    if (id === null || id.startsWith(RESERVED_ID_PREFIX)) return result;
    let existing: boolean;
    try {
      existing = this.#runs.has(id) || readTrajectory(this.#journal.root, id).length > 0;
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
      this.#append(id, "note", { sensitivity: "secret", integrity: "untrusted" }, { type: "admission", outcome: "rejected", failures: result.failures, request: input });
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
    this.#append(task.id, "note", admissionClass, {
      type: "admission",
      outcome: "admitted",
      admitted_at: now.toISOString(),
      task,
      criterion: admission.criterion,
      criterion_ref: admission.criterion === null ? null : contentAddress(canonicalJson(admission.criterion)),
      constants: admission.constants,
      provider: admission.provider.id,
      provider_profile: admission.provider,
      sources: admission.sources,
      warnings: admission.warnings,
    });
    this.#runs.set(task.id, {
      task,
      admission,
      provider,
      admittedAt: now.getTime(),
      admissionClass,
      spent: { ...NO_SPEND },
      runningSince: null,
      context: [],
      executingActors: new Set([RUNNER_ACTOR, ENFORCEMENT_ACTOR]),
      turns: 0,
    });
    result = { admitted: true, admission };
    return result;
  }

  /** Starts an admitted task and runs its turn loop until it parks or ends. */
  async run(id: string): Promise<RunOutcome> {
    const run = this.#runs.get(id);
    if (run === undefined) throw new RunnerError(`task ${id} was not admitted by this runner`);
    if (run.task.state !== "admitted") throw new RunnerError(`task ${id} is ${run.task.state}; only an admitted task starts (resume is Increment 6)`);
    // Slice 1 runs one task at a time (§18; concurrent tasks are out of scope).
    if (this.#active !== null) throw new RunnerError(`task ${this.#active} is running; this runner runs one task at a time`);
    this.#active = id;
    this.#setState(run, "running", "start");
    this.#pushContext(run, { role: "system", content: PREAMBLE }, { sensitivity: run.task.sensitivity_floor, integrity: "operator" });
    this.#pushContext(
      run,
      {
        role: "user",
        content: {
          task_id: run.task.id,
          objective: run.task.objective,
          criterion: run.admission.criterion,
          constants: Object.fromEntries(Object.entries(run.admission.constants).map(([slot, constant]) => [slot, constant.value])),
        },
      },
      run.admissionClass,
    );
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
    if (park !== null && NON_OVERRIDABLE.has(park.reason)) {
      throw new RunnerError(`task ${id} is parked ${park.reason}, which is not overridable (§8.3); it is never resumed. Remedy the cause and start a new task`);
    }

    const added = options.grants ?? [];
    if (added.length > 0) {
      const env = { registry: this.#registry, grants: this.#grants, providers: this.#providers.map((p) => p.profile), sources: this.#sources, now: this.#clock() };
      const problems = added.flatMap((grantId) => {
        const grant = this.#grants.get(grantId);
        return grant === undefined ? [{ check: "3.2", message: `grant ${grantId} is not stored` }] : grantChecks(grant, run.task.principal, env, run.admission.sources);
      });
      if (problems.length > 0) throw new RunnerError(`the grants added on resume do not pass admission's grant rules: ${JSON.stringify(problems)}`);
    }
    // Dropping a grant only narrows the task's authority, so it is always allowed (§7.4 rule 2's direction).
    const removed = options.remove_grants ?? [];
    const strays = removed.filter((grantId) => !run.task.grants.includes(grantId) || added.includes(grantId));
    if (strays.length > 0) throw new RunnerError(`grants to remove must be on the task and not also added: ${strays.join(", ")}`);
    const grants = [...run.task.grants, ...added.filter((grantId) => !run.task.grants.includes(grantId))].filter((grantId) => !removed.includes(grantId));
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
      ttl_remaining_ms: run.task.ttl - (now.getTime() - run.admittedAt),
      spent: this.#spentNow(run),
    });
    if (refused.length > 0) return this.#park(run, "awaiting_grant", this.#runnerClass(run), { phase: "resume", refused });
    if (!routing) {
      return this.#park(run, "routing_unavailable", this.#runnerClass(run), { phase: "resume", provider: run.admission.provider.id, sensitivity_floor: run.task.sensitivity_floor });
    }
    run.task = TaskSchema.parse({ ...run.task, state: "running", runtime_substate: "active" });
    run.runningSince = this.#clock().getTime();
    if (park !== null && park.tool_call !== null) {
      this.#pushContext(run, { role: "tool", content: { tool_call: park.tool_call, outcome: "parked", reason: park.reason, park_seq: park.seq, resumed: true } }, this.#runnerClass(run));
    }
    return this.#continue(run);
  }

  async #continue(run: TaskRun): Promise<RunOutcome> {
    if (this.#active !== null && this.#active !== run.task.id) throw new RunnerError(`task ${this.#active} is running; this runner runs one task at a time`);
    this.#active = run.task.id;
    try {
      return await this.#loop(run);
    } finally {
      this.#stopClock(run);
      this.#active = null;
    }
  }

  /** The operator closes a task that completed unverified (§6, §6.1): `accepted`, the weakest closure. */
  accept(id: string, principal: string): RunOutcome {
    const run = this.#runs.get(id);
    if (run === undefined) throw new RunnerError(`task ${id} was not admitted by this runner`);
    if (run.task.state !== "complete_unverified") throw new RunnerError(`task ${id} is ${run.task.state}; only a complete_unverified task can be accepted`);
    if (principal !== run.task.principal) throw new RunnerError(`only the task's principal ${run.task.principal} can accept it`);
    this.#writeClosure(run, "accepted", "inconclusive", principal);
    this.#setState(run, "accepted", "operator_accepted");
    return this.#outcome(run, "operator_accepted");
  }

  async #loop(run: TaskRun): Promise<RunOutcome> {
    for (;;) {
      if (this.#ttlExpired(run)) return this.#fail(run, "ttl_expired");
      const before = exhaustedAxes(this.#spentNow(run), run.task.budget);
      if (before.length > 0) return this.#budgetPark(run, before);
      const provider = run.provider;
      if (provider === null || !routable(run.task.model_policy, run.task.sensitivity_floor, provider.profile)) {
        return this.#park(run, "routing_unavailable", this.#runnerClass(run), { provider: run.admission.provider.id, sensitivity_floor: run.task.sensitivity_floor });
      }

      const request = this.#assemble(run, provider);
      const turnClass = join([{ sensitivity: run.task.sensitivity_floor, integrity: "derived" }, ...run.context.map((entry) => entry.data_class)]);
      run.spent.turns += 1;
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
      run.spent.tokens += usage.tokens_in + usage.tokens_out + usage.tokens_cached;
      run.spent.currency += currency;
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
        },
        { tokens_in: usage.tokens_in, tokens_out: usage.tokens_out, tokens_cached: usage.tokens_cached, currency, duration_ms: duration },
        provider.profile.model,
        provider.profile.id,
      );
      if (!parsed.success) {
        this.#pushContext(run, { role: "user", content: { turn_seq: turnSeq, error: "the runner could not read that turn", detail: parsed.error.message } }, turnClass);
        continue;
      }
      const response = parsed.data;
      this.#pushContext(run, { role: "assistant", content: { turn_seq: turnSeq, text: response.text, tool_calls: response.tool_calls } }, turnClass);

      const overrun = overrunAxes(this.#spentNow(run), run.task.budget);
      if (overrun.length > 0) return this.#budgetPark(run, overrun, { turn_seq: turnSeq, not_acted_on: response.tool_calls.map((call) => call.id) });
      if (response.tool_calls.length === 0) return this.#complete(run, turnSeq);

      for (const [index, call] of response.tool_calls.entries()) {
        const rest = response.tool_calls.slice(index + 1).map((later) => later.id);
        if (this.#ttlExpired(run)) return this.#fail(run, "ttl_expired");
        const clock = exhaustedAxes(this.#spentNow(run), run.task.budget, ["wall_clock_ms"]);
        if (clock.length > 0) return this.#budgetPark(run, clock, { turn_seq: turnSeq, not_acted_on: [call.id, ...rest] });

        const verdict = this.#authorize(run, toProposal(call), turnClass.sensitivity);
        if (verdict.outcome === "park") {
          return this.#park(run, verdict.detail.reason, this.#entryClass(run.task.id, verdict.call_seq), {
            call_seq: verdict.call_seq,
            tool_call: call.id,
            not_acted_on: rest,
            detail: verdict.detail,
          });
        }
        if (verdict.outcome === "reject") {
          this.#pushContext(run, { role: "tool", content: rejection(call.id, verdict.call_seq, verdict.detail) }, this.#entryClass(run.task.id, verdict.call_seq));
          continue;
        }
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

    const verdict = this.#authorize(run, { capability: criterion.command.capability, arguments: args }, run.task.sensitivity_floor);
    if (verdict.outcome === "park") {
      return this.#park(run, verdict.detail.reason, this.#entryClass(run.task.id, verdict.call_seq), { call_seq: verdict.call_seq, phase: "verification", detail: verdict.detail });
    }
    let result: "pass" | "fail" | "inconclusive" = "inconclusive";
    let resultSeq: number | null = null;
    let exitCode: number | null = null;
    if (verdict.outcome === "proceed") {
      const performed = await this.#perform(run, verdict.authorization);
      resultSeq = performed.seq;
      exitCode = performed.exitCode;
      if (performed.exitCode !== null) result = performed.exitCode === criterion.expect_exit_code ? "pass" : "fail";
    }
    this.#append(run.task.id, "note", this.#runnerClass(run), {
      type: "verification",
      phase: "result",
      result,
      call_seq: verdict.call_seq,
      result_seq: resultSeq,
      exit_code: exitCode,
      expected_exit_code: criterion.expect_exit_code,
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
      cost_actual: { ...this.#spentNow(run) },
    });
    this.#append(task.id, "note", this.#runnerClass(run), { type: "closure", closure });
  }

  #authorize(run: TaskRun, proposal: unknown, sensitivity: Sensitivity): Verdict {
    const context: TaskContext = { task: run.task, constants: run.admission.constants, synthesis: { sensitivity } };
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

  #budgetPark(run: TaskRun, axes: readonly BudgetAxis[], extra: Record<string, unknown> = {}): RunOutcome {
    return this.#park(run, "budget_exceeded", this.#runnerClass(run), { axes, spent: this.#spentNow(run), budget: run.task.budget, ...extra });
  }

  #park(run: TaskRun, reason: ParkReason, dataClass: DataClass, detail: Record<string, unknown>): RunOutcome {
    this.#stopClock(run);
    const entryClass = join([dataClass, this.#runnerClass(run)]);
    this.#append(run.task.id, "park", entryClass, { reason, overridable: !NON_OVERRIDABLE.has(reason), from: run.task.state, ...detail, spent: this.#spentNow(run) });
    run.task = TaskSchema.parse({ ...run.task, state: "parked", runtime_substate: null });
    return this.#outcome(run, reason);
  }

  #fail(run: TaskRun, reason: string): RunOutcome {
    this.#setState(run, "failed", reason);
    return this.#outcome(run, reason);
  }

  #setState(run: TaskRun, to: TaskState, reason: string, extra: Record<string, unknown> = {}): void {
    const from = run.task.state;
    if (to !== "running") this.#stopClock(run);
    this.#append(run.task.id, "note", this.#runnerClass(run), { type: "state", from, to, reason, ...extra, spent: this.#spentNow(run) });
    run.task = TaskSchema.parse({ ...run.task, state: to, runtime_substate: to === "running" ? "active" : null });
    if (to === "running") run.runningSince = this.#clock().getTime();
  }

  #outcome(run: TaskRun, reason: string | null): RunOutcome {
    return { task_id: run.task.id, state: run.task.state, reason };
  }

  #assemble(run: TaskRun, provider: Provider): ProviderRequest {
    const tools: ToolDefinition[] = this.#registry.capabilities().map((capability) => ({ capability: capability.id, interface: capability.interface }));
    return { model: provider.profile.model, context: run.context.map((entry) => entry.item), tools };
  }

  /** TTL is wall time since admission, parked time included (§6.4, D-025). */
  #ttlExpired(run: TaskRun): boolean {
    return this.#clock().getTime() - run.admittedAt >= run.task.ttl;
  }

  #spentNow(run: TaskRun): Spend {
    const running = run.runningSince === null ? 0 : Math.max(0, this.#clock().getTime() - run.runningSince);
    return { ...run.spent, wall_clock_ms: run.spent.wall_clock_ms + running };
  }

  #stopClock(run: TaskRun): void {
    if (run.runningSince === null) return;
    run.spent.wall_clock_ms += Math.max(0, this.#clock().getTime() - run.runningSince);
    run.runningSince = null;
  }

  /** Runner-written facts: never more trusted than `derived`, so no bound reference can lift text into an instruction field through them. */
  #runnerClass(run: TaskRun): DataClass {
    return { sensitivity: run.task.sensitivity_floor, integrity: "derived" };
  }

  #entryClass(taskId: string, seq: number): DataClass {
    const entry = readTrajectory(this.#journal.root, taskId).find((candidate) => candidate.seq === seq);
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
    const draft: EntryDraft = { kind, actor, provider, data_class: dataClass, cost };
    return this.#journal.append(taskId, draft, encoder.encode(canonicalJson(payload))).seq;
  }

  /** Adds an item to the task's context and journals it, so a rebuilt task sends exactly the same context (D-066). */
  #pushContext(run: TaskRun, item: ContextItem, dataClass: DataClass): void {
    run.context.push({ item, data_class: dataClass });
    this.#append(run.task.id, "note", join([dataClass, this.#runnerClass(run)]), { type: "context", item, data_class: dataClass });
  }

  /** The park entry the task is parked on, with the call it stopped at. */
  #lastPark(run: TaskRun): { seq: number; reason: ParkReason; tool_call: string | null } | null {
    const entry = readTrajectory(this.#journal.root, run.task.id).findLast((candidate) => candidate.kind === "park");
    if (entry === undefined) return null;
    const payload = ParkRecord.parse(this.#payloadOf(entry.payload_ref));
    return { seq: entry.seq, reason: payload.reason, tool_call: payload.tool_call ?? null };
  }

  #payloadOf(ref: string): unknown {
    const blob = readPayload(this.#journal.root, ref);
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
      entries = readTrajectory(this.#journal.root, id);
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
    };
    const run: TaskRun = {
      task: record.task,
      admission,
      provider: this.#providers.find((candidate) => candidate.profile.id === record.provider) ?? null,
      admittedAt: Date.parse(record.admitted_at),
      admissionClass: first.data_class,
      spent: { ...NO_SPEND },
      runningSince: null,
      context: [],
      executingActors: new Set([RUNNER_ACTOR, ENFORCEMENT_ACTOR]),
      turns: 0,
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
      if (body.spent !== undefined) run.spent = { ...body.spent };
      if (entry.kind === "park") state = "parked";
      else if (entry.kind === "resume") {
        state = "running";
        for (const grant of body.added_grants ?? []) if (!grants.includes(grant)) grants.push(grant);
        for (const grant of body.removed_grants ?? []) if (grants.includes(grant)) grants.splice(grants.indexOf(grant), 1);
      } else if (body.type === "state" && body.to !== undefined) state = TaskStateSchema.parse(body.to);
      else if (body.type === "sensitivity_floor" && body.to !== undefined) floor = SensitivitySchema.parse(body.to);
      else if (body.type === "context" && body.item !== undefined && body.data_class !== undefined) run.context.push({ item: body.item, data_class: body.data_class });
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
   * Grant charges and failed tasks survive a restart (D-066). The store must
   * hold no charges yet: the runner's record is the only count.
   */
  #rebuildRunnerRecord(): void {
    for (const id of this.#grants.ids()) {
      if (this.#grants.invocations(id) > 0) throw new RunnerError(`grant ${id} already has charges; the runner rebuilds every count from its record at start`);
    }
    for (const entry of readTrajectory(this.#journal.root, RUNNER_RECORD)) {
      const record = RunnerRecordEntry.safeParse(this.#payloadOf(entry.payload_ref));
      if (!record.success) throw new RunnerError(`the runner record at ${RUNNER_RECORD} entry ${String(entry.seq)} is not readable`);
      if (record.data.type === "grant_charge") {
        if (this.#grants.get(record.data.grant) !== undefined) this.#grants.charge(record.data.grant);
      } else this.#unverifiable.set(record.data.task, record.data.reason);
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
    for (const entry of readTrajectory(this.#journal.root, REGISTRY_RECORD)) {
      const blob = readPayload(this.#journal.root, entry.payload_ref);
      if (blob.status !== "present") throw new RunnerError(`the quarantine record at ${REGISTRY_RECORD} entry ${String(entry.seq)} is ${blob.status}`);
      const record = QuarantineRecord.safeParse(JSON.parse(decoder.decode(blob.bytes)));
      if (!record.success) throw new RunnerError(`the quarantine record at ${REGISTRY_RECORD} entry ${String(entry.seq)} is not readable`);
      const { capability, adapter, observation } = record.data;
      this.#registry.quarantine({ capability, adapter, observation });
      this.#recordedQuarantines.add(JSON.stringify([capability, adapter]));
    }
  }
}

function rejection(toolCall: string, callSeq: number, detail: RejectDetail): Record<string, unknown> {
  return { tool_call: toolCall, call_seq: callSeq, outcome: "rejected", ...detail };
}
