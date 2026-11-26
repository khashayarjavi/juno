import type { KeyObject } from "node:crypto";
import type { TrajectoryEntry } from "../../contracts/src/index.js";
import { type CallCounts, ENTRY_PLACEMENT, JOURNAL_RECORD_PREFIX, type SessionReplay, ownRecordEntry, recoveredRecord } from "../../enforcement/src/index.js";
import { checkAnchors, listRecords, readPayload, shownName, taskDigest } from "../../journal/src/index.js";

/**
 * `juno journal report` (operator's queue item 2 of 2026-11-25, D-251; DECISIONS.md D-254): a read-only summary of a
 * journal for the operator's weekly review. For each session and in total: the tool calls allowed, parked and
 * rejected; parks by reason, by capability and by the program requested; and the paths or targets most often blocked.
 *
 * It reports nothing until the whole journal has verified (§3.4.1, §3.4.2), as a service's start does (D-201, D-202):
 * every record's chain; one journal's own record, naming every other record; every record agreeing with the anchors in
 * the operator's fresh clone of `juno-anchors`, with nothing left unanchored; every payload present and readable. An
 * unverified journal is refused, with the reason, and nothing is summarised.
 *
 * Every figure is read from THE replay a service's start rebuilds each session with (`replaySession`, through
 * `recoveredRecord`; operator ruling 1 of 2026-11-26, D-266): the per-entry judgement it makes and the state it ends in.
 * The report keeps no counting rule of its own. Every kind of entry is placed (`ENTRY_PLACEMENT`): counted, or listed as
 * not counted with its count; an entry that is not placed refuses the report.
 *
 * Every value in the summary that came from a session (a path, a URL, a program, a command, a tool's name) is the
 * agent's or the workspace's to choose: it is shown only as an escaped quotation, never as, or inside, a command
 * (operator ruling D-251). The report itself gives no command.
 */

/** Counts of one kind of value, most frequent first, then by value. */
export type Tally = readonly { readonly value: string; readonly count: number }[];

export type { CallCounts };

export type Summary = CallCounts & {
  readonly parks_by_reason: Tally;
  /** The capability JUNO judged; a call parked before one was judged is counted under its tool (`tool <name>`). */
  readonly parks_by_capability: Tally;
  /** The program a parked shell call asked for: the judged `program`, or the first word of a command parked before. */
  readonly parks_by_program: Tally;
  /** The paths, URLs and commands of parked or rejected calls, most often blocked first. */
  readonly blocked_targets: Tally;
  /** The tool results the journal holds, as the replay judges them, and the allowed calls still waiting for one. */
  readonly results: { readonly for_allowed_calls: number; readonly without_decision: number; readonly awaiting: number };
  /** Each grant's uses: one per call that proceeded under it, as a service's start counts them. */
  readonly grant_uses: Tally;
  /** The entries that are no tool call, result, admission or end, by their place (`ENTRY_PLACEMENT`). */
  readonly not_counted: Tally;
};

/** A tool result the replay judges was run without JUNO's decision (D-142). */
export type ResultWithoutDecision = { readonly seq: number; readonly tool: string | null; readonly tool_use_id: string | null; readonly outcome: string | null; readonly recorded_missing_at: number | null };

export type SessionReport = Summary & {
  readonly id: string;
  /**
   * How the session ended, when it did (its time to live, or its journal head not anchored), and when: after that,
   * JUNO denies its calls without journalling them, so the report cannot count them (D-258).
   */
  readonly ended: { readonly reason: string; readonly at: string } | null;
  /**
   * Whether JUNO admitted the session (D-259): `refused` when its admission was refused. JUNO denies every call of a
   * refused or ended session; of those it journals only a shell command it cannot read (D-151, D-152: parked whatever the
   * session's state, counted as a park), never the others, which no report on the journal can count.
   */
  readonly admission: "admitted" | "refused" | "not recorded";
  /**
   * The refused admission attempts JUNO journalled for this id (D-263): before its admission, when `admitted`; all of
   * them, when `refused`. Judged by the one rule a service's start uses (`admissionOf`): a session is admitted when any
   * admission note admits it, and its mode and principal are that note's.
   */
  readonly refused_attempts: number;
  readonly mode: string | null;
  readonly principal: string | null;
  readonly first_entry: string | null;
  readonly last_entry: string | null;
  /** Each result the replay judges was run without JUNO's decision, with the `result_missing` note that recorded it missing, if one did. */
  readonly results_without_decision: readonly ResultWithoutDecision[];
  /** Each call whose result JUNO recorded missing (`result_missing`), and the entry holding its result when it came later. */
  readonly recorded_missing: readonly { readonly tool_use_id: string | null; readonly call_seq: number | null; readonly recorded_at: number; readonly result_seq: number | null }[];
};

