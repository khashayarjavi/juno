import {
  BoundaryError,
  type Closure,
  type DataClass,
  type EntryCost,
  type OutputClassRule,
  Task,
  type TaskState,
  assertSensitivityFloorTransition,
  closureSchemaFor,
  compareSensitivity,
  parseAtBoundary,
  raiseSensitivityFloor,
} from "../../contracts/src/index.js";
import {
  type ArgumentSource,
  type Authorization,
  type Constant,
  ENFORCEMENT_ACTOR,
  EnforcementBoundary,
  type GrantStore,
  type Synthesis,
  type TaskContext,
} from "../../enforcement/src/index.js";
import { type JournalWriter, canonicalJson, contentAddress, readTrajectory } from "../../journal/src/index.js";
import type { CapabilityRegistry, InvocationResult } from "../../registry/src/index.js";
import { AdmissionRequest, type Admitted, type AdmittedCriterion, type Rejected, type SourceRegistration, admit } from "./admission.js";
import { type RunnerLock, acquireRunnerLock } from "./lock.js";
import { type ModelOutput, type ModelProvider, type ToolDescription, type TurnInput, type TurnRequest, TurnResponse } from "./provider.js";

/**
 * The runner (spec §5, §6, §3.4.4; build plan Increment 5; DECISIONS.md D-058 to D-064).
 *
 * It admits tasks, runs the turn loop, enforces budgets and ttl, parks, runs
 * verification and writes closure. It reaches a capability only one way: the
 * enforcement boundary's `authorize`, then `perform` on the authorization it
 * returned. It never calls the registry's `invoke` or plans and runs an
 * invocation itself (STATE.md, Increment 4 note).
 *
 * The turn loop: assemble the turn's input → call the provider → journal the
 * turn → act on its output (a proposed call goes to the boundary; a proceed
 * is performed and its result journalled) → repeat. Before every turn the
 * ttl and every budget axis are checked; after every turn, the axes again.
 * TTL expiry fails the task (`ttl_expired`); it is never a park (§6.4, D-055).
 * The model only ever proposes; completion is the runner's call (invariant 3).
 */

export const RUNNER_ACTOR = "juno.runner";
/** The verifier is a runner component, never the model that did the work (§3.4.4, invariant 3). */
export const VERIFIER_ACTOR = "juno.verifier";

export class RunnerError extends Error {
  override readonly name = "RunnerError";
}

export type RunnerOptions = {
  readonly journal: JournalWriter;
  readonly registry: CapabilityRegistry;
  readonly grants: GrantStore;
  /** The one provider (build plan Increment 5). */
  readonly provider: ModelProvider;
  /** Registered sources and their declared classes (§1.3). */
  readonly sources: readonly SourceRegistration[];
  /** Wall-clock time: grants, journal timestamps and ttl, which counts sleep and parked time (D-025). */
  readonly clock?: () => Date;
  /** Monotonic milliseconds: the `wall_clock` budget, which counts running time only (D-025). */
  readonly monotonic?: () => number;
};

export type Usage = {
  tokens: number;
  currency: number;
  turns: number;
  /** Running time accumulated before the current run (§9, D-025). */
  running_ms: number;
};

export type BudgetAxis = "tokens" | "currency" | "wall_clock_ms" | "turns";

export type RunOutcome = {
  readonly task_id: string;
  readonly state: TaskState;
  /** The park reason, or the failure reason (`ttl_expired`, `verification_failed`); null otherwise. */
  readonly reason: string | null;
};

type TaskRecord = {
  task: Task;
  readonly constants: Readonly<Record<string, Constant>>;
  readonly criterion: AdmittedCriterion | null;
  /** When admission happened, wall clock: the ttl runs from here (§6.4). */
  readonly admittedAt: number;
  readonly usage: Usage;
  /** Monotonic instant the current run began, or null when not running. */
  runningSince: number | null;
  pending: TurnInput[];
};

const NO_COST: EntryCost = { tokens_in: 0, tokens_out: 0, tokens_cached: 0, currency: 0, duration_ms: 0 };

