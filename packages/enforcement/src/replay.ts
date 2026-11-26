import { Sensitivity, type TrajectoryEntry } from "../../contracts/src/index.js";

/**
 * THE replay of one journal record (operator ruling 1 of 2026-11-26 on PR #70; DECISIONS.md D-266). A service's start
 * rebuilds every session from its verified record through `replaySession` (D-201): the shared layer's `resume` takes the
 * calls counted against the budget, the consecutive rejections and a stop for good from it; its start takes each
 * session's admission from it; its grant counts use its rule for a grant's use; and the hook service takes from it the
 * calls JUNO allowed whose result has not arrived. `juno journal report` replays each verified record through the very
 * same function and prints only what it answers: the per-entry judgement it makes and the state it ends in. The report
 * keeps no counting rule of its own, so the two can never judge the same entries differently (rounds 6 to 8 of PR #70,
 * D-263 to D-265: each a report reading the journal by a rule of its own).
 *
 * It only reads: it is given entries already verified, with their payloads, and changes nothing.
 */

/** One journal entry with its payload as the journal stores it (parsed JSON), or `undefined` when it cannot be read. */
export type RecoveredEntry = { readonly entry: TrajectoryEntry; readonly payload: unknown };

/** One rejection in a session's current run of consecutive rejections (§2.7.1 A4). */
export type RejectionMark = { readonly kind: string; readonly seq: number | null };

function field(payload: unknown, name: string): unknown {
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>)[name] : undefined;
}

/** What one journal entry is as a tool call. */
export type CallJudgement = { readonly kind: "call"; readonly outcome: unknown } | { readonly kind: "park"; readonly judged: boolean; readonly reason: unknown; readonly command: boolean } | { readonly kind: "rejection_limit" } | { readonly kind: "rejection" } | { readonly kind: "result_missing" } | { readonly kind: "session_ended"; readonly reason: string; readonly call: boolean } | { readonly kind: "gateway_call" };

/**
 * What one journal entry is as a tool call (D-256 to D-258), or null when it is none. Each tool call for which JUNO
 * journalled a decision has exactly one entry of kind `call` (a judged call, with its verdict's outcome; a judged park
 * is that call's, counted as the park), `park` (a park no judged call records: the hook's own, or the budget's),
 * `rejection` (a rejection no judged call records; one that names a judged call is that call's), `result_missing` (the
 * call denied because an earlier call's result had not arrived), or `session_ended` with `call: true` (the call that
 * found the session's time to live expired, denied, D-258). `gateway_call` is a call passed to JUNO's gateway, which
 * decides it in its own journal. `rejection_limit` is the park a session makes when a rejection reaches its limit: it
 * follows that rejected call and is not a call of its own (D-257). `session_ended` with `call: false` is a session
 * stopped because its journal head could not be anchored, which can happen outside any call. **After a session ends,
 * or when its admission was refused, JUNO denies its calls; it journals only a shell command it cannot read** (D-151,
 * D-152: parked whatever the session's state), so every other such call has no entry, and no count (D-258, D-259).
 */
export function journalledCall(entry: TrajectoryEntry, payload: unknown): CallJudgement | null {
  const judged = field(payload, "call_seq") !== undefined && field(payload, "call_seq") !== null;
  if (entry.kind === "capability_call") return { kind: "call", outcome: field(field(payload, "verdict"), "outcome") };
  if (entry.kind === "park") {
    const reason = field(payload, "reason");
    if (reason === "rejection_limit") return { kind: "rejection_limit" };
    return { kind: "park", judged, reason, command: field(payload, "command") !== undefined };
  }
  if (entry.kind !== "note") return null;
  const type = field(payload, "type");
  if (type === "gateway_call") return { kind: "gateway_call" };
  if (type === "rejection" && !judged) return { kind: "rejection" };
  if (type === "result_missing") return { kind: "result_missing" };
  const reason = field(payload, "reason");
  // The hook's and the gateway's end of a session: only `ttl_expired` is always written while a call is handled.
  if (type === "state" && field(payload, "to") === "failed" && typeof reason === "string") return { kind: "session_ended", reason, call: reason === "ttl_expired" };
  return null;
}