export type Report =
  | { readonly ok: true; readonly verified: { readonly records: number; readonly history: "checked" | "not_checked"; readonly never_written: readonly string[]; readonly empty_folders: readonly string[]; readonly not_summarised: readonly { readonly id: string; readonly entries: number }[] }; readonly sessions: readonly SessionReport[]; readonly total: Summary }
  | { readonly ok: false; readonly refused: string };

type Payload = Record<string, unknown>;
type Read = { readonly entry: TrajectoryEntry; readonly payload: Payload };

/** The arguments whose value is a target a blocked call named: a path, a URL. `argv[i]` counts when it is a path. */
const TARGET_ARGUMENTS = new Set(["file_path", "path", "notebook_path", "url"]);
/** How many targets the text form lists; the JSON form lists them all. */
const TOP = 10;

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const field = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? (value as Payload)[key] : undefined);

function tally(values: readonly string[]): Tally {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

/** The record's entries with their payloads; null (refused) when any payload is missing, changed or not a JSON object. */
function readAll(journal: string, id: string, entries: readonly TrajectoryEntry[]): { ok: true; read: Read[] } | { ok: false; reason: string } {
  const read: Read[] = [];
  for (const entry of entries) {
    const blob = readPayload(journal, entry.payload_ref);
    if (blob.status !== "present") return { ok: false, reason: `journal record ${quoted(id)} entry ${String(entry.seq)} has no readable payload (${blob.status})` };
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(blob.bytes));
    } catch {
      return { ok: false, reason: `journal record ${quoted(id)} entry ${String(entry.seq)} has a payload that is not JSON` };
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return { ok: false, reason: `journal record ${quoted(id)} entry ${String(entry.seq)} has a payload that is not a JSON object` };
    read.push({ entry, payload: payload as Payload });
  }
  return { ok: true, read };
}

/** The first word of a command, as the program it asked for (a command parked before it was parsed). */
function firstWord(command: string): string {
  return command.trim().split(/\s+/, 1)[0] ?? "";
}

/** The targets a judged call named: its path and URL arguments, and every argv operand that is a path. */
function targetsOf(call: Payload | undefined): string[] {
  const args = field(call, "arguments");
  if (!Array.isArray(args)) return [];
  return args.flatMap((item) => {
    const name = text(field(item, "argument"));
    const value = text(field(item, "value"));
    if (name === null || value === null || value === "") return [];
    return TARGET_ARGUMENTS.has(name) || (name.startsWith("argv[") && value.startsWith("/")) ? [value] : [];
  });
}

function programOf(call: Payload | undefined): string | null {
  const args = field(call, "arguments");
  if (!Array.isArray(args)) return null;
  for (const item of args) if (field(item, "argument") === "program") return text(field(item, "value"));
  return null;
}

