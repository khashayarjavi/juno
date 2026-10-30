import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoundaryError, Closure, type TrajectoryEntry, closureSchemaFor } from "../../contracts/src/index.js";
import { CapabilityRegistry, WORKLOAD_EXECFILE, type Adapter, loadRegistryEntry } from "../../registry/src/index.js";
import { RunnerLockError } from "../src/lock.js";
import type { ProviderRequest } from "../src/provider.js";
import { REGISTRY_RECORD, RUNNER_ACTOR, Runner, VERIFIER_ACTOR } from "../src/runner.js";
import { CAT, DAY_MS, type Harness, OPERATOR_CRITERION, PRINCIPAL, PROFILE, SHELL_RUN_FILE, harness, request, shellRun, standInAdapter, turn } from "./helpers.js";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  h.cleanup();
});

const notes = (entries: readonly TrajectoryEntry[], type: string, payload: Harness["payload"]): Record<string, unknown>[] =>
  entries.filter((entry) => entry.kind === "note").map(payload).filter((body) => body["type"] === type);
const kinds = (entries: readonly TrajectoryEntry[]): string[] => entries.map((entry) => entry.kind);
const parks = (): Record<string, unknown>[] => h.entries().filter((entry) => entry.kind === "park").map(h.payload);
const admitted = (runner: Runner, overrides: Record<string, unknown> = {}): void => {
  const result = runner.admit(request(overrides));
  if (!result.admitted) throw new Error(`not admitted: ${JSON.stringify(result.failures)}`);
};

