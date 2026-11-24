import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { type AbsolutePath, type Budget, type DataClass, type TrajectoryEntry, pathWithin } from "../../contracts/src/index.js";
import {
  type RunnerLock,
  RunnerLockRefused,
  acquireRunnerLock,
  AnchorExistsError,
  AnchorReadBackError,
  type AnchorSink,
  type ChainVerdict,
  type EntryDraft,
  type JournalKey,
  JournalWriter,
  type JournalWriterOptions,
  type StoredRecord,
  anchorOf,
  type JournalHandle,
  type PendingRepair,
  canonicalJson,
  checkAnchors,
  clearPendingRepairs,
  contentAddress,
  dropTornTail,
  journalLayoutRefusals,
  listRecords,
  openJournalFolder,
  readPayload,
  readPendingRepairs,
  sameKey,
  taskDigest,
  type TornTail,
  tornTail,
  verifyTrajectory,
  writePendingRepairs,
} from "../../journal/src/index.js";
import type { CapabilityRegistry } from "../../registry/src/index.js";
import { EnforcementBoundary } from "./boundary.js";
import type { GrantStore } from "./grants.js";
import { type VerifiedPin, recoveryEpochOf } from "./anchor-pin.js";
import { type TrustAnchor } from "./signature.js";
import { type HostIo, type ServiceName, type StartupSpec, StartupRefused, laterFileRefusals, socketRefusals, startupCheck, systemHostIo } from "./startup.js";

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
 *
 * Nothing is forgotten across a restart (operator ruling D-201; DECISIONS.md D-202). `open`, after the start-up check and
 * before it hands out the layer, verifies every record of the journal (§3.4.2) and compares each with the anchors held
 * off the host (§3.4.1); a record that does not verify, one the journal's own record does not name, one that contradicts
 * an anchor, anchors of a record the journal no longer holds, or a destination that cannot be read, refuses the start.
 * Only then is state rebuilt from the journal, here, for every mode: each grant's use count (`requireGrants`), every
 * admitted id (`admit` refuses it again), and each session's spend, consecutive rejections and stop (`resume`).
 *
 * Recovery (operator ruling D-206 item 1; DECISIONS.md D-207). One failure is repaired at start: a torn final write (a
 * power loss in the middle of one append). If everything before the incomplete last entry verifies and agrees with the
 * anchors, the incomplete entry is dropped, a `recovered_truncation` note records it, and every grant used by a session
 * open at the crash is exhausted for good. Every other failure still refuses the start. A journal also records its
 * recovery epoch, the time the operator registered its folder in the anchor pin (D-208); a grant issued before it is
 * refused, so a manual recovery to a new journal folder invalidates every grant issued before it.
 *
 * The repair is atomic (operator ruling D-211 item 1; D-213): what it will do and the grants it exhausts are made durable
 * in the journal folder before the incomplete entry is removed, and that record is removed only when the journal's own
 * notes are durable. A power loss at any step of the repair leaves the grants exhausted, and the next start finishes it.
 *
 * The journal folder is opened once, from a directory handle, with no symbolic link followed in any component of its
 * path (D-211 item 1; D-213); every read and write of this layer goes through that handle.
 */

/** The task states after which a session is no longer open (§6). */
const CLOSED_STATES: ReadonlySet<string> = new Set(["verified", "failed", "aborted", "accepted"]);

/** The reserved prefix of JUNO's own records (the runner's `RESERVED_ID_PREFIX`); no task or session id may start with it. */
const OWN_RECORD_PREFIX = "juno.";

/**
 * The id of a journal's own record (D-202): one note per record the journal ever held, written before that record's
 * first entry, chained and anchored like every record. It is named after the journal's folder, so two journals that
 * anchor to one repository never share it. The name is the folder's path exactly as the service was given it, which is
 * exactly what the anchor pin names; the path is never looked up a second time to name the record (review round 7
 * finding F3; D-213), and the journal itself is opened once, from a directory handle (`openJournalFolder`). At start, a record the journal holds that it does not name was not written
 * by JUNO, and anchors of a record it names that the journal no longer holds show a deleted record.
 */
export function journalRecordId(journalRoot: string): string {
  return `${OWN_RECORD_PREFIX}journal.${createHash("sha256").update(journalRoot, "utf8").digest("hex").slice(0, 32)}`;
}

/** One journal entry with its payload as the journal stores it (parsed JSON), or `undefined` when it cannot be read. */
export type RecoveredEntry = { readonly entry: TrajectoryEntry; readonly payload: unknown };

/** One record of the journal as it stood, verified, when the service started. */
export type RecoveredRecord = {
  readonly id: string;
  readonly entries: readonly RecoveredEntry[];
  /** The payload of the note that admitted it, or null for a record that admitted nothing (a refused admission, JUNO's own records). */
  readonly admission: Readonly<Record<string, unknown>> | null;
};

function field(payload: unknown, name: string): unknown {
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>)[name] : undefined;
}

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

/**
 * How a layer copies its journal's heads off the host (§3.4.1, v0.6 C1; D-122; D-198). Every layer has one: §3.4.1
 * anchors "the journal", so every mode's journal is anchored the same way, here.
 */
export type Anchoring = {
  readonly sink: AnchorSink;
  /** The runner's own key for anchors; never the operator's grant-signing key (§3.4.1 V6-4). */
  readonly journalKey: JournalKey;
  /** At most this long passes between anchors of a running session; it is recorded in the session's journal. */
  readonly intervalMs: number;
};

/** The journal key's fingerprint, as the `anchoring` note records it. */
export function journalKeyFingerprint(key: JournalKey): string {
  return contentAddress(new Uint8Array(key.publicKey.export({ type: "spki", format: "der" })));
}

/** Why a layer's anchoring is refused before anything is opened (D-198); empty when it may be used. */
export function anchoringRefusals(anchoring: Anchoring | undefined): string[] {
  if (anchoring === undefined || anchoring === null) return ["no anchor destination and journal key were given; every mode's journal is anchored off the host (§3.4.1, D-198)"];
  const refusals: string[] = [];
  if (!Number.isSafeInteger(anchoring.intervalMs) || anchoring.intervalMs < 1) refusals.push("the anchoring interval must be a positive whole number of milliseconds (§3.4.1)");
  if (anchoring.journalKey?.privateKey?.asymmetricKeyType !== "ed25519" || anchoring.journalKey.privateKey.type !== "private") refusals.push("the journal key must be an Ed25519 private key (§3.4.1)");
  return refusals;
}

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
const decoder = new TextDecoder();
/** The actor of the journal's own record (D-202). */
export const LAYER_ACTOR = "juno.session-layer";
const INDEX_CLASS: DataClass = { sensitivity: "internal", integrity: "derived" };

