import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  type DataClass,
  Ref,
  FlagSurface,
  SIDE_EFFECTS,
  Sensitivity as SensitivitySchema,
  type Sensitivity,
  type SideEffect,
  Task,
  WorkPath,
  maxSensitivity,
  pathWithin,
} from "../../contracts/src/index.js";
import {
  type CanonicalPaths,
  type CheckpointStore,
  type EnforcementBoundary,
  type GovernedSession,
  type RecoveredRecord,
  REFUSED_ADMISSION_CLASS,
  SessionLayer,
  type SessionLimits,
  type Workspace,
  ManifestEntry,
  type SealedWorkspace,
  checkpointId,
  GrantStore,
  type PathResolver,
  type TaskContext,
  type Verdict,
  readCommandString,
} from "../../enforcement/src/index.js";
import { type Adapter, type CapabilityCall, CapabilityRegistry, RegistryEntry, loadRegistryEntry } from "../../registry/src/index.js";
import { DeclaredSource, type ReadTarget, classifyRead } from "./reads.js";
import { type FilesystemIo, caseFoldingRefusals } from "./filesystem.js";
import { windowsFormReason, windowsFormRefusal } from "./paths.js";
import { rebuildBashCommand } from "./rebuild.js";
import { GATEWAY_NAME } from "./install.js";

/**
 * Mediated mode C: a Claude Code session governed through its hooks (spec §4.3, §2.3.2, §2.2.2, §7.8; build plan Slice
 * 1.5 Increment 4; DECISIONS.md D-139 to D-142).
 *
 * The session is a Task (§4.3 V6-6). Every PreToolUse call is mapped to an operator-authored capability and judged by
 * the same enforcement boundary and journal as JUNO's own loop. Every model-written value is `untrusted` (§4.3); values
 * the operator listed are `constant`. Claude Code, not JUNO, performs the effect, so a proceed is reported as no
 * decision and the result arrives later by PostToolUse. A park always denies the call with its reason and is
 * journalled (§4.3 V6-3). The one `allow` is a Bash call JUNO proceeded: it is answered with `updatedInput` whose command
 * is rebuilt from what JUNO judged, so what runs is what was judged (D-152). Nothing here ever answers `ask` or `defer`,
 * or rewrites a result.
 */

/** The actor recorded for the harness's calls and results. */
export const HARNESS_ACTOR = "claude-code";
export const HARNESS_ADAPTER = "harness.claude_code";
const SESSION_ACTOR = "juno.mediated";

const DEFINITIONS_DIR = fileURLToPath(new URL("../definitions/claude-code/", import.meta.url));

/**
 * The harness performs every effect, so the adapter's planned invocation is never run: it only shows, for §2.4, that
 * each data value is one discrete element (D-141).
 */
export const harnessAdapter: Adapter = {
  id: HARNESS_ADAPTER,
  plan: (call: CapabilityCall) => ({
    file: "claude-code",
    args: ["--", ...Object.keys(call).sort().flatMap((name) => {
      const value = call[name];
      if (Array.isArray(value)) return value.map(String);
      if (typeof value === "object" && value !== null) return Object.values(value).map(String);
      return [String(value)];
    })],
  }),
};

/**
 * Programs the Bash name map may never name (D-131): anything that can sign with the operator's key, start a Windows
 * program, or run code. Registration review also refuses interpreters (§2.3), these are refused by name too.
 */
export const BARRED_PROGRAMS: ReadonlySet<string> = new Set(["ssh-keygen", "ssh-add", "ssh", "ssh-agent", "wsl", "wsl.exe", "powershell", "pwsh", "cmd", "cmd.exe", "git", "sh", "bash", "node", "python", "python3", "env", "xargs", "find"]);

/** One Bash name the operator maps to a program in the workload's program enum, with its declared effect (§2.3.2 V6-10). */
export const NameMapEntry = z.strictObject({ name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/), program: z.string(), side_effect: z.enum(SIDE_EFFECTS) });

/** The order §2.2.2 ranks effects by, for registration review's "lower than what it can do" (D-146). */
const EFFECT_RANK: Readonly<Record<SideEffect, number>> = { read: 0, write: 1, external: 2, irreversible: 3 };

const ProgramsFile = z.object({
  programs: z.array(z.strictObject({ program: z.string(), minimum_effect: z.enum(SIDE_EFFECTS), surface: z.union([z.literal("shell.run"), FlagSurface]) })),
});

/** What the operator declares to admit a session (§4.3 V6-6). */
export const SessionRequest = z.strictObject({
  session_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9-]+$/),
  principal: Ref,
  attendance: z.enum(["gated", "autonomous"]),
  ttl: z.int().positive(),
  grants: z.array(Ref),
  /** Tool calls (counted as turns) and wall-clock time are enforced (§4.3). */
  budget: z.strictObject({ tool_calls: z.int().positive(), wall_clock_ms: z.int().positive() }),
  /** §4.3: the operator accepts that the harness's own limits govern tokens and currency, which JUNO cannot measure. */
  unmetered_accepted: z.literal(true),
  /** The session provider's declared sensitivity clearance (§4.3 V6-7). */
  provider_clearance: SensitivitySchema,
  /**
   * What the operator declares the session can read, each with its class (§1.5): paths, URL origins, the public internet,
   * and the results of named tools JUNO does not support (D-162, D-164). A read no source positively matches is read at
   * the highest class declared here.
   */
  sources: z.array(DeclaredSource).min(1),
  /** Exact Bash command strings the operator allows as written (§4.3: `constant` at `operator` integrity). */
  commands: z.array(z.string().min(1)).default([]),
  name_map: z.array(NameMapEntry).default([]),
  /** §2.7.1 A4: consecutive rejections that park `rejection_limit`; per session in hook mode. */
  rejection_limit: z.int().min(1).max(10).default(3),
  /** §2.2.2 (plan Increment 4 item 9): workspaces checkpointed at admission, before the session's first effect (D-136). */
  reversible_workspaces: z.array(WorkPath).max(16).default([]),
});
export type SessionRequest = z.input<typeof SessionRequest>;

/** Claude Code's hook input, the fields JUNO reads (hooks reference, read 2026-11-05, D-139). */
export const HookInput = z.object({
  session_id: z.string(),
  hook_event_name: z.enum(["PreToolUse", "PostToolUse", "PostToolUseFailure"]),
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()),
  tool_use_id: z.string().optional(),
  cwd: z.string().optional(),
  agent_id: z.string().optional(),
  tool_response: z.unknown().optional(),
  error: z.unknown().optional(),
  /** For an MCP tool: the server's name and where its definition came from (hooks reference, read 2026-11-09, D-190). */
  mcp_server: z.object({ name: z.string(), source: z.string() }).optional(),
});
export type HookInput = z.infer<typeof HookInput>;

/**
 * What JUNO answers a PreToolUse: no decision (Claude Code's own rules apply), a denial with its reason, or, for a Bash
 * call JUNO proceeded only, `allow` with the whole tool input replaced by the rebuilt command and the other known fields
 * (D-152; hooks reference: `updatedInput` "replaces the entire input object").
 */
export type HookDecision =
  | { readonly decision: "none" }
  | { readonly decision: "deny"; readonly reason: string }
  | { readonly decision: "allow"; readonly updatedInput: Readonly<Record<string, unknown>> };

/** Just enough of a hook input to judge a Bash command before anything else is read (D-151, D-152). */
const BashProbe = z.object({ session_id: z.string(), hook_event_name: z.literal("PreToolUse"), tool_name: z.literal("Bash"), tool_input: z.object({ command: z.string() }) });

