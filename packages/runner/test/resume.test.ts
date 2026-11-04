import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TrajectoryEntry } from "../../contracts/src/index.js";
import { GrantStore } from "../../enforcement/src/index.js";
import { verifyTrajectory } from "../../journal/src/index.js";
import { entriesFile, headFile } from "../../journal/src/layout.js";
import { CapabilityRegistry, WORKLOAD_EXECFILE, loadRegistryEntry } from "../../registry/src/index.js";
import type { ProviderRequest } from "../src/provider.js";
import { RUNNER_RECORD, type Runner, RunnerError } from "../src/runner.js";
import { DAY_MS, type Harness, OPERATOR_CRITERION, PROFILE, SHELL_RUN_FILE, grant, harness, request, shellRun, standInAdapter, turn, writeWork } from "./helpers.js";
import { TEST_ANCHOR } from "../../enforcement/test/test-keys.js";

// Increment 6: resume (§6.3) and TTL (§6.4).

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  h.cleanup();
});

const HOUR = 60 * 60 * 1000;
const later = (ms: number): void => {
  h.now.value = new Date(h.now.value.getTime() + ms);
};
/** A provider turn that fails: the task parks routing_unavailable, a park any grant could follow. */
const unavailable = (): never => {
  throw new Error("provider down");
};
const admitted = (runner: Runner, overrides: Record<string, unknown> = {}): void => {
  const result = runner.admit(request(overrides));
  if (!result.admitted) throw new Error(`not admitted: ${JSON.stringify(result.failures)}`);
};
const ofKind = (kind: TrajectoryEntry["kind"], taskId = "task-1"): Record<string, unknown>[] => h.entries(taskId).filter((entry) => entry.kind === kind).map(h.payload);

/** A new runner on the same journal, as after a restart: a fresh registry and a fresh grant store holding the same grants. */
function restart(steps: Parameters<Harness["runner"]>[0], grants: readonly Record<string, unknown>[] = [grant()]): { runner: Runner; requests: ProviderRequest[] } {
  const registry = new CapabilityRegistry();
  registry.register(loadRegistryEntry(SHELL_RUN_FILE), [standInAdapter]);
  const store = new GrantStore(TEST_ANCHOR);
  for (const item of grants) store.add(item);
  const { runner, provider } = h.runner(steps, { registry, grants: store });
  return { runner, requests: provider.requests };
}

