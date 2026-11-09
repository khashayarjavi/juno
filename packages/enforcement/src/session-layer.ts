import { realpathSync } from "node:fs";
import { type Budget, type DataClass, pathWithin } from "../../contracts/src/index.js";
import { type EntryDraft, JournalWriter, type JournalWriterOptions, canonicalJson } from "../../journal/src/index.js";
import type { CapabilityRegistry } from "../../registry/src/index.js";
import { EnforcementBoundary } from "./boundary.js";
import type { GrantStore } from "./grants.js";
import { type TrustAnchor } from "./signature.js";
import { type HostIo, type ServiceName, type StartupSpec, StartupRefused, socketRefusals, startupCheck, systemHostIo } from "./startup.js";

/**
 * THE session layer (operator ruling D-193; DECISIONS.md D-194). Every mode (JUNO's own loop, the Claude Code hook, the
 * MCP gateway) admits its sessions, passes its calls and writes its journal only through it:
 *   - `SessionLayer.open` runs THE start-up check (startup.ts) before anything is opened; it is the only way to get the
 *     journal, so no service can start without the check;
 *   - the layer holds the journal privately: a mode appends only through `record` or `append`, and its boundary is the
 *     one `boundary()` builds on that journal;
 *   - `admit` journals the admission and opens the session; `refuse` journals a refused one at the most restrictive class;
 *   - a session owns the rejection limit (§2.7.1 A4; it journals the `rejection_limit` park itself), the budgets (§3.1,
 *     §4.3: `beginCall` counts every call and parks `budget_exceeded` itself; the own loop charges turns, tokens and
 *     currency), TTL expiry (§6.4), and every park (§8.3: `integrity_floor` and `adapter_quarantined` are never
 *     overridable, whatever the mode asks).
 * Mode classes take a `SessionLayer` and refuse anything else (`SessionLayer.require`), and check that the workspaces,
 * state and sockets they use are the ones the start-up check judged.
 */

export const BUDGET_AXES = ["tokens", "currency", "wall_clock_ms", "turns"] as const;
export type BudgetAxis = (typeof BUDGET_AXES)[number];
export type Spend = { tokens: number; currency: number; wall_clock_ms: number; turns: number };
export const NO_SPEND: Readonly<Spend> = Object.freeze({ tokens: 0, currency: 0, wall_clock_ms: 0, turns: 0 });

/** The axes with nothing left: no further turn or call may start. */
export function exhaustedAxes(spent: Readonly<Spend>, budget: Budget, axes: readonly BudgetAxis[] = BUDGET_AXES): BudgetAxis[] {
  return axes.filter((axis) => spent[axis] >= budget[axis]);
}

/** The axes a finished turn went past. Its proposed calls are then not acted on. */
export function overrunAxes(spent: Readonly<Spend>, budget: Budget, axes: readonly BudgetAxis[] = BUDGET_AXES): BudgetAxis[] {
  return axes.filter((axis) => spent[axis] > budget[axis]);
}

/** §8.3: parks the operator can never override, in every mode. */
export const NON_OVERRIDABLE_PARKS: ReadonlySet<string> = new Set(["integrity_floor", "adapter_quarantined"]);

/** A refused admission is recorded at the most restrictive class (as mode A always has). */
export const REFUSED_ADMISSION_CLASS: DataClass = { sensitivity: "secret", integrity: "untrusted" };

export type SessionMode = "own_loop" | "hook" | "gateway";

const MODE_OF_SERVICE: Readonly<Record<ServiceName, SessionMode>> = { runner: "own_loop", hook: "hook", gateway: "gateway" };

