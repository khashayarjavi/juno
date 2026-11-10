import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { GrantStore, HostPathResolver, type SessionLayer, Workspace, execFileScript } from "../../enforcement/src/index.js";
import { MemoryAnchorSink, testJournalKey } from "../../enforcement/test/anchoring.js";
import { openTestLayer } from "../../enforcement/test/layer.js";
import { TEST_ANCHOR, signed } from "../../enforcement/test/test-keys.js";
import { type JournalKey, readPayload } from "../../journal/src/index.js";
import { systemFilesystemIo } from "../../mediated/src/filesystem.js";
import { MCP_REVISION, McpGateway, type Upstream } from "../../mediated/src/gateway.js";
import { HookAdmissionService } from "../../mediated/src/hook-admission.js";
import { MediatedSessions, PathMap } from "../../mediated/src/session.js";
import { CapabilityRegistry, loadRegistryEntry } from "../../registry/src/index.js";
import { ScriptedProvider } from "../src/provider.js";
import { Runner } from "../src/runner.js";
import { PROFILE, PROJECT_SOURCE, SHELL_RUN_FILE, hostResolver, request as taskRequest, standInAdapter, turn } from "./helpers.js";

// Operator ruling D-201 (DECISIONS.md D-202): nothing JUNO enforces is forgotten when a service restarts.
//
// The property, for each mode (JUNO's own loop, the Claude Code hook, the MCP gateway): a generated sequence of calls,
// with restarts of the service inserted at generated points, reaches exactly the same decisions and leaves exactly the
// same journal as the same sequence with no restart. A restart here is what a restart is on the operator's machine:
// everything the service held in memory is dropped (the session layer, the grant store, the sessions, the registry),
// and a new service is started on the same journal and the same anchor destination. The grants, the session's call
// budget and its rejection limit are kept small, so the generated sequences run into every limit a restart could reset:
// a grant used up (§3.2 `max_invocations`), the call budget spent (§3.1, §4.3), the rejection limit (§2.7.1 A4), a
// second admission of an id (§5), a result still awaited (plan item 8), the floor a result raised (§1.2).
//
// Both runs use the same folder, clock and ids, so the two journals must be the same entries, byte for byte.

const PRINCIPAL = "alireza";
const T0 = Date.parse("2026-11-10T09:00:00.000Z");
const BASE = join(tmpdir(), `juno-restart-property-${String(process.pid)}`);
const RUNS = 40;
/** One journal key for every run, so the two journals compared record the same key. */
const JOURNAL_KEY: JournalKey = testJournalKey();

afterAll(() => {
  rmSync(BASE, { recursive: true, force: true });
});

type World = {
  /** Starts the service on the journal as it is. The first start is on an empty journal. */
  start(): Promise<void>;
  /** Stops the service: everything it held in memory is gone. */
  stop(): Promise<void>;
  /** One call (or one operator action); answers the decision, as JSON-ready data. */
  apply(step: number): Promise<unknown>;
  layer(): SessionLayer;
};

/** A whole journal, record by record, read straight from its files: every entry as stored, with its payload. */
function journalOf(layer: SessionLayer): unknown {
  const tasks = join(layer.root, "tasks");
  return readdirSync(tasks).sort().map((digest) => {
    const file = join(tasks, digest, "entries.jsonl");
    const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line !== "") : [];
    return lines.map((line) => {
      const entry = JSON.parse(line) as { payload_ref: string };
      const blob = readPayload(layer.root, entry.payload_ref);
      return { ...entry, payload: blob.status === "present" ? (JSON.parse(new TextDecoder().decode(blob.bytes)) as unknown) : blob.status };
    });
  });
}