describe("build plan Increment 6 tests", () => {
  // proves build plan Inc 6 test 1 / §6.3 step 1 / §3.2: a grant that expires while the task is parked re-parks it on resume; nothing proceeds
  it("re-parks on resume when its grant expired while parked", async () => {
    h.grants.add(grant({ id: "grant-short", expires_at: new Date(h.now.value.getTime() + HOUR).toISOString() }));
    const { runner, provider } = h.runner([unavailable, turn([shellRun(["notes.txt"])]), turn([])]);
    admitted(runner, { grants: ["grant-short"] });
    expect((await runner.run("task-1")).reason).toBe("routing_unavailable");
    later(2 * HOUR);
    expect(await runner.resume("task-1")).toEqual({ task_id: "task-1", state: "parked", reason: "awaiting_grant" });
    // No turn ran after the resume, and the resume entry says why.
    expect(provider.requests).toHaveLength(1);
    expect(ofKind("capability_result")).toEqual([]);
    expect(ofKind("resume")).toEqual([expect.objectContaining({ grants: [expect.objectContaining({ grant: "grant-short", refused: "expired" })] })]);
    expect(ofKind("park").at(-1)).toMatchObject({ reason: "awaiting_grant", phase: "resume", refused: [{ grant: "grant-short", reason: "expired" }] });
  });

  // proves §6.3 step 1: a grant revoked while parked also re-parks; agent resumed is not agent still authorized
  it("re-parks on resume when its grant was revoked while parked", async () => {
    const { runner } = h.runner([unavailable, turn([])]);
    admitted(runner);
    await runner.run("task-1");
    h.grants.revoke("grant-1", h.now.value);
    expect((await runner.resume("task-1")).reason).toBe("awaiting_grant");
    // A resume that re-parks leaves the runner free: the same task can be resumed again, and another task can run.
    expect((await runner.resume("task-1")).reason).toBe("awaiting_grant");
    admitted(runner, { id: "task-2", grants: [] });
    expect((await runner.run("task-2")).state).toBe("complete_unverified");
  });

  // proves §6.3 / D-066: an unusable grant can be dropped on resume (only narrowing authority) and a fresh one added
  it("resumes once a used-up grant is dropped and a fresh one added", async () => {
    h.grants.add(grant({ id: "grant-once", max_invocations: 1 }));
    const { runner } = h.runner([turn([shellRun(["a"])]), turn([shellRun(["b"])]), turn([shellRun(["b"])]), turn([])]);
    admitted(runner, { grants: ["grant-once"] });
    expect((await runner.run("task-1")).reason).toBe("awaiting_grant");
    // Adding a grant alone is not enough while the used-up one stays on the task.
    expect((await runner.resume("task-1", { grants: ["grant-1"] })).reason).toBe("awaiting_grant");
    await expect(runner.resume("task-1", { remove_grants: ["grant-none"] })).rejects.toThrow(/must be on the task/);
    expect((await runner.resume("task-1", { remove_grants: ["grant-once"] })).state).toBe("complete_unverified");
    expect(runner.task("task-1")?.grants).toEqual(["grant-1"]);
    expect(ofKind("resume").at(-1)).toMatchObject({ removed_grants: ["grant-once"], grants: [expect.objectContaining({ grant: "grant-1", refused: null })] });
  });

  // proves §6.3: with its grants still valid, the same task resumes and runs to the end (the control for the two tests above)
  it("resumes and proceeds when every grant is still valid", async () => {
    const { runner } = h.runner([unavailable, turn([shellRun(["notes.txt"])]), turn([])]);
    admitted(runner);
    await runner.run("task-1");
    later(2 * HOUR);
    expect((await runner.resume("task-1")).state).toBe("complete_unverified");
    expect(ofKind("capability_result")).toHaveLength(1);
  });

  // proves build plan Inc 6 test 2 / §6.4 / D-025: TTL counts parked time; on expiry the task fails and holds nothing
  it("fails a task whose ttl ran out while parked, and releases it", async () => {
    const { runner, provider } = h.runner([unavailable, turn([]), turn([])]);
    admitted(runner, { ttl: 3 * HOUR });
    await runner.run("task-1");
    // Barely any running time was spent; the TTL runs out on parked time alone.
    expect(runner.spent("task-1")?.wall_clock_ms).toBe(0);
    later(4 * HOUR);
    expect(await runner.resume("task-1")).toEqual({ task_id: "task-1", state: "failed", reason: "ttl_expired" });
    expect(provider.requests).toHaveLength(1);
    // Released: it can never resume, the runner is free for another task, and a restart sees it failed too.
    await expect(runner.resume("task-1")).rejects.toThrow(RunnerError);
    admitted(runner, { id: "task-2" });
    expect((await runner.run("task-2")).state).toBe("complete_unverified");
    runner.close();
    const { runner: next } = restart([]);
    await expect(next.resume("task-1")).rejects.toThrow(/failed/);
  });
});