/** One session's summary: every figure as THE replay judges it (D-266); only the values shown are read from payloads. */
function summarise(replay: SessionReplay): Summary {
  const reasons: string[] = [];
  const capabilities: string[] = [];
  const programs: string[] = [];
  const targets: string[] = [];
  const grants: string[] = [];
  const notCounted: string[] = [];
  const results = { for_allowed_calls: 0, without_decision: 0, awaiting: replay.pending.size };
  for (const judged of replay.judged) {
    const payload = (typeof judged.payload === "object" && judged.payload !== null ? judged.payload : {}) as Payload;
    const place = judged.placement === null ? undefined : ENTRY_PLACEMENT[judged.placement];
    if (place !== undefined && "not_counted" in place) notCounted.push(judged.placement ?? "");
    if (judged.grant_use !== null) grants.push(judged.grant_use);
    if (judged.result !== null) {
      if (judged.result.authorized) results.for_allowed_calls += 1;
      else results.without_decision += 1;
    }
    const call = judged.call;
    if (call === null) continue;
    if (call.kind === "call") {
      if (call.outcome === "reject") targets.push(...targetsOf(payload));
      continue;
    }
    if (call.kind === "rejection") {
      const tool = text(payload["tool"]);
      targets.push(`(not recorded: ${tool === null ? "a call" : `a ${tool} call`} rejected before it was judged)`);
      continue;
    }
    if (call.kind !== "park") continue;
    reasons.push(text(payload["reason"]) ?? "(no reason recorded)");
    const judgedCall = judged.judged_call?.payload as Payload | undefined;
    const tool = text(payload["tool"]);
    const capability = text(field(judgedCall, "capability"));
    capabilities.push(capability ?? (tool === null ? "(no capability or tool recorded)" : `tool ${tool}`));
    const command = text(payload["command"]);
    const program = programOf(judgedCall) ?? (command === null ? null : firstWord(command));
    if (program !== null && program !== "") programs.push(program);
    const named = targetsOf(judgedCall);
    if (named.length > 0) targets.push(...named);
    else if (command !== null) targets.push(command);
    else if (payload["outside_workspace"] === true) targets.push(`(not recorded: a ${text(payload["field"]) ?? "field"} outside the workspace)`);
  }
  return { ...replay.calls, parks_by_reason: tally(reasons), parks_by_capability: tally(capabilities), parks_by_program: tally(programs), blocked_targets: tally(targets), results, grant_uses: tally(grants), not_counted: tally(notCounted) };
}

function sum(parts: readonly Summary[]): Summary {
  const merge = (pick: (part: Summary) => Tally): Tally => tally(parts.flatMap((part) => pick(part).flatMap(({ value, count }) => Array<string>(count).fill(value))));
  return {
    allowed: parts.reduce((total, part) => total + part.allowed, 0),
    parked: parts.reduce((total, part) => total + part.parked, 0),
    rejected: parts.reduce((total, part) => total + part.rejected, 0),
    denied_session_ended: parts.reduce((total, part) => total + part.denied_session_ended, 0),
    denied_result_missing: parts.reduce((total, part) => total + part.denied_result_missing, 0),
    passed_to_gateway: parts.reduce((total, part) => total + part.passed_to_gateway, 0),
    rejection_limit_reached: parts.reduce((total, part) => total + part.rejection_limit_reached, 0),
    parks_by_reason: merge((part) => part.parks_by_reason),
    parks_by_capability: merge((part) => part.parks_by_capability),
    parks_by_program: merge((part) => part.parks_by_program),
    blocked_targets: merge((part) => part.blocked_targets),
    results: { for_allowed_calls: parts.reduce((total, part) => total + part.results.for_allowed_calls, 0), without_decision: parts.reduce((total, part) => total + part.results.without_decision, 0), awaiting: parts.reduce((total, part) => total + part.results.awaiting, 0) },
    grant_uses: merge((part) => part.grant_uses),
    not_counted: merge((part) => part.not_counted),
  };
}

/**
 * Verifies the journal against the anchors (`anchorsOf` reads the operator's clone), then summarises it. `history` says
 * whether the clone's history was checked by the caller (it refuses before calling this when it was not sound).
 */