/** Runs `steps` on a fresh world, restarting before each step whose index is in `restarts`. Answers every decision and the journal. */
async function play(make: (dir: string, clock: { now: number }) => World, name: string, steps: readonly number[], restarts: ReadonlySet<number>): Promise<{ decisions: unknown[]; journal: unknown }> {
  const dir = join(BASE, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const clock = { now: T0 };
  const world = make(dir, clock);
  await world.start();
  const decisions: unknown[] = [];
  for (const [index, step] of steps.entries()) {
    if (restarts.has(index)) {
      await world.stop();
      await world.start();
    }
    clock.now += 1000;
    decisions.push(JSON.parse(JSON.stringify(await world.apply(step))));
  }
  const journal = journalOf(world.layer());
  await world.stop();
  rmSync(dir, { recursive: true, force: true });
  return { decisions, journal };
}

/** The property itself. */
async function sameWithAndWithoutRestarts(make: (dir: string, clock: { now: number }) => World, name: string, steps: readonly number[], restartAt: readonly number[]): Promise<void> {
  const plain = await play(make, name, steps, new Set());
  const restarted = await play(make, name, steps, new Set(restartAt.map((index) => index % (steps.length + 1))));
  expect(restarted.decisions).toEqual(plain.decisions);
  expect(restarted.journal).toEqual(plain.journal);
}

function grantRecord(id: string, capabilities: readonly string[], maxInvocations: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return signed({
    id,
    principal: PRINCIPAL,
    capability_selector: { capabilities: [...capabilities] },
    resource_scope: [{ kind: "path", prefix: "/work/project" }],
    data_class_bounds: { max_sensitivity: "secret", min_integrity: "untrusted" },
    issuance: "preissued",
    issued_by: PRINCIPAL,
    issued_at: new Date(T0 - 60_000).toISOString(),
    expires_at: new Date(T0 + 86_400_000).toISOString(),
    max_invocations: maxInvocations,
    attenuation_parent: null,
    revoked_at: null,
    ...extra,
  });
}

function workspace(dir: string): string {
  const work = join(dir, "work");
  mkdirSync(join(work, "project", "secrets"), { recursive: true });
  mkdirSync(join(work, "other"), { recursive: true });
  writeFileSync(join(work, "project", "notes.txt"), "notes\n");
  writeFileSync(join(work, "project", "done.txt"), "ok\n");
  writeFileSync(join(work, "project", "secrets", "key.txt"), "secret\n");
  writeFileSync(join(work, "other", "x.txt"), "elsewhere\n");
  return work;
}

const SOURCES = [
  { id: "project", selector: { kind: "path", prefix: "/work/project" }, data_class: { sensitivity: "internal", integrity: "untrusted" } },
  { id: "secrets", selector: { kind: "path", prefix: "/work/project/secrets" }, data_class: { sensitivity: "secret", integrity: "operator" } },
];

// ---------------------------------------------------------------------------------------------------------------------
// Mode C: the Claude Code hook.
// ---------------------------------------------------------------------------------------------------------------------

const HOOK_STEPS = 13;

function hookWorld(dir: string, clock: { now: number }): World {
  const work = workspace(dir);
  const state = join(dir, "state");
  mkdirSync(join(state, "grants"), { recursive: true, mode: 0o700 });
  // The operator's files, as `juno hook admit` reads them: one session file per session id, and the signed grants.
  // Reads may be used five times and writes twice, so a restart that forgot a grant's use would let it be used again.
  const grantFiles = [
    ["grant-read", grantRecord("grant-read", ["cc.read", "cc.glob", "cc.bash.read", "cc.webfetch"], 5)],
    ["grant-write", grantRecord("grant-write", ["cc.write", "cc.edit"], 2)],
  ].map(([id, grant]) => {
    const path = join(state, "grants", `${String(id)}.json`);
    writeFileSync(path, JSON.stringify(grant), { mode: 0o600 });
    return path;
  });
  const sessionFile = (session: string): string => {
    const path = join(state, `${session}.json`);
    writeFileSync(path, JSON.stringify({
      session: {
        session_id: session,
        principal: PRINCIPAL,
        attendance: "gated",
        ttl: 3_600_000,
        grants: ["grant-read", "grant-write"],
        budget: { tool_calls: 10, wall_clock_ms: 3_600_000 },
        unmetered_accepted: true,
        provider_clearance: "internal",
        sources: SOURCES,
        name_map: [{ name: "cat", program: "/usr/bin/cat", side_effect: "read" }],
        rejection_limit: 2,
      },
      grants: grantFiles,
    }), { mode: 0o600 });
    return path;
  };
  const files = { a: sessionFile("session-a"), b: sessionFile("session-b") };
  const sink = new MemoryAnchorSink();
  const journalKey = JOURNAL_KEY;
  let layer: SessionLayer | null = null;
  let sessions: MediatedSessions | null = null;
  let admission: HookAdmissionService | null = null;
  let uses = 0;
  let awaited: Record<string, unknown>[] = [];
  const view = (): Workspace => new Workspace(execFileScript(process.execPath, []), "/work", work);
  const pre = (session: string, tool: string, input: Record<string, unknown>): Record<string, unknown> => {
    uses += 1;
    return { session_id: session, hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: `toolu_${String(uses)}`, cwd: join(work, "project") };
  };
  const ask = async (asked: Record<string, unknown>): Promise<unknown> => {
    const decision = await sessions?.preToolUse(asked);
    // A call JUNO did not deny is one Claude Code runs; its result comes later, as its own step. When JUNO records that
    // an earlier result never came, those results are no longer awaited.
    if (decision?.decision !== "deny") awaited.push(asked);
    else if (decision.reason.includes("did not receive the result")) awaited = [];
    return decision;
  };
  return {
    layer: () => layer as SessionLayer,
    start: async () => {
      layer = await openTestLayer("hook", { journal: join(state, "journal"), workspaces: [work], state: [{ what: "the grant files", path: join(state, "grants"), kind: "dir" }], anchor: null, clock: () => new Date(clock.now), journalOptions: { clock: () => new Date(clock.now) }, anchoring: { sink, journalKey, intervalMs: 5_000 } });
      const grants = new GrantStore(TEST_ANCHOR);
      sessions = new MediatedSessions({ layer, grants, paths: new PathMap([work]), resolver: new HostPathResolver(work), view: view(), filesystem: systemFilesystemIo(), clock: () => new Date(clock.now) });
      admission = new HookAdmissionService(sessions, grants);
    },
    stop: async () => {
      await layer?.close();
      layer = null;
      sessions = null;
      admission = null;
    },
    apply: async (step) => {
      switch (step % HOOK_STEPS) {
        case 0: return admission?.admitFile(files.a);
        case 1: return admission?.admitFile(files.b);
        case 2: return ask(pre("session-a", "Read", { file_path: join(work, "project", "notes.txt") }));
        case 3: return ask(pre("session-a", "Write", { file_path: join(work, "project", "out.txt"), content: "x" }));
        case 4: return ask(pre("session-a", "Read", { file_path: join(work, "project", "secrets", "key.txt") }));
        case 5: return ask(pre("session-a", "Read", { file_path: join(work, "other", "x.txt") }));
        case 6: return ask(pre("session-a", "NotATool", { anything: 1 }));
        case 7: return ask(pre("session-a", "Bash", { command: "cat notes.txt" }));
        case 8: return ask(pre("session-a", "Bash", { command: "cat notes.txt; sh -c 'id'" }));
        case 9: return ask(pre("session-b", "Read", { file_path: join(work, "project", "notes.txt") }));
        case 10: return ask(pre("session-a", "Read", { file_path: "/etc/passwd" }));
        case 11: {
          // The result of the oldest call still awaited, as Claude Code reports it.
          const asked = awaited.shift();
          return asked === undefined ? "nothing awaited" : sessions?.postToolUse({ ...asked, hook_event_name: "PostToolUse", tool_response: { ok: true } });
        }
        default: {
          // A result JUNO authorized no call for.
          awaited = [];
          return sessions?.postToolUse({ ...pre("session-a", "Read", { file_path: join(work, "project", "notes.txt") }), hook_event_name: "PostToolUse", tool_response: { ok: true } });
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Mode B: the MCP gateway.
// ---------------------------------------------------------------------------------------------------------------------

const GATEWAY_STEPS = 7;

const gatewayCapability = (id: string, sideEffect: "read" | "external", fields: Record<string, unknown>): unknown => ({
  capability: { id, interface: fields, providers: ["gateway.mcp"], side_effect: sideEffect, isolation_tier: 1, max_input_sensitivity: "internal", min_argument_integrity: "operator", output_class: { sensitivity: "input", integrity: "untrusted" }, cost_model: { expected_cost: 0, expected_latency_ms: 100, cost_of_failure: 0 } },
});

function gatewayWorld(dir: string, clock: { now: number }): World {
  const work = workspace(dir);
  const state = join(dir, "state");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const session = {
    session_id: "gw-1",
    principal: PRINCIPAL,
    attendance: "autonomous",
    ttl: 3_600_000,
    grants: ["grant-gw"],
    budget: { tool_calls: 8, wall_clock_ms: 3_600_000 },
    unmetered_accepted: true,
    provider_clearance: "internal",
    sources: [...SOURCES, { id: "send-acks", selector: { kind: "tool_result", tool: "mcp.message.send" }, data_class: { sensitivity: "internal", integrity: "untrusted" } }],
    tools: [
      { tool: "files.read", entry: gatewayCapability("mcp.files.read", "read", { path: { type: { kind: "path" }, role: "data", data_effect: "target" } }), reads: "path" },
      { tool: "message.send", entry: gatewayCapability("mcp.message.send", "external", { to: { type: { kind: "string" }, role: "data", data_effect: "target" }, body: { type: { kind: "string" }, role: "data", data_effect: "payload" } }) },
    ],
    rejection_limit: 2,
  };
  // Four uses in all, so a restart that forgot the grant's use would let it be used again.
  const grant = grantRecord("grant-gw", ["mcp.files.read", "mcp.message.send"], 4, { enumerated_targets: [{ field: "to", value: "ops@example.com" }] });
  const sink = new MemoryAnchorSink();
  const journalKey = JOURNAL_KEY;
  // The upstream MCP server, in this process: it answers the handshake and every call it is sent.
  const upstream = (): Upstream => ({
    request: (method) => Promise.resolve(method === "initialize" ? { protocolVersion: MCP_REVISION, capabilities: { tools: {} } } : { content: [{ type: "text", text: "done" }] }),
    notify: () => undefined,
    close: () => undefined,
  });
  let layer: SessionLayer | null = null;
  let gateway: McpGateway | null = null;
  let ids = 0;
  const call = (name: string, args: Record<string, unknown>): Promise<unknown> => {
    ids += 1;
    return (gateway as McpGateway).handle({ jsonrpc: "2.0", id: ids, method: "tools/call", params: { name, arguments: args } });
  };
  return {
    layer: () => layer as SessionLayer,
    start: async () => {
      layer = await openTestLayer("gateway", { journal: join(state, "journal"), workspaces: [work], clock: () => new Date(clock.now), journalOptions: { clock: () => new Date(clock.now) }, anchoring: { sink, journalKey, intervalMs: 5_000 } });
      const grants = new GrantStore(TEST_ANCHOR);
      grants.add(grant);
      gateway = new McpGateway({ layer, grants, resolver: new HostPathResolver(work), view: new Workspace(execFileScript(process.execPath, []), "/work", work), filesystem: systemFilesystemIo(), clock: () => new Date(clock.now), upstream });
      // As `juno gateway serve` does at every start: the operator's session file is given again.
      expect(await gateway.admit(session)).toMatchObject({ admitted: true });
      // The client connects again after a restart; the handshake is not a call.
      expect(await gateway.handle({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: MCP_REVISION, capabilities: {}, clientInfo: { name: "scripted", version: "1" } } })).toMatchObject({ result: { protocolVersion: MCP_REVISION } });
    },
    stop: async () => {
      gateway?.close();
      await layer?.close();
      layer = null;
      gateway = null;
    },
    apply: (step) => {
      switch (step % GATEWAY_STEPS) {
        case 0: return call("files.read", { path: "/work/project/notes.txt" });
        case 1: return call("message.send", { to: "ops@example.com", body: "hello" });
        case 2: return call("message.send", { to: "attacker@example.com", body: "the key" });
        case 3: return call("files.read", { path: "/work/other/x.txt" });
        case 4: return call("files.read", { path: "/work/project/secrets/key.txt" });
        case 5: return call("not.defined", { x: 1 });
        default: return call("files.read", { path: 7 });
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Mode A: JUNO's own loop. A task that is running when the runner stops is failed by design (D-066: an effect may have
// happened that its trajectory does not show), so here a step is one whole operator action (admit and run a task to its
// park or its end, or resume a parked one), and restarts come between them.
// ---------------------------------------------------------------------------------------------------------------------

const LOOP_STEPS = 6;

function loopWorld(dir: string, clock: { now: number }): World {
  const work = workspace(dir);
  const state = join(dir, "state");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const sink = new MemoryAnchorSink();
  const journalKey = JOURNAL_KEY;
  // Three uses in all, across every task and every restart.
  const grant = grantRecord("grant-1", ["shell.run"], 3);
  let layer: SessionLayer | null = null;
  let runner: Runner | null = null;
  let tasks = 0;
  let calls = 0;
  let script: unknown[] = [];
  const parked: string[] = [];
  const cat = (argv: readonly unknown[]): unknown => {
    calls += 1;
    return { id: `call-${String(calls)}`, capability: "shell.run", arguments: { program: { slot: "cat" }, argv, cwd: { slot: "project" } } };
  };
  const run = async (steps: readonly unknown[], overrides: Record<string, unknown> = {}): Promise<unknown> => {
    tasks += 1;
    const id = `task-${String(tasks)}`;
    script = [...steps];
    const admitted = (runner as Runner).admit(taskRequest({ id, ...overrides }));
    if (!admitted.admitted) return admitted;
    const outcome = await (runner as Runner).run(id);
    if (outcome.state === "parked") parked.push(id);
    return outcome;
  };
  return {
    layer: () => layer as SessionLayer,
    start: async () => {
      layer = await openTestLayer("runner", { journal: join(state, "journal"), workspaces: [work], clock: () => new Date(clock.now), journalOptions: { clock: () => new Date(clock.now) }, anchoring: { sink, journalKey, intervalMs: 5_000 } });
      const registry = new CapabilityRegistry();
      registry.register(loadRegistryEntry(SHELL_RUN_FILE), [standInAdapter]);
      const grants = new GrantStore(TEST_ANCHOR);
      grants.add(grant);
      // The scripted model: each turn is the next step of the task being run.
      const provider = new ScriptedProvider(PROFILE, Array.from({ length: 64 }, () => () => script.shift() ?? turn([])));
      runner = new Runner({ layer, registry, grants, providers: [provider], sources: [PROJECT_SOURCE], clock: () => new Date(clock.now), resolver: hostResolver(work) });
    },
    stop: async () => {
      runner?.close();
      await layer?.close();
      layer = null;
      runner = null;
    },
    apply: async (step) => {
      switch (step % LOOP_STEPS) {
        // One call under the grant, then done.
        case 0: return run([turn([cat(["notes.txt"])]), turn([])]);
        // Two calls under the grant in one turn.
        case 1: return run([turn([cat(["notes.txt"]), cat(["done.txt"])]), turn([])]);
        // A call outside the grant's scope parks.
        case 2: return run([turn([cat(["/work/other/x.txt"])]), turn([])]);
        // A capability that does not exist, until the rejection limit parks.
        case 3: return run([turn([{ id: "x1", capability: "no.such", arguments: {} }]), turn([{ id: "x2", capability: "no.such", arguments: {} }]), turn([{ id: "x3", capability: "no.such", arguments: {} }]), turn([])]);
        // The same id admitted twice.
        case 4: {
          const first = await run([turn([])]);
          tasks -= 1;
          return [first, await run([turn([])])];
        }
        // Resume the oldest parked task.
        default: {
          const id = parked.shift();
          if (id === undefined) return "nothing parked";
          script = [turn([cat(["notes.txt"])]), turn([])];
          try {
            const outcome = await (runner as Runner).resume(id);
            if (outcome.state === "parked") parked.push(id);
            return outcome;
          } catch (error: unknown) {
            return { refused: error instanceof Error ? error.message : String(error) };
          }
        }
      }
    },
  };
}

describe("operator ruling D-201: a restart forgets nothing JUNO enforces", () => {
  const sequence = (kinds: number) => fc.record({ steps: fc.array(fc.nat(kinds - 1), { minLength: 4, maxLength: 28 }), restarts: fc.array(fc.nat(64), { minLength: 1, maxLength: 6 }) });

  // proves D-201 for §4.3 mode C: grant use (§3.2), an id admitted once (§5), the call budget (§4.3), the rejection limit
  // (§2.7.1 A4), the floor (§1.2) and awaited results survive any restart of the hook service
  it("hook mode: the same decisions and the same journal with restarts at any points", async () => {
    await fc.assert(fc.asyncProperty(sequence(HOOK_STEPS), ({ steps, restarts }) => sameWithAndWithoutRestarts(hookWorld, "hook", [0, ...steps], restarts)), { numRuns: RUNS, seed: 20261110 });
  }, 600_000);

  // proves D-201 for §4.3 mode B: the same, for the gateway's one session
  it("gateway mode: the same decisions and the same journal with restarts at any points", async () => {
    await fc.assert(fc.asyncProperty(sequence(GATEWAY_STEPS), ({ steps, restarts }) => sameWithAndWithoutRestarts(gatewayWorld, "gateway", steps, restarts)), { numRuns: RUNS, seed: 20261110 });
  }, 600_000);

  // proves D-201 for JUNO's own loop (§3.2, §5, §6.3, §3.4.5): grant use, admitted ids and parked tasks survive any restart
  it("own loop: the same decisions and the same journal with restarts between operator actions", async () => {
    await fc.assert(fc.asyncProperty(sequence(LOOP_STEPS), ({ steps, restarts }) => sameWithAndWithoutRestarts(loopWorld, "loop", steps, restarts)), { numRuns: RUNS, seed: 20261110 });
  }, 600_000);

  // The generated sequences really reach the limits a restart could reset (the property is not vacuous).
  it("the sequences reach a used-up grant, a spent budget, the rejection limit and a refused second admission", async () => {
    const reach = async (make: (dir: string, clock: { now: number }) => World, name: string, steps: readonly number[], markers: readonly string[]): Promise<void> => {
      const text = JSON.stringify(await play(make, name, steps, new Set()));
      expect(markers.filter((marker) => !text.includes(marker)), name).toEqual([]);
    };
    await reach(hookWorld, "hook-reach", [0, 0, 4, 6, 6, 2, 2, 2, 11, 2, 11, 2, 11, 2, 11, 2, 2, 2, 12], ["is already admitted", "exhausted", "rejection_limit", "budget_exceeded", "proceed", "sensitivity_ceiling", "result_missing", "without_authorized_call"]);
    await reach(gatewayWorld, "gateway-reach", [0, 0, 1, 1, 0, 5, 5, 0, 0, 0], ["exhausted", "rejection_limit", "budget_exceeded", "proceed"]);
    await reach(loopWorld, "loop-reach", [2, 1, 0, 0, 4, 3, 5, 5], ["exhausted", "rejection_limit", "already has a trajectory", "scope_violation", "proceed"]);
  }, 120_000);
});