describe("resume across a restart (§6.3, §3.4.5, D-066)", () => {
  // proves §3.4.5: a parked task is rebuilt from the journal alone and continues with the same context, spend and grant counts
  it("rebuilds a parked task from its journal after a restart", async () => {
    const capped = grant({ max_invocations: 2 });
    h.cleanup();
    h = harness();
    const store = new GrantStore(TEST_ANCHOR);
    store.add(capped);
    const usage = { tokens_in: 7, tokens_out: 3, tokens_cached: 0 };
    const first = h.runner([turn([shellRun(["notes.txt"])], usage), unavailable], { grants: store });
    admitted(first.runner);
    expect((await first.runner.run("task-1")).reason).toBe("routing_unavailable");
    const spentBefore = first.runner.spent("task-1");
    const contextBefore = first.provider.requests[0]?.context;
    first.runner.close();

    later(DAY_MS / 4);
    const second = restart([turn([shellRun(["more.txt"])], usage), turn([shellRun(["again.txt"])], usage)], [capped]);
    const outcome = await second.runner.resume("task-1");
    // The rebuilt context starts with exactly what the first runner sent.
    expect(second.requests[0]?.context.slice(0, contextBefore?.length)).toEqual(contextBefore);
    // One charge survived the restart: the second call uses the last invocation, the third finds the grant exhausted.
    expect(outcome).toEqual({ task_id: "task-1", state: "parked", reason: "awaiting_grant" });
    expect(ofKind("park").at(-1)).toMatchObject({ detail: { reason: "awaiting_grant", refused: [{ grant: "grant-1", reason: "exhausted" }] } });
    expect(ofKind("capability_result")).toHaveLength(2);
    // Spend carried over, parked time excluded.
    expect(ofKind("resume")[0]?.["spent"]).toEqual(spentBefore);
    expect(second.runner.spent("task-1")?.turns).toBe(4);
    expect(second.runner.spent("task-1")?.tokens).toBe(30);
  });

  // proves §6.3 steps 2 and 3: on resume the model policy is re-evaluated against the providers available now
  it("re-parks routing_unavailable on resume when the task's provider is no longer served", async () => {
    const { runner } = h.runner([unavailable]);
    admitted(runner);
    await runner.run("task-1");
    runner.close();
    const registry = new CapabilityRegistry();
    registry.register(loadRegistryEntry(SHELL_RUN_FILE), [standInAdapter]);
    const store = new GrantStore(TEST_ANCHOR);
    store.add(grant());
    const { runner: next, provider } = h.runner([turn([])], { registry, grants: store, profile: { ...PROFILE, id: "juno.other" } });
    expect((await next.resume("task-1")).reason).toBe("routing_unavailable");
    expect(provider.requests).toEqual([]);
    expect(ofKind("park").at(-1)).toMatchObject({ reason: "routing_unavailable", phase: "resume" });
    expect(ofKind("resume").at(-1)).toMatchObject({ provider_available: false, routable: false });
  });

  // proves §3.4.5 / D-066: a grant dropped on resume stays dropped when the task is rebuilt after a restart
  it("keeps a dropped grant dropped across a restart", async () => {
    h.grants.add(grant({ id: "grant-once", max_invocations: 1 }));
    const { runner } = h.runner([turn([shellRun(["a"])]), turn([shellRun(["b"])]), turn([shellRun(["b"])])]);
    admitted(runner, { grants: ["grant-once"] });
    await runner.run("task-1");
    // Dropped, with nothing added: the task runs again and parks at its next call, holding no grant.
    expect((await runner.resume("task-1", { remove_grants: ["grant-once"] })).reason).toBe("awaiting_grant");
    runner.close();
    const { runner: next } = restart([turn([shellRun(["c"])]), turn([])], [grant(), grant({ id: "grant-once", max_invocations: 1 })]);
    expect((await next.resume("task-1", { grants: ["grant-1"] })).state).toBe("complete_unverified");
    expect(next.task("task-1")?.grants).toEqual(["grant-1"]);
  });

  // proves D-056: a task whose journal fails verification after a crash is never resumed; it fails, with the reason recorded
  it("fails, and never resumes, a task whose journal does not verify", async () => {
    const { runner } = h.runner([unavailable]);
    admitted(runner);
    await runner.run("task-1");
    runner.close();
    // A crash between writing an entry and replacing the head (D-027).
    const entriesPath = entriesFile(h.journal.root, "task-1");
    const intact = readFileSync(entriesPath);
    appendFileSync(entriesPath, '{"forged":true}\n');
    const { runner: next, requests } = restart([turn([])]);
    expect(await next.resume("task-1")).toEqual({ task_id: "task-1", state: "failed", reason: "journal_unverifiable" });
    expect(requests).toEqual([]);
    expect(h.entries(RUNNER_RECORD).map(h.payload)).toContainEqual(expect.objectContaining({ type: "task_failed", task: "task-1", reason: "journal_unverifiable" }));
    next.close();
    // Even once the file is repaired by hand, so that it verifies again, the recorded failure stands.
    writeFileSync(entriesPath, intact);
    expect(verifyTrajectory(h.journal.root, "task-1").ok).toBe(true);
    const { runner: third, requests: thirdRequests } = restart([turn([])]);
    expect((await third.resume("task-1")).reason).toBe("journal_unverifiable");
    expect(thirdRequests).toEqual([]);
  });

  // proves D-066: a task the journal shows still running was cut off mid-run; it fails rather than risk repeating an effect
  it("fails a task that was running when its runner stopped", async () => {
    const { runner } = h.runner([() => new Promise(() => undefined)]);
    admitted(runner);
    void runner.run("task-1");
    await Promise.resolve();
    runner.close();
    const { runner: next, requests } = restart([turn([])]);
    expect(await next.resume("task-1")).toEqual({ task_id: "task-1", state: "failed", reason: "runner_interrupted" });
    expect(requests).toEqual([]);
  });

  // proves D-066: the runner's record is the only grant count, so it refuses a store that already holds charges
  it("refuses to start with a grant store that already has charges", () => {
    const store = new GrantStore(TEST_ANCHOR);
    store.add(grant());
    store.charge("grant-1");
    expect(() => h.runner([], { grants: store })).toThrow(/already has charges/);
  });

  // proves §0.2 D8: a head that no longer matches its entries is caught the same way
  it("fails a task whose head was replaced", async () => {
    const { runner } = h.runner([unavailable]);
    admitted(runner);
    await runner.run("task-1");
    runner.close();
    writeFileSync(headFile(h.journal.root, "task-1"), "{}");
    const { runner: next } = restart([turn([])]);
    expect((await next.resume("task-1")).reason).toBe("journal_unverifiable");
  });
});

