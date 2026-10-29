import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoundaryError, type ProviderProfile, type TrajectoryEntry } from "../../contracts/src/index.js";
import { GrantStore } from "../../enforcement/src/index.js";
import { JournalWriter, readPayload, readTrajectory, verifyTrajectory } from "../../journal/src/index.js";
import { type Adapter, CapabilityRegistry, type InvocationResult, WORKLOAD_EXECFILE, loadRegistryEntry } from "../../registry/src/index.js";
import {
  type ModelOutput,
  RUNNER_LOCK_FILE,
  Runner,
  RunnerError,
  RunnerLockError,
  ScriptedProvider,
  type ScriptStep,
  type SourceRegistration,
  type TurnRequest,
  VERIFIER_ACTOR,
  VERIFY_EXIT_CODE,
  acquireRunnerLock,
  deriveContextOwnership,
  deriveSteerCapability,
  loadProviderProfile,
  toProposal,
  writeClosure,
} from "../src/index.js";

const SHELL_RUN_FILE = fileURLToPath(new URL("../../registry/definitions/shell.run.json", import.meta.url));
const PROFILE_FILE = fileURLToPath(new URL("../providers/scripted-fake.json", import.meta.url));
const RUNNER_SRC = fileURLToPath(new URL("../src", import.meta.url));
const PRINCIPAL = "alireza";
const T0 = "2026-10-29T09:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;
const MODEL = "scripted-model";

/**
 * A stand-in provider for unit tests: runs node on the host, prints the cwd
 * and each argv element on its own line, and exits 1 when an element names
 * `missing.txt`. It delivers every data value as one discrete argv element,
 * so it passes the §2.4 conformance suite.
 */
const PRINT = 'const a = process.argv.slice(1); process.stdout.write(a.join("\\n") + "\\n"); process.exit(a.some((x) => x.endsWith("missing.txt")) ? 1 : 0);';
const printAdapter: Adapter = {
  id: WORKLOAD_EXECFILE,
  plan: (call) => ({ file: process.execPath, args: ["-e", PRINT, String(call["cwd"]), ...(call["argv"] as readonly unknown[]).map(String)] }),
};

/** A registry whose `invoke` cannot be used: the runner must reach capabilities only through the boundary (STATE.md, D-061). */
class NoInvokeRegistry extends CapabilityRegistry {
  invoked = 0;
  override invoke(): Promise<InvocationResult> {
    this.invoked += 1;
    throw new Error("the runner called CapabilityRegistry.invoke");
  }
}

const profile = loadProviderProfile(PROFILE_FILE);
const SOURCES: SourceRegistration[] = [{ id: "work-vol", selector: { kind: "path", prefix: "/work" }, data_class: { sensitivity: "internal", integrity: "untrusted" } }];

function grant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "grant-1",
    principal: PRINCIPAL,
    capability_selector: { capabilities: ["shell.run"] },
    resource_scope: [{ kind: "path", prefix: "/work" }],
    data_class_bounds: { max_sensitivity: "internal", min_integrity: "untrusted" },
    issuance: "preissued",
    issued_by: PRINCIPAL,
    issued_at: T0,
    expires_at: new Date(Date.parse(T0) + DAY_MS).toISOString(),
    max_invocations: 10,
    attenuation_parent: null,
    revoked_at: null,
    ...overrides,
  };
}

const CRITERION = { capability: "shell.run", arguments: { program: "/usr/bin/cat", argv: ["notes.txt"], cwd: "/work" }, exit_code: 0 };

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-1",
    principal: PRINCIPAL,
    objective: "print the notes file",
    criterion: CRITERION,
    criterion_author: "operator",
    verification: VERIFY_EXIT_CODE,
    attendance: "autonomous",
    strategy: "direct",
    sensitivity_floor: "internal",
    model_policy: { permitted_providers: ["scripted-fake"], posture: "local", conversation_state: "any" },
    budget: { tokens: 100_000, currency: 1, wall_clock_ms: 600_000, turns: 20 },
    ttl: DAY_MS,
    grants: ["grant-1"],
    constants: { cat: "/usr/bin/cat", work: "/work" },
    ...overrides,
  };
}

const catCall = (argv: readonly unknown[] = ["notes.txt"], program: unknown = { slot: "cat" }): ModelOutput => ({
  kind: "tool_call",
  capability: "shell.run",
  input: { program, argv: [...argv], cwd: { slot: "work" } },
});
const done: ModelOutput = { kind: "done", summary: "the work is done and verified" };

