import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  type DataClass,
  Integrity as IntegritySchema,
  Ref,
  ResourceSelector,
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
  EnforcementBoundary,
  type Workspace,
  checkpointId,
  operandPath,
  type GrantStore,
  type PathResolver,
  type TaskContext,
  type Verdict,
  readCommandString,
} from "../../enforcement/src/index.js";
import { type JournalWriter, canonicalJson } from "../../journal/src/index.js";
import { type Adapter, type CapabilityCall, CapabilityRegistry, RegistryEntry, loadRegistryEntry } from "../../registry/src/index.js";
import { rebuildBashCommand } from "./rebuild.js";

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
const NO_COST = { tokens_in: 0, tokens_out: 0, tokens_cached: 0, currency: 0, duration_ms: 0 };
const encoder = new TextEncoder();

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
  sources: z.array(z.strictObject({ id: Ref, selector: ResourceSelector, data_class: z.strictObject({ sensitivity: SensitivitySchema, integrity: IntegritySchema }) })).min(1),
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

/** Maps the operator's workspace root, in each spelling the harness may use, onto the capability namespace (D-141). */
export class PathMap {
  readonly #roots: readonly string[];

  constructor(roots: readonly string[]) {
    this.#roots = roots.map((root) => root.replace(/[\\/]+$/, ""));
  }

  /** The path under `/work`, or null when it lies under no configured root (then it is outside every scope). */
  toWork(path: string): string | null {
    for (const root of this.#roots) {
      const windows = root.includes("\\") || /^[A-Za-z]:/.test(root);
      const candidate = windows ? path.replace(/\//g, "\\") : path;
      const sameRoot = windows ? candidate.toLowerCase().startsWith(root.toLowerCase()) : candidate.startsWith(root);
      if (!sameRoot) continue;
      const rest = candidate.slice(root.length);
      if (rest !== "" && !rest.startsWith(windows ? "\\" : "/")) continue;
      const mapped = "/work" + rest.replace(/\\/g, "/");
      return mapped === "/work/" ? "/work" : mapped;
    }
    return null;
  }
}

type Session = {
  task: z.infer<typeof Task>;
  readonly request: z.output<typeof SessionRequest>;
  readonly admittedAt: number;
  calls: number;
  rejections: number;
  floor: Sensitivity;
  /** Calls authorized and not yet reported by PostToolUse: tool_use_id → call_seq and the sensitivity of what it reads. */
  readonly pending: Map<string, { readonly call_seq: number; readonly reads: Sensitivity }>;
  /** The session's checkpointed workspaces: the only reversible ones (§2.2.2, D-135). */
  readonly reversible: readonly string[];
};

export type MediatedOptions = {
  readonly journal: JournalWriter;
  readonly grants: GrantStore;
  readonly paths: PathMap;
  readonly resolver: PathResolver;
  readonly clock?: () => Date;
  /** Where the host workspace is checkpointed (the same scripts, run on the host) and the store for its content (D-136). */
  readonly checkpoints?: { readonly workspace: Workspace; readonly store: CheckpointStore };
  /**
   * JUNO's own state on the host, which no tool call may reach (plan Increment 4 item 10; §3.2 "No selector may name
   * journal storage"; D-148): the checkpoint store, the trust anchor, the hook's socket directory, Claude Code's settings
   * files. The journal's root is always included. Each must lie under no workspace root, in any spelling the map knows,
   * or the sessions refuse to start.
   */
  readonly protectedPaths: readonly string[];
};

export class MediatedError extends Error {
  override readonly name = "MediatedError";
}

/** Unknown tool → no capability; known tools map their input fields onto the capability's interface (D-141). */
const TOOLS: Readonly<Record<string, { readonly capability: string; readonly fields: readonly string[] }>> = {
  Read: { capability: "cc.read", fields: ["file_path", "offset", "limit"] },
  Glob: { capability: "cc.glob", fields: ["pattern", "path"] },
  Write: { capability: "cc.write", fields: ["file_path", "content"] },
  Edit: { capability: "cc.edit", fields: ["file_path", "old_string", "new_string", "replace_all"] },
  WebFetch: { capability: "cc.webfetch", fields: ["url", "prompt"] },
  Bash: { capability: "cc.bash", fields: ["command", "description", "timeout", "run_in_background"] },
};

export class MediatedSessions {
  readonly #journal: JournalWriter;
  readonly #grants: GrantStore;
  readonly #paths: PathMap;
  readonly #resolver: PathResolver;
  readonly #clock: () => Date;
  readonly #checkpoints: MediatedOptions["checkpoints"];
  readonly #sessions = new Map<string, Session>();
  readonly #registries = new Map<string, { registry: CapabilityRegistry; boundary: EnforcementBoundary }>();
  /** Sessions whose admission was refused and journalled: task id → the refused request's name map (D-152). */
  readonly #refused = new Map<string, ReadonlyMap<string, string>>();