export function journalReport(journal: string, anchorsOf: (digest: string) => unknown[], publicKey: KeyObject, history: "checked" | "not_checked"): Report {
  const refuse = (why: string): Report => ({ ok: false, refused: `${why}; nothing is reported for a journal that does not verify` });
  const records = listRecords(journal);
  if (records.length === 0) return refuse("the journal holds no record");
  const verified = new Map<string, readonly TrajectoryEntry[]>();
  const emptyFolders: string[] = [];
  for (const record of records) {
    if (!record.verdict.ok) return refuse(`journal record ${quoted(record.taskId ?? record.digest)} does not verify: ${record.verdict.failure.code} (§3.4.2)`);
    if (record.taskId === null) {
      // D-259: an empty folder (no entries, no head) is a record a crash left before its first entry; a service's start
      // passes it too. It hides nothing: a record the journal names is judged by its id below, folder or none.
      if (record.verdict.entries.length === 0) {
        emptyFolders.push(record.digest);
        continue;
      }
      return refuse(`journal folder ${quoted(record.digest)} holds no record JUNO wrote (D-202)`);
    }
    verified.set(record.taskId, record.verdict.entries);
  }
  // D-202, as a service's start judges it (`ownRecordEntry`, the one rule for both): one journal's own record, holding
  // only entries JUNO writes there; every other record named by it.
  const own = [...verified.keys()].filter((id) => id.startsWith(JOURNAL_RECORD_PREFIX));
  if (own.length !== 1) return refuse(`the journal holds ${String(own.length)} records of its own where a service's journal holds exactly one (D-202)`);
  const ownId = own[0] ?? "";
  const ownRead = readAll(journal, ownId, verified.get(ownId) ?? []);
  if (!ownRead.ok) return refuse(ownRead.reason);
  const named = new Set<string>();
  for (const { entry, payload } of ownRead.read) {
    const judged = ownRecordEntry(entry, payload);
    if (judged === null) return refuse(`the journal's own record has an entry (seq ${String(entry.seq)}) that is not one JUNO writes there (D-202)`);
    if (judged.kind === "record") named.add(judged.task);
  }
  for (const id of verified.keys()) {
    if (id !== ownId && !named.has(id)) return refuse(`journal record ${quoted(id)} is not named by the journal's own record, so this journal did not write it (D-202)`);
  }
  // §3.4.1: the journal's own record and every record it names agree with their anchors, with nothing after the latest
  // anchor (a stopped service anchors all). A named record whose folder is gone is judged as holding no entries, as a
  // service's start judges it: with anchors held for it, it was deleted, and that refuses (review round 1 of PR #68).
  // Named with no folder and no anchor, it is a record never written (its name is journalled before its first entry);
  // the report lists it as such, never silently.
  const neverWritten: string[] = [];
  for (const id of [ownId, ...[...named].sort()]) {
    const entries = verified.get(id);
    const held = anchorsOf(taskDigest(id));
    if (entries === undefined && held.length === 0) {
      neverWritten.push(id);
      continue;
    }
    const check = checkAnchors(id, { ok: true, entries: entries ?? [], head: null }, held, publicKey);
    if (!check.ok) return refuse(`journal record ${quoted(id)} does not agree with its anchors in the clone: ${check.failure.code}${entries === undefined ? " (the journal names it, its anchors exist, and its entries are gone: it was deleted)" : ""} (§3.4.1, D-202)`);
    if (check.unanchored > 0) return refuse(`journal record ${quoted(id)} has ${String(check.unanchored)} entries after its latest anchor: stop the service first (stopping it anchors what is pending), then copy the journal again (§3.4.1)`);
  }
  const sessions: SessionReport[] = [];
  const notSummarised: { id: string; entries: number }[] = [];
  for (const [id, entries] of verified) {
    if (id === ownId) continue;
    const read = readAll(journal, id, entries);
    if (!read.ok) return refuse(read.reason);
    // D-266: only the records a hook or gateway service rebuilds as sessions are summarised; any other (the own loop's
    // tasks, its runner and registry records) is verified above and listed, never summarised by a replay not its own.
    if (!id.startsWith("session-") && !id.startsWith("gateway-")) {
      notSummarised.push({ id, entries: entries.length });
      continue;
    }
    // D-266: THE replay a service's start rebuilds the session with; every figure below is its answer.
    const { replay } = recoveredRecord(id, read.read);
    const unplaced = replay.judged.find((judged) => judged.placement === null);
    if (unplaced !== undefined) return { ok: false, refused: `journal record ${quoted(id)} entry ${String(unplaced.entry.seq)} is of a kind the report does not place (${quoted(unplaced.entry.kind === "note" ? `note:${String(field(unplaced.payload, "type"))}` : unplaced.entry.kind)}); the report places every kind of entry JUNO writes, so it reports nothing for this journal (D-266)` };
    const admission = replay.admission.kind === "not_recorded" ? undefined : replay.admission.payload;
    sessions.push({
      id,
      // D-263: by the one rule a service's start uses; mode and principal from the admitting note when there is one.
      admission: replay.admission.kind === "admitted" ? "admitted" : replay.admission.kind === "refused" ? "refused" : "not recorded",
      refused_attempts: replay.admission.kind === "admitted" ? replay.admission.refused_before : replay.admission.kind === "refused" ? replay.admission.attempts : 0,
      mode: text(admission?.["mode"]),
      principal: text(field(admission?.["request"], "principal")),
      // D-264: the session's first end, whoever journalled it, at the time it was journalled.
      ended: replay.end === null ? null : { reason: replay.end.reason, at: replay.end.at },
      first_entry: entries[0]?.timestamp ?? null,
      last_entry: entries[entries.length - 1]?.timestamp ?? null,
      ...summarise(replay),
      results_without_decision: replay.judged.flatMap((judged) => (judged.result === null || judged.result.authorized ? [] : [{ seq: judged.entry.seq, tool: text(field(judged.payload, "tool")), tool_use_id: text(field(judged.payload, "tool_use_id")), outcome: text(field(judged.payload, "outcome")), recorded_missing_at: judged.result.recorded_missing }])),
      recorded_missing: replay.missing.map((item) => ({ ...item })),
    });
  }
  sessions.sort((a, b) => (a.first_entry ?? "").localeCompare(b.first_entry ?? "") || a.id.localeCompare(b.id));
  return { ok: true, verified: { records: verified.size, history, never_written: neverWritten, empty_folders: emptyFolders.sort(), not_summarised: notSummarised.sort((a, b) => a.id.localeCompare(b.id)) }, sessions, total: sum(sessions) };
}

