import { z } from "zod";
import { type DataClass, type Sensitivity, Task, maxSensitivity, pathWithin } from "../../contracts/src/index.js";
import { type CanonicalPaths, type EnforcementBoundary, type GovernedSession, type GrantStore, type PathResolver, REFUSED_ADMISSION_CLASS, SessionLayer, type SessionLimits, type TaskContext, type Verdict, type Workspace } from "../../enforcement/src/index.js";
import { canonicalJson } from "../../journal/src/index.js";
import { type Adapter, type CapabilityCall, CapabilityRegistry, RegistryEntry } from "../../registry/src/index.js";
import { type FilesystemIo, caseFoldingRefusals } from "./filesystem.js";
import { DeclaredSource, type ReadTarget, classifyRead } from "./reads.js";

/**
 * Mediated mode B: an MCP gateway (spec §4.3 mode B, §2.3.2, §7.8 E2, §2.2.2; build plan Slice 1.5 Increment 5).
 *
 * JUNO stands between an MCP client (Claude Code) and one operator-configured upstream MCP server. Every `tools/call` is
 * mapped to the operator's capability definition for that tool and judged by the same enforcement boundary and journal
 * as JUNO's own loop. Every value the model wrote is `untrusted`; a value the operator listed for that field is a
 * `constant`. Proceed forwards the call; park or reject answers the client with a tool result carrying `isError: true`
 * and the reason (MCP has no defer), journalled; the remedy applies to the retry. A response is untrusted content and
 * raises the session's floor by what the call read (§1.2). Anything the gateway cannot read, any protocol revision but
 * the one observed from Claude Code (D-185), any server-to-client request and any multi-round-trip answer is an error to
 * the client, never a forwarded call (fail-closed).
 */

/** The one MCP revision the gateway speaks, observed from Claude Code 2.1.319 and the test server (D-185). */
export const MCP_REVISION = "2025-11-25";

export const GATEWAY_ADAPTER = "gateway.mcp";
const GATEWAY_ACTOR = "juno.gateway";
const UPSTREAM_ACTOR = "mcp.upstream";

/** The upstream server performs every effect, so the adapter's plan is never run; it shows each value is discrete (§2.4). */
export const gatewayAdapter: Adapter = {
  id: GATEWAY_ADAPTER,
  plan: (call: CapabilityCall) => ({
    file: "mcp-upstream",
    args: ["--", ...Object.keys(call).sort().flatMap((name) => {
      const value = call[name];
      if (Array.isArray(value)) return value.map(String);
      if (typeof value === "object" && value !== null) return Object.values(value).map(String);
      return [String(value)];
    })],
  }),
};

/** One upstream tool the operator defined (§2.5): its MCP name, its capability, what it reads, and the values the operator lists. */
export const GatewayTool = z.strictObject({
  tool: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/),
  entry: z.unknown(),
  /** The path field whose tree the call reads; absent: what it returns is classified at the highest declared class. */
  reads: z.string().optional(),
  /** Exact values the operator lists for a field: a call carrying one passes it as a `constant` (§4.3). */
  constants: z.record(z.string(), z.array(z.union([z.string(), z.number(), z.boolean()])).max(64)).default({}),
});

/** What the operator declares to admit one gateway session (§4.3 V6-6), as mode C's request without Claude Code's parts. */
export const GatewaySessionRequest = z.strictObject({
  session_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  principal: z.string().min(1),
  attendance: z.enum(["gated", "autonomous"]),
  ttl: z.int().positive(),
  grants: z.array(z.string()).min(1),
  budget: z.strictObject({ tool_calls: z.int().positive(), wall_clock_ms: z.int().positive() }),
  /** §4.3: tokens and currency are not measured by JUNO in mediated modes; the operator must accept that. */
  unmetered_accepted: z.literal(true),
  provider_clearance: z.enum(["public", "internal", "confidential", "secret"]),
  sources: z.array(DeclaredSource).min(1),
  tools: z.array(GatewayTool).max(256),
  /** §2.7.1 A4: consecutive rejections that park `rejection_limit`; per session in gateway mode, as in hook mode. */
  rejection_limit: z.int().min(1).max(10).default(3),
});
export type GatewaySessionRequest = z.input<typeof GatewaySessionRequest>;