export type SessionLimits = {
  /** §2.7.1 A4: consecutive rejections that park `rejection_limit`. */
  readonly rejection_limit: number;
  /** §6.4: wall time since admission, parked time included. */
  readonly ttl: number;
  readonly budget: Budget;
  /** The axes JUNO measures in this mode: all four in its own loop; tool calls (`turns`) and wall clock in hook and gateway modes (§4.3). */
  readonly metered: readonly BudgetAxis[];
  /** When wall clock runs: only while the task runs (own loop, D-025), or from admission on (hook and gateway sessions never stop). */
  readonly clock: "while_running" | "from_admission";
  /** Fields every park of this session carries (hook: `{ mode: "hook", answer: "deny" }`; gateway: `{ mode: "gateway", answer: "isError" }`). */
  readonly park_fields?: Readonly<Record<string, unknown>>;
};

/** One rejection counted toward the limit: what it was and the journal `seq` that records it. */
export type RejectionMark = { readonly kind: string; readonly seq: number | null };

const NO_COST = { tokens_in: 0, tokens_out: 0, tokens_cached: 0, currency: 0, duration_ms: 0 };
const encoder = new TextEncoder();

export type RecordOptions = { readonly actor: string; readonly provider?: string | null; readonly cost?: EntryDraft["cost"] };

export type LayerOpened = { readonly spec: StartupSpec; readonly refusals: readonly string[]; readonly layer: SessionLayer | null };
const OBSERVERS = new Set<(event: LayerOpened) => void>();

/** Held only by `SessionLayer.open`. */
const OPENED_BY_CHECK = Symbol("opened by the shared start-up check");

export class SessionLayerError extends Error {
  override readonly name = "SessionLayerError";
}

export class SessionLayer {
  readonly #journal: JournalWriter;
  readonly #spec: StartupSpec;
  readonly #anchor: TrustAnchor | null;
  readonly #host: HostIo;
  readonly #clock: () => Date;
  readonly #sessions = new Map<string, GovernedSession>();
  readonly #workspaces: readonly { readonly path: string; readonly real: string }[];

  private constructor(token: symbol, spec: StartupSpec, anchor: TrustAnchor | null, host: HostIo, clock: () => Date, journal: JournalWriterOptions) {
    // Only `open` holds the token, so no code can make a layer without the start-up check (D-194).
    if (token !== OPENED_BY_CHECK) throw new SessionLayerError("a session layer is made only by SessionLayer.open, after the shared start-up check (D-194)");
    this.#spec = spec;
    this.#anchor = anchor;
    this.#host = host;
    this.#clock = clock;
    this.#workspaces = spec.workspaces.map((path) => ({ path, real: realOrGiven(path) }));
    this.#journal = JournalWriter.open(spec.journal, journal);
  }

  /**
   * Runs the shared start-up check for `spec` and, only if it passes, opens the journal and returns the layer. Throws
   * `StartupRefused` with every refusal otherwise, having opened nothing.
   */
  static open(spec: StartupSpec, options: { readonly host?: HostIo; readonly clock?: () => Date; readonly journal?: JournalWriterOptions } = {}): SessionLayer {
    const host = options.host ?? systemHostIo();
    const checked = startupCheck(spec, host);
    if (!checked.ok) {
      for (const listener of OBSERVERS) listener({ spec, refusals: checked.refusals, layer: null });
      throw new StartupRefused(spec.service, checked.refusals);
    }
    const layer = new SessionLayer(OPENED_BY_CHECK, Object.freeze({ ...spec, workspaces: [...spec.workspaces], state: spec.state.map((item) => ({ ...item })) }), checked.anchor, host, options.clock ?? (() => new Date()), options.journal ?? {});
    for (const listener of OBSERVERS) listener({ spec, refusals: [], layer });
    return layer;
  }

  /**
   * Watches every `open` in this process: the spec judged, the refusals (empty when it opened) and the layer. The
   * entry-point test uses it to see that an entry ran THE shared check and admitted through the layer it got (D-194).
   * Returns the function that stops watching.
   */
  static observe(listener: (event: LayerOpened) => void): () => void {
    OBSERVERS.add(listener);
    return () => {
      OBSERVERS.delete(listener);
    };
  }