/** The Bash tool's input fields, and the types JUNO passes on in `updatedInput` (D-152; hooks reference, D-139). */
const BashFields = z.strictObject({
  command: z.string(),
  description: z.string().optional(),
  timeout: z.int().positive().optional(),
  run_in_background: z.boolean().optional(),
});

/**
 * Maps the operator's workspace root onto the capability namespace (D-141). Linux absolute paths only (D-173): a root in
 * any other form is refused when the map is built, and a Windows-form path never maps (the session refuses it first).
 */
export class PathMap {
  readonly #roots: readonly string[];

  constructor(roots: readonly string[]) {
    for (const root of roots) {
      const windows = windowsFormReason(root);
      if (windows !== null || !root.startsWith("/")) throw new MediatedError(`workspace root ${JSON.stringify(root)} is not a Linux absolute path; JUNO accepts only Linux paths (D-173)`);
    }
    this.#roots = roots.map((root) => (root === "/" ? root : root.replace(/\/+$/, "")));
  }

  /** The host workspace roots, as configured. */
  get roots(): readonly string[] {
    return this.#roots;
  }

  /** The path under `/work`, or null when it lies under no configured root or is not a Linux absolute path (then it is outside every scope). */
  toWork(path: string): string | null {
    if (windowsFormReason(path) !== null || !path.startsWith("/")) return null;
    for (const root of this.#roots) {
      if (!path.startsWith(root)) continue;
      const rest = path.slice(root.length);
      if (rest !== "" && !rest.startsWith("/")) continue;
      const mapped = "/work" + rest;
      return mapped === "/work/" ? "/work" : mapped;
    }
    return null;
  }
}

type Session = {
  task: z.infer<typeof Task>;
  readonly request: z.output<typeof SessionRequest>;
  /** The shared session layer's session: its rejection limit, budget and journal (D-194). */
  readonly governed: GovernedSession;
  floor: Sensitivity;
  /** Calls authorized and not yet reported by PostToolUse: tool_use_id → call_seq and the sensitivity of what it reads. */
  readonly pending: Map<string, { readonly call_seq: number | null; readonly reads: Sensitivity; readonly gateway?: true }>;
  /** The session's checkpointed workspaces: the only reversible ones (§2.2.2, D-135). */
  reversible: readonly string[];
};

export type MediatedOptions = {
  /**
   * The shared session layer (D-193, D-194), opened by the shared start-up check for the hook service: it holds the
   * journal, judged JUNO's state (the journal, the checkpoint store, the trust anchor, the hook's socket and Claude
   * Code's settings files, as the starter declared them) against every workspace root, and owns every session's
   * admission, rejection limit, budget and parks. Every workspace root and the read view's root must be among its
   * workspaces, and the checkpoint store among its state.
   */
  readonly layer: SessionLayer;
  readonly grants: GrantStore;
  readonly paths: PathMap;
  readonly resolver: PathResolver;
  /**
   * The host workspace as the read gate lists it, never following a symlink (D-156): a read of a directory counts every
   * link inside it as a read of that link's target.
   */
  readonly view: Workspace;
  readonly clock?: () => Date;
  /**
   * Where the host workspace is checkpointed and the store for its content (D-136): only through the sealed copy context
   * (D-228), never by this process reading the folder itself.
   */
  readonly checkpoints?: { readonly workspace: SealedWorkspace; readonly store: CheckpointStore };
  /**
   * How admission reads the file systems under the workspace roots and the registered sources (D-178): every admission
   * refuses one that is not a case-sensitive Linux file system or that holds a case-folding folder. Required, so no
   * configuration can leave the check out.
   */
  readonly filesystem: FilesystemIo;
  /**
   * JUNO's gateway relay, by its managed MCP server name (D-190). Only then does the hook let an MCP call through, and
   * only one whose hook input says it is that server's, defined in the managed MCP file (`source: "enterprise"`): the
   * gateway judges and journals it. Whoever starts the service gives it only after `juno hook check --gateway` holds.
   * Without it, every MCP call is denied.
   */
  readonly gateway?: { readonly server: string };
};

export class MediatedError extends Error {
  override readonly name = "MediatedError";
}

/**
 * THE tool table (D-141, D-162): every tool JUNO supports, the capability it maps to, the input fields it knows, and what
 * it reads. A tool with no entry is `unknown_capability` (denied), and any result it produces is classified as an
 * unknown read (the highest declared class). `reads` is given the values JUNO judged (paths already mapped onto `/work`),
 * field by field, and returns every read the call makes; a value it cannot describe is an `unknown` read. What it
 * returns is classified only by `classifyRead` (reads.ts).
 */
const TOOLS: Readonly<Record<string, { readonly capability: string; readonly fields: readonly string[]; readonly reads: (judged: (field: string) => unknown) => readonly ReadTarget[] }>> = {
  // Every path a tool names is read as a tree: a file's tree is the file, and what a tool does with a directory it was
  // handed is not JUNO's to know (restrictive, D-164; found by the D-162 property: a Read naming a directory that holds a
  // hard link was counted at the directory's class).
  // A Read reads the file it names.
  Read: { capability: "cc.read", fields: ["file_path", "offset", "limit"], reads: (judged) => [tree(judged("file_path"))] },
  // A Glob lists every name under its path, and through every link inside it (D-156).
  Glob: { capability: "cc.glob", fields: ["pattern", "path"], reads: (judged) => [tree(judged("path"))] },
  // A Write's result may carry the content it replaced; JUNO does not rely on it not doing so (restrictive, D-164).
  Write: { capability: "cc.write", fields: ["file_path", "content"], reads: (judged) => [tree(judged("file_path"))] },
  // An Edit reads the file it edits (D-141).
  Edit: { capability: "cc.edit", fields: ["file_path", "old_string", "new_string", "replace_all"], reads: (judged) => [tree(judged("file_path"))] },
  // A WebFetch reads the page at its URL; no path source can match it (D-160, D-162).
  WebFetch: { capability: "cc.webfetch", fields: ["url", "prompt"], reads: (judged) => { const url = judged("url"); return [typeof url === "string" ? { kind: "url", url } : unknown("url")]; } },
  // A Bash program reads every operand, each as a tree (`ls -R` lists a directory's whole tree; a file's tree is the
  // file), and with no operand its working directory's tree (`ls` lists it). Flags are words before `--` that start with
  // `-`; anything else, a flag's separate value included, is an operand (restrictive, D-156).
  Bash: { capability: "cc.bash", fields: ["command", "description", "timeout", "run_in_background"], reads: (judged) => {
    const argv = judged("argv");
    const cwd = judged("cwd");
    if (typeof cwd !== "string" || !Array.isArray(argv) || !argv.every((element) => typeof element === "string")) return [unknown("argv")];
    const operands: string[] = [];
    let flagsEnd = false;
    for (const element of argv as string[]) {
      if (!flagsEnd && element === "--") flagsEnd = true;
      else if (flagsEnd || !element.startsWith("-")) operands.push(element);
    }
    return operands.length === 0 ? [{ kind: "tree", path: cwd }] : operands.map((element) => ({ kind: "tree", path: element.startsWith("/") ? element : `${cwd}/${element}` }));
  } },
};

/** The tools JUNO supports: exactly the tool table's entries (D-162). */
export const SUPPORTED_TOOLS: readonly string[] = Object.keys(TOOLS);

function tree(path: unknown): ReadTarget {
  return typeof path === "string" ? { kind: "tree", path } : unknown("path");
}
function unknown(field: string): ReadTarget {
  return { kind: "unknown", why: `the table cannot describe what ${field} reads` };
}