/**
 * What one journal entry says of a session's end (D-264), or null when it says nothing of it: a `stopped` note (the
 * session layer's stop for good, journalled when it happens, in a call or in the background: the interval's anchoring,
 * or a stop that could not anchor) or a mode's `state: failed` note, each with its reason. `stop` is true for a stop for
 * good, which a restarted service restores (`anchor_unavailable`); a `ttl_expired` end needs no restoring, as the
 * session's time to live is judged again from its admission.
 */
export function sessionEnd(entry: TrajectoryEntry, payload: unknown): { readonly reason: string; readonly stop: boolean } | null {
  if (entry.kind !== "note") return null;
  const type = field(payload, "type");
  const reason = field(payload, "reason");
  if (typeof reason !== "string") return null;
  if (type === "stopped") return { reason, stop: true };
  if (type === "state" && field(payload, "to") === "failed") return { reason, stop: reason === "anchor_unavailable" };
  return null;
}

export type AdmissionJudgement = { readonly kind: "admitted"; readonly payload: Readonly<Record<string, unknown>>; readonly refused_before: number } | { readonly kind: "refused"; readonly payload: Readonly<Record<string, unknown>>; readonly attempts: number } | { readonly kind: "not_recorded" };

/**
 * What a session record's admission notes say (D-263): `admitted` when any admission note says `outcome: "admitted"`
 * (an id is admitted at most once, D-201), with the refused attempts journalled before it; `refused` when every
 * admission note is a refusal; `not_recorded` when there is none. The hook service journals a refusal only for an id
 * not yet admitted; the gateway journals one into an admitted record when an admission under the same id is asked
 * again of the gateway process that already holds it ("this gateway already holds a session") (`refused_before` counts only the refusals before the admission).
 */
export function admissionOf(entries: readonly RecoveredEntry[]): AdmissionJudgement {
  const notes = entries.filter((item) => item.entry.kind === "note" && field(item.payload, "type") === "admission");
  const index = notes.findIndex((item) => field(item.payload, "outcome") === "admitted");
  const admitted = index < 0 ? undefined : notes[index];
  if (admitted !== undefined) return { kind: "admitted", payload: admitted.payload as Readonly<Record<string, unknown>>, refused_before: index };
  const first = notes[0];
  if (first === undefined) return { kind: "not_recorded" };
  return { kind: "refused", payload: first.payload as Readonly<Record<string, unknown>>, attempts: notes.length };
}

/** The grant a call used, when the entry is a call the boundary let proceed under a grant (§3.2 `max_invocations`; D-201). */
export function grantUseOf(entry: TrajectoryEntry, payload: unknown): string | null {
  if (entry.kind !== "capability_call") return null;
  const grant = field(payload, "grant");
  return typeof grant === "string" && field(field(payload, "verdict"), "outcome") === "proceed" ? grant : null;
}

/**
 * Where each kind of entry JUNO writes stands in what the replay answers (operator ruling 2 of 2026-11-26; D-266): a
 * figure it counts, or the reason it counts nothing. Keyed by the entry's kind, and for a note by `note:<type>`. Every
 * kind of entry (`ENTRY_KINDS`) and every note type any of JUNO's code writes is here: a test reads JUNO's source for
 * every note type it writes and fails on one that is not, so a kind added later is placed before it can be journalled
 * unseen. An entry of a summarised session that is not here makes the report refuse, fail-closed.
 */