/** §2.1 `output_class`: the result's class from the call's input class. */
export function outputClass(rule: OutputClassRule, input: DataClass): DataClass {
  return { sensitivity: rule.sensitivity === "input" ? input.sensitivity : rule.sensitivity, integrity: rule.integrity };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One value of the model's tool call, read by mechanism, never by content
 * (invariant 7; D-060): `{"ref": "${…}"}` is a `bound` reference, `{"slot":
 * name}` names a constant fixed at admission, and a plain scalar is free text
 * the model composed, so `synthesized`. Anything else is passed on as written;
 * it states no provenance, and the boundary judges it so (D-054).
 */
function argumentSource(value: unknown): ArgumentSource | unknown {
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "ref" && typeof value["ref"] === "string") return { class: "bound", reference: value["ref"] };
    if (keys.length === 1 && keys[0] === "slot" && typeof value["slot"] === "string") return { class: "constant", slot: value["slot"] };
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    return { class: "synthesized", value };
  }
  return value;
}

/** The proposal for a model's tool call, or null when its input is not an object of arguments. */
export function toProposal(capability: string, input: unknown): { capability: string; arguments: Record<string, unknown> } | null {
  if (!isPlainObject(input)) return null;
  const args: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(input)) args[name] = Array.isArray(value) ? value.map(argumentSource) : argumentSource(value);
  return { capability, arguments: args };
}

/** The axes with no budget left (`>=`, checked before a turn) or overrun (`>`, checked after one). */
export function spentAxes(usage: Usage & { readonly running_now: number }, budget: Task["budget"], mode: "exhausted" | "exceeded"): BudgetAxis[] {
  const over = (used: number, limit: number): boolean => (mode === "exhausted" ? used >= limit : used > limit);
  const axes: BudgetAxis[] = [];
  if (over(usage.tokens, budget.tokens)) axes.push("tokens");
  if (over(usage.currency, budget.currency)) axes.push("currency");
  if (over(usage.running_now, budget.wall_clock_ms)) axes.push("wall_clock_ms");
  if (over(usage.turns, budget.turns)) axes.push("turns");
  return axes;
}