export type RecordOptions = { readonly actor: string; readonly provider?: string | null; readonly cost?: EntryDraft["cost"] };

/** A torn final write a start repaired (D-207). */
export type RecoveredTruncation = { readonly record: string | null; readonly how: "partial_line" | "unheaded_entry"; readonly kept_entries: number; readonly open_sessions: readonly string[]; readonly exhausted_grants: readonly string[] };

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
  /** The journal's one-writer lock, held by the hook and gateway services while they run (D-221). */
  #lock: RunnerLock | null = null;
  readonly #anchoring: Anchoring;
  /** Per journal record: the seq last anchored and when (§3.4.1, D-122, D-198). */
  readonly #anchored = new Map<string, { seq: number; at: number }>();
  /** Every record this layer wrote, with the class of its last entry (an `anchor_failed` note is recorded at it). */
  readonly #written = new Map<string, DataClass>();
  /** Anchoring runs one at a time, so two anchors of one record never race. */
  #anchorQueue: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | null = null;
  /** This journal's own record (D-202). */
  readonly #indexId: string;
  /** Every record this journal's own record names: the ones found at start and the ones written since. */
  readonly #known = new Set<string>();
  /** The records as they stood, verified against their anchors, when the layer opened (D-201). */
  readonly #recovered = new Map<string, RecoveredRecord>();
  /** The grant stores whose use counts were set from the journal (D-201). */
  readonly #adopted = new WeakSet<GrantStore>();
  /** The store last given its counts. */
  #counted: GrantStore | null = null;
  /** The anchor pin the start-up check verified, or null when the entry named none (D-208). */
  readonly #pin: VerifiedPin | null;
  /** The journal's recovery epoch, as its own record holds it (D-207); null when it records none. */
  #recoveryEpoch: number | null = null;
  /** Every grant a recovered torn write exhausted, from the journal's own record (D-207). */
  readonly #exhausted = new Set<string>();
  /** What this start recovered, if anything (D-207). */
  #recovery: RecoveredTruncation | null = null;
  /** The journal folder as it was opened, once, from a directory handle (D-213). */
  readonly #handle: JournalHandle;

  private constructor(token: symbol, spec: StartupSpec, anchor: TrustAnchor | null, pin: VerifiedPin | null, host: HostIo, clock: () => Date, journal: JournalWriterOptions, anchoring: Anchoring) {
    // Only `open` holds the token, so no code can make a layer without the start-up check (D-194).
    if (token !== OPENED_BY_CHECK) throw new SessionLayerError("a session layer is made only by SessionLayer.open, after the shared start-up check (D-194)");
    this.#spec = spec;
    this.#anchor = anchor;
    this.#pin = pin;
    this.#host = host;
    this.#clock = clock;
    this.#workspaces = spec.workspaces.map((path) => ({ path, real: realOrGiven(path) }));
    this.#anchoring = anchoring;
    // D-211 item 1, D-213: the journal's path is looked up once, here, component by component from a directory handle,
    // following no symbolic link; everything after uses the folder that was opened, and the journal's own record is
    // named after the path as given (the one the pin names), not after a second look-up of it.
    this.#handle = openJournalFolder(spec.journal, host.uid);
    this.#journal = JournalWriter.open(this.#handle.via, journal);
    this.#indexId = journalRecordId(this.#handle.path);
  }

  /**
   * Runs the shared start-up check for `spec` and, only if it passes, opens the journal; then verifies the journal's
   * chains and its off-host anchors, and only if both hold rebuilds what the journal records and returns the layer
   * (operator ruling D-201). Throws `StartupRefused` with every refusal otherwise; a start refused by the start-up
   * check has opened nothing, and one refused for its journal or anchors hands out no layer, so nothing is served.
   */
  static async open(spec: StartupSpec, options: { readonly anchoring: Anchoring | ((journalRoot: string, pin: VerifiedPin | null) => Anchoring); readonly host?: HostIo; readonly clock?: () => Date; readonly journal?: JournalWriterOptions; readonly lockJournal?: boolean }): Promise<SessionLayer> {
    const host = options.host ?? systemHostIo();
    const checked = startupCheck(spec, host);
    const refuse = (refusals: readonly string[]): never => {
      for (const listener of OBSERVERS) listener({ spec, refusals, layer: null });
      throw new StartupRefused(spec.service, refusals);
    };
    if (!checked.ok) refuse(checked.refusals);
    // D-198: every mode's journal is anchored (§3.4.1), so a layer without an anchor destination and a journal key of its
    // own is refused like any other start-up refusal. A factory (the services' real key and clone) runs only once the
    // check has passed, so nothing is created for a refused start. The journal key is never the operator's.
    const given = (options as { readonly anchoring?: Anchoring | ((journalRoot: string, pin: VerifiedPin | null) => Anchoring) } | undefined)?.anchoring;
    let anchoring: Anchoring | undefined;
    try {
      anchoring = typeof given === "function" ? given(spec.journal, checked.ok ? checked.pin : null) : given;
    } catch (error: unknown) {
      refuse([`the journal key or the anchor destination could not be opened: ${error instanceof Error ? error.message : String(error)} (§3.4.1, D-198)`]);
    }
    const refusals = anchoringRefusals(anchoring);
    if (refusals.length === 0 && anchoring !== undefined && checked.ok && checked.anchor !== null && sameKey(anchoring.journalKey.publicKey, checked.anchor)) {
      refusals.push("the journal key is the operator's grant-signing key; the runner must hold its own (§3.4.1 V6-4)");
    }
    if (refusals.length > 0 || anchoring === undefined || !checked.ok) return refuse(refusals);
    let layer: SessionLayer;
    try {
      layer = new SessionLayer(OPENED_BY_CHECK, Object.freeze({ ...spec, workspaces: [...spec.workspaces], state: spec.state.map((item) => ({ ...item })) }), checked.anchor, checked.pin, host, options.clock ?? (() => new Date()), options.journal ?? {}, anchoring);
    } catch (error: unknown) {
      return refuse([`the journal ${spec.journal} could not be opened: ${error instanceof Error ? error.message : String(error)} (§3.4.1, D-213)`]);
    }
    // D-221: the hook and gateway services hold the journal's one-writer lock (the runner takes its own, D-069) from
    // before the journal is verified or repaired until they stop, so `juno checkpoint restore` can prove that no service
    // writes it. A journal another process holds (a running service, or a restore in progress) refuses the start.
    if (options.lockJournal === true) {
      try {
        // D-243: a lock whose owner is provably dead (a service killed without a stop, as when WSL tears its instance
        // down) is taken over here; the take-over is recorded in the journal's own record once the journal has verified.
        layer.#lock = acquireRunnerLock(layer.root as AbsolutePath, undefined, undefined, { shown: layer.path });
      } catch (error: unknown) {
        const running = error instanceof RunnerLockRefused && error.reason === "owner_running";
      return refuse([`the journal ${spec.journal} ${running ? "is in use by another process (a service already running on it, or a checkpoint restore)" : "cannot be locked for this service"}: ${error instanceof Error ? error.message : String(error)} (D-221, D-243)`]);
      }
    }
    // D-201: the journal and its anchors are verified before anything is rebuilt, admitted or served.
    let unverified: string[];
    try {
      unverified = journalLayoutRefusals(layer.#handle.via);
      if (unverified.length === 0) unverified = await layer.#recover();
    } catch (error: unknown) {
      unverified = [`the journal could not be verified: ${error instanceof Error ? error.message : String(error)} (§3.4.1, D-201)`];
    }
    if (unverified.length > 0) {
      layer.releaseLock();
      return refuse(unverified);
    }
    for (const listener of OBSERVERS) listener({ spec, refusals: [], layer });
    return layer;
  }

  /**
   * Verifies the whole journal against itself and against the anchors held off the host, then rebuilds from it (operator
   * ruling D-201; D-202). Answers every reason the service may not start; empty when it may.
   *   1. Every record's chain verifies (§3.4.2), and its folder is named by the id its entries carry.
   *   2. Every record is one the journal's own record names (it is written before a record's first entry).
   *   3. For the journal's own record and every record it names, each anchor the destination holds carries the journal
   *      key's signature and agrees with the entry at its seq (§3.4.1); a record whose anchors exist while the journal
   *      holds fewer entries, or none, was cut or deleted. Entries after a record's latest anchor are within the interval
   *      §3.4.1 leaves unanchored: they are not a contradiction, and they are anchored now, before anything is served.
   *   4. A destination that cannot be read verifies nothing, so the start is refused.
   */
  async #recover(): Promise<string[]> {
    const refusals: string[] = [];
    const stored = new Map<string, StoredRecord>();
    // D-206 item 1: one record may end in a torn final write. It is judged, with everything else, as it stands without
    // its incomplete last entry; nothing on disk is changed until every check below has passed.
    let torn: TornTail | null = null;
    // D-211 item 1 (D-213): a repair an earlier start began and did not finish recording. Its grants are exhausted
    // whatever else this start finds; it is finished below, once the journal has verified.
    let pending: PendingRepair[];
    try {
      pending = readPendingRepairs(this.#journal.root);
    } catch (error: unknown) {
      return [`the journal's record of an unfinished repair cannot be read: ${error instanceof Error ? error.message : String(error)}; nothing was changed (D-207, D-213)`];
    }
    for (const record of listRecords(this.#journal.root)) {
      if (record.verdict.ok) {
        if (record.taskId !== null) stored.set(record.taskId, record);
        continue;
      }
      const tail = tornTail(this.#journal.root, record.digest);
      if (tail !== null && torn === null) {
        torn = tail;
        if (tail.taskId !== null) stored.set(tail.taskId, { digest: record.digest, taskId: tail.taskId, verdict: tail.kept });
        continue;
      }
      const also = tail !== null ? "; a second record ends in an incomplete entry, and a single interrupted write leaves only one" : "";
      refusals.push(`journal record ${record.taskId ?? record.digest} does not verify: ${record.verdict.failure.code} (${record.verdict.failure.message})${also} (§3.4.2)`);
    }
    if (refusals.length > 0) return refusals;
    const named: string[] = [];
    let journalEpoch: string | null = null;
    const index = this.#read(this.#indexId, stored.get(this.#indexId)?.verdict);
    for (const item of index) {
      const task = field(item.payload, "task");
      const type = field(item.payload, "type");
      const own = item.entry.kind === "note" && item.entry.actor === LAYER_ACTOR;
      if (own && type === "record" && typeof task === "string") named.push(task);
      // D-203 journals a failed anchor of this record in it; that note is JUNO's own and names no record (D-205).
      else if (item.entry.kind === "note" && item.entry.actor === ANCHOR_ACTOR && type === "anchor_failed") continue;
      // D-207: the recovery epoch is this record's first entry and no other; a recovered torn write is recorded here.
      else if (own && type === "recovery_epoch" && item.entry.seq === 0 && typeof field(item.payload, "epoch") === "string") journalEpoch = field(item.payload, "epoch") as string;
      else if (own && type === "recovered_truncation" && Array.isArray(field(item.payload, "exhausted_grants"))) continue;
      // D-243: a start that took over the lock of a service that was provably no longer running records it here.
      else if (own && type === "stale_lock_reclaimed" && typeof field(item.payload, "reason") === "string") continue;
      else refusals.push(`the journal's own record has an entry (seq ${String(item.entry.seq)}) that is not one JUNO writes there (D-202)`);
    }
    // D-206, D-207: the journal and the anchor pin must name the same recovery epoch. A journal that already has entries
    // was registered at the epoch it records; a pin that now says otherwise (or a journal with an epoch and no pin) is a
    // journal or a setting that was replaced.
    const pinnedEpoch = this.#pin === null ? null : this.#pin.journal.recovery_epoch;
    const fresh = index.length === 0;
    if (!fresh && (journalEpoch === null) !== (pinnedEpoch === null)) {
      refusals.push(journalEpoch === null ? `the anchor pin names a recovery epoch for this journal (${String(pinnedEpoch)}), but the journal records none: it was not started under this pin (D-206, D-207)` : `the journal records a recovery epoch (${journalEpoch}), but no anchor pin names it (D-206, D-207)`);
    } else if (!fresh && journalEpoch !== null && pinnedEpoch !== null && Date.parse(journalEpoch) !== Date.parse(pinnedEpoch)) {
      refusals.push(`the journal records the recovery epoch ${journalEpoch}, but the anchor pin says ${pinnedEpoch}; they must agree (D-206, D-207)`);
    }
    for (const id of stored.keys()) {
      if (id !== this.#indexId && !named.includes(id)) refusals.push(`journal record ${id} is not named by the journal's own record, so this journal did not write it (D-202)`);
    }
    const ids = [this.#indexId, ...new Set(named)];
    let anchors: Map<string, unknown[]>;
    try {
      anchors = await this.#anchoring.sink.listMany(ids.map((id) => taskDigest(id)));
    } catch (error: unknown) {
      return [...refusals, `the anchor destination could not be read, so the journal cannot be checked against its anchors: ${error instanceof Error ? error.message : String(error)} (§3.4.1, D-201)`];
    }
    for (const id of ids) {
      const held = anchors.get(taskDigest(id)) ?? [];
      if (held.length === 0) continue;
      const chain: ChainVerdict = stored.get(id)?.verdict ?? { ok: true, entries: [], head: null };
      const check = checkAnchors(id, chain, held, this.#anchoring.journalKey.publicKey);
      if (check.ok) {
        const latest = held.find((anchor) => field(anchor, "seq") === check.anchored_seq);
        this.#anchored.set(id, { seq: check.anchored_seq, at: Date.parse(String(field(latest, "at"))) });
        continue;
      }
      const failure = check.failure;
      const what =
        failure.code === "truncated" ? `an anchor names its entry ${String(failure.anchor_seq)}, but the journal holds ${String(failure.chain_length)} entries: entries were removed`
        : failure.code === "rewritten" ? `its entry ${String(failure.anchor_seq)} is not the one anchored off the host: history at or before it was rewritten`
        : failure.code === "anchor_invalid" ? `a stored anchor is not valid: ${failure.reason}`
        : failure.code;
      refusals.push(`journal record ${id} disagrees with its off-host anchors: ${what} (§3.4.1, D-201)`);
    }
    if (refusals.length > 0) return refusals;
    // Every entry's payload must be there and readable, whatever its kind (D-204): the chain and the anchors cover the
    // entries, and a payload removed or damaged in the blob store would otherwise be state silently dropped.
    for (const id of ids) {
      if (id === this.#indexId) continue;
      for (const item of this.#read(id, stored.get(id)?.verdict)) {
        if (item.payload === undefined) refusals.push(`journal record ${id} entry ${String(item.entry.seq)} has no readable payload, so what it records cannot be rebuilt (§3.4.5, D-201)`);
      }
    }
    if (refusals.length > 0) return refusals;
    // Verified. Only now is anything changed or rebuilt (D-201).
    // D-206 item 1, D-211 item 1 (D-207, D-213): the repair, in an order that a power loss at any step leaves safe.
    //   1. What the repair will do, and the grants it exhausts, is made durable (`recovery-pending.json`).
    //   2. The incomplete entry is cut off.
    //   3. The journal's own notes of the repair are written.
    //   4. Only then is the record of step 1 removed.
    const repairs = [...pending];
    if (torn !== null) {
      const cut = torn;
      // The same incomplete entry an earlier start already recorded and did not get to cut: it is not recorded twice.
      if (!repairs.some((repair) => repair.record_digest === cut.digest && repair.kept_bytes === cut.keptBytes && repair.dropped_sha256 === cut.droppedSha256)) {
        repairs.push(this.#planRepair(cut, ids, stored));
        writePendingRepairs(this.#journal.root, repairs);
      }
      dropTornTail(this.#journal.root, cut);
    }
    // D-207: a journal opened for the first time under a pin records its recovery epoch as its own record's first entry.
    if (fresh && pinnedEpoch !== null) {
      this.#write(this.#indexId, "note", INDEX_CLASS, { type: "recovery_epoch", epoch: pinnedEpoch }, { actor: LAYER_ACTOR });
      journalEpoch = pinnedEpoch;
    }
    this.#recoveryEpoch = journalEpoch === null ? null : Date.parse(journalEpoch);
    if (this.#pin !== null && this.#recoveryEpoch !== recoveryEpochOf(this.#pin)) return ["the journal's recovery epoch could not be set from the anchor pin (D-207)"];
    if (repairs.length > 0) {
      this.#recordRepairs(repairs);
      clearPendingRepairs(this.#journal.root);
    }
    // D-243: the lock this start took over, from a service that was provably no longer running, is on the record; only
    // now, once the journal has verified and any torn write is repaired, so it is never written to an unverified journal.
    const reclaimed = this.#lock?.cleared ?? null;
    if (reclaimed !== null) this.#write(this.#indexId, "note", INDEX_CLASS, { type: "stale_lock_reclaimed", reason: reclaimed.reason, holder: { ...reclaimed.holder } }, { actor: LAYER_ACTOR });
    for (const id of ids) {
      // A record this start wrote to (the recovery's own notes, a lock take-over) is read again from the journal.
      const verdict = repairs.length > 0 || reclaimed !== null || (fresh && id === this.#indexId) ? verifyTrajectory(this.#journal.root, id) : stored.get(id)?.verdict;
      if (id !== this.#indexId) this.#known.add(id);
      if (verdict === undefined || !verdict.ok) continue;
      const entries = this.#read(id, verdict);
      const last = entries.at(-1);
      if (last !== undefined) this.#written.set(id, last.entry.data_class);
      if (id === this.#indexId) {
        for (const item of entries) {
          if (field(item.payload, "type") !== "recovered_truncation") continue;
          for (const grant of field(item.payload, "exhausted_grants") as unknown[]) if (typeof grant === "string") this.#exhausted.add(grant);
        }
        continue;
      }
      const admission = entries.find((item) => item.entry.kind === "note" && field(item.payload, "type") === "admission" && field(item.payload, "outcome") === "admitted");
      this.#recovered.set(id, { id, entries, admission: admission === undefined ? null : (admission.payload as Readonly<Record<string, unknown>>) });
    }
    // §3.4.1: what was written and not yet copied off the host is copied before the service serves anything.
    const unanchored = await this.anchorPending();
    return unanchored.map((id) => `journal record ${id} could not be anchored off the host (journalled as anchor_failed), so the service does not start (§3.4.1, D-201)`);
  }

  /**
   * What the repair of a torn final write will record (operator ruling D-206 item 1; D-207). Called only when every
   * entry before the incomplete one has verified (§3.4.2), agrees with every anchor held off the host (§3.4.1) and has
   * its payload. Changes nothing.
   *   - Every session open at the crash is found: one the journal admitted whose record shows no closing state.
   *   - Every grant such a session holds (its admission's list) or used (any call it made under one) is exhausted.
   */
  #planRepair(torn: TornTail, ids: readonly string[], stored: ReadonlyMap<string, StoredRecord>): PendingRepair {
    const open: string[] = [];
    const grants = new Set<string>();
    for (const id of ids) {
      if (id === this.#indexId) continue;
      const entries = this.#read(id, stored.get(id)?.verdict);
      const admission = entries.find((item) => item.entry.kind === "note" && field(item.payload, "type") === "admission" && field(item.payload, "outcome") === "admitted");
      if (admission === undefined) continue;
      let state: unknown = null;
      for (const item of entries) if (item.entry.kind === "note" && field(item.payload, "type") === "state") state = field(item.payload, "to");
      if (typeof state === "string" && CLOSED_STATES.has(state)) continue;
      open.push(id);
      const held = field(field(admission.payload, "task"), "grants");
      if (Array.isArray(held)) for (const grant of held) if (typeof grant === "string") grants.add(grant);
      for (const item of entries) {
        const grant = field(item.payload, "grant");
        if (item.entry.kind === "capability_call" && typeof grant === "string") grants.add(grant);
      }
    }
    return { record: torn.taskId, record_digest: torn.digest, how: torn.how, kept_entries: torn.kept.entries.length, kept_bytes: torn.keptBytes, dropped_bytes: torn.droppedBytes, dropped_sha256: torn.droppedSha256, open_sessions: open.sort(), exhausted_grants: [...grants].sort() };
  }

  /**
   * Writes the journal's notes of each repair, unless the journal already holds them (a start that lost its power after
   * writing a note and before the next step; D-213). Called after the incomplete entry is gone.
   *   - A `recovered_truncation` note in the journal's own record says which record, how many entries were kept, the
   *     size and digest of what was dropped, the open sessions and the exhausted grants. The exhausted grants are read
   *     back from that note at every later start.
   *   - The record that lost the entry gets a note of its own, so whoever reads that record alone sees it (§3.4.5).
   * A note is the same repair's when it names the same record, the same number of kept entries and the same dropped
   * bytes; a record cannot lose the same bytes at the same place twice, because the note itself then follows them.
   */
  #recordRepairs(repairs: readonly PendingRepair[]): void {
    for (const repair of repairs) {
      const what = { how: repair.how, kept_entries: repair.kept_entries, dropped_bytes: repair.dropped_bytes, dropped_sha256: repair.dropped_sha256 };
      const same = (payload: unknown): boolean => field(payload, "type") === "recovered_truncation" && field(payload, "kept_entries") === repair.kept_entries && field(payload, "dropped_sha256") === repair.dropped_sha256 && field(payload, "dropped_bytes") === repair.dropped_bytes;
      const index = this.#read(this.#indexId, verifyTrajectory(this.#journal.root, this.#indexId));
      if (!index.some((item) => item.entry.actor === LAYER_ACTOR && same(item.payload) && field(item.payload, "record_digest") === repair.record_digest)) {
        this.#write(this.#indexId, "note", INDEX_CLASS, { type: "recovered_truncation", record: repair.record, record_digest: repair.record_digest, ...what, open_sessions: repair.open_sessions, exhausted_grants: repair.exhausted_grants }, { actor: LAYER_ACTOR });
      }
      if (repair.record === null || repair.record === this.#indexId || repair.kept_entries === 0) continue;
      const record = this.#read(repair.record, verifyTrajectory(this.#journal.root, repair.record));
      const last = record[repair.kept_entries - 1];
      if (last === undefined || record.some((item) => item.entry.kind === "note" && item.entry.actor === LAYER_ACTOR && same(item.payload))) continue;
      this.#journal.append(repair.record, { kind: "note", actor: LAYER_ACTOR, provider: null, data_class: last.entry.data_class, cost: NO_COST }, encoder.encode(canonicalJson({ type: "recovered_truncation", ...what })));
    }
    const first = repairs[0];
    if (first !== undefined) {
      this.#recovery = { record: first.record, how: first.how, kept_entries: first.kept_entries, open_sessions: [...new Set(repairs.flatMap((repair) => repair.open_sessions))].sort(), exhausted_grants: [...new Set(repairs.flatMap((repair) => repair.exhausted_grants))].sort() };
    }
  }

  /** What this start recovered from a torn final write, or null (D-207). A service says it on its output. */
  get recovery(): RecoveredTruncation | null {
    return this.#recovery;
  }

  /** The lock this start took over from a service that was provably no longer running, or null (D-243). */
  get reclaimedLock(): { readonly reason: string; readonly holder: Readonly<Record<string, unknown>> } | null {
    const cleared = this.#lock?.cleared ?? null;
    return cleared === null ? null : { reason: cleared.reason, holder: { ...cleared.holder } };
  }

  /** The journal's recovery epoch in milliseconds, or null when it records none (D-207). */
  get recoveryEpoch(): number | null {
    return this.#recoveryEpoch;
  }

  /** The anchor pin the start-up check verified for this service, or null (D-208). */
  get pin(): VerifiedPin | null {
    return this.#pin;
  }

  /** A verified record's entries with their payloads. */
  #read(id: string, verdict: ChainVerdict | undefined): RecoveredEntry[] {
    if (verdict === undefined || !verdict.ok) return [];
    return verdict.entries.map((entry) => {
      if (entry.task_id !== id) return { entry, payload: undefined };
      const blob = readPayload(this.#journal.root, entry.payload_ref);
      if (blob.status !== "present") return { entry, payload: undefined };
      try {
        return { entry, payload: JSON.parse(decoder.decode(blob.bytes)) as unknown };
      } catch {
        return { entry, payload: undefined };
      }
    });
  }

  /** This journal's own record's id (D-202). */
  get journalRecord(): string {
    return this.#indexId;
  }

  /**
   * The records as the journal held them, verified against their anchors, when this layer opened (D-201): what a mode
   * rebuilds its sessions from. Empty for a journal opened for the first time.
   */
  recovered(): readonly RecoveredRecord[] {
    return [...this.#recovered.values()];
  }

  /** Whether the journal already holds an admission under this id: an id is admitted once, across restarts (D-201). */
  admitted(taskId: string): boolean {
    const record = this.#recovered.get(taskId);
    return this.#sessions.has(taskId) || (record !== undefined && record.admission !== null);
  }

  /**
   * Every grant's use count, as the journal records it now (§3.2 `max_invocations`; D-201): one use per call the
   * boundary let proceed under the grant, in any record of any mode. The boundary journals that call in the same step
   * as it charges the grant, so the count in the journal and the count in a running service are the same number.
   *
   * At start every record has just been verified. Later, a record changed under a running service no longer verifies
   * (its task is failed when it is next touched, D-056) and cannot be counted; a count is then never lower than the one
   * the store this layer last counted for holds, so no use is forgotten that way either.
   */
  grantUse(): Map<string, number> {
    const used = new Map<string, number>();
    for (const id of this.#known) {
      const verdict = verifyTrajectory(this.#journal.root, id);
      if (!verdict.ok) continue;
      for (const entry of verdict.entries) {
        if (entry.kind !== "capability_call") continue;
        const blob = readPayload(this.#journal.root, entry.payload_ref);
        if (blob.status !== "present") throw new SessionLayerError(`journal record ${id} entry ${String(entry.seq)} has no readable payload, so grant use cannot be counted (D-201)`);
        const payload: unknown = JSON.parse(decoder.decode(blob.bytes));
        const grant = field(payload, "grant");
        if (typeof grant === "string" && field(field(payload, "verdict"), "outcome") === "proceed") used.set(grant, (used.get(grant) ?? 0) + 1);
      }
    }
    for (const [grant, count] of this.#counted?.use() ?? []) used.set(grant, Math.max(used.get(grant) ?? 0, count));
    return used;
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

  /**
   * The journal's root, for readers in this process: the folder as it was opened, held by its handle (D-213), so a
   * reader reads the very folder this layer writes whatever is done to the path meanwhile.
   */
  get root(): string {
    return this.#journal.root;
  }

  /** The journal's path as the service was given it and the anchor pin names it: for messages and for other programs. */
  get path(): string {
    return this.#handle.path;
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
    // D-201: a store a mode brings starts from the use the journal records, never from zero. Every mode passes its
    // store here before it can get a boundary, so no mode can leave it out.
    if (this.#adopted.has(grants)) return;
    grants.restoreUse(this.grantUse());
    // D-206, D-207: what the journal's recoveries decide for grants goes with the counts, for every mode.
    grants.restoreRecovery({ exhausted: this.#exhausted, recoveryEpoch: this.#recoveryEpoch });
    this.#adopted.add(grants);
    this.#counted = grants;
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

  /**
   * Why a file this running service is asked to read later (a session file, a grant file) must be refused: the start-up
   * check's own rules, against this layer's workspaces and host (D-196). Empty when it may be read.
   */
  fileRefusals(what: string, path: string): string[] {
    return laterFileRefusals(what, path, this.#spec.workspaces, this.#host);
  }

  /** Reads a file `fileRefusals` accepted, through this layer's host. */
  readFile(path: string): string {
    return this.#host.readFile(path);
  }

  now(): number {
    return this.#clock().getTime();
  }

  /** A journal record outside any session (the runner's and registry's own records). */
  append(taskId: string, kind: EntryDraft["kind"], dataClass: DataClass, payload: unknown, options: RecordOptions): number {
    if (taskId === this.#indexId) throw new SessionLayerError("the journal's own record is written only by the session layer (D-202)");
    return this.#write(taskId, kind, dataClass, payload, options);
  }

  /** Every journal write of this layer; the journal's own record is written only from inside the layer. */
  #write(taskId: string, kind: EntryDraft["kind"], dataClass: DataClass, payload: unknown, options: RecordOptions): number {
    // D-202: a record is named in the journal's own record before its first entry is written.
    if (taskId !== this.#indexId && !this.#known.has(taskId)) {
      this.#journal.append(this.#indexId, { kind: "note", actor: LAYER_ACTOR, provider: null, data_class: INDEX_CLASS, cost: NO_COST }, encoder.encode(canonicalJson({ type: "record", task: taskId })));
      this.#written.set(this.#indexId, INDEX_CLASS);
      this.#known.add(taskId);
    }
    const draft: EntryDraft = { kind, actor: options.actor, provider: options.provider ?? null, data_class: dataClass, cost: options.cost ?? NO_COST };
    const seq = this.#journal.append(taskId, draft, encoder.encode(canonicalJson(payload))).seq;
    this.#written.set(taskId, dataClass);
    return seq;
  }

  /** How this layer anchors (§3.4.1, D-198). */
  get anchoring(): Anchoring {
    return this.#anchoring;
  }

  /** The `anchoring` note every session records before its first anchor: the interval and the journal key (§3.4.1). */
  anchoringNote(): { readonly type: "anchoring"; readonly interval_ms: number; readonly journal_key: string } {
    return { type: "anchoring", interval_ms: this.#anchoring.intervalMs, journal_key: journalKeyFingerprint(this.#anchoring.journalKey) };
  }

  /**
   * Copies one journal record's head off the host (§3.4.1, D-122, D-198): signed with the journal key, appended to the
   * destination. Nothing new since the last anchor: nothing to do. When the destination already holds an anchor at this
   * seq (a restart), it counts only if it names the same head. A failure is journalled (`anchor_failed`, at `dataClass`
   * or the class of the record's last entry) and answers false. Anchors run one at a time.
   */
  anchorHead(recordId: string, dataClass?: DataClass): Promise<boolean> {
    const run = this.#anchorQueue.then(() => this.#anchorNow(recordId, dataClass));
    this.#anchorQueue = run.catch(() => undefined);
    return run;
  }

  async #anchorNow(recordId: string, dataClass: DataClass | undefined): Promise<boolean> {
    const verdict = verifyTrajectory(this.#journal.root, recordId);
    if (!verdict.ok) return false;
    const head = verdict.head;
    if (head === null) return true;
    if (this.#anchored.get(recordId)?.seq === head.seq) return true;
    const now = this.#clock();
    const anchor = anchorOf(recordId, head, now, this.#anchoring.journalKey.privateKey);
    try {
      try {
        await this.#anchoring.sink.append(anchor);
      } catch (error: unknown) {
        if (!(error instanceof AnchorExistsError)) throw error;
        const stored = (await this.#anchoring.sink.list(taskDigest(recordId))).find((item) => (item as { seq?: unknown }).seq === head.seq) as { head?: unknown } | undefined;
        if (stored?.head !== head.hash) throw new Error(`the destination holds a different anchor at seq ${String(head.seq)}`, { cause: error });
      }
    } catch (error: unknown) {
      const recordClass = dataClass ?? this.#written.get(recordId) ?? { sensitivity: "internal" as const, integrity: "derived" as const };
      // The journal's own record is a record like any other here (D-203): its failed anchor is journalled in it.
      this.#write(recordId, "note", recordClass, { type: "anchor_failed", seq: head.seq, head: head.hash, reason: error instanceof Error ? error.message : String(error) }, { actor: ANCHOR_ACTOR });
      // Operator ruling D-211 item 1 (D-213): an anchor that could not be read back from the pinned repository, or a
      // destination changed under the service, says nothing this run anchors is known to be off the host. Every
      // session stops, not only this record's; each stop is journalled (D-203).
      if (error instanceof AnchorReadBackError) for (const session of this.#sessions.values()) session.stop("anchor_unavailable");
      return false;
    }
    this.#anchored.set(recordId, { seq: head.seq, at: now.getTime() });
    return true;
  }

  /** Whether a record is due an anchor: never anchored, or its interval has passed since the last one (§3.4.1). */
  anchorDue(recordId: string): boolean {
    const last = this.#anchored.get(recordId);
    return last === undefined || this.now() - last.at >= this.#anchoring.intervalMs;
  }

  /** Whether every entry of a record this layer wrote is anchored. */
  anchoredUpToDate(recordId: string): boolean {
    const verdict = verifyTrajectory(this.#journal.root, recordId);
    return verdict.ok && (verdict.head === null || this.#anchored.get(recordId)?.seq === verdict.head.seq);
  }

  /**
   * Anchors every record this layer wrote that has entries after its last anchor (refused admissions and calls from
   * sessions never admitted included). Answers the records that could not be anchored. A service runs it at each
   * interval (`startAnchoring`) and when it stops (`close`), so no record of any mode is left unanchored for longer
   * than one interval while the service runs (§3.4.1, D-198).
   */
  async anchorPending(): Promise<string[]> {
    const failed: string[] = [];
    for (const recordId of [...this.#written.keys()]) {
      if (!(await this.anchorHead(recordId))) failed.push(recordId);
    }
    // §3.4.1: a session whose head cannot be anchored stops for good. The journal's own record names every record, so
    // when it cannot be anchored no session's history is fully off the host, and every session stops (D-203).
    const all = failed.includes(this.#indexId);
    for (const session of this.#sessions.values()) if (all || failed.includes(session.id)) session.stop("anchor_unavailable");
    return failed;
  }

  /** The class a record's own notes are written at: that of its last entry. */
  classOf(recordId: string): DataClass {
    return this.#written.get(recordId) ?? INDEX_CLASS;
  }

  /** Starts anchoring every pending record once per interval, in the background; `close` stops it (D-198). */
  startAnchoring(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      // Fail-closed (D-203): if the anchoring itself cannot run, no session goes on.
      this.anchorPending().catch(() => {
        for (const session of this.#sessions.values()) session.stop("anchor_unavailable");
      });
    }, this.#anchoring.intervalMs);
    this.#timer.unref();
  }

  /** Stops the interval and anchors everything pending (a service's last act, §3.4.1). Answers the records that failed. */
  async close(): Promise<string[]> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    try {
      return await this.anchorPending();
    } finally {
      this.releaseLock();
    }
  }

  /** Releases the journal's lock, if this layer holds it (D-221); the layer writes nothing more after it. */
  releaseLock(): void {
    this.#lock?.release();
    this.#lock = null;
  }

  /** A refused admission: never run, never referenced, so recorded at the most restrictive class. */
  refuse(taskId: string, payload: Record<string, unknown>, actor: string): number {
    return this.append(taskId, "note", REFUSED_ADMISSION_CLASS, { type: "admission", outcome: "rejected", ...payload }, { actor });
  }

  /** Admits a session: journals its admission and opens it. An id is admitted once, across restarts too (D-201). */
  admit(taskId: string, limits: SessionLimits, admission: { readonly dataClass: DataClass; readonly payload: Record<string, unknown>; readonly actor: string; readonly now?: () => number }): GovernedSession {
    if (this.#sessions.has(taskId)) throw new SessionLayerError(`session ${taskId} is already open`);
    if (this.admitted(taskId)) throw new SessionLayerError(`the journal already holds an admission of ${taskId}; an id is admitted once (D-201)`);
    const now = admission.now ?? (() => this.now());
    const session = new GovernedSession(this, taskId, this.mode, limits, now(), { ...NO_SPEND }, now);
    this.append(taskId, "note", admission.dataClass, { type: "admission", outcome: "admitted", ...admission.payload }, { actor: admission.actor });
    this.#sessions.set(taskId, session);
    return session;
  }

  /** Reopens a session rebuilt from its journal (the own loop's resume); journals nothing. */
  restore(taskId: string, limits: SessionLimits, state: { readonly admittedAt: number; readonly spent: Spend; readonly now?: () => number }): GovernedSession {
    const session = new GovernedSession(this, taskId, this.mode, limits, state.admittedAt, { ...state.spent }, state.now ?? (() => this.now()));
    // D-201: the `anchoring` note is written once per session; a session whose journal already holds it does not write it again.
    if (this.#sessions.get(taskId)?.anchoringNoted === true || this.#noted(taskId)) session.noteAnchoring();
    // D-203: a stop for good is for good; it is in the journal, and a session rebuilt from it is still stopped.
    const stopped = this.#sessions.get(taskId)?.stopped ?? this.#stoppedIn(taskId);
    if (stopped !== null) session.restoreStop(stopped);
    this.#sessions.set(taskId, session);
    return session;
  }

  /** The stop for good a record journals (`stopped`, or a mode's `state: failed` for `anchor_unavailable`), or null. */
  #stoppedIn(taskId: string): string | null {
    for (const { entry, payload } of this.#recovered.get(taskId)?.entries ?? []) {
      if (entry.kind !== "note") continue;
      const type = field(payload, "type");
      const reason = field(payload, "reason");
      if (type === "stopped" && typeof reason === "string") return reason;
      if (type === "state" && field(payload, "to") === "failed" && reason === "anchor_unavailable") return "anchor_unavailable";
    }
    return null;
  }

  #noted(taskId: string): boolean {
    return this.#recovered.get(taskId)?.entries.some((item) => item.entry.kind === "note" && field(item.payload, "type") === "anchoring") === true;
  }

  /**
   * Reopens a hook or gateway session exactly as its journal leaves it (operator ruling D-201), for every mediated
   * mode the same way; journals nothing. From the record verified at start it rebuilds:
   *   - the admission time, so the time limit and the wall-clock budget go on from admission, not from the restart;
   *   - the calls counted against the budget: every call the boundary judged (`capability_call`), every call rejected
   *     before it (a `rejection` note that names no judged call), every call passed to the gateway (`gateway_call`), and
   *     every call parked before the boundary (a park that names no judged call, other than `budget_exceeded` and
   *     `rejection_limit`, which count nothing, and an injected command parked before the call was counted, D-152);
   *   - the consecutive rejections (§2.7.1 A4): each rejection since the last park or the last call that proceeded;
   *   - a stop for good (`anchor_unavailable`, §3.4.1), which the layer journals at the moment it stops the session.
   * Answers the session and its record, from which the mode rebuilds what only it knows (its floor, its pending calls).
   * Null when the journal holds no admission under this id.
   */
  resume(taskId: string, limits: SessionLimits, options: { readonly now?: () => number } = {}): { readonly session: GovernedSession; readonly record: RecoveredRecord } | null {
    const record = this.#recovered.get(taskId);
    if (record === undefined || record.admission === null) return null;
    if (this.#sessions.has(taskId)) throw new SessionLayerError(`session ${taskId} is already open`);
    const admittedAt = Date.parse(String(record.admission["admitted_at"]));
    if (!Number.isFinite(admittedAt)) throw new SessionLayerError(`the admission of ${taskId} records no admission time, so its limits cannot be rebuilt (D-201)`);
    let turns = 0;
    let rejections: RejectionMark[] = [];
    const stopped = this.#stoppedIn(taskId);
    for (const { entry, payload } of record.entries) {
      const judged = field(payload, "call_seq") !== undefined && field(payload, "call_seq") !== null;
      if (entry.kind === "capability_call") {
        turns += 1;
        const outcome = field(field(payload, "verdict"), "outcome");
        if (outcome === "reject") rejections.push({ kind: "call", seq: entry.seq });
        else if (outcome === "proceed") rejections = [];
      } else if (entry.kind === "park") {
        const reason = field(payload, "reason");
        if (!judged && reason !== "budget_exceeded" && reason !== "rejection_limit" && field(payload, "command") === undefined) turns += 1;
        rejections = [];
      } else if (entry.kind === "note") {
        const type = field(payload, "type");
        if (type === "gateway_call") turns += 1;
        else if (type === "rejection" && !judged) {
          turns += 1;
          rejections.push({ kind: "call", seq: entry.seq });
        }
      }
    }
    const session = new GovernedSession(this, taskId, this.mode, limits, admittedAt, { ...NO_SPEND, turns }, options.now ?? (() => this.now()));
    session.setRejections(rejections);
    if (this.#noted(taskId)) session.noteAnchoring();
    if (stopped !== null) session.restoreStop(stopped);
    this.#sessions.set(taskId, session);
    return { session, record };
  }

  session(taskId: string): GovernedSession | undefined {
    return this.#sessions.get(taskId);
  }

  /** Every session this layer opened, for the entry-point test (D-194). */
  sessions(): readonly GovernedSession[] {
    return [...this.#sessions.values()];
  }
}

export type CallStart =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "ttl_expired" }
  | { readonly ok: false; readonly reason: "anchor_unavailable" }
  | { readonly ok: false; readonly reason: "budget_exceeded"; readonly axes: readonly BudgetAxis[] };

/** The actor of the layer's own anchoring records. */
export const ANCHOR_ACTOR = "juno.anchoring";

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
  #anchoringNoted = false;
  #stopped: string | null = null;
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

  /** Whether this session's `anchoring` note is in its journal. */
  get anchoringNoted(): boolean {
    return this.#anchoringNoted;
  }

  /** The `anchoring` note is already in this session's journal (a session rebuilt from it, D-201). */
  noteAnchoring(): void {
    this.#anchoringNoted = true;
  }

  /** Sets the consecutive rejections the journal records (a session rebuilt from it, D-201). */
  setRejections(marks: readonly RejectionMark[]): void {
    this.#rejections = [...marks];
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

  /** Why the session stopped for good (`anchor_unavailable`), or null while it may go on (D-198). */
  get stopped(): string | null {
    return this.#stopped;
  }

  /** Stops the session for good: no call starts again (a session whose head cannot be anchored stops, §3.4.1, D-198). */
  stop(reason: string): void {
    if (this.#stopped !== null) return;
    this.#stopped = reason;
    // D-203: the stop is journalled when it happens, whoever stops the session (a call, or the interval's anchoring in
    // the background), so a restart finds it. The journal is on this host; it does not need the destination.
    this.#layer.append(this.id, "note", this.#layer.classOf(this.id), { type: "stopped", reason }, { actor: ANCHOR_ACTOR });
  }

  /** The stop the journal already records (a session rebuilt from it); journals nothing. */
  restoreStop(reason: string): void {
    this.#stopped ??= reason;
  }

  /**
   * Anchors this session's head off the host (§3.4.1, D-198). The first time, it journals the `anchoring` note (the
   * interval and the journal key) and anchors, whatever is due; later, only when the interval has passed, unless
   * `force`. A head that cannot be anchored stops the session for good. Answers whether the session may go on.
   */
  async anchor(dataClass: DataClass, options: { readonly force?: boolean } = {}): Promise<boolean> {
    if (this.#stopped !== null) return false;
    if (!this.#anchoringNoted) {
      this.#anchoringNoted = true;
      this.record("note", dataClass, this.#layer.anchoringNote(), { actor: ANCHOR_ACTOR });
    } else if (options.force !== true && !this.#layer.anchorDue(this.id)) return true;
    if (await this.#layer.anchorHead(this.id, dataClass)) return true;
    this.stop("anchor_unavailable");
    return false;
  }

  /**
   * One call in a mediated mode (§4.3): the anchor (the first one, or one due), then TTL, then the budget, then the call
   * is counted, so every call counts, one JUNO then rejects included (D-192). A session whose head cannot be anchored
   * stops and no call starts (§3.4.1, D-198). On `budget_exceeded` the park is journalled here.
   */
  async beginCall(dataClass: DataClass, actor: string, detail: Record<string, unknown>): Promise<CallStart> {
    if (!(await this.anchor(dataClass))) return { ok: false, reason: "anchor_unavailable" };
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