export const ENTRY_PLACEMENT: Readonly<Record<string, { readonly counted: string } | { readonly not_counted: string }>> = Object.freeze({
  // Counted: what a tool call, its result, its admission or its end is.
  capability_call: { counted: "a tool call JUNO judged: allowed, parked (with its park entry) or rejected" },
  park: { counted: "a park: a call parked (counted once, with its judged call when it names one), or the rejection limit reached (after a rejected call; not a call of its own)" },
  capability_result: { counted: "a tool result: for a call JUNO allowed, for a call the hook passed to JUNO's gateway (which judged it in its own journal), or without JUNO's decision" },
  "note:admission": { counted: "the session's admission, or a refused admission attempt" },
  "note:rejection": { counted: "a call rejected (once: with the judged call it names, or on its own when it names none)" },
  "note:result_missing": { counted: "a call denied because an earlier call's result had not arrived; the calls whose result JUNO recorded missing" },
  "note:state": { counted: "the session's end (state failed, with its reason; the call that found its time to live expired)" },
  "note:stopped": { counted: "the session's stop for good (its journal head not copied off the machine)" },
  "note:gateway_call": { counted: "a call passed to JUNO's gateway, which judges it in its own journal" },
  "note:gateway_error": { counted: "a message JUNO's gateway could not complete, answered with an error (fail-closed)" },
  "note:authorized": { counted: "a call JUNO allowed now waits for its result (matched to the result when it arrives)" },
  "note:updated_input": { counted: "a shell call JUNO allowed, with the command it rebuilt, now waits for its result (matched to the result when it arrives)" },
  // Not counted: no tool call, result, admission or end.
  "note:anchoring": { not_counted: "the session's anchoring interval and journal key (§3.4.1)" },
  "note:anchor_failed": { not_counted: "a journal head that could not be copied off the machine (the stop it causes is counted)" },
  "note:checkpoint": { not_counted: "a checkpoint of a reversible workspace, taken at admission" },
  "note:checkpoint_restore": { not_counted: "an undo the operator ran (juno checkpoint restore)" },
  "note:recovered_truncation": { not_counted: "a torn final write JUNO repaired at a start (D-207)" },
  "note:server_request_refused": { not_counted: "a request from the upstream server to the client, refused (D-186); not a call of the session" },
  "note:record": { not_counted: "the journal's own record naming a record" },
  "note:recovery_epoch": { not_counted: "the journal's own record of its recovery epoch" },
  "note:stale_lock_reclaimed": { not_counted: "the journal's own record of a lock taken over at a start (D-243)" },
  "note:stale_lock_cleared": { not_counted: "the own loop's runner record of a lock taken over" },
  "note:grant_charge": { not_counted: "the own loop's runner record of a grant charged" },
  "note:task_failed": { not_counted: "the own loop's runner record of a task failed" },
  "note:quarantine": { not_counted: "the own loop's registry record of an adapter quarantined" },
  "note:verification": { not_counted: "the own loop's verification of a task" },
  "note:verification_pins": { not_counted: "the own loop's verification pins" },
  "note:pin_files": { not_counted: "the own loop's pinned files" },
  "note:pin_hash": { not_counted: "the own loop's pin hashes" },
  "note:protected_listing": { not_counted: "the own loop's protected listing" },
  "note:checkpoint_failed": { not_counted: "the own loop's checkpoint that could not be taken" },
  "note:closure": { not_counted: "the own loop's task closure" },
  "note:sensitivity_floor": { not_counted: "the own loop's sensitivity floor raised" },
  "note:context": { not_counted: "the own loop's context item" },
  turn: { not_counted: "a model turn of the own loop" },
  resume: { not_counted: "the own loop's resume of a task" },
  binding_resolution: { not_counted: "the boundary's binding resolution for a judged call" },
  steer: { not_counted: "not written in Slice 1.5 (Steer is out of scope)" },
  block: { not_counted: "not written in Slice 1.5" },
  unblock: { not_counted: "not written in Slice 1.5" },
  override: { not_counted: "not written in Slice 1.5 (Override is out of scope)" },
  gate: { not_counted: "not written in Slice 1.5" },
  abandon: { not_counted: "not written in Slice 1.5" },
  classification_proposal: { not_counted: "not written in Slice 1.5" },
  classification_contradiction: { not_counted: "not written in Slice 1.5" },
});

/** The placement key of an entry: its kind, or `note:<type>` for a note (`note:` with no type for a note with none). */
export function placementKey(entry: TrajectoryEntry, payload: unknown): string {
  if (entry.kind !== "note") return entry.kind;
  const type = field(payload, "type");
  return `note:${typeof type === "string" ? type : ""}`;
}

/** A call JUNO allowed that waits for its result, as the hook service holds it (plan item 8; D-201). */
export type PendingCall = {
  readonly call_seq: number | null;
  readonly reads: Sensitivity;
  readonly gateway: boolean;
  /** The call's own `tool_use_id`, or null when Claude Code gave it none: then the key it waits under is JUNO's label (`call-<seq>`, `gateway-<seq>`). */
  readonly tool_use_id: string | null;
};