describe("build plan Increment 5 tests", () => {
  // proves build plan Inc 5 test 1 / §5.1: no criterion admits, but never as verified
  it("admits a task with no criterion as non-verified", () => {
    const { runner } = h.runner([]);
    const result = runner.admit(request({ criterion: null, verification: null, closure_mode: "verified" }));
    expect(result.admitted).toBe(true);
    expect(runner.task("task-1")).toMatchObject({ state: "admitted", closure_mode: "accepted", criterion: null, criterion_integrity: "untrusted" });
  });

  // proves build plan Inc 5 test 1 / §5.1: a criterion with no verification method also admits non-verified
  it("admits a task with a criterion but no verification method as non-verified", () => {
    const { runner } = h.runner([]);
    admitted(runner, { criterion: OPERATOR_CRITERION, verification: null });
    expect(runner.task("task-1")?.closure_mode).toBe("accepted");
  });

  // proves build plan Inc 5 test 2 / §5.2 / §3.4.4: a model-drafted criterion is derived and can never produce verified closure
  it("gives a model-drafted criterion derived integrity, and never closes it verified", async () => {
    const { runner } = h.runner([turn([])]);
    admitted(runner, { criterion: { ...OPERATOR_CRITERION, author: "model" }, verification: "command_exit", closure_mode: "verified" });
    expect(runner.task("task-1")).toMatchObject({ criterion_integrity: "derived", closure_mode: "accepted" });
    // The model claims done; its criterion's command would pass, but nothing may confer verified on it.
    const outcome = await runner.run("task-1");
    expect(outcome.state).toBe("complete_unverified");
    expect(notes(h.entries(), "closure", h.payload)).toEqual([]);
    expect(notes(h.entries(), "verification", h.payload)).toEqual([]);
    // And no closure of that criterion can claim verified: the schema refuses it.
    const forged = {
      task_id: "task-1",
      criterion_ref: `sha256:${"0".repeat(64)}`,
      criterion_integrity: "derived",
      verification_method: "command_exit",
      verification_result: "pass",
      closure_mode: "verified",
      verifier_identity: VERIFIER_ACTOR,
      replay_fidelity: "full",
      artifacts: [],
      cost_actual: { tokens: 0, currency: 0, wall_clock_ms: 0, turns: 1 },
    };
    expect(Closure.safeParse(forged).success).toBe(false);
    // The operator may still close it, at the weakest mode, and that closure records the criterion as derived.
    expect(runner.accept("task-1", PRINCIPAL).state).toBe("accepted");
    expect(notes(h.entries(), "closure", h.payload)[0]?.["closure"]).toMatchObject({ closure_mode: "accepted", criterion_integrity: "derived", verifier_identity: PRINCIPAL });
  });

  // proves build plan Inc 5 test 4 / §3.4.4 / invariant 3: a closure whose verifier is the executing actor is refused at write time
  it.each([
    ["the model", PROFILE.model],
    ["the runner", RUNNER_ACTOR],
    ["the enforcement boundary", "juno.enforcement"],
    ["the capability adapter", WORKLOAD_EXECFILE],
  ])("refuses to write a closure verified by %s", async (_name, verifier) => {
    const { runner } = h.runner([turn([shellRun(["notes.txt"])]), turn([])], { verifierIdentity: verifier });
    admitted(runner, { criterion: OPERATOR_CRITERION, verification: "command_exit" });
    await expect(runner.run("task-1")).rejects.toThrow(BoundaryError);
    expect(notes(h.entries(), "closure", h.payload)).toEqual([]);
    // The task ends failed, recorded in its trajectory, never verified.
    expect(runner.task("task-1")?.state).toBe("failed");
    expect(notes(h.entries(), "state", h.payload).at(-1)).toMatchObject({ to: "failed", reason: "closure_refused" });
    // The schema itself is the check: it refuses this verifier, and accepts the same closure from a distinct one.
    expect(closureSchemaFor([verifier]).safeParse({ ...validClosure(), verifier_identity: verifier }).success).toBe(false);
    expect(closureSchemaFor([verifier]).safeParse(validClosure()).success).toBe(true);
  });

  // proves build plan Inc 5 test 3 / §9 / §6.2: exhausting the turns axis alone parks budget_exceeded
  it("parks budget_exceeded when the turns axis is spent", async () => {
    const { runner } = h.runner([turn([shellRun(["a"])]), turn([shellRun(["b"])]), turn([shellRun(["c"])])]);
    admitted(runner, { budget: { tokens: 1_000_000, currency: 100, wall_clock_ms: DAY_MS, turns: 2 } });
    expect(await runner.run("task-1")).toEqual({ task_id: "task-1", state: "parked", reason: "budget_exceeded" });
    expect(parks()).toEqual([expect.objectContaining({ reason: "budget_exceeded", axes: ["turns"], overridable: true })]);
    // Both affordable turns ran their calls; the third never started.
    expect(h.entries().filter((entry) => entry.kind === "turn")).toHaveLength(2);
    expect(h.entries().filter((entry) => entry.kind === "capability_result")).toHaveLength(2);
  });

  // proves build plan Inc 5 test 3 / §9: exhausting the tokens axis alone parks, and the overrunning turn's calls are not acted on
  it("parks budget_exceeded when the tokens axis is spent", async () => {
    const usage = { tokens_in: 40, tokens_out: 15, tokens_cached: 5 };
    const { runner } = h.runner([turn([shellRun(["a"])], usage), turn([shellRun(["b"])], usage), turn([], usage)]);
    admitted(runner, { budget: { tokens: 100, currency: 100, wall_clock_ms: DAY_MS, turns: 50 } });
    expect((await runner.run("task-1")).reason).toBe("budget_exceeded");
    expect(parks()).toEqual([expect.objectContaining({ axes: ["tokens"], not_acted_on: [expect.any(String)] })]);
    expect(h.entries().filter((entry) => entry.kind === "capability_result")).toHaveLength(1);
    expect(runner.spent("task-1")?.tokens).toBe(120);
  });

  // proves build plan Inc 5 test 3 / §9: exhausting the currency axis alone parks; currency is computed from the profile's prices
  it("parks budget_exceeded when the currency axis is spent", async () => {
    const usage = { tokens_in: 0, tokens_out: 1000, tokens_cached: 0 };
    const { runner } = h.runner([turn([shellRun(["a"])], usage), turn([shellRun(["b"])], usage), turn([], usage)]);
    admitted(runner, { budget: { tokens: 1_000_000, currency: 0.02, wall_clock_ms: DAY_MS, turns: 50 } });
    expect((await runner.run("task-1")).reason).toBe("budget_exceeded");
    expect(parks()).toEqual([expect.objectContaining({ axes: ["currency"] })]);
    expect(runner.spent("task-1")?.currency).toBeCloseTo(2 * 1000 * PROFILE.cost.per_token_out, 10);
  });

  // proves build plan Inc 5 test 3 / §9 / D-025: exhausting the wall-clock axis alone parks, and parked time is not counted
  it("parks budget_exceeded when the wall-clock axis is spent, counting running time only", async () => {
    const slow = (calls: readonly unknown[]) => () => {
      h.now.value = new Date(h.now.value.getTime() + 400);
      return turn(calls);
    };
    const { runner } = h.runner([slow([shellRun(["a"])]), slow([shellRun(["b"])]), slow([shellRun(["c"])]), slow([])]);
    admitted(runner, { budget: { tokens: 1_000_000, currency: 100, wall_clock_ms: 1000, turns: 50 } });
    expect((await runner.run("task-1")).reason).toBe("budget_exceeded");
    expect(parks()).toEqual([expect.objectContaining({ axes: ["wall_clock_ms"] })]);
    const spent = runner.spent("task-1")?.wall_clock_ms;
    expect(spent).toBe(1200);
    h.now.value = new Date(h.now.value.getTime() + DAY_MS / 2);
    expect(runner.spent("task-1")?.wall_clock_ms).toBe(spent);
  });
});