/** A value from the journal as the text form shows it: an escaped quotation (D-251), never part of a command. */
export function quoted(value: string): string {
  return shownName(JSON.stringify(value));
}

/** The report as JSON, every character outside printable ASCII (and every backtick) written as a JSON `\u` escape. */
export function reportJson(report: Report): string {
  return `${JSON.stringify(report, null, 2).replace(/[^\x20-\x5f\x61-\x7e\n]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;
}

function tallyLines(title: string, items: Tally, limit?: number): string[] {
  if (items.length === 0) return [`  ${title}: none`];
  const shown = limit === undefined ? items : items.slice(0, limit);
  const more = items.length - shown.length;
  return [`  ${title}:`, ...shown.map(({ value, count }) => `    ${String(count).padStart(5)}  ${quoted(value)}`), ...(more > 0 ? [`    (and ${String(more)} more; --json lists them all)`] : [])];
}

function summaryLines(summary: Summary): string[] {
  return [
    `  tool calls: ${String(summary.allowed)} allowed, ${String(summary.parked)} parked, ${String(summary.rejected)} rejected${summary.denied_session_ended > 0 ? `, ${String(summary.denied_session_ended)} denied because the session's time to live had expired` : ""}${summary.denied_result_missing > 0 ? `, ${String(summary.denied_result_missing)} denied because an earlier call's result had not arrived when ${summary.denied_result_missing === 1 ? "it" : "they"} came` : ""}${summary.passed_to_gateway > 0 ? `, ${String(summary.passed_to_gateway)} passed to the gateway` : ""}`,
    ...(summary.rejection_limit_reached > 0 ? [`  the session parked at its rejection limit ${String(summary.rejection_limit_reached)} time${summary.rejection_limit_reached === 1 ? "" : "s"} (each after a rejected call counted above)`] : []),
    `  tool results: ${String(summary.results.for_allowed_calls)} for calls JUNO allowed${summary.results.without_decision > 0 ? `, ${String(summary.results.without_decision)} without JUNO's decision (listed below)` : ""}${summary.results.awaiting > 0 ? `; ${String(summary.results.awaiting)} allowed call${summary.results.awaiting === 1 ? "" : "s"} with no result in the journal yet` : ""}`,
    ...tallyLines("grant uses (calls that proceeded under each grant)", summary.grant_uses),
    ...tallyLines("parks by reason", summary.parks_by_reason),
    ...tallyLines("parks by capability", summary.parks_by_capability),
    ...tallyLines("parks by program requested", summary.parks_by_program),
    ...tallyLines("most often blocked (parked or rejected)", summary.blocked_targets, TOP),
  ];
}

/** Each result run without JUNO's decision, and each call whose result JUNO recorded missing, as the replay judges them (D-266). */
function resultLines(session: SessionReport): string[] {
  const shown = (value: string | null): string => (value === null ? "none recorded" : quoted(value));
  return [
    ...session.results_without_decision.map((result) => `  result without JUNO's decision (entry ${String(result.seq)}): tool ${shown(result.tool)}, tool_use_id ${shown(result.tool_use_id)}, ${shown(result.outcome)}: ${result.recorded_missing_at === null ? "no call JUNO allowed was waiting for it, so the harness ran it without JUNO's decision." : `JUNO had recorded this call's result missing (entry ${String(result.recorded_missing_at)}) and denied the next call; the result came after, and JUNO journals it as without its decision.`}`),
    ...session.recorded_missing.map((call) => `  result recorded missing (entry ${String(call.recorded_at)}): tool_use_id ${shown(call.tool_use_id)}: ${call.result_seq === null ? "the journal holds no result for it." : `its result came later (entry ${String(call.result_seq)}), journalled without JUNO's decision.`}`),
  ];
}