describe("what resume will not do (§6.3, §8.3)", () => {
  // proves §8.3: a park that is not overridable is never cleared by resuming
  it.each([
    ["integrity_floor", () => [turn([shellRun(["notes.txt"], "/usr/bin/cat")])]],
    ["adapter_quarantined", null],
  ] as const)("never resumes a task parked %s", async (reason, steps) => {
    if (steps === null) {
      // Delivers the registration canary honestly and interpolates everything else (the §2.4 residual).
      h.cleanup();
      h = harness({
        id: WORKLOAD_EXECFILE,
        plan: (call) => {
          const argv = (call["argv"] as readonly unknown[]).map(String);
          if (argv.some((element) => element.startsWith("juno-canary-"))) return standInAdapter.plan(call);
          return { file: process.execPath, args: ["-e", "0", `${String(call["cwd"])} ${argv.join(" ")}`] };
        },
      });
    }
    const { runner } = h.runner(steps === null ? [turn([shellRun(["notes.txt"])])] : steps());
    admitted(runner);
    expect((await runner.run("task-1")).reason).toBe(reason);
    await expect(runner.resume("task-1")).rejects.toThrow(/not overridable/);
    expect(ofKind("resume")).toEqual([]);
  });

  // proves §6.4 over §8.3: a task on a non-overridable park still fails once its ttl has run out
  it("fails a task parked integrity_floor once its ttl has run out", async () => {
    const { runner } = h.runner([turn([shellRun(["notes.txt"], "/usr/bin/cat")])]);
    admitted(runner, { ttl: HOUR });
    expect((await runner.run("task-1")).reason).toBe("integrity_floor");
    later(2 * HOUR);
    expect(await runner.resume("task-1")).toEqual({ task_id: "task-1", state: "failed", reason: "ttl_expired" });
    expect(ofKind("resume")).toEqual([]);
  });

  // proves §6.3 / §5.3: a grant the operator issues while the task is parked can be added on resume, under admission's grant rules
  it("adds a grant issued while parked, and refuses one admission would refuse", async () => {
    const { runner } = h.runner([turn([shellRun(["notes.txt"])]), turn([shellRun(["notes.txt"])]), turn([])]);
    admitted(runner, { grants: [] });
    expect((await runner.run("task-1")).reason).toBe("awaiting_grant");
    h.grants.add(grant({ id: "grant-wide", resource_scope: [{ kind: "path", prefix: "/work" }] }));
    await expect(runner.resume("task-1", { grants: ["grant-wide"] })).rejects.toThrow(/grant rules/);
    // §3.2 C1 (D-125): an unsigned grant does not exist, so it cannot be added on resume either.
    const { signature: _signature, ...unsigned } = grant({ id: "grant-unsigned" });
    void _signature;
    h.grants.add(unsigned);
    await expect(runner.resume("task-1", { grants: ["grant-unsigned"] })).rejects.toThrow(/no valid operator signature/);
    expect((await runner.resume("task-1", { grants: ["grant-1"] })).state).toBe("complete_unverified");
    expect(ofKind("resume")).toEqual([expect.objectContaining({ added_grants: ["grant-1"], parked_reason: "awaiting_grant" })]);
    // The model is told the parked call was not run.
    expect(ofKind("capability_result")).toHaveLength(1);
  });

  // proves D-067: when the first protected-path listing parked, it is taken on resume, and the task can still close verified
  it("takes the protected-path baseline on resume when the first listing parked", async () => {
    const { runner, provider } = h.runner([turn([]), turn([])]);
    admitted(runner, { criterion: OPERATOR_CRITERION, verification: "command_exit" });
    h.grants.revoke("grant-1", h.now.value);
    expect(await runner.run("task-1")).toMatchObject({ state: "parked", reason: "awaiting_grant" });
    expect(ofKind("park")[0]).toMatchObject({ phase: "protected_baseline" });
    expect(provider.requests).toEqual([]);
    h.grants.add(grant({ id: "grant-2" }));
    expect(await runner.resume("task-1", { grants: ["grant-2"], remove_grants: ["grant-1"] })).toEqual({ task_id: "task-1", state: "verified", reason: "verification_pass" });
    expect(ofKind("note").filter((note) => note["type"] === "protected_listing").map((note) => note["phase"])).toEqual(["baseline", "check"]);
  });

  // proves §6.3: only a parked task resumes
  it("refuses to resume a task that is not parked", async () => {
    const { runner } = h.runner([turn([])]);
    admitted(runner, { criterion: OPERATOR_CRITERION, verification: "command_exit" });
    await runner.run("task-1");
    await expect(runner.resume("task-1")).rejects.toThrow(/only a parked task resumes/);
  });
});