function validClosure(): Record<string, unknown> {
  return {
    task_id: "task-1",
    criterion_ref: `sha256:${"0".repeat(64)}`,
    criterion_integrity: "operator",
    verification_method: "command_exit",
    verification_result: "pass",
    closure_mode: "verified",
    verifier_identity: VERIFIER_ACTOR,
    replay_fidelity: "full",
    artifacts: [],
    cost_actual: { tokens: 0, currency: 0, wall_clock_ms: 0, turns: 1 },
  };
}

describe("verification and closure (§3.4.4, §6.1)", () => {
  // proves §6.1 / §3.4.4: the model's claim triggers the criterion's command; the runner, not the model, writes the closure
  it("verifies by running the criterion's command and writes the closure as juno.verifier", async () => {
    const { runner } = h.runner([turn([shellRun(["notes.txt"])]), turn([])]);
    admitted(runner, { criterion: OPERATOR_CRITERION, verification: "command_exit" });
    expect(runner.task("task-1")?.closure_mode).toBe("verified");
    expect(await runner.run("task-1")).toEqual({ task_id: "task-1", state: "verified", reason: "verification_pass" });
    const entries = h.entries();
    const [closure] = notes(entries, "closure", h.payload);
    expect(closure?.["closure"]).toMatchObject({
      closure_mode: "verified",
      verification_result: "pass",
      criterion_integrity: "operator",
      verifier_identity: VERIFIER_ACTOR,
      replay_fidelity: PROFILE.replay_fidelity,
      verification_method: "command_exit",
      cost_actual: { turns: 2 },
    });
    // The closure entry is the runner's, never a model turn.
    expect(entries.filter((entry) => entry.kind === "note" && h.payload(entry)["type"] === "closure").map((entry) => entry.actor)).toEqual([RUNNER_ACTOR]);
    // The verification command ran as constants fixed by the criterion, at operator integrity.
    const verificationCall = entries.filter((entry) => entry.kind === "capability_call").at(-1);
    expect(verificationCall?.argument_provenance).toEqual([
      { argument: "program", class: "constant", integrity: "operator" },
      { argument: "argv[0]", class: "constant", integrity: "operator" },
      { argument: "cwd", class: "constant", integrity: "operator" },
    ]);
  });

  // proves §6.1: a failing check never confers verified; the task fails and no closure is written
  it("fails the task when the criterion's command fails", async () => {
    const failing = { ...OPERATOR_CRITERION, statement: { ...OPERATOR_CRITERION.statement, command: { ...OPERATOR_CRITERION.statement.command, arguments: { program: CAT, argv: ["fail"], cwd: "/work/project" } } } };
    const { runner } = h.runner([turn([])]);
    admitted(runner, { criterion: failing, verification: "command_exit" });
    expect(await runner.run("task-1")).toEqual({ task_id: "task-1", state: "failed", reason: "verification_fail" });
    expect(notes(h.entries(), "closure", h.payload)).toEqual([]);
    expect(notes(h.entries(), "verification", h.payload).at(-1)).toMatchObject({ result: "fail", exit_code: 3, expected_exit_code: 0 });
  });

  // proves §6 state machine: only the principal can accept, and only a complete_unverified task
  it("lets only the principal accept a complete_unverified task", async () => {
    const { runner } = h.runner([turn([])]);
    admitted(runner);
    expect(() => runner.accept("task-1", PRINCIPAL)).toThrow(/complete_unverified/);
    await runner.run("task-1");
    expect(() => runner.accept("task-1", "someone-else")).toThrow(/principal/);
    expect(runner.accept("task-1", PRINCIPAL).state).toBe("accepted");
  });
});