  /** Whether `value` is a layer `open` made (no other object passes, whatever its shape). */
  static genuine(value: unknown): value is SessionLayer {
    return typeof value === "object" && value !== null && #journal in value;
  }

  /** The layer a mode was given, if `open` made it for `service`; throws otherwise (D-194). */
  static require(value: unknown, service: ServiceName): SessionLayer {
    if (!SessionLayer.genuine(value)) throw new SessionLayerError(`the ${service} service was not given a session layer opened by the shared start-up check (D-194)`);
    if (value.#spec.service !== service) throw new SessionLayerError(`the session layer was opened for the ${value.#spec.service} service, not the ${service} service (D-194)`);
    return value;
  }

  get service(): ServiceName {
    return this.#spec.service;
  }

  get mode(): SessionMode {
    return MODE_OF_SERVICE[this.#spec.service];
  }

  /** The journal's root, for readers. */
  get root(): string {
    return this.#journal.root;
  }

  /** The anchor the start-up check verified, or null when none was configured. */
  get anchor(): TrustAnchor | null {
    return this.#anchor;
  }

  /** What the start-up check judged. */
  get spec(): StartupSpec {
    return this.#spec;
  }

  /** The enforcement boundary on this layer's journal; the only boundary a mode may use. */
  boundary(registry: CapabilityRegistry, grants: GrantStore, clock: () => Date = this.#clock): EnforcementBoundary {
    this.requireGrants(grants);
    return new EnforcementBoundary({ registry, grants, journal: this.#journal, clock });
  }

  /** A grant store must check signatures against the verified anchor, when one was configured (§3.2, D-116, D-194). */
  requireGrants(grants: GrantStore): void {
    if (this.#anchor !== null && !this.#anchor.equals(grants.trustAnchor)) throw new SessionLayerError("the grant store does not check grants against the trust anchor the start-up check verified (§3.2, D-194)");
  }

  /** Throws unless `path` is one of the workspaces the start-up check judged, or inside one, lexically and as the kernel resolves it (D-194). */
  requireWorkspace(what: string, path: string): void {
    const real = realOrGiven(path);
    if (!this.#workspaces.some((root) => pathWithin(path, root.path) && pathWithin(real, root.real))) {
      throw new SessionLayerError(`${what} ${path} is not a workspace the start-up check judged; JUNO's state could overlap it (D-148, D-194)`);
    }
  }

  /** Throws unless `path` is state the start-up check judged, or inside it (D-194). */
  requireState(what: string, path: string): void {
    const items = [this.#spec.journal, ...this.#spec.state.map((item) => item.path), ...(this.#spec.anchor === null ? [] : [this.#spec.anchor])];
    if (!items.some((item) => pathWithin(path, item))) throw new SessionLayerError(`${what} ${path} is not state the start-up check judged (D-194)`);
  }

  /**
   * Before a service listens: `path` must be a socket the start-up check judged, its folder must still be writable by no
   * one but its owner, and `mode` may give at most read and write to the owner and group (D-144, D-173, D-194).
   */
  requireSocket(path: string, mode: number): void {
    if (!this.#spec.state.some((item) => item.kind === "socket" && item.path === path)) throw new SessionLayerError(`the socket ${path} is not one the start-up check judged (D-194)`);
    const refusals = socketRefusals("the socket", path, this.#host);
    if ((mode & 0o007) !== 0 || (mode & ~0o660) !== 0) refusals.push("the socket's mode may give at most read and write to its owner and group (D-173)");
    if (refusals.length > 0) throw new SessionLayerError(refusals.join("; "));
  }

  now(): number {
    return this.#clock().getTime();
  }

  /** A journal record outside any session (the runner's and registry's own records). */
  append(taskId: string, kind: EntryDraft["kind"], dataClass: DataClass, payload: unknown, options: RecordOptions): number {
    const draft: EntryDraft = { kind, actor: options.actor, provider: options.provider ?? null, data_class: dataClass, cost: options.cost ?? NO_COST };
    return this.#journal.append(taskId, draft, encoder.encode(canonicalJson(payload))).seq;
  }

  /** A refused admission: never run, never referenced, so recorded at the most restrictive class. */
  refuse(taskId: string, payload: Record<string, unknown>, actor: string): number {
    return this.append(taskId, "note", REFUSED_ADMISSION_CLASS, { type: "admission", outcome: "rejected", ...payload }, { actor });
  }

  /** Admits a session: journals its admission and opens it. An id is admitted once. */
  admit(taskId: string, limits: SessionLimits, admission: { readonly dataClass: DataClass; readonly payload: Record<string, unknown>; readonly actor: string; readonly now?: () => number }): GovernedSession {
    if (this.#sessions.has(taskId)) throw new SessionLayerError(`session ${taskId} is already open`);
    const now = admission.now ?? (() => this.now());
    const session = new GovernedSession(this, taskId, this.mode, limits, now(), { ...NO_SPEND }, now);
    this.append(taskId, "note", admission.dataClass, { type: "admission", outcome: "admitted", ...admission.payload }, { actor: admission.actor });
    this.#sessions.set(taskId, session);
    return session;
  }

  /** Reopens a session rebuilt from its journal (the own loop's resume); journals nothing. */
  restore(taskId: string, limits: SessionLimits, state: { readonly admittedAt: number; readonly spent: Spend; readonly now?: () => number }): GovernedSession {
    const session = new GovernedSession(this, taskId, this.mode, limits, state.admittedAt, { ...state.spent }, state.now ?? (() => this.now()));
    this.#sessions.set(taskId, session);
    return session;
  }

  session(taskId: string): GovernedSession | undefined {
    return this.#sessions.get(taskId);
  }

  /** Every session this layer opened, for the entry-point test (D-194). */
  sessions(): readonly GovernedSession[] {
    return [...this.#sessions.values()];
  }
}

export type CallStart = { readonly ok: true } | { readonly ok: false; readonly reason: "ttl_expired" } | { readonly ok: false; readonly reason: "budget_exceeded"; readonly axes: readonly BudgetAxis[] };

/** One admitted session: its limits, its spend, its consecutive rejections, and its journal records. */
export class GovernedSession {
  readonly #layer: SessionLayer;
  readonly id: string;
  readonly mode: SessionMode;
  readonly limits: SessionLimits;
  readonly admittedAt: number;
  readonly #spent: Spend;
  #runningSince: number | null;
  #rejections: RejectionMark[] = [];
  #parks = 0;
  #lastPark: string | null = null;
  readonly #now: () => number;

  constructor(layer: SessionLayer, id: string, mode: SessionMode, limits: SessionLimits, admittedAt: number, spent: Spend, now: () => number) {
    this.#layer = layer;
    this.#now = now;
    this.id = id;
    this.mode = mode;
    this.limits = limits;
    this.admittedAt = admittedAt;
    this.#spent = spent;
    this.#runningSince = limits.clock === "from_admission" ? admittedAt : null;
  }

  /** §6.4: TTL is wall time since admission, parked time included. */
  expired(): boolean {
    return this.#now() - this.admittedAt >= this.limits.ttl;
  }

  /** Spend so far, with the running time up to now. */
  spent(): Spend {
    const running = this.#runningSince === null ? 0 : Math.max(0, this.#now() - this.#runningSince);
    return { ...this.#spent, wall_clock_ms: this.#spent.wall_clock_ms + running };
  }

  /** Sets the spend recorded in the journal (the own loop's rebuild). */
  setSpent(spent: Spend): void {
    Object.assign(this.#spent, spent);
  }

  startClock(): void {
    if (this.#runningSince === null) this.#runningSince = this.#now();
  }

  stopClock(): void {
    if (this.#runningSince === null || this.limits.clock === "from_admission") return;
    this.#spent.wall_clock_ms += Math.max(0, this.#now() - this.#runningSince);
    this.#runningSince = null;
  }

  charge(spend: Partial<Pick<Spend, "tokens" | "currency" | "turns">>): void {
    this.#spent.tokens += spend.tokens ?? 0;
    this.#spent.currency += spend.currency ?? 0;
    this.#spent.turns += spend.turns ?? 0;
  }

  /** Metered axes with nothing left (all metered axes, or the ones named, which must be metered). */
  exhausted(axes: readonly BudgetAxis[] = this.limits.metered): BudgetAxis[] {
    return exhaustedAxes(this.spent(), this.limits.budget, axes.filter((axis) => this.limits.metered.includes(axis)));
  }

  overrun(): BudgetAxis[] {
    return overrunAxes(this.spent(), this.limits.budget, this.limits.metered);
  }

  /**
   * One call in a mediated mode (§4.3): TTL, then the budget, then the call is counted, so every call counts, one JUNO
   * then rejects included (D-192). On `budget_exceeded` the park is journalled here.
   */
  beginCall(dataClass: DataClass, actor: string, detail: Record<string, unknown>): CallStart {
    if (this.expired()) return { ok: false, reason: "ttl_expired" };
    const axes = this.exhausted();
    if (axes.length > 0) {
      this.park("budget_exceeded", true, dataClass, actor, detail);
      return { ok: false, reason: "budget_exceeded", axes };
    }
    this.charge({ turns: 1 });
    return { ok: true };
  }

  get rejections(): readonly RejectionMark[] {
    return [...this.#rejections];
  }

  /**
   * Counts one rejection (§2.7.1 A4). Under the limit: `parked: false`. At the limit, `park` is called with the marks
   * counted and must journal the `rejection_limit` park through `park()` below (the mode adds what its park records);
   * the layer refuses to go on if it did not.
   */
  reject<T>(mark: RejectionMark, park: (marks: readonly RejectionMark[]) => T): { readonly parked: false } | { readonly parked: true; readonly result: T } {
    this.#rejections.push(mark);
    if (this.#rejections.length < this.limits.rejection_limit) return { parked: false };
    const before = this.#parks;
    const result = park([...this.#rejections]);
    if (this.#parks === before || this.#lastPark !== "rejection_limit") throw new SessionLayerError(`session ${this.id} reached its rejection limit and no rejection_limit park was journalled (§2.7.1 A4, D-194)`);
    return { parked: true, result };
  }

  /** §2.7.1: the count resets when a call proceeds, and on resume. */
  clearRejections(): void {
    this.#rejections = [];
  }

  /**
   * Journals a park and clears the rejection count. It is overridable only if the mode asks and §8.3 allows. Answers
   * whether it is overridable and its `seq`.
   */
  park(reason: string, overridable: boolean, dataClass: DataClass, actor: string, detail: Record<string, unknown>): { readonly overridable: boolean; readonly seq: number } {
    const allowed = overridable && !NON_OVERRIDABLE_PARKS.has(reason);
    this.#rejections = [];
    this.#parks += 1;
    this.#lastPark = reason;
    const seq = this.record("park", dataClass, { ...(this.limits.park_fields ?? {}), ...detail, reason, overridable: allowed }, { actor });
    return { overridable: allowed, seq };
  }

  /** Journals one record of this session. */
  record(kind: EntryDraft["kind"], dataClass: DataClass, payload: unknown, options: RecordOptions): number {
    return this.#layer.append(this.id, kind, dataClass, payload, options);
  }
}

function realOrGiven(path: string): string {
  let at = path;
  const rest: string[] = [];
  for (;;) {
    try {
      const base = realpathSync(at);
      return rest.length === 0 ? base : `${base === "/" ? "" : base}/${rest.join("/")}`;
    } catch {
      if (at === "/" || at === "") return path;
      rest.unshift(at.slice(at.lastIndexOf("/") + 1));
      at = at.slice(0, Math.max(at.lastIndexOf("/"), 1));
    }
  }
}