describe("§3.4.4 B2 across a restart (D-112)", () => {
  // proves §3.4.5 / §3.4.4 B2: a task rebuilt from its journal hashes the same pinned files at closure and is checked against
  // the pins taken at admission, so a restart neither drops a pin nor lets a change through
  it("checks a rebuilt task against the pins taken before the restart", async () => {
    const { runner } = h.runner([unavailable]);
    admitted(runner, { criterion: OPERATOR_CRITERION, verification: "command_exit" });
    expect((await runner.run("task-1")).reason).toBe("routing_unavailable");
    runner.close();
    const unchanged = restart([turn([])]);
    expect((await unchanged.runner.resume("task-1")).state).toBe("verified");
    const verification = ofKind("note").filter((note) => note["type"] === "verification").at(-1);
    expect(verification).toMatchObject({ result: "pass", inputs: "unchanged" });
    // The closure's hashes covered the files fixed at admission.
    const [baseline, check] = ofKind("note").filter((note) => note["type"] === "verification_pins");
    expect(Object.keys((check?.["pins"] ?? {}) as object)).toEqual(Object.keys((baseline?.["pins"] ?? {}) as object));
    unchanged.runner.close();

    h.cleanup();
    h = harness();
    const second = h.runner([unavailable]);
    admitted(second.runner, { criterion: OPERATOR_CRITERION, verification: "command_exit" });
    await second.runner.run("task-1");
    second.runner.close();
    writeWork({ "/work/project/done.txt": "OK\n" });
    const changed = restart([turn([])]);
    expect((await changed.runner.resume("task-1")).reason).toBe("verification_fail");
    expect(ofKind("note").filter((note) => note["type"] === "verification").at(-1)?.["changed_paths"]).toEqual(["/work/project/done.txt"]);
  });
});