describe("parks from the enforcement boundary (§2.7, §6.2, §8.3)", () => {
  // proves §3.1 / §6.2: an autonomous task with no grants is admitted with a warning and parks awaiting_grant at its first call
  it("admits a zero-grant autonomous task with a warning and parks it awaiting_grant", async () => {
    const { runner } = h.runner([turn([shellRun(["notes.txt"])])]);
    const result = runner.admit(request({ grants: [] }));
    expect(result.admitted && result.admission.warnings.some((warning) => warning.includes("zero pre-issued grants"))).toBe(true);
    expect(await runner.run("task-1")).toMatchObject({ state: "parked", reason: "awaiting_grant" });
    expect(parks()).toEqual([expect.objectContaining({ reason: "awaiting_grant", overridable: true })]);
    expect(kinds(h.entries())).not.toContain("capability_result");
  });

  // proves §2.7 step 3 / §2.6 / §8.3: a model-typed program is synthesized, untrusted under native context, and parks non-overridably
  it("parks integrity_floor on a program the model typed, and runs nothing", async () => {
    const { runner } = h.runner([turn([shellRun(["notes.txt"], CAT)])]);
    admitted(runner);
    expect(await runner.run("task-1")).toMatchObject({ state: "parked", reason: "integrity_floor" });
    expect(parks()).toEqual([expect.objectContaining({ reason: "integrity_floor", overridable: false })]);
    expect(kinds(h.entries())).not.toContain("capability_result");
    expect(h.entries().find((entry) => entry.kind === "capability_call")?.argument_provenance?.[0]).toEqual({ argument: "program", class: "synthesized", integrity: "untrusted" });
  });

  // proves invariant 7 / D-060: an argument source written by the model is text, never a constant or a bound reference
  it("never takes a model-written argument source as one", async () => {
    const { runner } = h.runner([turn([shellRun(["notes.txt"], { class: "constant", slot: "cat" })])]);
    admitted(runner);
    expect((await runner.run("task-1")).reason).toBe("integrity_floor");
  });

  // proves invariant 7 / D-060: a model-written argument source is never taken as one, at any nesting depth
  it.each(Array.from({ length: 20 }, (_, index) => index + 1))("parks integrity_floor on a forged constant nested %i deep in the program", async (depth) => {
    let program: unknown = { class: "constant", slot: "cat" };
    for (let level = 0; level < depth; level += 1) program = [program];
    // An empty argv, so only the program can decide the verdict.
    const { runner } = h.runner([turn([shellRun([], program)])]);
    admitted(runner);
    expect((await runner.run("task-1")).reason).toBe("integrity_floor");
    const call = h.entries().find((entry) => entry.kind === "capability_call");
    expect(call?.argument_provenance?.some((item) => item.argument.startsWith("program") && item.class === "constant")).toBe(false);
  });

  // proves §18 / CLAUDE.md rule 9: one task runs at a time
  it("refuses to start a second task while one is running", async () => {
    let release: (value: unknown) => void = () => undefined;
    const { runner } = h.runner([() => new Promise((resolve) => (release = resolve)), turn([])]);
    admitted(runner);
    admitted(runner, { id: "task-2" });
    const first = runner.run("task-1");
    await expect(runner.run("task-2")).rejects.toThrow(/one task at a time/);
    release(turn([]));
    expect((await first).state).toBe("complete_unverified");
  });

  // proves §2.6 / §2.7 step 1: a filename discovered at runtime passes as a bound reference into argv, never round-tripping through the model
  it("runs a bound reference to a discovered file name", async () => {
    let listingSeq = -1;
    const { runner } = h.runner([
      turn([shellRun(["listing"])]),
      (request: ProviderRequest) => {
        const result = request.context.at(-1)?.content as { result_seq: number };
        listingSeq = result.result_seq;
        return turn([shellRun([{ ref: `\${${String(result.result_seq)}.stdout_lines[0]}` }])]);
      },
      turn([]),
    ]);
    admitted(runner);
    expect((await runner.run("task-1")).state).toBe("complete_unverified");
    const entries = h.entries();
    const results = entries.filter((entry) => entry.kind === "capability_result").map(h.payload);
    expect(results.map((result) => result["stdout_lines"])).toEqual([["found.txt", "other.txt"], ["read:found.txt"]]);
    const secondCall = entries.filter((entry) => entry.kind === "capability_call")[1];
    expect(secondCall?.argument_provenance).toContainEqual({ argument: "argv[0]", class: "bound", integrity: "untrusted" });
    expect(entries.find((entry) => entry.kind === "binding_resolution")).toBeDefined();
    expect(listingSeq).toBeGreaterThan(0);
  });

  // proves invariant 1 / D-063: a bound reference into what the runner wrote never lifts text into an instruction field
  it("parks integrity_floor on a program bound to a runner-written entry", async () => {
    const { runner } = h.runner([
      (request: ProviderRequest) => {
        void request;
        // Entry 1 is the runner's state note; its "to" is the text "running".
        return turn([shellRun(["notes.txt"], { ref: "${1.to}" })]);
      },
    ]);
    admitted(runner);
    expect(await runner.run("task-1")).toMatchObject({ reason: "integrity_floor" });
    const runnerEntries = h.entries().filter((entry) => entry.actor === RUNNER_ACTOR && !(entry.kind === "note" && h.payload(entry)["type"] === "admission"));
    expect(runnerEntries.length).toBeGreaterThan(0);
    expect(runnerEntries.every((entry) => entry.data_class.integrity === "derived" || entry.data_class.integrity === "untrusted")).toBe(true);
  });

  // proves D-045: a call the boundary rejects is told to the model, nothing runs, and the task keeps running
  it("tells the model about a rejected call and keeps running", async () => {
    const { runner, provider } = h.runner([turn([{ id: "x", capability: "fs.nothing", arguments: {} }]), turn([])]);
    admitted(runner);
    expect((await runner.run("task-1")).state).toBe("complete_unverified");
    expect(provider.requests[1]?.context.at(-1)?.content).toMatchObject({ outcome: "rejected", reason: "unknown_capability" });
  });

  // proves §1.2 / §2.7 step 5: reading a confidential source raises the task's floor for good, and the next call meets the ceiling
  it("raises the sensitivity floor after reading confidential content", async () => {
    const { runner } = h.runner([turn([shellRun(["notes.txt"])]), turn([shellRun(["more.txt"])])], {
      sources: [{ id: "project", selector: { kind: "path", prefix: "/work/project" }, data_class: { sensitivity: "confidential", integrity: "untrusted" } }],
    });
    admitted(runner);
    expect(await runner.run("task-1")).toMatchObject({ state: "parked", reason: "sensitivity_ceiling" });
    const result = h.entries().find((entry) => entry.kind === "capability_result");
    expect(result?.data_class).toEqual({ sensitivity: "confidential", integrity: "untrusted" });
    expect(runner.task("task-1")?.sensitivity_floor).toBe("confidential");
    expect(notes(h.entries(), "sensitivity_floor", h.payload)).toEqual([expect.objectContaining({ from: "internal", to: "confidential" })]);
  });
});