/** What the replay judges a tool result to be. */
export type ResultJudgement =
  /** The result of a call JUNO allowed (`call_seq`, or null for a call passed to the gateway). */
  | { readonly authorized: true; readonly call_seq: number | null; readonly gateway: boolean }
  /**
   * A result no call JUNO allowed was waiting for: the harness ran it without JUNO's decision (D-142). `recorded_missing`
   * is the `result_missing` note that recorded this very call's result missing, when one did (its result came later).
   */
  | { readonly authorized: false; readonly recorded_missing: number | null };

/**
 * One call a `result_missing` note recorded (D-266, review round 9). `tool_use_id` is the call's own id, as the call
 * waiting for its result held it; null when it had none, and then `label` is the key JUNO recorded it under (its own
 * label, never Claude Code's id). Only a call with an id can be matched to a result that came later (`result_seq`): a
 * result with no id names no call, exactly as the hook service matches it.
 */
export type MissingCall = { readonly tool_use_id: string | null; readonly label: string | null; readonly call_seq: number | null; readonly recorded_at: number; readonly result_seq: number | null };

export type EntryJudgement = {
  readonly entry: TrajectoryEntry;
  readonly payload: unknown;
  /** Its place in `ENTRY_PLACEMENT`, or null when it has none (the report then refuses). */
  readonly placement: string | null;
  readonly call: CallJudgement | null;
  readonly end: { readonly reason: string; readonly stop: boolean } | null;
  readonly result: ResultJudgement | null;
  readonly grant_use: string | null;
  /** For a park or rejection that names a judged call (`call_seq`): that call's entry and payload. */
  readonly judged_call: RecoveredEntry | null;
  /** For a `gateway_error` note: the message JUNO's gateway could not complete (D-268). */
  readonly gateway_error: { readonly method: string | null } | null;
};

export type CallCounts = {
  /** Calls JUNO let proceed (`capability_call` with outcome `proceed`). */
  readonly allowed: number;
  /** Parks journalled (`park` entries other than the rejection limit), whichever check made them. */
  readonly parked: number;
  /** Calls JUNO rejected (`rejection` notes naming no judged call, and `capability_call` entries with outcome `reject`). */
  readonly rejected: number;
  /** The call that found the session's time to live expired, denied (D-258); later calls are not journalled. */
  readonly denied_session_ended: number;
  /** Calls denied because an earlier call's result had not arrived when they came (`result_missing`, plan item 8). */
  readonly denied_result_missing: number;
  /** Calls the hook passed to JUNO's gateway, which judged them there and journals them in its own journal (D-190). */
  readonly passed_to_gateway: number;
  /** Times the session parked at its rejection limit: each after a rejected call counted above, not a call of its own (D-257). */
  readonly rejection_limit_reached: number;
  /** Messages JUNO's gateway could not complete (`gateway_error`): each answered with an error, fail-closed (D-268). */
  readonly gateway_errors: number;
};

export type SessionReplay = {
  readonly admission: AdmissionJudgement;
  /** The admitting note's admission time in milliseconds, or null when it records none a start can read (`resume` refuses then). */
  readonly admitted_at: number | null;
  /** The admitting note's mode (`hook`, `gateway`, `own_loop`), or the first refusal's; null when none names one. */
  readonly mode: string | null;
  /** One judgement per entry, in the record's order. */
  readonly judged: readonly EntryJudgement[];
  readonly calls: CallCounts;
  /** The calls counted against the session's budget (`turns`), as the shared layer restores them. */
  readonly turns: number;
  /** The session's current run of consecutive rejections (§2.7.1 A4). */
  readonly rejections: readonly RejectionMark[];
  /** The first stop for good the record journals (a restarted service restores it), or null. */
  readonly stop: string | null;
  /** The session's first end (`sessionEnd`), with the entry that journalled it, or null. */
  readonly end: { readonly reason: string; readonly stop: boolean; readonly seq: number; readonly at: string } | null;
  /** The last `state` note's `to` when it is text, or null (a start's repair judges a session open unless it is closed). */
  readonly state: string | null;
  /** The calls JUNO allowed whose result the record does not hold, keyed as the hook service keys them. */
  readonly pending: ReadonlyMap<string, PendingCall>;
  /** Each call a `result_missing` note recorded, with the result the record holds for it later. */
  readonly missing: readonly MissingCall[];
  /** Why an entry that records a call waiting for its result could not be read (a hook session is then not rebuilt). */
  readonly malformed: readonly string[];
  /** Each grant's uses in this record: one per call that proceeded under it. */
  readonly grant_use: ReadonlyMap<string, number>;
};