/** The upstream MCP server, as the gateway reaches it. */
export interface Upstream {
  /** Sends a request and waits for its answer; an upstream that cannot answer rejects. */
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  close(): void;
}

const JsonRpcId = z.union([z.string().max(256), z.int()]);
const ClientMessage = z.object({ jsonrpc: z.literal("2.0"), id: JsonRpcId.optional(), method: z.string(), params: z.unknown().optional() });
const InitializeParams = z.object({ protocolVersion: z.string() }).passthrough();
const CallParams = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() }).passthrough();
const ToolList = z.object({ tools: z.array(z.object({ name: z.string() }).passthrough()) }).passthrough();
const ContentItem = z.object({ type: z.string() }).passthrough();
const CallResult = z.object({ content: z.array(ContentItem), isError: z.boolean().optional() }).passthrough();
const UpstreamInit = z.object({ protocolVersion: z.string(), capabilities: z.object({ tools: z.unknown() }).passthrough() }).passthrough();

type Reply = { readonly jsonrpc: "2.0"; readonly id: string | number; readonly result?: unknown; readonly error?: { readonly code: number; readonly message: string } };

export type GatewayOptions = {
  /**
   * The shared session layer (D-193, D-194), opened by the shared start-up check for the gateway service: it holds the
   * journal, and every admission, call, rejection, budget and park of the gateway's session goes through it. Its
   * workspaces must include the folder the upstream's paths name (`view`'s root), so JUNO's state was judged against it.
   */
  readonly layer: SessionLayer;
  readonly grants: GrantStore;
  readonly resolver: PathResolver;
  readonly view: Workspace;
  readonly filesystem: FilesystemIo;
  /** Starts the upstream; `refused` is called for each request the upstream sent the client, which the gateway refuses (D-186). */
  readonly upstream: (refused: (method: string) => void) => Upstream;
  readonly clock?: () => Date;
};

export class GatewayError extends Error {
  override readonly name = "GatewayError";
}

/** A gateway session: one admitted Task, one upstream, one client (§4.3 V6-6). */
export class McpGateway {
  readonly #options: GatewayOptions;
  readonly #clock: () => Date;
  #request: z.output<typeof GatewaySessionRequest> | null = null;
  #task: z.infer<typeof Task> | null = null;
  #boundary: EnforcementBoundary | null = null;
  #tools = new Map<string, { readonly capability: string; readonly reads: string | undefined; readonly constants: Readonly<Record<string, readonly (string | number | boolean)[]>> }>();
  #upstream: Upstream | null = null;
  #initialized = false;
  #session: GovernedSession | null = null;
  #floor: Sensitivity = "public";
  readonly #layer: SessionLayer;

  constructor(options: GatewayOptions) {
    // D-194: only through the shared session layer, whose start-up check judged JUNO's state against this workspace
    // (D-148 for mode B, D-192), and whose verified anchor the grant store checks against.
    this.#layer = SessionLayer.require(options.layer, "gateway");
    this.#layer.requireWorkspace("the gateway's workspace", options.view.viewRoot);
    this.#layer.requireGrants(options.grants);
    this.#options = options;
    this.#clock = options.clock ?? (() => new Date());
  }

  /** The shared session layer this gateway admits and journals through (D-194). */
  get layer(): SessionLayer {
    return this.#layer;
  }

  get taskId(): string | null {
    return this.#task?.id ?? null;
  }

  task(): z.infer<typeof Task> | null {
    return this.#task;
  }