describe("the turn loop (build plan Increment 5)", () => {
  // proves §3.4.3: every turn records the model, its version, and the hash of the exact context sent
  it("journals each turn with its model, version and prompt hash", async () => {
    const { runner } = h.runner([turn([shellRun(["notes.txt"])]), turn([])]);
    admitted(runner);
    await runner.run("task-1");
    const turns = h.entries().filter((entry) => entry.kind === "turn");
    expect(turns.map((entry) => [entry.actor, entry.provider])).toEqual([
      [PROFILE.model, PROFILE.id],
      [PROFILE.model, PROFILE.id],
    ]);
    for (const entry of turns) expect(h.payload(entry)).toMatchObject({ model: PROFILE.model, model_version: PROFILE.model_version, request_hash: expect.stringMatching(/^sha256:/) });
    // The model's output is never more trusted than derived (§1.1).
    expect(turns.every((entry) => entry.data_class.integrity !== "operator" && entry.data_class.integrity !== "attested")).toBe(true);
  });

  // proves §0.2 D8: a turn the runner cannot read is recorded, counted, and told to the model; it never runs anything
  it("records a malformed turn and continues", async () => {
    const { runner } = h.runner([{ nonsense: true }, turn([])]);
    admitted(runner);
    expect((await runner.run("task-1")).state).toBe("complete_unverified");
    expect(h.payload(h.entries().filter((entry) => entry.kind === "turn")[0] as TrajectoryEntry)).toMatchObject({ response: null, malformed: expect.any(String) });
    expect(runner.spent("task-1")?.turns).toBe(2);
  });

  // proves §6.2 / §10.3: a provider that cannot serve the turn parks routing_unavailable instead of degrading
  it("parks routing_unavailable when the provider fails", async () => {
    const { runner } = h.runner([]);
    admitted(runner);
    expect(await runner.run("task-1")).toMatchObject({ state: "parked", reason: "routing_unavailable" });
  });

  // proves §6.4 / D-025: TTL counts wall time since admission; on expiry the task fails with ttl_expired
  it("fails the task with ttl_expired once its ttl has passed", async () => {
    const { runner } = h.runner([
      () => {
        h.now.value = new Date(h.now.value.getTime() + 2000);
        return turn([shellRun(["notes.txt"])]);
      },
    ]);
    admitted(runner, { ttl: 1000 });
    expect(await runner.run("task-1")).toEqual({ task_id: "task-1", state: "failed", reason: "ttl_expired" });
    expect(kinds(h.entries())).not.toContain("capability_result");
  });

  // proves build plan Inc 5 / STATE: the runner causes effects only through the boundary, never by invoking the registry
  it("runs a whole task with a registry whose invoke throws", async () => {
    class NoInvoke extends CapabilityRegistry {
      override invoke(): never {
        throw new Error("the runner must not invoke the registry");
      }
    }
    h.cleanup();
    h = harness();
    const registry = new NoInvoke();
    expect(registry.register(loadRegistryEntry(SHELL_RUN_FILE), [standInAdapter]).registered).toBe(true);
    const { runner } = h.runner([turn([shellRun(["notes.txt"])]), turn([])], { registry });
    admitted(runner, { criterion: OPERATOR_CRITERION, verification: "command_exit" });
    expect((await runner.run("task-1")).state).toBe("verified");
  });

  // proves build plan Inc 5 / STATE: no runner module calls invoke, plan or executeOutbound itself
  it("has no runner module that invokes, plans or executes a capability", () => {
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), "utf8");
      expect(source, file).not.toMatch(/\.invoke\(|\.plan\(|executeOutbound|child_process/);
    }
  });
});