export class MediatedSessions {
  readonly #gateway: string | undefined;
  readonly #layer: SessionLayer;
  readonly #grants: GrantStore;
  readonly #paths: PathMap;
  readonly #resolver: PathResolver;
  readonly #clock: () => Date;
  readonly #checkpoints: MediatedOptions["checkpoints"];
  readonly #view: Workspace;
  readonly #filesystem: FilesystemIo;
  readonly #sessions = new Map<string, Session>();
  readonly #registries = new Map<string, { registry: CapabilityRegistry; boundary: EnforcementBoundary }>();
  /** Sessions whose admission was refused and journalled: task id → the refused request's name map (D-152). */
  readonly #refused = new Map<string, ReadonlyMap<string, string>>();
  /** Sessions the journal admitted that could not be rebuilt at start, and why: they stay closed, and are never admitted again (D-201). */
  readonly #unrestored = new Map<string, string>();
  /** Grant files a rebuilt session's admission named that could not be read again at start; those grants are absent. */
  readonly #grantWarnings: string[] = [];
  /** A rebuilt session's workspaces that stay reversible only once the sealed context confirms their checkpoints can still be restored (D-224, D-228). */
  readonly #unconfirmed = new Map<string, { readonly root: string; readonly manifest: readonly ManifestEntry[] }[]>();