/** A non-negative integer or null, as a call's `call_seq` and a missing call's are; undefined when it is neither. */
function seqOrNull(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return Number.isInteger(value) ? (value as number) : undefined;
}

function idOrNull(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/**
 * Replays one verified record. The calls counted against the budget, the consecutive rejections and the stop are what
 * the shared layer's `resume` restores; the pending calls are what the hook service restores. A tool result is the
 * result of a call JUNO allowed when that call is waiting for it: keyed by its `tool_use_id` as the hook service keys
 * it (an `authorized`, `updated_input` or `gateway_call` note sets it waiting, a `result_missing` note clears every
 * waiting call, a result takes it); and, in a mode that journals each result right after the call it ran and names
 * that call (the gateway, the own loop), the call its `call_seq` names when that call proceeded and has no result yet.
 * Any other result was run without JUNO's decision.
 */
export function replaySession(entries: readonly RecoveredEntry[]): SessionReplay {
  const admission = admissionOf(entries);
  const mode = admission.kind === "not_recorded" ? null : typeof admission.payload["mode"] === "string" ? admission.payload["mode"] : null;
  const judged: EntryJudgement[] = [];
  const counts = { allowed: 0, parked: 0, rejected: 0, denied_session_ended: 0, denied_result_missing: 0, passed_to_gateway: 0, rejection_limit_reached: 0, gateway_errors: 0 };
  const admittedAt = admission.kind === "admitted" ? Date.parse(String(admission.payload["admitted_at"])) : Number.NaN;
  const proceeded = new Map<number, boolean>();
  const calls = new Map<number, RecoveredEntry>();
  const pending = new Map<string, PendingCall>();
  const missing: { tool_use_id: string | null; label: string | null; call_seq: number | null; recorded_at: number; result_seq: number | null }[] = [];
  const malformed: string[] = [];
  const grantUse = new Map<string, number>();
  let turns = 0;
  let rejections: RejectionMark[] = [];
  let stop: string | null = null;
  let end: SessionReplay["end"] = null;
  let state: string | null = null;
  for (const item of entries) {
    const { entry, payload } = item;
    const key = placementKey(entry, payload);
    const call = journalledCall(entry, payload);
    const ended = sessionEnd(entry, payload);
    const grant = grantUseOf(entry, payload);
    let result: ResultJudgement | null = null;
    // The budget's calls and the consecutive rejections, exactly as a restarted service counts them (D-201, D-256).
    if (call !== null) {
      if (call.kind === "call") {
        turns += 1;
        if (call.outcome === "reject") rejections.push({ kind: "call", seq: entry.seq });
        else if (call.outcome === "proceed") rejections = [];
      } else if (call.kind === "park") {
        if (!call.judged && call.reason !== "budget_exceeded" && !call.command) turns += 1;
        rejections = [];
      } else if (call.kind === "rejection_limit") rejections = [];
      else if (call.kind === "gateway_call") turns += 1;
      else if (call.kind === "rejection") {
        turns += 1;
        rejections.push({ kind: "call", seq: entry.seq });
      }
    }
    // What each entry counts as a tool call (D-256 to D-258).
    if (call?.kind === "call") {
      calls.set(entry.seq, item);
      proceeded.set(entry.seq, call.outcome === "proceed");
      if (call.outcome === "proceed") counts.allowed += 1;
      else if (call.outcome === "reject") counts.rejected += 1;
    } else if (call?.kind === "rejection") counts.rejected += 1;
    else if (call?.kind === "gateway_call") counts.passed_to_gateway += 1;
    else if (call?.kind === "result_missing") counts.denied_result_missing += 1;
    else if (call?.kind === "rejection_limit") counts.rejection_limit_reached += 1;
    else if (call?.kind === "session_ended") {
      if (call.call) counts.denied_session_ended += 1;
    } else if (call?.kind === "park") counts.parked += 1;
    if (ended !== null) {
      if (end === null) end = { ...ended, seq: entry.seq, at: entry.timestamp };
      if (ended.stop && stop === null) stop = ended.reason;
    }
    if (grant !== null) grantUse.set(grant, (grantUse.get(grant) ?? 0) + 1);
    const type = entry.kind === "note" ? field(payload, "type") : undefined;
    if (entry.kind === "note" && type === "state") {
      const to = field(payload, "to");
      state = typeof to === "string" ? to : null;
    }
    // The calls waiting for their result, exactly as the hook service holds them (plan item 8, D-201).
    if (entry.kind === "note" && (type === "authorized" || type === "updated_input" || type === "gateway_call")) {
      const callSeq = seqOrNull(field(payload, "call_seq"));
      const toolUseId = idOrNull(field(payload, "tool_use_id"));
      const reads = Sensitivity.safeParse(field(payload, "reads"));
      if (callSeq === undefined || toolUseId === undefined || !reads.success) malformed.push(`entry ${String(entry.seq)} records a call waiting for its result that cannot be read`);
      else pending.set(toolUseId ?? (type === "gateway_call" ? `gateway-${String(entry.seq)}` : `call-${String(callSeq)}`), type === "gateway_call" ? { call_seq: null, reads: reads.data, gateway: true, tool_use_id: toolUseId } : { call_seq: callSeq, reads: reads.data, gateway: false, tool_use_id: toolUseId });
    } else if (entry.kind === "note" && type === "result_missing") {
      const listed = field(payload, "calls");
      for (const listedCall of Array.isArray(listed) ? listed : []) {
        // The hook service records each waiting call under the key it waited by; the call's own id is the one it held.
        // A key no waiting call held is taken as JUNO's label, never as an id (restrictive: it can then match no result).
        const key = idOrNull(field(listedCall, "tool_use_id")) ?? null;
        const held = key === null ? undefined : pending.get(key);
        const own = held?.tool_use_id ?? null;
        missing.push({ tool_use_id: own, label: own === null ? key : null, call_seq: seqOrNull(field(listedCall, "call_seq")) ?? null, recorded_at: entry.seq, result_seq: null });
      }
      pending.clear();
    } else if (entry.kind === "capability_result") {
      const toolUseId = field(payload, "tool_use_id");
      const waiting = typeof toolUseId === "string" ? toolUseId : "";
      const held = pending.get(waiting);
      const named = seqOrNull(field(payload, "call_seq"));
      if (held !== undefined) {
        pending.delete(waiting);
        result = { authorized: true, call_seq: held.call_seq, gateway: held.gateway };
      } else if (mode !== "hook" && typeof named === "number" && proceeded.get(named) === true) {
        proceeded.set(named, false);
        result = { authorized: true, call_seq: named, gateway: false };
      } else {
        const late = typeof toolUseId === "string" ? missing.find((item) => item.tool_use_id === toolUseId && item.result_seq === null) : undefined;
        if (late !== undefined) late.result_seq = entry.seq;
        result = { authorized: false, recorded_missing: late?.recorded_at ?? null };
      }
    }
    const gatewayError = entry.kind === "note" && type === "gateway_error" ? { method: typeof field(payload, "method") === "string" ? (field(payload, "method") as string) : null } : null;
    if (gatewayError !== null) counts.gateway_errors += 1;
    const callSeq = field(payload, "call_seq");
    const judgedCall = (call?.kind === "park" || entry.kind === "note") && typeof callSeq === "number" && entry.kind !== "capability_result" ? (calls.get(callSeq) ?? null) : null;
    judged.push({ entry, payload, placement: Object.hasOwn(ENTRY_PLACEMENT, key) ? key : null, call, end: ended, result, grant_use: grant, judged_call: judgedCall, gateway_error: gatewayError });
  }
  return { admission, admitted_at: Number.isFinite(admittedAt) ? admittedAt : null, mode, judged, calls: counts, turns, rejections, stop, end, state, pending, missing, malformed, grant_use: grantUse };
}