/** The entries no figure counts, by their place, each with why (`ENTRY_PLACEMENT`; D-266). The keys are the report's own. */
function notCountedLines(items: Tally): string[] {
  if (items.length === 0) return ["  entries not counted (no tool call, result, admission or end): none"];
  return ["  entries not counted (no tool call, result, admission or end):", ...items.map(({ value, count }) => {
    const place = ENTRY_PLACEMENT[value];
    return `    ${String(count).padStart(5)}  ${value}: ${place !== undefined && "not_counted" in place ? place.not_counted : ""}`;
  })];
}

/** What the report says of a refused or ended session's calls (D-259): which are journalled, and which are not counted. */
const UNJOURNALLED = "Of those calls JUNO journals only a shell command it could not read (parked, and counted above); every other call was denied without a journal entry, so it is not counted here.";

/** The report as plain text for the operator. Every value from the journal is an escaped quotation; no command is given. */
export function reportText(report: Report): string {
  if (!report.ok) return `juno journal report: refused: ${report.refused}\n`;
  const lines = [
    `JUNO journal report: ${String(report.verified.records)} records verified against their anchors (anchor history ${report.verified.history === "checked" ? "checked" : "NOT checked: --no-history"}).`,
    "Values in quotes are as the journal holds them; paths, commands, programs and tools were chosen by Claude or the workspace: read them, never run them.",
    ...(report.verified.empty_folders.length === 0 ? [] : [`Empty record folders (a crash before a record's first entry; nothing in them): ${report.verified.empty_folders.map(quoted).join(", ")}.`]),
    ...(report.verified.never_written.length === 0 ? [] : [`Named by the journal but never written (no entries, no anchors): ${report.verified.never_written.map(quoted).join(", ")}.`]),
    ...(report.verified.not_summarised.length === 0 ? [] : [`Verified, not summarised (no hook or gateway session): ${report.verified.not_summarised.map((record) => `${quoted(record.id)} (${String(record.entries)} entr${record.entries === 1 ? "y" : "ies"})`).join(", ")}.`]),
    "",
  ];
  for (const session of report.sessions) {
    lines.push(`Session ${quoted(session.id)} (${session.mode === null ? "mode not recorded" : `mode ${quoted(session.mode)}`}${session.principal === null ? "" : `, principal ${quoted(session.principal)}`}), ${session.first_entry ?? "?"} to ${session.last_entry ?? "?"}:`, ...summaryLines(session), ...resultLines(session), ...(session.admission === "refused" ? [`  ADMISSION REFUSED: JUNO denied every call of this session. ${UNJOURNALLED}`] : []), ...(session.admission === "admitted" && session.refused_attempts > 0 ? [`  admitted after ${String(session.refused_attempts)} refused admission attempt${session.refused_attempts === 1 ? "" : "s"}: JUNO denied every call made before the admission. ${UNJOURNALLED}`] : []), ...(session.admission === "not recorded" ? [`  no admission recorded: JUNO admitted nothing under this id, and denied every call under it. ${UNJOURNALLED}`] : []), ...(session.ended === null ? [] : [`  ended at ${session.ended.at}: ${quoted(session.ended.reason)}. ${session.ended.reason === "ttl_expired" ? "JUNO denied every later call of this session." : "JUNO denied the call that found this, if a call found it, and every later call of this session."} ${UNJOURNALLED}`]), "");
  }
  const endedCount = report.sessions.filter((session) => session.ended !== null).length;
  const refusedCount = report.sessions.filter((session) => session.admission !== "admitted").length;
  const notes = [...(endedCount === 0 ? [] : [`${String(endedCount)} ended`]), ...(refusedCount === 0 ? [] : [`${String(refusedCount)} not admitted`])];
  lines.push(`Total, ${String(report.sessions.length)} session${report.sessions.length === 1 ? "" : "s"}${notes.length === 0 ? "" : ` (${notes.join(", ")}: the calls JUNO denied there without journalling them are not counted)`}:`, ...summaryLines(report.total), ...notCountedLines(report.total.not_counted));
  return `${lines.join("\n")}\n`;
}