function textOf(bytes: Buffer): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function linesOf(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * Writes a closure for a task (§3.4.4). The schema refuses a `verifier_identity`
 * equal to any actor that served one of the task's turns, read from the
 * journal at write time, and refuses `verified` without an operator criterion
 * and a passing method. Nothing is written when it refuses.
 */
export function writeClosure(journal: JournalWriter, taskId: string, sensitivity: DataClass["sensitivity"], input: unknown): Closure {
  const executing = [...new Set(readTrajectory(journal.root, taskId).filter((entry) => entry.kind === "turn").map((entry) => entry.actor))];
  const closure = parseAtBoundary("closure", closureSchemaFor(executing), input);
  if (closure.task_id !== taskId) throw new RunnerError(`closure names task ${closure.task_id}, not ${taskId}`);
  journal.append(
    taskId,
    { kind: "note", actor: RUNNER_ACTOR, provider: null, data_class: { sensitivity, integrity: "untrusted" }, cost: NO_COST },
    new TextEncoder().encode(canonicalJson({ event: "closure", closure })),
  );
  return closure;
}

export class Runner {
  readonly #journal: JournalWriter;
  readonly #registry: CapabilityRegistry;
  readonly #grants: GrantStore;
  readonly #provider: ModelProvider;
  readonly #sources: readonly SourceRegistration[];
  readonly #clock: () => Date;
  readonly #monotonic: () => number;
  readonly #boundary: EnforcementBoundary;
  readonly #lock: RunnerLock;
  readonly #tasks = new Map<string, TaskRecord>();

  private constructor(options: RunnerOptions, lock: RunnerLock) {
    this.#journal = options.journal;
    this.#registry = options.registry;
    this.#grants = options.grants;
    this.#provider = options.provider;
    this.#sources = options.sources;
    this.#clock = options.clock ?? (() => new Date());
    this.#monotonic = options.monotonic ?? (() => performance.now());
    this.#boundary = new EnforcementBoundary({ registry: options.registry, grants: options.grants, journal: options.journal, clock: this.#clock });
    this.#lock = lock;
  }

  /** Starts a runner on a journal. A second runner on the same journal volume refuses to start (D-025). */
  static async open(options: RunnerOptions): Promise<Runner> {
    return new Runner(options, await acquireRunnerLock(options.journal.root));
  }

  /** Releases the journal volume's runner lock. */
  shutdown(): Promise<void> {
    return this.#lock.release();
  }

  task(id: string): Task | undefined {
    return this.#tasks.get(id)?.task;
  }

  usage(id: string): Readonly<Usage> | undefined {
    const record = this.#tasks.get(id);
    return record === undefined ? undefined : { ...record.usage, running_ms: this.#runningMs(record) };
  }

  /**
   * Admits a task, or rejects it (§5). The decision and every failed check are
   * journalled under the task's id, which can then never be admitted again.
   */
  admit(input: unknown): Admitted | Rejected {
    const request = parseAtBoundary("admission request", AdmissionRequest, input);
    if (this.#tasks.has(request.id) || readTrajectory(this.#journal.root, request.id).length > 0) {
      throw new RunnerError(`task id ${request.id} already has a trajectory; ids are never reused`);
    }
    const decision = admit(request, { registry: this.#registry, grants: this.#grants, provider: this.#provider.profile, sources: this.#sources });
    const integrity = decision.admitted ? decision.task.criterion_integrity : "untrusted";
    this.#append(request.id, "note", RUNNER_ACTOR, { sensitivity: request.sensitivity_floor, integrity }, {
      event: "admission",
      outcome: decision.admitted ? "admitted" : "rejected",
      request,
      ...(decision.admitted ? { task: decision.task, warnings: decision.warnings } : { failures: decision.failures }),
    });
    if (decision.admitted) {
      this.#tasks.set(request.id, {
        task: decision.task,
        constants: decision.constants,
        criterion: decision.criterion,
        admittedAt: this.#clock().getTime(),
        usage: { tokens: 0, currency: 0, turns: 0, running_ms: 0 },
        runningSince: null,
        pending: [],
      });
    }
    return decision;
  }

  /** Starts an admitted task, or continues a running one, until it parks, fails, or completes. */
  async run(id: string): Promise<RunOutcome> {
    const record = this.#record(id);
    if (record.task.state === "admitted") {
      this.#transition(record, { state: "running", runtime_substate: "active" });
      this.#note(record, RUNNER_ACTOR, { event: "state", to: "running" });
      record.pending.push({ kind: "objective", objective: record.task.objective, constants: this.#constantValues(record) });
    } else if (record.task.state !== "running") {
      throw new RunnerError(`task ${id} is ${record.task.state}; only an admitted or running task runs`);
    }
    record.runningSince = this.#monotonic();
    try {
      return await this.#loop(record);
    } finally {
      record.usage.running_ms = this.#runningMs(record);
      record.runningSince = null;
    }
  }

  /**
   * The operator closes a task that completed without verification. The result
   * is `accepted`, never `verified`: the operator may trigger verification but
   * never confer it (§6.1).
   */
  closeAccepted(id: string, principal: string): Closure {
    const record = this.#record(id);
    if (record.task.state !== "complete_unverified") throw new RunnerError(`task ${id} is ${record.task.state}; only complete_unverified is closed by the operator`);
    if (principal !== record.task.principal) throw new RunnerError(`${principal} is not the principal of task ${id}`);
    const closure = writeClosure(this.#journal, id, record.task.sensitivity_floor, {
      ...this.#closureBase(record),
      verification_result: "inconclusive",
      closure_mode: "accepted",
      verifier_identity: principal,
    });
    this.#transition(record, { state: "accepted", runtime_substate: null });
    this.#note(record, RUNNER_ACTOR, { event: "state", to: "accepted", by: principal });
    return closure;
  }

  async #loop(record: TaskRecord): Promise<RunOutcome> {
    for (;;) {
      if (this.#ttlExpired(record)) return this.#fail(record, "ttl_expired");
      const exhausted = this.#spent(record, "exhausted");
      if (exhausted.length > 0) return this.#parkBudget(record, exhausted);

      // Assemble. Under `native` context the provider holds the conversation; the turn carries what is new (§10.2).
      const request: TurnRequest = { task_id: record.task.id, turn: record.usage.turns + 1, input: record.pending, tools: this.#tools(record) };
      record.pending = [];
      // A synthesized value is at least as sensitive as the turn that composed it (§1.2, D-041).
      const synthesis: Synthesis = { sensitivity: record.task.sensitivity_floor };
      const started = this.#monotonic();
      const response = parseAtBoundary("provider response", TurnResponse, await this.#provider.turn(request));
      const durationMs = Math.max(0, Math.round(this.#monotonic() - started));
      const { tokens_in, tokens_out, tokens_cached } = response.usage;
      const price = this.#provider.profile.cost;
      const currency = tokens_in * price.input + tokens_out * price.output + tokens_cached * price.cached;
      record.usage.tokens += tokens_in + tokens_out + tokens_cached;
      record.usage.currency += currency;
      record.usage.turns += 1;
      // The turn holds synthesized text: its class is the synthesized class, so no reference into it gains integrity (§2.6).
      this.#append(record.task.id, "turn", response.model, this.#synthesizedClass(record), {
        turn: request.turn,
        model: response.model,
        model_version: response.model_version,
        request_digest: contentAddress(canonicalJson(request)),
        input: request.input,
        output: response.output,
      }, { tokens_in, tokens_out, tokens_cached, currency, duration_ms: durationMs }, this.#provider.profile.id);

      if (this.#ttlExpired(record)) return this.#fail(record, "ttl_expired");
      // A turn that overran a budget is journalled but not acted on (D-062).
      const exceeded = this.#spent(record, "exceeded");
      if (exceeded.length > 0) return this.#parkBudget(record, exceeded);

      const outcome = await this.#act(record, response.output, synthesis);
      if (outcome !== null) return outcome;
    }
  }

  async #act(record: TaskRecord, output: ModelOutput, synthesis: Synthesis): Promise<RunOutcome | null> {
    if (output.kind === "done") return this.#complete(record);
    if (output.kind === "text") {
      record.pending.push({ kind: "no_action" });
      return null;
    }
    const proposal = toProposal(output.capability, output.input);
    if (proposal === null) {
      this.#note(record, RUNNER_ACTOR, { event: "malformed_tool_call", capability: output.capability });
      record.pending.push({ kind: "rejected", call_seq: null, reason: "the tool call's input is not an object of arguments" });
      return null;
    }
    const verdict = this.#boundary.authorize(this.#context(record, synthesis), proposal);
    if (verdict.outcome === "reject") {
      record.pending.push({ kind: "rejected", call_seq: verdict.call_seq, reason: verdict.detail.reason });
      return null;
    }
    if (verdict.outcome === "park") return this.#park(record, verdict.detail.reason, verdict.call_seq, verdict.detail);
    const performed = await this.#perform(record, verdict.authorization);
    record.pending.push({
      kind: "result",
      call_seq: verdict.call_seq,
      result_seq: performed.seq,
      exit_code: performed.result?.exitCode ?? null,
      stdout: performed.result === null ? "" : textOf(performed.result.stdout),
    });
    return this.#routingCheck(record);
  }

  /** `perform`, then the `capability_result` entry. The result's class follows the capability's `output_class` (§2.1). */
  async #perform(record: TaskRecord, authorization: Authorization): Promise<{ seq: number; result: InvocationResult | null }> {
    const started = this.#monotonic();
    let result: InvocationResult | null = null;
    let error: string | null = null;
    try {
      result = await this.#boundary.perform(authorization);
    } catch (caught: unknown) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const durationMs = Math.max(0, Math.round(this.#monotonic() - started));
    const capability = this.#registry.capability(authorization.capability);
    if (capability === undefined) throw new RunnerError(`capability ${authorization.capability} is not registered`);
    const dataClass = outputClass(capability.output_class, authorization.input_class);
    const stdout = result === null ? "" : textOf(result.stdout);
    const seq = this.#append(record.task.id, "capability_result", ENFORCEMENT_ACTOR, dataClass, {
      call_seq: authorization.call_seq,
      capability: authorization.capability,
      grant: authorization.grant,
      adapter: authorization.adapter,
      outcome: result === null ? "not_run" : "ran",
      error,
      exit_code: result?.exitCode ?? null,
      signal: result?.signal ?? null,
      stdout,
      stdout_lines: linesOf(stdout),
      stderr: result === null ? "" : textOf(result.stderr),
    }, { ...NO_COST, duration_ms: durationMs }, authorization.adapter);
    // Exposure is cumulative: what the task read raises its floor, never lowers it (§1.2, §3.1).
    this.#transition(record, { sensitivity_floor: raiseSensitivityFloor(record.task.sensitivity_floor, dataClass.sensitivity) });
    return { seq, result };
  }

  /** §10.3 mid-run: a floor raised to `confidential`+ on a provider holding server-side state parks `routing_unavailable`. */
  #routingCheck(record: TaskRecord): RunOutcome | null {
    if (compareSensitivity(record.task.sensitivity_floor, "confidential") >= 0 && this.#provider.profile.conversation_state !== "stateless") {
      return this.#park(record, "routing_unavailable", null, { sensitivity_floor: record.task.sensitivity_floor, provider: this.#provider.profile.id });
    }
    return null;
  }

  /** The model said done. That is a claim; only verification by the runner can make it `verified` (invariant 3). */
  async #complete(record: TaskRecord): Promise<RunOutcome> {
    const { criterion } = record;
    if (record.task.closure_mode !== "verified" || criterion === null) {
      this.#transition(record, { state: "complete_unverified", runtime_substate: null });
      this.#note(record, RUNNER_ACTOR, { event: "state", to: "complete_unverified", reason: "no operator criterion and method license verified closure" });
      return this.#outcome(record, null);
    }
    this.#note(record, VERIFIER_ACTOR, { event: "verification", phase: "started", method: record.task.verification });
    // The criterion's command, every argument a constant slot fixed at admission, through the boundary like any call.
    const verdict = this.#boundary.authorize(this.#context(record, { sensitivity: record.task.sensitivity_floor }), {
      capability: criterion.capability,
      arguments: criterion.arguments,
    });
    if (verdict.outcome === "park") return this.#park(record, verdict.detail.reason, verdict.call_seq, verdict.detail);
    if (verdict.outcome === "reject") {
      this.#note(record, VERIFIER_ACTOR, { event: "verification", phase: "finished", result: "inconclusive", call_seq: verdict.call_seq });
      this.#transition(record, { state: "complete_unverified", runtime_substate: null });
      this.#note(record, RUNNER_ACTOR, { event: "state", to: "complete_unverified", reason: "verification inconclusive" });
      return this.#outcome(record, null);
    }
    const performed = await this.#perform(record, verdict.authorization);
    const passed = performed.result !== null && performed.result.exitCode === criterion.exit_code;
    this.#note(record, VERIFIER_ACTOR, { event: "verification", phase: "finished", result: passed ? "pass" : "fail", result_seq: performed.seq });
    if (!passed) return this.#fail(record, "verification_failed");
    writeClosure(this.#journal, record.task.id, record.task.sensitivity_floor, {
      ...this.#closureBase(record),
      verification_result: "pass",
      closure_mode: "verified",
      verifier_identity: VERIFIER_ACTOR,
    });
    this.#transition(record, { state: "verified", runtime_substate: null });
    this.#note(record, RUNNER_ACTOR, { event: "state", to: "verified" });
    return this.#outcome(record, null);
  }

  #closureBase(record: TaskRecord): Record<string, unknown> {
    const { task, usage } = record;
    return {
      task_id: task.id,
      criterion_ref: task.criterion === null ? null : contentAddress(canonicalJson(task.criterion)),
      criterion_integrity: task.criterion_integrity,
      verification_method: task.verification,
      replay_fidelity: this.#provider.profile.replay_fidelity,
      artifacts: [],
      cost_actual: { tokens: usage.tokens, currency: usage.currency, wall_clock_ms: Math.round(this.#runningMs(record)), turns: usage.turns },
    };
  }

  #parkBudget(record: TaskRecord, axes: readonly BudgetAxis[]): RunOutcome {
    const { usage, task } = record;
    return this.#park(record, "budget_exceeded", null, {
      axes,
      used: { tokens: usage.tokens, currency: usage.currency, wall_clock_ms: Math.round(this.#runningMs(record)), turns: usage.turns },
      budget: task.budget,
    });
  }

  #park(record: TaskRecord, reason: string, callSeq: number | null, detail: unknown): RunOutcome {
    this.#append(record.task.id, "park", RUNNER_ACTOR, this.#synthesizedClass(record), { reason, call_seq: callSeq, detail });
    this.#transition(record, { state: "parked", runtime_substate: null });
    return this.#outcome(record, reason);
  }

  #fail(record: TaskRecord, reason: string): RunOutcome {
    this.#transition(record, { state: "failed", runtime_substate: null });
    this.#note(record, RUNNER_ACTOR, { event: "state", to: "failed", reason });
    return this.#outcome(record, reason);
  }

  #outcome(record: TaskRecord, reason: string | null): RunOutcome {
    return { task_id: record.task.id, state: record.task.state, reason };
  }

  /** TTL counts wall time from admission, including sleep and parked time (§6.4, D-025). */
  #ttlExpired(record: TaskRecord): boolean {
    return this.#clock().getTime() - record.admittedAt >= record.task.ttl;
  }

  #runningMs(record: TaskRecord): number {
    return record.usage.running_ms + (record.runningSince === null ? 0 : this.#monotonic() - record.runningSince);
  }

  #spent(record: TaskRecord, mode: "exhausted" | "exceeded"): BudgetAxis[] {
    return spentAxes({ ...record.usage, running_now: this.#runningMs(record) }, record.task.budget, mode);
  }

  #synthesizedClass(record: TaskRecord): DataClass {
    // Slice 1 admits `native` context only (D-059), where synthesized values are `untrusted` (§2.6).
    return { sensitivity: record.task.sensitivity_floor, integrity: "untrusted" };
  }

  #context(record: TaskRecord, synthesis: Synthesis): TaskContext {
    return { task: record.task, constants: record.constants, synthesis };
  }

  #constantValues(record: TaskRecord): Record<string, string | number | boolean> {
    return Object.fromEntries(Object.entries(record.constants).map(([slot, constant]) => [slot, constant.value]));
  }

  #tools(record: TaskRecord): ToolDescription[] {
    const ids = new Set<string>();
    for (const id of record.task.grants) for (const capability of this.#grants.get(id)?.capability_selector.capabilities ?? []) ids.add(capability);
    return [...ids].flatMap((id) => {
      const capability = this.#registry.capability(id);
      if (capability === undefined) return [];
      const fields = Object.fromEntries(
        Object.entries(capability.interface).map(([name, field]) => [
          name,
          { role: field.role, type: field.type.kind === "enum" ? `enum(${field.type.values.join("|")})` : field.type.kind },
        ]),
      );
      return [{ capability: id, fields }];
    });
  }

  #transition(record: TaskRecord, patch: Partial<Pick<Task, "state" | "runtime_substate" | "sensitivity_floor">>): void {
    if (patch.sensitivity_floor !== undefined) assertSensitivityFloorTransition(record.task.sensitivity_floor, patch.sensitivity_floor);
    record.task = parseAtBoundary("task", Task, { ...record.task, ...patch });
  }

  #record(id: string): TaskRecord {
    const record = this.#tasks.get(id);
    if (record === undefined) throw new RunnerError(`task ${id} is not admitted on this runner`);
    return record;
  }

  #note(record: TaskRecord, actor: string, payload: Record<string, unknown>): number {
    return this.#append(record.task.id, "note", actor, this.#synthesizedClass(record), payload);
  }

  #append(
    taskId: string,
    kind: "note" | "turn" | "park" | "capability_result",
    actor: string,
    dataClass: DataClass,
    payload: unknown,
    cost: EntryCost = NO_COST,
    provider: string | null = null,
  ): number {
    try {
      return this.#journal.append(taskId, { kind, actor, provider, data_class: dataClass, cost }, new TextEncoder().encode(canonicalJson(payload))).seq;
    } catch (error: unknown) {
      if (error instanceof BoundaryError) throw new RunnerError(`journal refused a ${kind} entry: ${error.message}`);
      throw error;
    }
  }
}