  constructor(options: MediatedOptions) {
    this.#journal = options.journal;
    this.#grants = options.grants;
    this.#paths = options.paths;
    this.#resolver = options.resolver;
    this.#clock = options.clock ?? (() => new Date());
    this.#checkpoints = options.checkpoints;
    for (const path of [options.journal.root, ...options.protectedPaths]) {
      if (options.paths.toWork(path) !== null) {
        throw new MediatedError(`${path} is JUNO's own state and lies under a workspace root, so a tool call could reach it; move the workspace or the state (D-148)`);
      }
    }
  }

  /** Admits a session as a Task (§4.3 V6-6), or says why not. */
  async admit(input: unknown): Promise<{ readonly admitted: true; readonly task_id: string } | { readonly admitted: false; readonly failures: readonly string[] }> {
    const parsed = SessionRequest.safeParse(input);
    if (!parsed.success) return { admitted: false, failures: [parsed.error.message] };
    const request = parsed.data;
    const failures: string[] = [];
    const id = `session-${request.session_id}`;
    if (this.#sessions.has(id)) failures.push(`session ${request.session_id} is already admitted`);
    for (const grantId of request.grants) {
      const grant = this.#grants.signed(grantId);
      if (grant === undefined) failures.push(`grant ${grantId} does not exist or has no valid operator signature (§3.2)`);
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
      if (!this.#sessions.has(id)) {
        this.#append(id, "note", REFUSED_CLASS, SESSION_ACTOR, { type: "admission", outcome: "rejected", mode: "hook", failures });
        this.#refused.set(id, new Map(request.name_map.map((entry) => [entry.name, entry.program])));
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
    const checkpoints: { root: string; checkpoint: string; manifest: unknown }[] = [];
    for (const root of request.reversible_workspaces) {
      const resolved = (await this.#resolver.resolve([root])).get(root);
      const taken = resolved?.ok === true && resolved.canonical === root && this.#checkpoints !== undefined ? await this.#checkpoints.workspace.list(root, true) : null;
      if (taken === null || !taken.ok) return { admitted: false, failures: [`reversible workspace ${root} could not be checkpointed${taken === null ? "" : `: ${taken.reason}`}`] };
      for (const bytes of taken.snapshot.contents.values()) this.#checkpoints?.store.put(bytes);
      checkpoints.push({ root, checkpoint: checkpointId(root, taken.snapshot.manifest), manifest: taken.snapshot.manifest });
      reversible.push(root);
    }
    this.#registries.set(id, built);
    this.#refused.delete(id);
    const session: Session = { task, request, admittedAt: this.#clock().getTime(), calls: 0, rejections: 0, floor: "public", pending: new Map(), reversible };
    this.#sessions.set(id, session);
    this.#append(id, "note", { sensitivity: "internal", integrity: "operator" }, SESSION_ACTOR, {
      type: "admission",
      outcome: "admitted",
      mode: "hook",
      admitted_at: this.#clock().toISOString(),
      task,
      request,
      // §4.3: tokens and currency are not measured by JUNO; the operator accepted the harness's limits.
      unmetered: ["tokens", "currency"],
    });
    for (const checkpoint of checkpoints) this.#append(id, "note", { sensitivity: "internal", integrity: "derived" }, SESSION_ACTOR, { type: "checkpoint", ...checkpoint });
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
    if (session === undefined || built === undefined) return deny("this Claude Code session is not admitted to JUNO, so no call is allowed (§4.3)");
    if (session.task.state !== "running") return deny(`this session is ${session.task.state}; no call is allowed`);
    const now = this.#clock().getTime();
    if (now - session.admittedAt > session.request.ttl) {
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
    if (session.calls >= session.request.budget.tool_calls || now - session.admittedAt > session.request.budget.wall_clock_ms) {
      return this.#park(session, "budget_exceeded", { tool: input.tool_name }, true);
    }
    session.calls += 1;

    const mapped = await this.#map(session, input);
    if (mapped.kind === "reject") return this.#reject(session, mapped.reason, input.tool_name);
    if (mapped.kind === "park") return this.#park(session, mapped.reason, mapped.detail, mapped.overridable);

    // §4.3 V6-7: a read of a source classified above the provider's clearance parks before it runs. The boundary judges it
    // at step 5, after integrity, scope and effects, so a park that cannot be overridden always wins (D-150).
    const reads = this.#readsSensitivity(session, mapped.paths);

    const constants = mapped.constants;
    const base: TaskContext = { task: { ...session.task, sensitivity_floor: session.floor }, constants, synthesis: { sensitivity: session.floor }, reversible: session.reversible, readGate: { reads, clearance: session.request.provider_clearance } };
    const canonical: CanonicalPaths = await this.#resolver.resolve(built.boundary.pathsToResolve(base, mapped.proposal));
    const verdict: Verdict = built.boundary.authorize({ ...base, canonical }, mapped.proposal);
    if (verdict.outcome === "proceed") {
      session.rejections = 0;
      session.pending.set(input.tool_use_id ?? `call-${String(verdict.call_seq)}`, { call_seq: verdict.call_seq, reads });
      if (mapped.bash === undefined) return { decision: "none" };
      // D-152: what runs is what was judged. The command Claude Code runs is the one rebuilt from the judged program and
      // argv, recorded against the call before it is handed out.
      this.#append(id, "note", this.#class(session), SESSION_ACTOR, { type: "updated_input", call_seq: verdict.call_seq, tool_use_id: input.tool_use_id ?? null, command: mapped.bash.command });
      return { decision: "allow", updatedInput: mapped.bash };
    }
    if (verdict.outcome === "reject") return this.#reject(session, verdict.detail.reason, input.tool_name, verdict.call_seq);
    const grantOnly = verdict.detail.reason === "scope_violation" && verdict.detail.untrusted.length > 0;
    return this.#park(session, verdict.detail.reason, { call_seq: verdict.call_seq, tool: input.tool_name, detail: verdict.detail }, !NON_OVERRIDABLE.has(verdict.detail.reason) && !grantOnly);
  }

  /** Journals a PostToolUse or PostToolUseFailure result against the call JUNO authorized (plan item 8). */
  postToolUse(raw: unknown): { readonly recorded: boolean } {
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
    // A result with no call JUNO authorized read something JUNO never classified: the highest declared class (§1.5, D-150).
    const reads = call?.reads ?? session.request.sources.reduce<Sensitivity>((high, source) => maxSensitivity(high, source.data_class.sensitivity), "public");
    session.floor = maxSensitivity(session.floor, reads);
    const dataClass: DataClass = { sensitivity: reads, integrity: "untrusted" };
    this.#append(id, "capability_result", dataClass, HARNESS_ACTOR, {
      call_seq: call?.call_seq ?? null,
      tool_use_id: input.tool_use_id ?? null,
      tool: input.tool_name,
      outcome: input.hook_event_name === "PostToolUse" ? "succeeded" : "failed",
      // A result with no call JUNO authorized is recorded as such: the harness acted without a decision from JUNO.
      ...(call === undefined ? { without_authorized_call: true } : {}),
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
    return { registry, boundary: new EnforcementBoundary({ registry, grants: this.#grants, journal: this.#journal, clock: this.#clock }) };
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
    switch (tool.capability) {
      case "cc.read": {
        const filePath = path("file_path");
        if (filePath === null) return outside("file_path");
        return proposal("cc.read", { file_path: synthesized(filePath), offset: synthesized(numberOr(value("offset"))), limit: synthesized(numberOr(value("limit"))) }, [filePath]);
      }
      case "cc.write":
      case "cc.edit": {
        const filePath = path("file_path");
        if (filePath === null) return outside("file_path");
        const args: Record<string, unknown> = { file_path: synthesized(filePath) };
        for (const key of tool.fields.slice(1)) args[key] = synthesized(key === "replace_all" ? value(key) === true : String(value(key) ?? ""));
        // §4.3 V6-7 gates reads: a Write reads nothing; an Edit reads the file it edits (D-141).
        return proposal(tool.capability, args, tool.capability === "cc.edit" ? [filePath] : []);
      }
      case "cc.glob": {
        const pattern = value("pattern");
        if (typeof pattern !== "string" || pattern.startsWith("/") || pattern.startsWith("~") || pattern.split(/[\\/]/).includes("..")) {
          return { kind: "reject", reason: "malformed_call: a Glob pattern must be relative and hold no .." };
        }
        const where = path("path", input.cwd);
        if (where === null) return outside("path");
        // A Glob lists everything under its path, so every source under it counts as read (D-141).
        return proposal("cc.glob", { path: synthesized(where), pattern: synthesized(pattern) }, [`${where}/**`]);
      }
      case "cc.webfetch":
        return proposal("cc.webfetch", { url: synthesized(String(value("url") ?? "")), prompt: synthesized(String(value("prompt") ?? "")) }, []);
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
        // What a Bash call reads is its operands, not its working directory (§4.3 V6-7).
        const member = session.request.name_map.find((entry) => entry.name === reading.name);
        return {
          kind: "proposal",
          proposal: { capability: `cc.bash.${member?.side_effect ?? "irreversible"}`, arguments: args },
          constants,
          paths: argv.map((element) => (element.startsWith("/") ? element : `${cwd}/${element}`)),
          bash: { ...fields.data, command: rebuilt },
        };
      }
    }
  }

  /**
   * The highest class of what a call reads (§4.3 V6-7): every source a read path lies in; for a tree (`<dir>/**`),
   * also every source under it. A path that names no source is read at the highest class any source declares
   * (restrictive: an unclassified read is never below the clearance by default, D-141).
   */
  #readsSensitivity(session: Session, paths: readonly string[]): Sensitivity {
    let reads: Sensitivity = "public";
    const highest = session.request.sources.reduce<Sensitivity>((high, source) => maxSensitivity(high, source.data_class.sensitivity), "public");
    for (const raw of paths) {
      const tree = raw.endsWith("/**");
      const parsed = WorkPath.safeParse(operandPath("/", tree ? raw.slice(0, -3) : raw));
      if (!parsed.success) return highest;
      let named = false;
      for (const source of session.request.sources) {
        if (source.selector.kind !== "path") continue;
        if (pathWithin(parsed.data, source.selector.prefix) || (tree && pathWithin(source.selector.prefix, parsed.data))) {
          named = true;
          reads = maxSensitivity(reads, source.data_class.sensitivity);
        }
      }
      if (!named) return highest;
    }
    return reads;
  }

  #reject(session: Session, reason: string, tool: string, callSeq?: number): HookDecision {
    session.rejections += 1;
    if (callSeq === undefined) this.#append(session.task.id, "note", this.#class(session), SESSION_ACTOR, { type: "rejection", tool, reason });
    // §2.7.1 A4: consecutive rejections park `rejection_limit` (per session in hook mode).
    if (session.rejections >= session.request.rejection_limit) {
      session.rejections = 0;
      return this.#park(session, "rejection_limit", { tool, last: reason }, true);
    }
    return deny(`JUNO rejected this ${tool} call: ${reason}`);
  }

  #park(session: Session, reason: string, detail: Record<string, unknown>, overridable: boolean): HookDecision {
    session.rejections = 0;
    // §4.3 V6-3: a park denies the call with its reason and is journalled; the remedy applies to the retry.
    this.#append(session.task.id, "park", this.#class(session), SESSION_ACTOR, { reason, overridable, mode: "hook", answer: "deny", ...detail });
    return deny(`JUNO parked this call: ${reason}. ${overridable ? "The operator may remedy it, and the call can then be retried." : "This cannot be overridden (§8.3)."}`);
  }

  /** An injected Bash command from a session whose admission was refused: recorded against it, never overridable (D-152). */
  #parkRefused(taskId: string, detail: Record<string, unknown>): HookDecision {
    this.#append(taskId, "park", REFUSED_CLASS, SESSION_ACTOR, { reason: "integrity_floor", overridable: false, mode: "hook", answer: "deny", admitted: false, ...detail });
    return deny("JUNO parked this call: integrity_floor. This cannot be overridden (§8.3).");
  }

  #class(session: Session): DataClass {
    return { sensitivity: maxSensitivity("internal", session.floor), integrity: "derived" };
  }

  #append(taskId: string, kind: "note" | "park" | "capability_result", dataClass: DataClass, actor: string, payload: unknown): number {
    return this.#journal.append(taskId, { kind, actor, provider: kind === "capability_result" ? HARNESS_ADAPTER : null, data_class: dataClass, cost: NO_COST }, encoder.encode(canonicalJson(payload))).seq;
  }
}

type Mapped =
  | {
      readonly kind: "proposal";
      readonly proposal: unknown;
      readonly constants: TaskContext["constants"];
      readonly paths: readonly string[];
      /** For Bash only: the whole tool input Claude Code is to run, with the rebuilt command (D-152). */
      readonly bash?: Readonly<Record<string, unknown>> & { readonly command: string };
    }
  | { readonly kind: "reject"; readonly reason: string }
  | { readonly kind: "park"; readonly reason: string; readonly detail: Record<string, unknown>; readonly overridable: boolean };

/** A refused admission and what is recorded against it: the most restrictive class, as mode A records one. */
const REFUSED_CLASS: DataClass = { sensitivity: "secret", integrity: "untrusted" };

/** §8.3: parks the operator can never override, as in mode A. */
const NON_OVERRIDABLE: ReadonlySet<string> = new Set(["integrity_floor", "adapter_quarantined"]);

function proposal(capability: string, args: Record<string, unknown>, paths: readonly string[]): Mapped {
  return { kind: "proposal", proposal: { capability, arguments: args }, constants: {}, paths };
}

function numberOr(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

function deny(reason: string): HookDecision {
  return { decision: "deny", reason };
}