let dir: string;
let journal: JournalWriter;
let registry: NoInvokeRegistry;
let grants: GrantStore;
let now: Date;
let mono: number;
let runner: Runner | undefined;
let provider: ScriptedProvider;

async function open(script: readonly ScriptStep[], options: { profile?: ProviderProfile; usage?: { tokens_in: number; tokens_out: number; tokens_cached: number } } = {}): Promise<Runner> {
  provider = new ScriptedProvider({ profile: options.profile ?? profile, script, model: MODEL, ...(options.usage === undefined ? {} : { usage: options.usage }) });
  runner = await Runner.open({ journal, registry, grants, provider, sources: SOURCES, clock: () => now, monotonic: () => mono });
  return runner;
}

const entries = (taskId = "task-1"): readonly TrajectoryEntry[] => readTrajectory(journal.root, taskId);
const payloadOf = (entry: TrajectoryEntry): Record<string, unknown> => {
  const blob = readPayload(journal.root, entry.payload_ref);
  if (blob.status !== "present") throw new Error("payload missing");
  return JSON.parse(new TextDecoder().decode(blob.bytes)) as Record<string, unknown>;
};
const notes = (event: string, taskId = "task-1"): Record<string, unknown>[] =>
  entries(taskId).filter((entry) => entry.kind === "note").map(payloadOf).filter((payload) => payload["event"] === event);
const parks = (taskId = "task-1"): Record<string, unknown>[] => entries(taskId).filter((entry) => entry.kind === "park").map(payloadOf);
const resultSeq = (turn: TurnRequest): number => {
  const result = turn.input.find((input) => input.kind === "result");
  if (result?.kind !== "result") throw new Error("no result in this turn's input");
  return result.result_seq;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "juno-runner-"));
  journal = JournalWriter.open(join(dir, "journal"));
  registry = new NoInvokeRegistry();
  expect(registry.register(loadRegistryEntry(SHELL_RUN_FILE), [printAdapter]).registered).toBe(true);
  grants = new GrantStore();
  grants.add(grant());
  now = new Date(Date.parse(T0) + 60 * 60 * 1000);
  mono = 0;
  runner = undefined;
});