  /**
   * Admits the session as a Task (§4.3 V6-6), or says why not; a refusal is journalled at the most restrictive class.
   *
   * An id is admitted once (operator ruling D-201). When the journal already holds this id's admission (the gateway
   * was restarted), nothing is admitted again: the same session goes on exactly as its journal leaves it (`resumed`),
   * with the budget, time limit, rejections and floor it had. That needs the session file to declare the very session
   * that was admitted; a changed one is refused and needs a new `session_id`.
   */
  async admit(input: unknown): Promise<{ readonly admitted: true; readonly task_id: string; readonly resumed?: true } | { readonly admitted: false; readonly failures: readonly string[] }> {
    const parsed = GatewaySessionRequest.safeParse(input);
    if (!parsed.success) return { admitted: false, failures: [parsed.error.message] };
    const request = parsed.data;
    const id = `gateway-${request.session_id}`;
    const failures: string[] = [];
    if (this.#task !== null) failures.push("this gateway already holds a session");
    for (const grantId of request.grants) {
      const grant = this.#options.grants.signed(grantId);
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
    // D-178: the folder the upstream's paths name must be on a case-sensitive Linux file system with no folding folder.
    const viewRoot = this.#options.view.viewRoot;
    failures.push(...(await caseFoldingRefusals([
      { what: "the workspace", path: viewRoot },
      ...request.sources.flatMap((source) => (source.selector.kind === "path" ? [{ what: `source ${source.id}`, path: viewRoot + source.selector.prefix.slice("/work".length) }] : [])),
    ], this.#options.filesystem)));
    const registry = new CapabilityRegistry();
    const tools = new Map<string, { capability: string; reads: string | undefined; constants: Record<string, (string | number | boolean)[]> }>();
    for (const tool of request.tools) {
      const entry = RegistryEntry.safeParse(tool.entry);
      if (!entry.success) {
        failures.push(`tool ${tool.tool}: its capability definition is not valid: ${entry.error.message}`);
        continue;
      }
      if (tools.has(tool.tool)) failures.push(`tool ${tool.tool} is defined twice`);
      const fields = entry.data.capability.interface;
      // Typed capabilities only: a gateway tool may name no program and have no instruction field (restrictive, D-187).
      if (Object.values(fields).some((field) => field.role === "instruction")) failures.push(`tool ${tool.tool} has an instruction field; a gateway tool's fields are data only (D-187)`);
      if (tool.reads !== undefined && fields[tool.reads]?.type.kind !== "path") failures.push(`tool ${tool.tool} reads ${tool.reads}, which is not one of its path fields`);
      for (const field of Object.keys(tool.constants)) if (fields[field] === undefined) failures.push(`tool ${tool.tool} lists constants for ${field}, which it does not have`);
      const result = registry.register(entry.data, [gatewayAdapter]);
      if (!result.registered) failures.push(`tool ${tool.tool} did not pass registration review: ${JSON.stringify(result.refusals)}`);
      tools.set(tool.tool, { capability: entry.data.capability.id, reads: tool.reads, constants: tool.constants });
    }
    if (this.#task === null && this.#layer.admitted(id)) {
      // D-201: never a second admission. The record is the admitted session's, so nothing is added to it for a refusal.
      const record = this.#layer.recovered().find((candidate) => candidate.id === id);
      const admission = record?.admission ?? null;
      if (record === undefined || admission === null || admission["mode"] !== "gateway" || canonicalJson(admission["request"]) !== canonicalJson(request)) {
        failures.unshift(`the journal already holds an admission of ${id}, and this session file does not declare that same session; an id is admitted once, so a new or changed session needs a new session_id (D-201)`);
      }
      if (failures.length > 0) return { admitted: false, failures };
      let task = Task.parse(admission?.["task"]);
      let floor: Sensitivity = "public";
      for (const { entry, payload } of record?.entries ?? []) {
        if (entry.kind === "capability_result") floor = maxSensitivity(floor, entry.data_class.sensitivity);
        const state = z.object({ type: z.literal("state"), to: z.literal("failed") }).safeParse(payload);
        if (entry.kind === "note" && state.success) task = Task.parse({ ...task, state: "failed", runtime_substate: null });
        // A quarantine is permanent (§2.4, D-064): the ones this session's journal records are applied again.
        const parked = z.object({ capability: z.string(), verdict: z.object({ reason: z.literal("adapter_quarantined"), adapter: z.string(), observation: z.unknown() }) }).safeParse(payload);
        if (entry.kind === "capability_call" && parked.success) registry.quarantine({ capability: parked.data.capability, adapter: parked.data.verdict.adapter, observation: parked.data.verdict.observation as never });
      }
      const resumed = this.#layer.resume(id, gatewayLimits(request, task.budget), { now: () => this.#clock().getTime() });
      if (resumed === null) return { admitted: false, failures: [`the journal holds no admission of ${id}`] };
      this.#request = request;
      this.#task = task;
      this.#tools = tools;
      this.#floor = floor;
      this.#boundary = this.#layer.boundary(registry, this.#options.grants, this.#clock);
      this.#session = resumed.session;
      return { admitted: true, task_id: id, resumed: true };
    }
    if (failures.length > 0) {
      this.#layer.refuse(id, { mode: "gateway", failures }, GATEWAY_ACTOR);
      // §3.4.1 (D-198): a refused admission is anchored too; a failure is journalled by the layer.
      await this.#layer.anchorHead(id, REFUSED_ADMISSION_CLASS);
      return { admitted: false, failures };
    }
    const task = Task.parse({
      id,
      principal: request.principal,
      objective: "operator session via an MCP gateway",
      criterion: null,
      criterion_integrity: "operator",
      verification: null,
      closure_mode: "accepted",
      attendance: request.attendance,
      strategy: "gateway",
      sensitivity_floor: "public",
      context_ownership: "native",
      model_policy: { permitted_providers: ["mcp-client"], posture: "harness", conversation_state: "any" },
      budget: { tokens: 0, currency: 0, wall_clock_ms: request.budget.wall_clock_ms, turns: request.budget.tool_calls },
      ttl: request.ttl,
      grants: request.grants,
      parent: null,
      state: "running",
      runtime_substate: "active",
      // §7.8 E2: a gateway session cannot be steered.
      steer_capability: "none",
      trajectory: id,
    });
    this.#request = request;
    this.#task = task;
    this.#tools = tools;
    this.#boundary = this.#layer.boundary(registry, this.#options.grants, this.#clock);
    // §2.7.1 A4, §4.3: the layer owns the session's rejection limit, its budget (every call, and wall clock from admission) and its journal.
    this.#session = this.#layer.admit(id, gatewayLimits(request, task.budget), { dataClass: { sensitivity: "internal", integrity: "operator" }, now: () => this.#clock().getTime(), actor: GATEWAY_ACTOR, payload: { mode: "gateway", admitted_at: this.#clock().toISOString(), task, request, unmetered: ["tokens", "currency"] } });
    // §3.4.1 (D-198): the shared layer records the interval and anchors the admitted session's head before its first
    // call; a session whose head cannot be anchored is never run.
    if (!(await this.#session.anchor(this.#class(), { force: true }))) {
      this.#stopForAnchor();
      return { admitted: false, failures: ["the session's journal head could not be anchored off the host, so the session does not start (§3.4.1, D-198)"] };
    }
    return { admitted: true, task_id: id };
  }

  /**
   * One message from the client. Returns the reply to send, or null for a notification. Never throws: anything it cannot
   * read, or any failure upstream, is an error to the client.
   */
  async handle(raw: unknown): Promise<Reply | null> {
    const parsed = ClientMessage.safeParse(raw);
    if (!parsed.success) return { jsonrpc: "2.0", id: idOf(raw), error: { code: -32600, message: "JUNO could not read this message (§4.3 fail-closed)" } };
    const message = parsed.data;
    if (message.id === undefined) {
      if (message.method === "notifications/initialized" && this.#upstream !== null) this.#upstream.notify("notifications/initialized");
      return null;
    }
    const reply = (result: unknown): Reply => ({ jsonrpc: "2.0", id: message.id ?? 0, result });
    const error = (code: number, text: string): Reply => ({ jsonrpc: "2.0", id: message.id ?? 0, error: { code, message: text } });
    try {
      switch (message.method) {
        case "ping":
          return reply({});
        case "initialize":
          return await this.#initialize(message.params, reply, error);
        case "tools/list":
          return await this.#list(reply, error);
        case "tools/call":
          return await this.#call(message.params, reply, error);
        default:
          // D-185: only the tools of revision 2025-11-25; `server/discover` (2026-07-28) and everything else are not offered.
          return error(-32601, `JUNO's gateway does not offer ${message.method}`);
      }
    } catch (failure: unknown) {
      if (this.#task !== null) this.#append(this.#task.id, "note", this.#class(), GATEWAY_ACTOR, { type: "gateway_error", method: message.method, error: failure instanceof Error ? failure.message : String(failure) });
      return error(-32603, `JUNO's gateway could not complete ${message.method}: ${failure instanceof Error ? failure.message : String(failure)} (§4.3 fail-closed)`);
    }
  }

  close(): void {
    this.#upstream?.close();
    this.#upstream = null;
  }

  async #initialize(params: unknown, reply: (result: unknown) => Reply, error: (code: number, text: string) => Reply): Promise<Reply> {
    if (this.#task === null) return error(-32002, "this gateway has no admitted session, so no call is allowed (§4.3)");
    const asked = InitializeParams.safeParse(params);
    if (!asked.success || asked.data.protocolVersion !== MCP_REVISION) {
      return error(-32602, `JUNO's gateway speaks only MCP ${MCP_REVISION} (D-185); the client asked for ${asked.success ? asked.data.protocolVersion : "an unreadable version"}`);
    }
    if (this.#upstream === null) {
      const taskId = this.#task.id;
      this.#upstream = this.#options.upstream((method) => {
        this.#append(taskId, "note", this.#class(), GATEWAY_ACTOR, { type: "server_request_refused", method, why: "the gateway forwards no request from the server to the client (D-186)" });
      });
    }
    const answer = UpstreamInit.safeParse(await this.#upstream.request("initialize", { protocolVersion: MCP_REVISION, capabilities: {}, clientInfo: { name: "juno-gateway", version: "1" } }));
    if (!answer.success || answer.data.protocolVersion !== MCP_REVISION) {
      this.close();
      throw new GatewayError(`the upstream server did not answer MCP ${MCP_REVISION} (D-185)`);
    }
    this.#upstream.notify("notifications/initialized");
    this.#initialized = true;
    return reply({ protocolVersion: MCP_REVISION, capabilities: { tools: {} }, serverInfo: { name: "juno-gateway", version: "1" } });
  }

  async #list(reply: (result: unknown) => Reply, error: (code: number, text: string) => Reply): Promise<Reply> {
    if (this.#upstream === null || !this.#initialized) return error(-32002, "initialize first");
    const listed = ToolList.safeParse(await this.#upstream.request("tools/list", {}));
    if (!listed.success) throw new GatewayError("the upstream server's tool list could not be read");
    // §2.5: only tools the operator defined are offered; descriptions pass through unchanged and unprotected (§4.3 mode B).
    return reply({ tools: listed.data.tools.filter((tool) => this.#tools.has(tool.name)) });
  }

  async #call(params: unknown, reply: (result: unknown) => Reply, error: (code: number, text: string) => Reply): Promise<Reply> {
    const task = this.#task;
    const request = this.#request;
    const boundary = this.#boundary;
    const session = this.#session;
    if (task === null || request === null || boundary === null || session === null) return error(-32002, "this gateway has no admitted session, so no call is allowed (§4.3)");
    if (this.#upstream === null || !this.#initialized) return error(-32002, "initialize first");
    const asked = CallParams.safeParse(params);
    if (!asked.success) return error(-32602, "JUNO could not read this tool call (§4.3 fail-closed)");
    const toolName = asked.data.name;
    const args = asked.data.arguments ?? {};
    const tool = this.#tools.get(toolName);
    const denied = (text: string): Reply => reply({ content: [{ type: "text", text }], isError: true });
    if (task.state !== "running") return denied(`this session is ${task.state}; no call is allowed`);
    // §6.4 and §4.3, in the shared layer: TTL, then the budget, then the call is counted, so every call counts, a call
    // to a tool the operator did not define included (D-192, D-194).
    const started = await session.beginCall(this.#class(), GATEWAY_ACTOR, { tool: toolName });
    if (!started.ok && started.reason === "anchor_unavailable") {
      this.#stopForAnchor();
      return denied("JUNO could not copy this session's journal head off the host, so the session has stopped (§3.4.1)");
    }
    if (!started.ok && started.reason === "ttl_expired") {
      this.#task = Task.parse({ ...task, state: "failed", runtime_substate: null });
      this.#append(task.id, "note", this.#class(), GATEWAY_ACTOR, { type: "state", to: "failed", reason: "ttl_expired" });
      return denied("the session's time to live has expired (§6.4)");
    }
    if (!started.ok) return denied(parkText("budget_exceeded", true));
    // §2.5: a tool the operator did not define is a rejection, journalled, never forwarded.
    if (tool === undefined) return this.#reject(session, "unknown_capability", toolName, undefined, `${toolName} is not a tool the operator defined (§2.5)`, denied);

    // Every model-written value is synthesized (untrusted); a value the operator listed for that field is a constant.
    const constants: Record<string, { value: string | number | boolean; data_class: DataClass }> = {};
    const proposalArgs: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(args)) {
      const listed = tool.constants[field];
      if (listed !== undefined && (typeof value === "string" || typeof value === "number" || typeof value === "boolean") && listed.includes(value)) {
        const slot = `${toolName}.${field}`;
        constants[slot] = { value, data_class: { sensitivity: "internal", integrity: "operator" } };
        proposalArgs[field] = { class: "constant", slot };
      } else proposalArgs[field] = { class: "synthesized", value };
    }
    const proposal = { capability: tool.capability, arguments: proposalArgs };
    // §4.3 V6-7: what the call reads, classified before it is forwarded; the boundary judges it at step 5.
    const readValue = tool.reads === undefined ? undefined : args[tool.reads];
    const targets: ReadTarget[] = tool.reads === undefined ? [{ kind: "tool_result", tool: `mcp.${toolName}` }] : typeof readValue === "string" ? [{ kind: "tree", path: readValue }] : [{ kind: "unknown", why: `${tool.reads} is not a path` }];
    const reads = await classifyRead(targets, { sources: request.sources, resolver: this.#options.resolver, view: this.#options.view });
    const base: TaskContext = { task: { ...task, sensitivity_floor: this.#floor }, constants, synthesis: { sensitivity: this.#floor }, reversible: [], readGate: { reads, clearance: request.provider_clearance } };
    const canonical: CanonicalPaths = await this.#options.resolver.resolve(boundary.pathsToResolve(base, proposal));
    const verdict: Verdict = boundary.authorize({ ...base, canonical }, proposal);
    if (verdict.outcome === "reject") return this.#reject(session, verdict.detail.reason, toolName, verdict.call_seq, verdict.detail.reason, denied);
    if (verdict.outcome === "park") {
      // §8.2: a park whose only remedy is a grant is not overridden; the layer applies §8.3's never-overridable reasons.
      const grantOnly = verdict.detail.reason === "scope_violation" && verdict.detail.untrusted.length > 0;
      const parked = session.park(verdict.detail.reason, !grantOnly, this.#class(), GATEWAY_ACTOR, { call_seq: verdict.call_seq, tool: toolName, detail: verdict.detail });
      return denied(parkText(verdict.detail.reason, parked.overridable));
    }
    session.clearRejections();
    // Proceed: forwarded exactly as judged, the boundary's own copy of the call and nothing the client sent (D-053, D-195).
    // The response is untrusted content at the class of what the call read (§1.2).
    const answered = await this.#upstream.request("tools/call", { name: toolName, arguments: structuredClone(verdict.authorization.call) });
    const result = CallResult.safeParse(answered);
    const multiRound = typeof answered === "object" && answered !== null && ["input_required", "inputRequired", "inputRequests"].some((key) => Object.hasOwn(answered, key));
    this.#floor = maxSensitivity(this.#floor, reads);
    const recorded: DataClass = { sensitivity: reads, integrity: "untrusted" };
    if (multiRound || !result.success) {
      // D-186: a multi-round-trip (input_required) answer is refused; a malformed one is an error, never passed on.
      this.#append(task.id, "capability_result", recorded, UPSTREAM_ACTOR, { call_seq: verdict.call_seq, tool: toolName, outcome: "refused", why: multiRound ? "input_required" : "malformed", response: answered ?? null });
      throw new GatewayError(multiRound ? "the upstream server asked for more input (input_required), which Slice 1.5 refuses (D-186)" : "the upstream server's result could not be read");
    }
    this.#append(task.id, "capability_result", recorded, UPSTREAM_ACTOR, { call_seq: verdict.call_seq, tool: toolName, outcome: result.data.isError === true ? "failed" : "succeeded", response: result.data });
    return reply(result.data);
  }

  /** A rejection, journalled; §2.7.1 A4: the shared layer counts it and parks `rejection_limit` at the limit (per session in gateway mode). */
  #reject(session: GovernedSession, reason: string, tool: string, callSeq: number | undefined, why: string, denied: (text: string) => Reply): Reply {
    const seq = this.#append(session.id, "note", this.#class(), GATEWAY_ACTOR, { type: "rejection", reason, tool, ...(callSeq === undefined ? {} : { call_seq: callSeq }), mode: "gateway" });
    if (session.reject({ kind: "call", seq: callSeq ?? seq }, () => session.park("rejection_limit", true, this.#class(), GATEWAY_ACTOR, { tool, last: reason })).parked) return denied(parkText("rejection_limit", true));
    return denied(`JUNO rejected this call: ${why}`);
  }

  /** §3.4.1 (D-198): a session whose head cannot be anchored stops for good, journalled; every later call is denied. */
  #stopForAnchor(): void {
    const task = this.#task;
    if (task === null || task.state === "failed") return;
    this.#task = Task.parse({ ...task, state: "failed", runtime_substate: null });
    this.#append(task.id, "note", this.#class(), GATEWAY_ACTOR, { type: "state", to: "failed", reason: "anchor_unavailable" });
  }

  #class(): DataClass {
    return { sensitivity: maxSensitivity("internal", this.#floor), integrity: "derived" };
  }

  /** Journals through the shared session layer (D-194). */
  #append(taskId: string, kind: "note" | "capability_result", dataClass: DataClass, actor: string, payload: unknown): number {
    return this.#layer.append(taskId, kind, dataClass, payload, { actor, provider: kind === "capability_result" ? GATEWAY_ADAPTER : null });
  }
}

/** §2.7.1 A4, §4.3, §6.4: a gateway session's limits, the same at admission and when it is rebuilt from its journal (D-201). */
function gatewayLimits(request: z.output<typeof GatewaySessionRequest>, budget: z.infer<typeof Task>["budget"]): SessionLimits {
  return { rejection_limit: request.rejection_limit, ttl: request.ttl, budget, metered: ["turns", "wall_clock_ms"], clock: "from_admission", park_fields: { mode: "gateway", answer: "isError" } };
}

/** §4.3 V6-3: a park answers with its reason; the remedy applies to the retry. */
function parkText(reason: string, overridable: boolean): string {
  return `JUNO parked this call: ${reason}. ${overridable ? "The operator may remedy it, and the call can then be retried." : "This cannot be overridden (§8.3)."}`;
}

function idOf(raw: unknown): string | number {
  if (typeof raw === "object" && raw !== null) {
    const id = (raw as { id?: unknown }).id;
    if (typeof id === "string" || (typeof id === "number" && Number.isInteger(id))) return id;
  }
  return 0;
}