  constructor(options: MediatedOptions) {
    if (options.gateway !== undefined && !GATEWAY_NAME.test(options.gateway.server)) throw new MediatedError(`the gateway's server name ${JSON.stringify(options.gateway.server)} must be letters, digits and hyphens only (D-190)`);
    this.#gateway = options.gateway?.server;
    // D-194: only through the shared session layer; what this service touches must be what its start-up check judged.
    this.#layer = SessionLayer.require(options.layer, "hook");
    for (const root of options.paths.roots) this.#layer.requireWorkspace("the workspace root", root);
    this.#layer.requireWorkspace("the read view's root", options.view.viewRoot);
    if (options.checkpoints !== undefined) {
      this.#layer.requireWorkspace("the checkpointed workspace", options.checkpoints.workspace.workspace);
      if (options.checkpoints.workspace.workspace !== options.view.viewRoot) throw new MediatedError("the checkpointed workspace must be the read view's folder");
      this.#layer.requireState("the checkpoint store", options.checkpoints.store.root);
    }
    this.#layer.requireGrants(options.grants);
    this.#grants = options.grants;
    this.#paths = options.paths;
    this.#resolver = options.resolver;
    this.#clock = options.clock ?? (() => new Date());
    this.#checkpoints = options.checkpoints;
    this.#view = options.view;
    this.#filesystem = options.filesystem;
    // D-201: every session the journal admitted is reopened exactly as its journal leaves it, before any call is judged.
    for (const record of this.#layer.recovered()) {
      if (!record.id.startsWith("session-")) continue;
      if (record.admission === null) this.#restoreRefused(record);
      else if (record.admission["mode"] === "hook") {
        try {
          this.#restore(record);
        } catch (error: unknown) {
          this.#unrestored.set(record.id, error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  /**
   * D-224 with D-228: asks the sealed context, for every rebuilt session's checkpointed workspace, whether the runner
   * could still restore it; only a confirmed one becomes reversible again. The service calls it once, before it serves.
   * Never throws: a workspace that cannot be confirmed stays irreversible.
   */
  async confirmReversible(): Promise<readonly string[]> {
    const notes: string[] = [];
    for (const [id, candidates] of this.#unconfirmed) {
      const session = this.#sessions.get(id);
      if (session === undefined || this.#checkpoints === undefined) continue;
      const confirmed: string[] = [];
      for (const { root, manifest } of candidates) {
        let refusals: readonly string[];
        try {
          refusals = await this.#checkpoints.workspace.check(root, manifest);
        } catch (error: unknown) {
          refusals = [error instanceof Error ? error.message : String(error)];
        }
        if (refusals.length === 0) confirmed.push(root);
        else notes.push(`${id}: ${root} is no longer reversible, so writes there park: ${refusals.join("; ")}`);
      }
      session.reversible = confirmed;
    }
    this.#unconfirmed.clear();
    return notes;
  }

  /** The sessions rebuilt from the journal when this service started, and the ones that could not be (D-201). */
  get rebuilt(): { readonly sessions: readonly string[]; readonly failed: ReadonlyMap<string, string>; readonly grants: readonly string[] } {
    return { sessions: [...this.#sessions.keys()], failed: this.#unrestored, grants: [...this.#grantWarnings] };
  }

  /**
   * Reads one signed grant file into the service's store (D-196): the file must pass the start-up check's own rules, and
   * the grant enters the store only once its operator signature is verified, on a store of its own first, so a forged
   * grant can never take the place of the real one under its id. Answers the grant's id, or every reason why not.
   */
  loadGrant(grantFile: string): { readonly ok: true; readonly id: string } | { readonly ok: false; readonly failures: readonly string[] } {
    const refusals = this.#layer.fileRefusals("the grant file", grantFile);
    if (refusals.length > 0) return { ok: false, failures: refusals };
    try {
      const grant: unknown = JSON.parse(this.#layer.readFile(grantFile));
      const trial = new GrantStore(this.#grants.trustAnchor);
      const id = trial.add(grant).id;
      if (trial.signed(id) === undefined) return { ok: false, failures: [`the grant file ${grantFile} holds grant ${id} without a valid operator signature (§3.2)`] };
      // A grant already held (verified by an earlier admission) is not added twice. One held and refused for the
      // journal's recovery epoch (D-207) stays held and refused; the admission below says why.
      if (this.#grants.signed(id) === undefined && !this.#grants.issuedBeforeRecovery(id)) this.#grants.add(grant);
      return { ok: true, id };
    } catch (error: unknown) {
      return { ok: false, failures: [`the grant file ${grantFile} holds no valid grant: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }

  /** A refused admission found in the journal at start: its name map judges an injected command from it, as before the restart (D-152, D-201). */
  #restoreRefused(record: RecoveredRecord): void {
    for (const { payload } of record.entries) {
      const note = z.object({ type: z.literal("admission"), outcome: z.literal("rejected"), mode: z.literal("hook"), name_map: z.array(NameMapEntry) }).safeParse(payload);
      if (note.success) this.#refused.set(record.id, new Map(note.data.name_map.map((entry) => [entry.name, entry.program])));
    }
  }

  /**
   * Reopens one admitted session from its journal (operator ruling D-201). The shared layer rebuilds its limits, its
   * spend, its consecutive rejections and a stop; here, what only this mode knows: the session's grants (read again
   * from the grant files its admission names, under the same rules; one that is gone or no longer verifies is absent,
   * so its calls park `awaiting_grant`), its tool registry (with every adapter quarantine the journal records), its
   * state, its floor (the class of every result it received), and the calls authorized whose result has not arrived.
   */
  #restore(record: RecoveredRecord): void {
    const admitted = z.object({ task: Task, request: SessionRequest, grant_files: z.array(z.string()).default([]) }).parse(record.admission);
    const request = admitted.request;
    for (const file of admitted.grant_files) {
      const loaded = this.loadGrant(file);
      if (!loaded.ok) this.#grantWarnings.push(...loaded.failures.map((why) => `${record.id}: ${why}`));
    }
    const built = this.#registryFor(request);
    let task = admitted.task;
    let floor: Sensitivity = "public";
    const pending: Session["pending"] = new Map();
    const Pending = z.object({ call_seq: z.int().nullable().default(null), tool_use_id: z.string().nullable().default(null), reads: SensitivitySchema });
    const checkpointed: Record<string, unknown>[] = [];
    if (request.reversible_workspaces.length > 0 && this.#checkpoints === undefined) throw new MediatedError("the session has reversible workspaces and this service has no checkpoint store (D-136)");
    for (const { entry, payload } of record.entries) {
      // The floor comes from the chained entry itself, never from its payload (D-204).
      if (entry.kind === "capability_result") floor = maxSensitivity(floor, entry.data_class.sensitivity);
      const body = z.record(z.string(), z.unknown()).safeParse(payload);
      if (!body.success) throw new MediatedError(`entry ${String(entry.seq)} has no readable payload`);
      const type = body.data["type"];
      if (entry.kind === "capability_call") {
        const verdict = z.object({ capability: z.string(), verdict: z.object({ reason: z.literal("adapter_quarantined"), adapter: z.string(), observation: z.unknown() }) }).safeParse(payload);
        // A quarantine is permanent (§2.4, D-064): the ones this session's journal records are applied again.
        if (verdict.success) built.registry.quarantine({ capability: verdict.data.capability, adapter: verdict.data.verdict.adapter, observation: verdict.data.verdict.observation as never });
      } else if (entry.kind === "capability_result") {
        pending.delete(typeof body.data["tool_use_id"] === "string" ? body.data["tool_use_id"] : "");
      } else if (entry.kind === "note" && (type === "updated_input" || type === "authorized" || type === "gateway_call")) {
        const call = Pending.parse(payload);
        const fallback = type === "gateway_call" ? `gateway-${String(entry.seq)}` : `call-${String(call.call_seq)}`;
        pending.set(call.tool_use_id ?? fallback, type === "gateway_call" ? { call_seq: null, reads: call.reads, gateway: true } : { call_seq: call.call_seq, reads: call.reads });
      } else if (entry.kind === "note" && type === "result_missing") pending.clear();
      else if (entry.kind === "note" && type === "state" && body.data["to"] === "failed") task = Task.parse({ ...task, state: "failed", runtime_substate: null });
      else if (entry.kind === "note" && type === "checkpoint") checkpointed.push(body.data);
    }
    // D-224 (review round 2 of PR #60, F1): §2.2.2 counts a workspace reversible only while its checkpoint can be
    // restored. A rebuilt session keeps a workspace reversible only when its journal holds that workspace's checkpoint,
    // taken in this service's own folder by the sealed context (one taken before 1.5-field records no folder, one taken
    // before D-228 is not marked sealed, and the host restore refuses both), and the sealed context confirms the runner
    // could restore it as the folder now stands. Until `confirmReversible` has confirmed it, the session has no
    // reversible workspace: its writes are judged irreversible, so an untrusted target parks (integrity_floor, §8.3).
    const candidates: { root: string; manifest: readonly ManifestEntry[] }[] = [];
    for (const root of request.reversible_workspaces) {
      const note = z.object({ root: z.string(), workspace: z.string(), manifest: z.array(ManifestEntry), taken_by: z.literal("sealed") }).safeParse(checkpointed.findLast((item) => item["root"] === root));
      if (note.success && note.data.workspace === this.#view.viewRoot) candidates.push({ root, manifest: note.data.manifest });
    }
    if (candidates.length > 0) this.#unconfirmed.set(record.id, candidates);
    const reversible: string[] = [];
    const resumed = this.#layer.resume(record.id, hookLimits(request, task.budget), { now: () => this.#clock().getTime() });
    if (resumed === null) throw new MediatedError(`the journal holds no admission of ${record.id}`);
    this.#registries.set(record.id, built);
    this.#sessions.set(record.id, { task, request, governed: resumed.session, floor, pending, reversible });
  }

  /**
   * A session refused before admission was judged (its session file's grant files failed, D-196): journalled as a
   * refused admission at the most restrictive class, and anchored, as every refusal is (§3.2, §3.4.1; D-198 autopilot
   * ruling). A request that does not even name a session cannot be recorded under one, and is only refused.
   */
  async refuse(input: unknown, failures: readonly string[]): Promise<void> {
    const parsed = SessionRequest.safeParse(input);
    if (!parsed.success) return;
    const id = `session-${parsed.data.session_id}`;
    if (this.#layer.admitted(id)) return;
    this.#layer.refuse(id, { mode: "hook", failures, name_map: parsed.data.name_map }, SESSION_ACTOR);
    this.#refused.set(id, new Map(parsed.data.name_map.map((entry) => [entry.name, entry.program])));
    await this.#layer.anchorHead(id, REFUSED_ADMISSION_CLASS);
  }

  /** Admits a session as a Task (§4.3 V6-6), or says why not. */
  async admit(input: unknown, origin: { readonly grantFiles?: readonly string[] } = {}): Promise<{ readonly admitted: true; readonly task_id: string } | { readonly admitted: false; readonly failures: readonly string[] }> {
    const parsed = SessionRequest.safeParse(input);
    if (!parsed.success) return { admitted: false, failures: [parsed.error.message] };
    const request = parsed.data;
    const failures: string[] = [];
    const id = `session-${request.session_id}`;
    // D-201: an id is admitted once, and the journal remembers it across restarts. A session admitted before a restart is
    // still open (rebuilt from its journal); it is never admitted again with a fresh budget and time limit.
    if (this.#sessions.has(id)) failures.push(`session ${request.session_id} is already admitted`);
    else if (this.#layer.admitted(id)) failures.push(`session ${request.session_id} is already admitted: the journal holds its admission, and an id is admitted once. A new session needs a new session_id (D-201)`);
    for (const grantId of request.grants) {
      const grant = this.#grants.signed(grantId);
      if (grant === undefined) failures.push(this.#grants.issuedBeforeRecovery(grantId) ? `grant ${grantId} was issued before this journal's recovery epoch, so it is refused; sign a new grant (D-206)` : `grant ${grantId} does not exist or has no valid operator signature (§3.2)`);
      else {
        if (grant.principal !== request.principal) failures.push(`grant ${grantId} belongs to another principal`);
        for (const selector of grant.resource_scope) {
          if (!request.sources.some((source) => source.selector.kind === "path" && selector.kind === "path" && pathWithin(selector.prefix, source.selector.prefix))) {
            failures.push(`grant ${grantId} reaches beyond every declared source (§5.4 check 4)`);
          }
        }
      }
    }
    for (const root of request.reversible_workspaces) {
      const reachable = request.grants.some((grantId) => this.#grants.signed(grantId)?.resource_scope.some((selector) => selector.kind === "path" && pathWithin(root, selector.prefix)) === true);
      if (!reachable || root === "/work") failures.push(`reversible workspace ${root} is the whole namespace or lies within no grant (D-136)`);
    }
    for (const source of request.sources) {
      // D-164: a supported tool's result is classified by what its call read; a result of one with no authorized call
      // bypassed JUNO's decision, so it is never given a lower class by a source (D-150).
      if (source.selector.kind === "tool_result" && Object.hasOwn(TOOLS, source.selector.tool)) {
        failures.push(`source ${source.id} classifies results of ${source.selector.tool}, a tool JUNO judges by what it reads; only a tool outside the table may be declared (D-164)`);
      }
    }
    // D-173: Linux paths only, in the operator's configuration too: a backslash in a source, a reversible workspace or a
    // grant's scope is how a Windows path is spelled (restrictive; mode A's path type is unchanged, D-173).
    const configured = [
      ...request.sources.flatMap((source) => (source.selector.kind === "path" ? [source.selector.prefix] : [])),
      ...request.reversible_workspaces,
      ...request.grants.flatMap((grantId) => this.#grants.signed(grantId)?.resource_scope.flatMap((selector) => (selector.kind === "path" ? [selector.prefix] : [])) ?? []),
    ];
    for (const path of configured) {
      const why = windowsFormReason(path);
      if (why !== null) failures.push(windowsFormRefusal("admission", why));
    }
    // D-178: the workspace and every registered path source must be on a case-sensitive Linux file system with no
    // case-folding folder; a Windows folder mounted into WSL (drvfs, 9p) is refused, fail-closed.
    // Judged where JUNO reads the workspace: the view's directory (D-182 item 8), and every configured root that exists
    // on this machine; each source under the view's directory.
    const viewRoot = this.#view.viewRoot;
    const located = [
      { what: "the workspace", path: viewRoot },
      ...this.#paths.roots.filter((root) => root !== viewRoot && this.#filesystem.realpath(root) !== null).map((root) => ({ what: "the workspace", path: root })),
      ...request.sources.flatMap((source) => (source.selector.kind === "path" ? [{ what: `source ${source.id}`, path: viewRoot + source.selector.prefix.slice("/work".length) }] : [])),
    ];
    failures.push(...(await caseFoldingRefusals(located, this.#filesystem)));
    if (request.reversible_workspaces.length > 0 && this.#checkpoints === undefined) failures.push("no checkpoint store is configured, so no workspace can be reversible (D-136)");
    for (const entry of request.name_map) {
      if (BARRED_PROGRAMS.has(entry.name) || BARRED_PROGRAMS.has(entry.program.split("/").pop() ?? "")) failures.push(`the name map may not name ${entry.name} (D-131)`);
    }
    let built: { registry: CapabilityRegistry; boundary: EnforcementBoundary } | null = null;
    try {
      built = this.#registryFor(request);
    } catch (error: unknown) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    if (failures.length > 0 || built === null) {
      // Never admitted, never referenced: recorded at the most restrictive class, as mode A records a refused admission.
      if (!this.#layer.admitted(id)) {
        this.#layer.refuse(id, { mode: "hook", failures, name_map: request.name_map }, SESSION_ACTOR);
        this.#refused.set(id, new Map(request.name_map.map((entry) => [entry.name, entry.program])));
        // §3.4.1 (D-198): a refused admission is anchored too; a failure is journalled by the layer.
        await this.#layer.anchorHead(id, REFUSED_ADMISSION_CLASS);
      }
      return { admitted: false, failures };
    }
    const task = Task.parse({
      id,
      principal: request.principal,
      objective: "operator session via claude-code",
      criterion: null,
      criterion_integrity: "operator",
      verification: null,
      closure_mode: "accepted",
      attendance: request.attendance,
      strategy: "hook",
      sensitivity_floor: "public",
      context_ownership: "native",
      model_policy: { permitted_providers: ["claude-code"], posture: "harness", conversation_state: "any" },
      budget: { tokens: 0, currency: 0, wall_clock_ms: request.budget.wall_clock_ms, turns: request.budget.tool_calls },
      ttl: request.ttl,
      grants: request.grants,
      parent: null,
      state: "running",
      runtime_substate: "active",
      steer_capability: "none",
      trajectory: id,
    });
    // §2.2.2: each reversible workspace is checkpointed now, before the session's first effect; one that cannot be is refused.
    const reversible: string[] = [];
    const checkpoints: { root: string; checkpoint: string; manifest: unknown; workspace: string; taken_by: "sealed" }[] = [];
    for (const root of request.reversible_workspaces) {
      const resolved = (await this.#resolver.resolve([root])).get(root);
      // D-228: the sealed context takes the checkpoint, then judges that the runner could restore it (D-221: §2.2.2
      // counts the workspace reversible only if restoring the checkpoint is possible); one that holds anything but files
      // and folders, or that the runner could not restore, is refused now, before any effect.
      const taken = resolved?.ok === true && resolved.canonical === root && this.#checkpoints !== undefined ? await this.#checkpoints.workspace.checkpoint(root) : null;
      if (taken !== null && !taken.ok && taken.restorable === false) return { admitted: false, failures: [`reversible workspace ${root} could not be restored by the runner, so it is not reversible (§2.2.2, D-221): ${taken.reason}`] };
      if (taken === null || !taken.ok) return { admitted: false, failures: [`reversible workspace ${root} could not be checkpointed${taken === null ? "" : `: ${taken.reason}`}`] };
      for (const bytes of taken.snapshot.contents.values()) this.#checkpoints?.store.put(bytes);
      // `workspace`: the host folder the checkpoint was taken in, which `juno checkpoint restore --workspace` must match
      // (D-221); `taken_by`: the sealed context took it (D-228).
      checkpoints.push({ root, checkpoint: checkpointId(root, taken.snapshot.manifest), manifest: taken.snapshot.manifest, workspace: this.#view.viewRoot, taken_by: "sealed" });
      reversible.push(root);
    }
    this.#registries.set(id, built);
    this.#refused.delete(id);
    // §2.7.1 A4, §4.3, §6.4: the shared layer owns the session's rejection limit, budget (every tool call, and wall clock
    // from admission), TTL, parks and journal (D-194).
    const governed = this.#layer.admit(id, hookLimits(request, task.budget), {
      dataClass: { sensitivity: "internal", integrity: "operator" },
      now: () => this.#clock().getTime(), actor: SESSION_ACTOR,
      payload: {
        mode: "hook",
        admitted_at: this.#clock().toISOString(),
        task,
        request,
        // §4.3: tokens and currency are not measured by JUNO; the operator accepted the harness's limits.
        unmetered: ["tokens", "currency"],
        // D-201: the signed grant files this admission read; a restarted service reads them again, under the same rules.
        ...(origin.grantFiles === undefined ? {} : { grant_files: [...origin.grantFiles] }),
      },
    });
    const session: Session = { task, request, governed, floor: "public", pending: new Map(), reversible };
    this.#sessions.set(id, session);
    for (const checkpoint of checkpoints) this.#append(id, "note", { sensitivity: "internal", integrity: "derived" }, SESSION_ACTOR, { type: "checkpoint", ...checkpoint });
    // §3.4.1 (D-198): the shared layer records the interval and anchors the admitted session's head before its first
    // call; a session whose head cannot be anchored is never run.
    if (!(await governed.anchor(this.#class(session), { force: true }))) {
      this.#stopForAnchor(session);
      return { admitted: false, failures: ["the session's journal head could not be anchored off the host, so the session does not start (§3.4.1, D-198)"] };
    }
    return { admitted: true, task_id: id };
  }

  /** The session's Task, as admitted and as it stands now. */
  task(sessionId: string): z.infer<typeof Task> | undefined {
    return this.#sessions.get(`session-${sessionId}`)?.task;
  }

  /** Judges one PreToolUse (D-141). Never throws on bad input: anything it cannot judge is denied. */
  async preToolUse(raw: unknown): Promise<HookDecision> {
    // §2.7.1 D5 (D-151, D-152): a Bash command string is the call's one instruction value, so it is judged first, from
    // the least of the input that names it, before the rest of the input is read and before the session's state, the
    // budget, unknown or malformed fields, the working directory or a missing result can turn its non-overridable park
    // into anything else. A session whose admission was refused records it too, against its refused request's name map.
    const probe = BashProbe.safeParse(raw);
    if (probe.success) {
      const probeId = `session-${probe.data.session_id}`;
      const command = probe.data.tool_input.command;
      const admitted = this.#sessions.get(probeId);
      const nameMap = admitted === undefined ? this.#refused.get(probeId) : new Map(admitted.request.name_map.map((entry) => [entry.name, entry.program]));
      const reading = nameMap === undefined ? null : readCommandString(command, nameMap);
      if (reading !== null && !reading.ok) {
        const detail = { tool: "Bash", command, why: reading.reason };
        return admitted === undefined ? this.#parkRefused(probeId, detail) : this.#park(admitted, "integrity_floor", detail, false);
      }
    }
    const parsed = HookInput.safeParse(raw);
    if (!parsed.success || parsed.data.hook_event_name !== "PreToolUse") return deny("JUNO could not read the hook input, so the call is blocked (§4.3 fail-closed)");
    const input = parsed.data;
    const id = `session-${input.session_id}`;
    const session = this.#sessions.get(id);
    const built = this.#registries.get(id);
    if (session === undefined || built === undefined) {
      const why = this.#unrestored.get(id);
      return deny(why === undefined ? "this Claude Code session is not admitted to JUNO, so no call is allowed (§4.3)" : `JUNO could not rebuild this session from its journal after a restart, so no call is allowed: ${why} (§4.3 fail-closed, D-201)`);
    }
    if (session.task.state !== "running") return deny(`this session is ${session.task.state}; no call is allowed`);
    if (session.governed.expired()) {
      session.task = Task.parse({ ...session.task, state: "failed", runtime_substate: null });
      this.#append(id, "note", this.#class(session), SESSION_ACTOR, { type: "state", to: "failed", reason: "ttl_expired" });
      return deny("the session's time to live has expired (§6.4)");
    }
    // A call whose result never arrived is recorded, and this call is denied, so a missing result is never silent (plan item 8).
    if (session.pending.size > 0) {
      const missing = [...session.pending.entries()].map(([toolUseId, call]) => ({ tool_use_id: toolUseId, call_seq: call.call_seq }));
      session.pending.clear();
      this.#append(id, "note", this.#class(session), SESSION_ACTOR, { type: "result_missing", calls: missing });
      return deny("JUNO did not receive the result of an earlier call; that gap is now recorded. Retry this call");
    }
    // §4.3 in the shared layer: the budget is checked and the call counted there; a `budget_exceeded` park is journalled there.
    const started = await session.governed.beginCall(this.#class(session), SESSION_ACTOR, { tool: input.tool_name });
    if (!started.ok && started.reason === "anchor_unavailable") {
      this.#stopForAnchor(session);
      return deny("JUNO could not copy this session's journal head off the host, so the session has stopped (§3.4.1)");
    }
    if (!started.ok && started.reason === "ttl_expired") {
      session.task = Task.parse({ ...session.task, state: "failed", runtime_substate: null });
      this.#append(id, "note", this.#class(session), SESSION_ACTOR, { type: "state", to: "failed", reason: "ttl_expired" });
      return deny("the session's time to live has expired (§6.4)");
    }
    if (!started.ok) return deny(parkText("budget_exceeded", "", true));
    if (input.tool_name.startsWith("mcp__")) return this.#mcp(session, input);

    const mapped = await this.#map(session, input);
    if (mapped.kind === "reject") return this.#reject(session, mapped.reason, input.tool_name);
    if (mapped.kind === "park") return this.#park(session, mapped.reason, mapped.detail, mapped.overridable);

    // §4.3 V6-7: a read of a source classified above the provider's clearance parks before it runs. The boundary judges it
    // at step 5, after integrity, scope and effects, so a park that cannot be overridden always wins (D-150). What the call
    // reads comes from the tool table, and its class from the one classification function (D-162).
    const reads = await this.#classify(session, TOOLS[input.tool_name]?.reads(judgedValue(mapped.proposal.arguments, mapped.constants)) ?? [unknown(input.tool_name)]);

    const constants = mapped.constants;
    const base: TaskContext = { task: { ...session.task, sensitivity_floor: session.floor }, constants, synthesis: { sensitivity: session.floor }, reversible: session.reversible, readGate: { reads, clearance: session.request.provider_clearance } };
    const canonical: CanonicalPaths = await this.#resolver.resolve(built.boundary.pathsToResolve(base, mapped.proposal));
    const verdict: Verdict = built.boundary.authorize({ ...base, canonical }, mapped.proposal);
    if (verdict.outcome === "proceed") {
      session.governed.clearRejections();
      session.pending.set(input.tool_use_id ?? `call-${String(verdict.call_seq)}`, { call_seq: verdict.call_seq, reads });
      // D-201: the call now waits for its result. What a restarted service needs to match that result to this call (its
      // id and the class of what it reads) is journalled with the decision, before the decision is handed out.
      if (mapped.bash === undefined) {
        this.#append(id, "note", this.#class(session), SESSION_ACTOR, { type: "authorized", call_seq: verdict.call_seq, tool_use_id: input.tool_use_id ?? null, reads });
        return { decision: "none" };
      }
      // D-152: what runs is what was judged. The command Claude Code runs is the one rebuilt from the judged program and
      // argv, recorded against the call before it is handed out.
      this.#append(id, "note", this.#class(session), SESSION_ACTOR, { type: "updated_input", call_seq: verdict.call_seq, tool_use_id: input.tool_use_id ?? null, command: mapped.bash.command, reads });
      return { decision: "allow", updatedInput: mapped.bash };
    }
    if (verdict.outcome === "reject") return this.#reject(session, verdict.detail.reason, input.tool_name, verdict.call_seq);
    const grantOnly = verdict.detail.reason === "scope_violation" && verdict.detail.untrusted.length > 0;
    return this.#park(session, verdict.detail.reason, { call_seq: verdict.call_seq, tool: input.tool_name, detail: verdict.detail }, !grantOnly);
  }

  /** Journals a PostToolUse or PostToolUseFailure result against the call JUNO authorized (plan item 8). */
  async postToolUse(raw: unknown): Promise<{ readonly recorded: boolean }> {
    const parsed = HookInput.safeParse(raw);
    if (!parsed.success || parsed.data.hook_event_name === "PreToolUse") return { recorded: false };
    const input = parsed.data;
    const id = `session-${input.session_id}`;
    const session = this.#sessions.get(id);
    if (session === undefined) return { recorded: false };
    const key = input.tool_use_id ?? "";
    const call = session.pending.get(key);
    session.pending.delete(key);
    // §4.3: a tool result is untrusted content; it raises the session's floor by what it read (§1.2).
    // A result with no call JUNO authorized is classified as that tool's result: the highest declared class unless a
    // declared `tool_result` source names that tool, which admission allows only for a tool outside the table (§1.5;
    // D-150, D-162, D-164).
    const reads = call?.reads ?? (await this.#classify(session, [{ kind: "tool_result", tool: input.tool_name }]));
    session.floor = maxSensitivity(session.floor, reads);
    const dataClass: DataClass = { sensitivity: reads, integrity: "untrusted" };
    this.#append(id, "capability_result", dataClass, HARNESS_ACTOR, {
      call_seq: call?.call_seq ?? null,
      tool_use_id: input.tool_use_id ?? null,
      tool: input.tool_name,
      outcome: input.hook_event_name === "PostToolUse" ? "succeeded" : "failed",
      // A result with no call JUNO authorized is recorded as such: the harness acted without a decision from JUNO.
      ...(call === undefined ? { without_authorized_call: true } : {}),
      // A call the hook passed to JUNO's gateway, which judged it there (D-190).
      ...(call?.gateway === true ? { judged_by: "gateway" } : {}),
      response: input.hook_event_name === "PostToolUse" ? (input.tool_response ?? null) : (input.error ?? null),
    });
    return { recorded: true };
  }

  #registryFor(request: z.output<typeof SessionRequest>): { registry: CapabilityRegistry; boundary: EnforcementBoundary } {
    const registry = new CapabilityRegistry();
    for (const file of readdirSync(DEFINITIONS_DIR).filter((name) => name.endsWith(".json")).sort()) {
      const result = registry.register(loadRegistryEntry(DEFINITIONS_DIR + file), [harnessAdapter]);
      if (!result.registered) throw new Error(`${file} did not register: ${JSON.stringify(result.refusals)}`);
    }
    // §2.3.2 V6-10: each member's effect is declared per program; registration review refuses a member declared lower than
    // what its program can do, or a program whose effect is not on the operator's list (D-146).
    const known = ProgramsFile.parse(JSON.parse(readFileSync(fileURLToPath(new URL("../definitions/programs.json", import.meta.url)), "utf8"))).programs;
    const shellRun = JSON.parse(readFileSync(fileURLToPath(new URL("../../registry/definitions/shell.run.json", import.meta.url)), "utf8")) as { program_surfaces: { program: string }[] };
    const byEffect = new Map<SideEffect, Set<string>>();
    for (const entry of request.name_map) {
      const program = known.find((candidate) => candidate.program === entry.program);
      if (program === undefined) throw new Error(`registration review: ${entry.program} is not on the operator's list of programs and their effects (D-146)`);
      if (EFFECT_RANK[entry.side_effect] < EFFECT_RANK[program.minimum_effect]) {
        throw new Error(`registration review: ${entry.name} is declared ${entry.side_effect}, lower than what ${entry.program} can do (${program.minimum_effect}) (§2.3.2 V6-10)`);
      }
      byEffect.set(entry.side_effect, (byEffect.get(entry.side_effect) ?? new Set()).add(entry.program));
    }
    for (const [effect, members] of byEffect) {
      const programs = [...members].sort();
      const surfaces = programs.map((program) => {
        const declared = known.find((candidate) => candidate.program === program)?.surface;
        return declared === "shell.run" ? shellRun.program_surfaces.find((surface) => surface.program === program) : declared;
      });
      // §2.3.2: in hook mode only, a program enum that passes the interpreter test for every member takes floor `untrusted`.
      // One capability per declared effect, so a call takes the effect of the member it runs (V6-10).
      const entry = RegistryEntry.parse({
        capability: {
          id: `cc.bash.${effect}`,
          interface: {
            program: { type: { kind: "enum", values: programs } },
            argv: { type: { kind: "list", items: { kind: "string" } }, role: "data", data_effect: "target" },
            cwd: { type: { kind: "path" }, role: "data", data_effect: "target" },
          },
          providers: [HARNESS_ADAPTER],
          side_effect: effect,
          isolation_tier: 1,
          max_input_sensitivity: "internal",
          min_argument_integrity: "untrusted",
          output_class: { sensitivity: "input", integrity: "untrusted" },
          cost_model: { expected_cost: 0, expected_latency_ms: 1000, cost_of_failure: 0 },
        },
        program_field: "program",
        argv_field: "argv",
        cwd_field: "cwd",
        program_surfaces: surfaces.filter((surface) => surface !== undefined),
      });
      const result = registry.register(entry, [harnessAdapter]);
      if (!result.registered) throw new Error(`the Bash name map did not pass registration review: ${JSON.stringify(result.refusals)}`);
    }
    return { registry, boundary: this.#layer.boundary(registry, this.#grants, this.#clock) };
  }

  /** Maps a tool call onto a capability proposal (D-141). Every model-written value is synthesized, so `untrusted`. */
  async #map(session: Session, input: HookInput): Promise<Mapped> {
    const tool = TOOLS[input.tool_name];
    if (tool === undefined) return { kind: "reject", reason: "unknown_capability" };
    for (const key of Object.keys(input.tool_input)) {
      if (!tool.fields.includes(key)) return { kind: "reject", reason: `malformed_call: ${input.tool_name} field ${key} is not one JUNO knows` };
    }
    const value = (key: string): unknown => input.tool_input[key];
    const path = (key: string, fallback?: string): string | null => {
      const given = value(key) ?? fallback;
      return typeof given === "string" ? this.#paths.toWork(given) : null;
    };
    const synthesized = (v: unknown): unknown => ({ class: "synthesized", value: v });
    const outside = (key: string): Mapped => ({ kind: "park", reason: "scope_violation", detail: { tool: input.tool_name, field: key, outside_workspace: true }, overridable: false });
    // D-173: Claude Code is governed only inside WSL2; a Windows-form path anywhere a path is named is refused, fail-closed,
    // before it is mapped, with a reason that says so. Never overridable: no remedy makes a Windows path a Linux one.
    const windows = (key: string, given: unknown): Mapped | null => {
      const why = typeof given === "string" ? windowsFormReason(given) : null;
      return why === null ? null : { kind: "park", reason: "scope_violation", detail: { tool: input.tool_name, field: key, windows_path: true, why: windowsFormRefusal(key, why) }, overridable: false };
    };
    for (const key of ["file_path", "path", "pattern"]) {
      const refused = windows(key, value(key));
      if (refused !== null) return refused;
    }
    const refusedCwd = windows("cwd", input.cwd);
    if (refusedCwd !== null) return refusedCwd;
    switch (tool.capability) {
      case "cc.read": {
        const filePath = path("file_path");
        if (filePath === null) return outside("file_path");
        return proposal("cc.read", { file_path: synthesized(filePath), offset: synthesized(numberOr(value("offset"))), limit: synthesized(numberOr(value("limit"))) });
      }
      case "cc.write":
      case "cc.edit": {
        const filePath = path("file_path");
        if (filePath === null) return outside("file_path");
        const args: Record<string, unknown> = { file_path: synthesized(filePath) };
        for (const key of tool.fields.slice(1)) args[key] = synthesized(key === "replace_all" ? value(key) === true : String(value(key) ?? ""));
        return proposal(tool.capability, args);
      }
      case "cc.glob": {
        const pattern = value("pattern");
        if (typeof pattern !== "string" || pattern.startsWith("/") || pattern.startsWith("~") || pattern.split(/[\\/]/).includes("..")) {
          return { kind: "reject", reason: "malformed_call: a Glob pattern must be relative and hold no .." };
        }
        const where = path("path", input.cwd);
        if (where === null) return outside("path");
        return proposal("cc.glob", { path: synthesized(where), pattern: synthesized(pattern) });
      }
      case "cc.webfetch":
        return proposal("cc.webfetch", { url: synthesized(String(value("url") ?? "")), prompt: synthesized(String(value("prompt") ?? "")) });
      default: {
        const command = value("command");
        if (typeof command !== "string") return { kind: "reject", reason: "malformed_call: Bash without a command" };
        const map = new Map(session.request.name_map.map((entry) => [entry.name, entry.program]));
        const reading = readCommandString(command, map);
        if (!reading.ok) return { kind: "park", reason: "integrity_floor", detail: { tool: "Bash", command, why: reading.reason }, overridable: false };
        // D-152: the other fields are passed on to Claude Code as given, so each must have the type Claude Code expects.
        const fields = BashFields.safeParse(input.tool_input);
        if (!fields.success) return { kind: "reject", reason: "malformed_call: a Bash field has the wrong type" };
        // D-152: the command that will run is rebuilt from the judged program and argv; one that cannot be is never allowed.
        const rebuilt = rebuildBashCommand(reading.program, reading.argv);
        if (rebuilt === null) return { kind: "reject", reason: "malformed_call: the command cannot be rebuilt exactly as judged" };
        const cwd = input.cwd === undefined ? null : this.#paths.toWork(input.cwd);
        if (cwd === null) return outside("cwd");
        // Every absolute operand is a host path, like a Read's file_path: it is mapped onto /work through the workspace roots,
        // so the boundary judges the file the harness will act on. One that maps nowhere is outside every scope (D-147).
        const argv: string[] = [];
        for (const element of reading.argv) {
          // D-173: every operand, absolute or not (`C:x`, `C:/x`, a single-quoted `'a\\b'`).
          const refusedOperand = windows("argv", element);
          if (refusedOperand !== null) return refusedOperand;
          if (!element.startsWith("/")) {
            argv.push(element);
            continue;
          }
          const mappedOperand = this.#paths.toWork(element);
          if (mappedOperand === null) return outside("argv");
          argv.push(mappedOperand);
        }
        // §4.3: a command string the operator listed is `constant`, as written; anything else is the model's.
        const listed = session.request.commands.includes(command);
        const constants: Record<string, { value: string; data_class: DataClass }> = {};
        const operator: DataClass = { sensitivity: "internal", integrity: "operator" };
        const word = (slot: string, text: string): unknown => {
          if (!listed) return synthesized(text);
          constants[slot] = { value: text, data_class: operator };
          return { class: "constant", slot };
        };
        const args = {
          program: word("command.program", reading.program),
          argv: argv.map((element, index) => word(`command.argv.${String(index)}`, element)),
          cwd: synthesized(cwd),
        };
        const member = session.request.name_map.find((entry) => entry.name === reading.name);
        return {
          kind: "proposal",
          proposal: { capability: `cc.bash.${member?.side_effect ?? "irreversible"}`, arguments: args },
          constants,
          bash: { ...fields.data, command: rebuilt },
        };
      }
    }
  }

  /** What a session's call reads, classified by the one classification function (D-162). */
  #classify(session: Session, targets: readonly ReadTarget[]): Promise<Sensitivity> {
    return classifyRead(targets, { sources: session.request.sources, resolver: this.#resolver, view: this.#view });
  }

  /**
   * An MCP call (D-190): "no decision" only for the gateway's own tool, from the server the managed MCP file defines, so
   * the gateway judges it at its boundary and journals it; every other MCP call is `unknown_capability`, as any tool
   * outside the table. The passed call is recorded here too, and its result, when it comes, is classified as that
   * tool's result (D-164).
   */
  async #mcp(session: Session, input: HookInput): Promise<HookDecision> {
    const gateway = this.#gateway;
    const server = input.mcp_server;
    if (gateway === undefined || !input.tool_name.startsWith(`mcp__${gateway}__`) || server?.name !== gateway || server.source !== "enterprise") {
      return this.#reject(session, "unknown_capability", input.tool_name);
    }
    // Restrictive (D-192): the hook does not know whether the gateway will reject this call, so passing it on does not
    // clear the session's count of consecutive rejections (§2.7.1 A4); the gateway keeps its own count.
    const reads = await this.#classify(session, [{ kind: "tool_result", tool: input.tool_name }]);
    const seq = this.#append(session.task.id, "note", this.#class(session), SESSION_ACTOR, { type: "gateway_call", tool: input.tool_name, tool_use_id: input.tool_use_id ?? null, mcp_server: server, judged_by: "gateway", reads });
    session.pending.set(input.tool_use_id ?? `gateway-${String(seq)}`, { call_seq: null, reads, gateway: true });
    return { decision: "none" };
  }

  /** A rejection; §2.7.1 A4: the shared layer counts it and parks `rejection_limit` at the limit (per session in hook mode). */
  #reject(session: Session, reason: string, tool: string, callSeq?: number): HookDecision {
    const seq = callSeq ?? this.#append(session.task.id, "note", this.#class(session), SESSION_ACTOR, { type: "rejection", tool, reason });
    if (session.governed.reject({ kind: "call", seq }, () => session.governed.park("rejection_limit", true, this.#class(session), SESSION_ACTOR, { tool, last: reason })).parked) return deny(parkText("rejection_limit", "", true));
    return deny(`JUNO rejected this ${tool} call: ${reason}`);
  }

  /** §4.3 V6-3: a park denies the call with its reason and is journalled by the shared layer; the remedy applies to the retry. */
  #park(session: Session, reason: string, detail: Record<string, unknown>, overridable: boolean): HookDecision {
    const parked = session.governed.park(reason, overridable, this.#class(session), SESSION_ACTOR, detail);
    const why = typeof detail["why"] === "string" && detail["windows_path"] === true ? ` ${detail["why"]}.` : "";
    return deny(parkText(reason, why, parked.overridable));
  }

  /** An injected Bash command from a session whose admission was refused: recorded against it, never overridable (D-152). */
  #parkRefused(taskId: string, detail: Record<string, unknown>): HookDecision {
    this.#layer.append(taskId, "park", REFUSED_ADMISSION_CLASS, { reason: "integrity_floor", overridable: false, mode: "hook", answer: "deny", admitted: false, ...detail }, { actor: SESSION_ACTOR });
    return deny("JUNO parked this call: integrity_floor. This cannot be overridden (§8.3).");
  }

  /** §3.4.1 (D-198): a session whose head cannot be anchored stops for good, journalled; every later call is denied. */
  #stopForAnchor(session: Session): void {
    if (session.task.state === "failed") return;
    session.task = Task.parse({ ...session.task, state: "failed", runtime_substate: null });
    this.#append(session.task.id, "note", this.#class(session), SESSION_ACTOR, { type: "state", to: "failed", reason: "anchor_unavailable" });
  }

  /** The shared session layer this service admits and journals through (D-194). */
  get layer(): SessionLayer {
    return this.#layer;
  }

  #class(session: Session): DataClass {
    return { sensitivity: maxSensitivity("internal", session.floor), integrity: "derived" };
  }

  /** Journals through the shared session layer (D-194). */
  #append(taskId: string, kind: "note" | "capability_result", dataClass: DataClass, actor: string, payload: unknown): number {
    return this.#layer.append(taskId, kind, dataClass, payload, { actor, provider: kind === "capability_result" ? HARNESS_ADAPTER : null });
  }
}

type Mapped =
  | {
      readonly kind: "proposal";
      readonly proposal: { readonly capability: string; readonly arguments: Readonly<Record<string, unknown>> };
      readonly constants: TaskContext["constants"];
      /** For Bash only: the whole tool input Claude Code is to run, with the rebuilt command (D-152). */
      readonly bash?: Readonly<Record<string, unknown>> & { readonly command: string };
    }
  | { readonly kind: "reject"; readonly reason: string }
  | { readonly kind: "park"; readonly reason: string; readonly detail: Record<string, unknown>; readonly overridable: boolean };

/** §2.7.1 A4, §4.3, §6.4: a hook session's limits, the same at admission and when it is rebuilt from its journal (D-201). */
function hookLimits(request: z.output<typeof SessionRequest>, budget: z.infer<typeof Task>["budget"]): SessionLimits {
  return { rejection_limit: request.rejection_limit, ttl: request.ttl, budget, metered: ["turns", "wall_clock_ms"], clock: "from_admission", park_fields: { mode: "hook", answer: "deny" } };
}

function parkText(reason: string, why: string, overridable: boolean): string {
  return `JUNO parked this call: ${reason}.${why} ${overridable ? "The operator may remedy it, and the call can then be retried." : "This cannot be overridden (§8.3)."}`;
}

function proposal(capability: string, args: Record<string, unknown>): Mapped {
  return { kind: "proposal", proposal: { capability, arguments: args }, constants: {} };
}

/**
 * The value JUNO judged for one proposal field: a synthesized value as written, an operator constant from its slot, a
 * list element by element. Anything else is `undefined`, which the tool table reads as an `unknown` read (D-162).
 */
function judgedValue(args: Readonly<Record<string, unknown>>, constants: TaskContext["constants"]): (field: string) => unknown {
  const one = (arg: unknown): unknown => {
    if (Array.isArray(arg)) return arg.map(one);
    if (typeof arg !== "object" || arg === null) return undefined;
    const tagged = arg as { class?: unknown; value?: unknown; slot?: unknown };
    if (tagged.class === "synthesized") return tagged.value;
    if (tagged.class === "constant" && typeof tagged.slot === "string") return constants[tagged.slot]?.value;
    return undefined;
  };
  return (field) => one(args[field]);
}

function numberOr(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

function deny(reason: string): HookDecision {
  return { decision: "deny", reason };
}