afterEach(async () => {
  await runner?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

function admitted(result: ReturnType<Runner["admit"]>) {
  if (!result.admitted) throw new Error(`not admitted: ${JSON.stringify(result.failures)}`);
  return result;
}
function rejectedChecks(result: ReturnType<Runner["admit"]>): unknown[] {
  if (result.admitted) throw new Error("admitted");
  return result.failures.map((failure) => failure.check);
}

describe("admission (§5)", () => {
  // proves build plan Inc 5 test 1 / §5.1: a task with no criterion admits, as non-verified
  it("admits a task with no criterion as non-verified", async () => {
    const r = await open([]);
    const { task } = admitted(r.admit(request({ criterion: null, criterion_author: undefined, verification: null })));
    expect(task.state).toBe("admitted");
    expect(task.closure_mode).not.toBe("verified");
    expect(task.closure_mode).toBe("accepted");
    expect(task.criterion).toBeNull();
  });

  // proves §5.1: a criterion with no verification method also admits as non-verified
  it("admits a criterion without a verification method as non-verified", async () => {
    const r = await open([]);
    expect(admitted(r.admit(request({ verification: null }))).task.closure_mode).toBe("accepted");
  });

  // proves build plan Inc 5 test 2 (first half) / §5.2: a model-drafted criterion carries derived integrity and is not licensed for verified
  it("records a model-drafted criterion at derived integrity, admitted as non-verified", async () => {
    const r = await open([]);
    const { task } = admitted(r.admit(request({ criterion_author: "model" })));
    expect(task.criterion_integrity).toBe("derived");
    expect(task.closure_mode).toBe("accepted");
  });

  // proves §5.4 check 3 / §5.2: an operator-written criterion is recorded at operator integrity and licenses verified
  it("records an operator criterion at operator integrity, admitted as verified", async () => {
    const r = await open([]);
    const { task } = admitted(r.admit(request()));
    expect({ integrity: task.criterion_integrity, mode: task.closure_mode }).toEqual({ integrity: "operator", mode: "verified" });
  });

  // proves §5.4 check 3: a criterion whose author is not stated cannot have its integrity recorded, so it is refused
  it("rejects a criterion given without its author", async () => {
    const r = await open([]);
    expect(rejectedChecks(r.admit(request({ criterion_author: undefined })))).toEqual([3]);
  });

  // proves §5.4 check 1 / §5.1: no objective → reject
  it.each([[undefined], [""], ["   "]])("rejects a missing or blank objective (%j)", async (objective) => {
    const r = await open([]);
    expect(rejectedChecks(r.admit(request({ objective })))).toEqual([1]);
  });

  // proves §5.4 check 2: an unknown verification method, or a criterion that is not machine-evaluable, is refused
  it.each([
    [{ verification: "juno.verify.vibes" }],
    [{ criterion: { prose: "the notes look right" } }],
    [{ criterion: { ...CRITERION, capability: "fs.file.read" } }],
    [{ criterion: { ...CRITERION, arguments: { program: "/bin/sh", argv: [], cwd: "/work" } } }],
  ])("rejects a criterion it cannot check: %j", async (overrides) => {
    const r = await open([]);
    expect(rejectedChecks(r.admit(request(overrides)))).toEqual([2]);
  });

  // proves §5.4 check 6 and the operator ruling: there is no default spend ceiling; a task without one is refused
  it("rejects a task with no spend ceiling, and fills in no default", async () => {
    const r = await open([]);
    const result = r.admit(request({ budget: { tokens: 1000, wall_clock_ms: 60_000, turns: 5 } }));
    expect(rejectedChecks(result)).toEqual([6]);
    expect(r.task("task-1")).toBeUndefined();
    const [admission] = notes("admission");
    expect(admission?.["outcome"]).toBe("rejected");
    expect(JSON.stringify(admission?.["failures"])).toContain("currency");
  });

  // proves §5.4 check 6: every budget axis must be declared
  it.each(["tokens", "currency", "wall_clock_ms", "turns"])("rejects a budget missing the %s axis", async (axis) => {
    const r = await open([]);
    const budget = Object.fromEntries(Object.entries({ tokens: 1000, currency: 1, wall_clock_ms: 60_000, turns: 5 }).filter(([name]) => name !== axis));
    expect(rejectedChecks(r.admit(request({ budget })))).toEqual([6]);
  });

  // proves §5.4 check 7: no ttl → reject
  it("rejects a task with no ttl", async () => {
    const r = await open([]);
    expect(rejectedChecks(r.admit(request({ ttl: undefined })))).toEqual([7]);
  });

  // proves §5.4 check 4 / §1.5: a source with no declared class, or no registration at all, rejects the task
  it("rejects a task whose grants reach an unclassified or unregistered source", async () => {
    let r = await open([]);
    SOURCES[0] = { id: "work-vol", selector: { kind: "path", prefix: "/work" }, data_class: "unclassified" };
    try {
      expect(rejectedChecks(r.admit(request()))).toEqual([4]);
      await r.shutdown();
      SOURCES[0] = { id: "elsewhere", selector: { kind: "path", prefix: "/work/other" }, data_class: { sensitivity: "internal", integrity: "untrusted" } };
      r = await open([]);
      expect(rejectedChecks(r.admit(request({ id: "task-2" })))).toEqual([4]);
    } finally {
      SOURCES[0] = { id: "work-vol", selector: { kind: "path", prefix: "/work" }, data_class: { sensitivity: "internal", integrity: "untrusted" } };
    }
  });

  // proves §5.4 check 5: the model policy must be satisfiable by a registered provider
  it("rejects a policy that permits no registered provider", async () => {
    const r = await open([]);
    expect(rejectedChecks(r.admit(request({ model_policy: { permitted_providers: ["elsewhere"], posture: "local", conversation_state: "any" } })))).toEqual([5]);
  });

  // proves §5.4 check 5 with §10.3: confidential work, or a stateless policy, needs a stateless provider
  it.each([
    [{ sensitivity_floor: "confidential" }],
    [{ model_policy: { permitted_providers: ["scripted-fake"], posture: "local", conversation_state: "stateless" } }],
  ])("rejects routing to a server-held provider: %j", async (overrides) => {
    const r = await open([], { profile: { ...profile, conversation_state: "server_held" } });
    expect(rejectedChecks(r.admit(request(overrides)))).toContain(5);
  });

  // proves §5.4 check 8 / §10.2: native context with no native context management is refused, never degraded
  it("rejects native context ownership when the provider offers no native context management", async () => {
    const r = await open([], { profile: { ...profile, native_context_management: false } });
    expect(rejectedChecks(r.admit(request()))).toEqual([8]);
  });

  // proves §10.2 (as D-059 evaluates it): an enum instruction field derives native; a free-text instruction field derives owned
  it("derives context ownership from the capability set", () => {
    expect(deriveContextOwnership([{ program: { role: "instruction", type: { kind: "enum" } }, argv: { role: "data", type: { kind: "list" } } }])).toBe("native");
    expect(deriveContextOwnership([{ command: { role: "instruction", type: { kind: "string" } } }])).toBe("owned");
    expect(deriveContextOwnership([])).toBe("native");
  });

  // proves §5.4 check 8 and D-059: a task that would derive owned is refused, since owned assembly is not built
  it("refuses a task whose capability set derives owned context", async () => {
    const r = await open([]);
    const definition = JSON.parse(readFileSync(SHELL_RUN_FILE, "utf8")) as { capability: Record<string, unknown> & { interface: Record<string, unknown> } };
    definition.capability["id"] = "shell.exec";
    definition.capability.interface = { ...definition.capability.interface, mode: { type: { kind: "string" }, role: "instruction" } };
    expect(registry.register(definition, [printAdapter]).registered).toBe(true);
    grants.add(grant({ id: "grant-exec", capability_selector: { capabilities: ["shell.exec"] } }));
    expect(rejectedChecks(r.admit(request({ grants: ["grant-exec"] })))).toEqual([8]);
  });

  // proves §7.8: steer_capability derivation, every row of the table
  it("derives steer_capability by §7.8's table", () => {
    const p = (conversation_state: "stateless" | "server_held", turn_control: "client" | "server", server_interrupt: boolean) => ({ conversation_state, turn_control, server_interrupt });
    expect(deriveSteerCapability("owned", p("server_held", "server", false))).toBe("full");
    expect(deriveSteerCapability("native", p("stateless", "server", false))).toBe("full");
    expect(deriveSteerCapability("native", p("server_held", "client", false))).toBe("full");
    expect(deriveSteerCapability("native", p("server_held", "server", true))).toBe("checkpoint_only");
    expect(deriveSteerCapability("native", p("server_held", "server", false))).toBe("none");
  });

  // proves §5.4 check 10: a task requiring live steer is refused when steers cannot land; requires_live_steer defaults from attendance
  it("rejects a gated task on a provider that cannot take live steers, and admits it when live steer is not required", async () => {
    const r = await open([], { profile: { ...profile, conversation_state: "server_held", turn_control: "server", server_interrupt: false } });
    expect(rejectedChecks(r.admit(request({ attendance: "gated" })))).toEqual([10]);
    const ok = admitted(r.admit(request({ id: "task-2", attendance: "gated", requires_live_steer: false })));
    expect({ steer: ok.task.steer_capability, ownership: ok.task.context_ownership }).toEqual({ steer: "none", ownership: "native" });
  });

  // proves §5.4 check 9: capabilities in scope must be registered with an adapter that is not quarantined; grants must exist and be the principal's
  it("rejects unknown grants, other principals' grants and quarantined capabilities", async () => {
    const r = await open([]);
    expect(rejectedChecks(r.admit(request({ grants: ["grant-missing"] })))).toEqual([9]);
    grants.add(grant({ id: "grant-other", principal: "someone-else" }));
    expect(rejectedChecks(r.admit(request({ id: "task-2", grants: ["grant-other"] })))).toEqual([9]);
    registry.quarantine({ capability: "shell.run", adapter: WORKLOAD_EXECFILE, observation: "test" });
    expect(rejectedChecks(r.admit(request({ id: "task-3" })))).toEqual([9]);
  });

  // proves §5.3: a grant for a capability that writes needs max_invocations
  it("rejects a grant without an invocation cap on a capability that writes", async () => {
    const r = await open([]);
    const definition = JSON.parse(readFileSync(SHELL_RUN_FILE, "utf8")) as { capability: Record<string, unknown> };
    definition.capability["id"] = "shell.write";
    definition.capability["side_effect"] = "write";
    expect(registry.register(definition, [printAdapter]).registered).toBe(true);
    grants.add(grant({ id: "grant-write", capability_selector: { capabilities: ["shell.write"] }, max_invocations: null }));
    expect(rejectedChecks(r.admit(request({ grants: ["grant-write"] })))).toEqual(["grant_bounds"]);
  });

  // proves §5.4 check 11 / §3.1: an autonomous task with zero grants is admitted, with a warning
  it("admits an autonomous task with zero grants, warning about it", async () => {
    const r = await open([]);
    const result = admitted(r.admit(request({ grants: [] })));
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("check 11");
  });

  // proves D-058: Slice 1 runs the direct strategy only (no planning logic)
  it("rejects a strategy Slice 1 does not have", async () => {
    const r = await open([]);
    expect(rejectedChecks(r.admit(request({ strategy: "plan-then-execute" })))).toEqual(["strategy"]);
  });

  // proves §3.4.5 ("why did this happen" from the journal alone): every admission decision is journalled, and an id is never reused
  it("journals every admission decision and never reuses a task id", async () => {
    const r = await open([]);
    expect(r.admit(request({ ttl: undefined })).admitted).toBe(false);
    expect(() => r.admit(request())).toThrow(RunnerError);
    expect(notes("admission")).toHaveLength(1);
    expect(verifyTrajectory(journal.root, "task-1").ok).toBe(true);
  });

  // proves §0.2 D8: a request that is not a request at all is refused at the boundary
  it("throws on a request that does not parse", async () => {
    const r = await open([]);
    expect(() => r.admit({ id: "task-1" })).toThrow(BoundaryError);
  });
});

describe("turn loop (§6, §2.7 through the boundary)", () => {
  // proves §3.4.4 / invariant 3 / build plan Inc 5: verification runs the declared command and the runner, never the model, writes the closure
  it("runs to verified: the model proposes, the boundary performs, the verifier closes", async () => {
    const r = await open([catCall(), done]);
    admitted(r.admit(request()));
    const outcome = await r.run("task-1");
    expect(outcome).toEqual({ task_id: "task-1", state: "verified", reason: null });
    const [closure] = notes("closure").map((note) => note["closure"] as Record<string, unknown>);
    expect(closure).toMatchObject({ closure_mode: "verified", verification_result: "pass", verifier_identity: VERIFIER_ACTOR, criterion_integrity: "operator", replay_fidelity: "partial" });
    expect(closure?.["verifier_identity"]).not.toBe(MODEL);
    const closureEntry = entries().find((entry) => entry.kind === "note" && payloadOf(entry)["event"] === "closure");
    expect(closureEntry?.actor).not.toBe(MODEL);
    expect(entries().map((entry) => entry.kind)).toEqual([
      "note", // admission
      "note", // running
      "turn",
      "capability_call",
      "capability_result",
      "turn",
      "note", // verification started
      "capability_call",
      "capability_result",
      "note", // verification finished
      "note", // closure
      "note", // verified
    ]);
    expect(verifyTrajectory(journal.root, "task-1").ok).toBe(true);
    expect(registry.invoked).toBe(0);
  });

  // proves invariant 3 / §3.4.4: the model saying "done and verified" is a claim; a failing check fails the task and writes no closure
  it("fails the task when verification fails, whatever the model claimed", async () => {
    const r = await open([done]);
    admitted(r.admit(request({ criterion: { ...CRITERION, arguments: { ...CRITERION.arguments, argv: ["missing.txt"] } } })));
    expect(await r.run("task-1")).toEqual({ task_id: "task-1", state: "failed", reason: "verification_failed" });
    expect(notes("closure")).toEqual([]);
  });

  // proves build plan Inc 5 test 2 (second half) / §5.2, §3.4.4: a model-drafted criterion can never yield verified closure
  it("never closes a model-drafted criterion as verified, by the runner or by the schema", async () => {
    const r = await open([catCall(), done]);
    admitted(r.admit(request({ criterion_author: "model" })));
    expect(await r.run("task-1")).toEqual({ task_id: "task-1", state: "complete_unverified", reason: null });
    expect(notes("closure")).toEqual([]);
    // Even a direct write of a verified closure for it is refused.
    const attempt = {
      task_id: "task-1",
      criterion_ref: `sha256:${"0".repeat(64)}`,
      criterion_integrity: "derived",
      verification_method: VERIFY_EXIT_CODE,
      verification_result: "pass",
      closure_mode: "verified",
      verifier_identity: VERIFIER_ACTOR,
      replay_fidelity: "partial",
      artifacts: [],
      cost_actual: { tokens: 0, currency: 0, wall_clock_ms: 0, turns: 0 },
    };
    expect(() => writeClosure(journal, "task-1", "internal", attempt)).toThrow(BoundaryError);
    // The operator may close it, and the closure says accepted: verification is never conferred (§6.1).
    const closure = r.closeAccepted("task-1", PRINCIPAL);
    expect({ mode: closure.closure_mode, verifier: closure.verifier_identity }).toEqual({ mode: "accepted", verifier: PRINCIPAL });
    expect(r.task("task-1")?.state).toBe("accepted");
  });

  // proves build plan Inc 5 test 4 / §3.4.4: a closure whose verifier is the executing actor is rejected by the schema at write time, and nothing is written
  it("rejects a closure written with verifier_identity equal to the executing actor", async () => {
    const r = await open([done]);
    admitted(r.admit(request({ criterion: null, criterion_author: undefined, verification: null })));
    await r.run("task-1");
    const before = entries().length;
    const closure = {
      task_id: "task-1",
      criterion_ref: null,
      criterion_integrity: "untrusted",
      verification_method: null,
      verification_result: "inconclusive",
      closure_mode: "accepted",
      verifier_identity: MODEL,
      replay_fidelity: "partial",
      artifacts: [],
      cost_actual: { tokens: 0, currency: 0, wall_clock_ms: 0, turns: 1 },
    };
    expect(() => writeClosure(journal, "task-1", "internal", closure)).toThrow(BoundaryError);
    expect(() => writeClosure(journal, "task-1", "internal", closure)).toThrow(/verifier_identity must not equal the executing actor/);
    expect(entries()).toHaveLength(before);
    expect(() => r.closeAccepted("task-1", MODEL)).toThrow(RunnerError);
  });

  // proves §6.1: the operator closes only a complete_unverified task, and only the task's principal can
  it("lets only the principal close, and only a complete_unverified task", async () => {
    const r = await open([catCall()]);
    admitted(r.admit(request({ criterion: null, criterion_author: undefined, verification: null, budget: { tokens: 100_000, currency: 1, wall_clock_ms: 600_000, turns: 1 } })));
    await r.run("task-1");
    expect(r.task("task-1")?.state).toBe("parked");
    expect(() => r.closeAccepted("task-1", PRINCIPAL)).toThrow(RunnerError);
  });

  // proves §6.2 / §3.1: an autonomous task with zero grants parks awaiting_grant at its first capability call
  it("parks awaiting_grant at the first call of a task with no grants", async () => {
    const r = await open([catCall()]);
    admitted(r.admit(request({ grants: [] })));
    expect(await r.run("task-1")).toEqual({ task_id: "task-1", state: "parked", reason: "awaiting_grant" });
    expect(parks()[0]?.["reason"]).toBe("awaiting_grant");
    expect(r.task("task-1")?.runtime_substate).toBeNull();
  });

  // proves §2.7 step 3 / §6.2 / §8.3: a synthesized program parks integrity_floor through the runner
  it("parks integrity_floor when the model synthesizes the program", async () => {
    const r = await open([catCall(["notes.txt"], "/usr/bin/cat")]);
    admitted(r.admit(request()));
    expect(await r.run("task-1")).toEqual({ task_id: "task-1", state: "parked", reason: "integrity_floor" });
    const call = entries().find((entry) => entry.kind === "capability_call");
    expect(call?.argument_provenance?.find((item) => item.argument === "program")).toEqual({ argument: "program", class: "synthesized", integrity: "untrusted" });
  });

  // proves §2.6 bound / D-060: a reference the model emits is resolved by the runtime from the task's own trajectory, and the task completes
  it("carries a bound reference from a capability result into the next call's argv", async () => {
    const r = await open([catCall(), (turn) => catCall([{ ref: `\${${String(resultSeq(turn))}.stdout_lines[1]}` }]), done]);
    admitted(r.admit(request()));
    expect((await r.run("task-1")).state).toBe("verified");
    const calls = entries().filter((entry) => entry.kind === "capability_call");
    expect(calls[1]?.argument_provenance?.find((item) => item.argument === "argv[0]")).toEqual({ argument: "argv[0]", class: "bound", integrity: "untrusted" });
    expect(entries().some((entry) => entry.kind === "binding_resolution")).toBe(true);
  });

  // proves D-045 through the runner: a rejected proposal is reported to the model and the task keeps running
  it("tells the model about a rejected call and keeps running", async () => {
    const r = await open([catCall([{ ref: "${999.stdout}" }]), done]);
    admitted(r.admit(request()));
    expect((await r.run("task-1")).state).toBe("verified");
    expect(provider.requests[1]?.input).toEqual([{ kind: "rejected", call_seq: expect.any(Number) as number, reason: "unresolved_argument" }]);
    expect(parks()).toEqual([]);
  });

  // proves D-060: text that is not a proposal does nothing; a tool call whose input is not an object is refused without reaching a capability
  it("does nothing on plain text, and refuses a tool call with no object of arguments", async () => {
    const r = await open([{ kind: "text", text: "thinking" }, { kind: "tool_call", capability: "shell.run", input: "cat notes.txt" }, done]);
    admitted(r.admit(request()));
    expect((await r.run("task-1")).state).toBe("verified");
    expect(provider.requests[1]?.input).toEqual([{ kind: "no_action" }]);
    expect(provider.requests[2]?.input[0]).toMatchObject({ kind: "rejected", call_seq: null });
    expect(notes("malformed_tool_call")).toHaveLength(1);
  });

  // proves invariant 7 / D-060: provenance comes from the tool call's shape, never from its content
  it("reads provenance from the shape of each value, not its content", () => {
    expect(toProposal("shell.run", { program: { slot: "cat" }, argv: ["${3.stdout}", { ref: "${3.stdout}" }], cwd: "/work" })).toEqual({
      capability: "shell.run",
      arguments: {
        program: { class: "constant", slot: "cat" },
        argv: [
          { class: "synthesized", value: "${3.stdout}" },
          { class: "bound", reference: "${3.stdout}" },
        ],
        cwd: { class: "synthesized", value: "/work" },
      },
    });
    expect(toProposal("shell.run", { program: { slot: "cat", extra: 1 } })).toEqual({ capability: "shell.run", arguments: { program: { slot: "cat", extra: 1 } } });
    expect(toProposal("shell.run", { argv: [{ ref: "${3.stdout}", class: "constant" }] })).toEqual({
      capability: "shell.run",
      arguments: { argv: [{ ref: "${3.stdout}", class: "constant" }] },
    });
    expect(toProposal("shell.run", ["/usr/bin/cat"])).toBeNull();
  });

  // proves §2.1 output_class: a result is (input sensitivity, untrusted), and the task's floor is never lowered by it (§3.1)
  it("classes a result by the capability's output_class", async () => {
    const r = await open([catCall(), done]);
    admitted(r.admit(request()));
    await r.run("task-1");
    const result = entries().find((entry) => entry.kind === "capability_result");
    expect(result?.data_class).toEqual({ sensitivity: "internal", integrity: "untrusted" });
    expect(r.task("task-1")?.sensitivity_floor).toBe("internal");
  });
});

describe("budgets (§9, §6.2 budget_exceeded)", () => {
  const ample = { tokens: 100_000, currency: 1, wall_clock_ms: 600_000, turns: 20 };
  const forever: ScriptStep[] = Array.from({ length: 50 }, () => catCall());

  async function exhaust(budget: Record<string, number>, script: readonly ScriptStep[] = forever): Promise<Record<string, unknown>> {
    const r = await open(script);
    admitted(r.admit(request({ budget: { ...ample, ...budget } })));
    expect(await r.run("task-1")).toEqual({ task_id: "task-1", state: "parked", reason: "budget_exceeded" });
    const [park] = parks();
    expect(park?.["reason"]).toBe("budget_exceeded");
    return park?.["detail"] as Record<string, unknown>;
  }

  // proves build plan Inc 5 test 3 / §9: token exhaustion alone parks the task
  it("parks when the token budget is spent", async () => {
    // 120 tokens a turn: the second turn overruns 200 and is not acted on.
    expect((await exhaust({ tokens: 200 }))["axes"]).toEqual(["tokens"]);
    expect(entries().filter((entry) => entry.kind === "turn")).toHaveLength(2);
    expect(entries().filter((entry) => entry.kind === "capability_call")).toHaveLength(1);
  });

  // proves build plan Inc 5 test 3 / §9: currency exhaustion alone parks the task
  it("parks when the currency budget is spent", async () => {
    // 0.0006 a turn at the profile's prices.
    expect((await exhaust({ currency: 0.001 }))["axes"]).toEqual(["currency"]);
  });

  // proves build plan Inc 5 test 3 / §9 and D-025: running time alone parks the task
  it("parks when the wall-clock budget is spent in running time", async () => {
    const script = forever.map((step) => (turn: TurnRequest) => {
      mono += 1000;
      return typeof step === "function" ? step(turn) : step;
    });
    expect((await exhaust({ wall_clock_ms: 2500 }, script))["axes"]).toEqual(["wall_clock_ms"]);
  });

  // proves build plan Inc 5 test 3 / §9: the turn count alone parks the task
  it("parks when the turn budget is spent", async () => {
    expect((await exhaust({ turns: 3 }))["axes"]).toEqual(["turns"]);
    expect(entries().filter((entry) => entry.kind === "turn")).toHaveLength(3);
  });

  // proves D-025: the wall-clock budget counts running time only; wall time passing (sleep) does not spend it
  it("does not spend the wall-clock budget on wall time that is not running time", async () => {
    const r = await open([
      () => {
        now = new Date(now.getTime() + 60 * 60 * 1000);
        return catCall();
      },
      done,
    ]);
    admitted(r.admit(request({ budget: { ...ample, wall_clock_ms: 1000 } })));
    expect((await r.run("task-1")).state).toBe("verified");
  });
});

describe("ttl (§6.4, D-055)", () => {
  // proves §6.4 and D-055: ttl expiry moves the task to failed with ttl_expired; it is never a park
  it("fails the task with ttl_expired, and never parks it", async () => {
    const r = await open([
      catCall(),
      () => {
        now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
        return catCall();
      },
    ]);
    admitted(r.admit(request({ ttl: 60 * 60 * 1000 })));
    expect(await r.run("task-1")).toEqual({ task_id: "task-1", state: "failed", reason: "ttl_expired" });
    expect(parks()).toEqual([]);
    expect(notes("state").at(-1)).toEqual({ event: "state", to: "failed", reason: "ttl_expired" });
    // The turn that ran past the ttl is journalled and not acted on.
    expect(entries().filter((entry) => entry.kind === "capability_call")).toHaveLength(1);
  });

  // proves D-025: ttl counts wall time (including sleep), not running time
  it("counts wall time toward the ttl even when no running time passes", async () => {
    const r = await open([catCall()]);
    admitted(r.admit(request({ ttl: 1000 })));
    now = new Date(now.getTime() + 1000);
    expect(await r.run("task-1")).toEqual({ task_id: "task-1", state: "failed", reason: "ttl_expired" });
    expect(provider.requests).toHaveLength(0);
  });
});

describe("the runner reaches capabilities only through the boundary (STATE.md, Increment 4 note)", () => {
  // proves §3.2 "the task requests an effect, the boundary performs it": a registry whose invoke throws does not stop the whole call path
  it("runs a task end to end with a registry whose invoke throws", async () => {
    const r = await open([catCall(), done]);
    admitted(r.admit(request()));
    expect((await r.run("task-1")).state).toBe("verified");
    expect(entries().filter((entry) => entry.kind === "capability_result")).toHaveLength(2);
    expect(registry.invoked).toBe(0);
  });

  // proves the same statically: no runner module calls invoke, plans an invocation, or executes one itself
  it("has no runner module that invokes, plans or executes outside the boundary", () => {
    const sources = readdirSync(RUNNER_SRC).filter((file) => file.endsWith(".ts"));
    expect(sources.length).toBeGreaterThan(3);
    for (const file of sources) {
      const text = readFileSync(join(RUNNER_SRC, file), "utf8");
      expect({ file, uses: /\.invoke\(|\.plan\(|executeOutbound|child_process/.exec(text)?.[0] ?? null }).toEqual({ file, uses: null });
    }
  });
});

describe("one runner per journal volume (D-025, D-064)", () => {
  const run = promisify(execFile);

  // proves D-025 Increment 5: a second runner on the same journal refuses to start; once the first stops, a new one starts
  it("refuses a second runner while the first holds the journal", async () => {
    const first = await open([]);
    await expect(Runner.open({ journal, registry, grants, provider, sources: SOURCES })).rejects.toThrow(RunnerLockError);
    await first.shutdown();
    runner = await Runner.open({ journal, registry, grants, provider, sources: SOURCES });
  });

  // proves D-064: a runner that died leaves a socket nobody answers; the next runner replaces it
  it("replaces the lock of a runner that was killed", async () => {
    const path = join(journal.root, RUNNER_LOCK_FILE);
    const die = 'require("node:net").createServer().listen(process.argv[1], () => process.kill(process.pid, "SIGKILL"));';
    await expect(run(process.execPath, ["-e", die, path])).rejects.toMatchObject({ signal: "SIGKILL" });
    const lock = await acquireRunnerLock(journal.root);
    await lock.release();
  });

  // proves D-064 (fail closed): anything at the lock path that is not a socket refuses the start
  it("refuses to start when the lock path holds something other than a socket", async () => {
    writeFileSync(join(journal.root, RUNNER_LOCK_FILE), "not a socket");
    await expect(acquireRunnerLock(journal.root)).rejects.toThrow(RunnerLockError);
  });
});