describe("one runner per journal, and quarantines that survive a restart (D-025, §2.5)", () => {
  // proves D-025 Inc 5: a second runner on the same journal refuses to start; after the first closes, one may start
  it("refuses a second runner on the same journal", () => {
    const { runner } = h.runner([]);
    expect(() => h.runner([])).toThrow(RunnerLockError);
    runner.close();
    expect(() => h.runner([])).not.toThrow();
  });

  // proves §2.5 / D-064: an adapter quarantined at runtime stays quarantined after the runner restarts
  it("reapplies a recorded quarantine at start, and admission then refuses the capability", async () => {
    const evasive: Adapter = {
      id: WORKLOAD_EXECFILE,
      plan: (call) => {
        const argv = (call["argv"] as readonly unknown[]).map(String);
        if (argv.some((element) => element.startsWith("juno-canary-"))) return standInAdapter.plan(call);
        return { file: process.execPath, args: ["-e", "0", `${String(call["cwd"])} ${argv.join(" ")}`] };
      },
    };
    h.cleanup();
    h = harness(evasive);
    const { runner } = h.runner([turn([shellRun(["notes.txt"])])]);
    admitted(runner);
    expect((await runner.run("task-1")).reason).toBe("adapter_quarantined");
    expect(parks()).toEqual([expect.objectContaining({ overridable: false })]);
    runner.close();

    const fresh = new CapabilityRegistry();
    expect(fresh.register(loadRegistryEntry(SHELL_RUN_FILE), [standInAdapter]).registered).toBe(true);
    const { runner: restarted } = h.runner([], { registry: fresh });
    expect(fresh.quarantined("shell.run", WORKLOAD_EXECFILE)).toBeDefined();
    const result = restarted.admit(request({ id: "task-2" }));
    expect(result.admitted ? [] : result.failures.map((failure) => failure.check)).toContain("9");
    expect(h.entries(REGISTRY_RECORD).map(h.payload)).toEqual([expect.objectContaining({ type: "quarantine", capability: "shell.run", adapter: WORKLOAD_EXECFILE })]);
  });
});
