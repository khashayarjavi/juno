import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ContextOwnership, WORK_NAMESPACE } from "../../contracts/src/index.js";
import { WORKLOAD_EXECFILE, loadRegistryEntry } from "../../registry/src/index.js";
import { DIRECT_STRATEGY, admit, deriveContextOwnership, deriveSteerCapability, routable } from "../src/admission.js";
import type { ProviderProfile } from "../src/profile.js";
import { toProposal } from "../src/translate.js";
import { CAT, type Harness, OPERATOR_CRITERION, PROFILE, PROJECT_SOURCE, SHELL_RUN_FILE, grant, harness, request, standInAdapter } from "./helpers.js";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  h.cleanup();
});

const env = (overrides: { providers?: readonly ProviderProfile[] } = {}) => ({
  registry: h.registry,
  grants: h.grants,
  providers: overrides.providers ?? [PROFILE],
  sources: [PROJECT_SOURCE, { id: "loose", selector: { kind: "path" as const, prefix: "/work/loose" }, data_class: "unclassified" as const }],
  now: h.now.value,
});
const failedChecks = (input: unknown, overrides: Parameters<typeof env>[0] = {}): string[] => {
  const result = admit(input, env(overrides));
  return result.admitted ? [] : result.failures.map((failure) => failure.check);
};

describe("§5.4 admission checks", () => {
  // proves §3.2 C1 (D-125): a grant with a missing or forged signature does not exist, so admission refuses a task naming it
  it("refuses a task whose grant is unsigned or forged", () => {
    const { signature: _signature, ...unsigned } = grant({ id: "grant-unsigned" });
    void _signature;
    h.grants.add(unsigned);
    h.grants.add({ ...grant({ id: "grant-forged" }), max_invocations: 99 });
    for (const id of ["grant-unsigned", "grant-forged"]) {
      const result = admit(request({ grants: [id] }), env());
      expect(result.admitted, id).toBe(false);
      if (result.admitted) continue;
      expect(result.failures).toContainEqual(expect.objectContaining({ check: "3.2", message: `grant ${id} has no valid operator signature, so it does not exist (§3.2)` }));
    }
  });

  // proves §5.4 baseline: a complete request is admitted, with ownership and steer capability derived
  it("admits a complete request and derives what admission derives", () => {
    const result = admit(request({ criterion: OPERATOR_CRITERION, verification: "command_exit" }), env());
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    expect(result.admission.task).toMatchObject({
      state: "admitted",
      context_ownership: "native",
      steer_capability: "full",
      criterion_integrity: "operator",
      closure_mode: "verified",
      requires_live_steer: false,
    });
    // The criterion's literals are constants with the criterion's integrity (§2.6).
    // ... fixed for the verifier only (§2.6, v0.6 B1).
    expect(result.admission.constants["criterion.program"]).toEqual({ value: CAT, data_class: { sensitivity: "internal", integrity: "operator" }, actors: ["verifier"] });
    expect(result.admission.constants["criterion.argv.0"]?.value).toBe("done.txt");
    expect(result.admission.constants["cat"]).toEqual({ value: CAT, data_class: { sensitivity: "internal", integrity: "operator" }, actors: ["executing"] });
  });

  // proves §5.4 check 1 / §5.1: no objective, no task
  it.each(["", "   \n"])("rejects a missing objective %j (check 1)", (objective) => {
    expect(failedChecks(request({ objective }))).toContain("1");
  });

  // proves §5.4 check 2: a verification method needs a criterion, and only a known method is accepted
  it("rejects a verification method without a criterion, or one that does not exist (check 2)", () => {
    expect(failedChecks(request({ verification: "command_exit" }))).toContain("2");
    expect(failedChecks(request({ criterion: OPERATOR_CRITERION, verification: "vibes" }))).toContain("2");
  });

  // proves §5.4 check 2: a criterion's command must be a call the capability's interface accepts
  it("rejects a criterion whose command does not parse (check 2)", () => {
    const bad = { ...OPERATOR_CRITERION, statement: { ...OPERATOR_CRITERION.statement, command: { capability: "shell.run", arguments: { program: "/bin/sh", argv: [], cwd: "/work/project" } } } };
    expect(failedChecks(request({ criterion: bad, verification: "command_exit" }))).toContain("2");
  });

  // proves D-057 / D-025 Inc 7 / D-112: every criterion names protected paths the task's sources classify, and its
  // verification scope must be one its grants let the verifier pin (refused under D-112 since v0.6 B2)
  it("rejects a criterion without protected paths, or with ones it cannot check", () => {
    const withPaths = (paths: unknown) => ({ ...OPERATOR_CRITERION, statement: { ...OPERATOR_CRITERION.statement, protected_paths: paths } });
    expect(failedChecks(request({ criterion: withPaths([]), verification: "command_exit" }))).toEqual(["schema"]);
    const { protected_paths: _omitted, ...withoutPaths } = OPERATOR_CRITERION.statement;
    void _omitted;
    expect(failedChecks(request({ criterion: { ...OPERATOR_CRITERION, statement: withoutPaths }, verification: "command_exit" }))).toEqual(["schema"]);
    expect(failedChecks(request({ criterion: withPaths(["/work/elsewhere"]), verification: "command_exit" }))).toContain("D-057");
    h.grants.add(grant({ id: "grant-narrow", resource_scope: [{ kind: "path", prefix: "/work/project/src" }] }));
    expect(failedChecks(request({ criterion: OPERATOR_CRITERION, verification: "command_exit", grants: ["grant-narrow"] }))).toContain("D-112");
    expect(failedChecks(request({ criterion: OPERATOR_CRITERION, verification: "command_exit" }))).toEqual([]);
  });

  // proves §5.4 check 4 / §1.5: unregistered and unclassified sources are rejected, never defaulted
  it("rejects an unregistered or unclassified source (check 4)", () => {
    expect(failedChecks(request({ sources: ["nowhere"] }))).toContain("4");
    expect(failedChecks(request({ sources: ["project", "loose"] }))).toContain("4");
  });

  // proves §5.4 check 4: a grant may reach only content the task's sources classify
  it("rejects a grant that reaches outside every referenced source (check 4)", () => {
    h.grants.add(grant({ id: "grant-wide", resource_scope: [{ kind: "path", prefix: "/work/other" }] }));
    expect(failedChecks(request({ grants: ["grant-wide"] }))).toContain("4");
  });

  // proves §5.4 check 5 / §10.3: the policy must be satisfiable by a registered provider
  it("rejects a model policy no provider satisfies (check 5)", () => {
    expect(failedChecks(request({ model_policy: { permitted_providers: ["elsewhere"], posture: "local", conversation_state: "any" } }))).toContain("5");
    expect(failedChecks(request({ model_policy: { permitted_providers: [PROFILE.id], posture: "cloud", conversation_state: "any" } }))).toContain("5");
    const held = { ...PROFILE, conversation_state: "server_held" as const };
    expect(failedChecks(request({ sensitivity_floor: "confidential" }), { providers: [held] })).toContain("5");
    expect(failedChecks(request({ model_policy: { permitted_providers: [PROFILE.id], posture: "local", conversation_state: "stateless" } }), { providers: [held] })).toContain("5");
    // A constant's own sensitivity counts towards the floor.
    expect(failedChecks(request({ constants: { key: { value: "x", sensitivity: "secret" } } }), { providers: [held] })).toContain("5");
    expect(failedChecks(request(), { providers: [held] })).toEqual([]);
  });

  // proves §5.4 check 8: a native task needs a provider that manages context; never silently owned
  it("rejects a native task when no permitted provider offers native context management (check 8)", () => {
    expect(failedChecks(request(), { providers: [{ ...PROFILE, native_context_management: false }] })).toContain("8");
  });

  // proves §5.4 check 9: every capability in scope is registered, with no quarantined adapter
  it("rejects capabilities that are not registered or are quarantined (check 9)", () => {
    h.grants.add(grant({ id: "grant-x", capability_selector: { capabilities: ["fs.file.read"] } }));
    expect(failedChecks(request({ grants: ["grant-x"] }))).toContain("9");
    h.registry.quarantine({ capability: "shell.run", adapter: WORKLOAD_EXECFILE, observation: "test" });
    expect(failedChecks(request())).toContain("9");
  });

  // proves §5.4 check 10 / §7.8: live steering needs steer_capability full; it defaults from attendance
  it("rejects a task needing live steering when no provider can deliver it (check 10)", () => {
    const serverLoop = { ...PROFILE, conversation_state: "server_held" as const, turn_control: "server" as const };
    expect(failedChecks(request({ attendance: "gated" }), { providers: [serverLoop] })).toContain("10");
    expect(failedChecks(request({ attendance: "autonomous", requires_live_steer: true }), { providers: [serverLoop] })).toContain("10");
    expect(failedChecks(request({ attendance: "gated", requires_live_steer: false }), { providers: [serverLoop] })).toEqual([]);
  });

  // proves §5.4 check 11: autonomous with zero grants is admitted, with a warning
  it("warns on an autonomous task with zero grants (check 11)", () => {
    const result = admit(request({ grants: [] }), env());
    expect(result.admitted && result.admission.warnings).toContainEqual(expect.stringContaining("zero pre-issued grants"));
    // With one grant there is no such warning.
    const granted = admit(request(), env());
    expect(granted.admitted && granted.admission.warnings.some((warning) => warning.includes("zero pre-issued"))).toBe(false);
  });

  // proves §5.3 / D-061: a grant over the whole capability namespace needs an Override, which Slice 1 lacks
  it("rejects a grant scoped to the whole capability namespace (§5.3)", () => {
    h.grants.add(grant({ id: "grant-all", resource_scope: [{ kind: "path", prefix: WORK_NAMESPACE }] }));
    expect(failedChecks(request({ grants: ["grant-all"], sources: ["project"] }))).toContain("5.3");
  });

  // proves §5.3: a grant selecting a write capability must cap its invocations
  it("rejects an uncapped grant for a write capability (§5.3)", () => {
    const writer = loadRegistryEntry(SHELL_RUN_FILE);
    const definition = { ...writer, capability: { ...writer.capability, id: "shell.write", side_effect: "write" as const } };
    expect(h.registry.register(definition, [standInAdapter]).registered).toBe(true);
    h.grants.add(grant({ id: "grant-w", capability_selector: { capabilities: ["shell.write"] } }));
    expect(failedChecks(request({ grants: ["grant-w"] }))).toContain("5.3");
    h.grants.add(grant({ id: "grant-w2", capability_selector: { capabilities: ["shell.write"] }, max_invocations: 3 }));
    expect(failedChecks(request({ grants: ["grant-w2"] }))).toEqual([]);
  });

  // proves §3.1 / §3.2 / §4.1 for Slice 1: no delegation, only the direct strategy, grants that exist and are the principal's
  it("rejects a parent, an unknown strategy, a missing grant and another principal's grant", () => {
    expect(failedChecks(request({ parent: "task-0" }))).toContain("3.1");
    expect(failedChecks(request({ strategy: "explore" }))).toContain("4.1");
    expect(failedChecks(request({ grants: ["grant-none"] }))).toContain("3.2");
    h.grants.add(grant({ id: "grant-other", principal: "someone-else" }));
    expect(failedChecks(request({ grants: ["grant-other"] }))).toContain("3.2");
  });

  // proves §5.4 checks 6 and 7: every budget axis and the ttl must be declared
  it.each([["tokens"], ["currency"], ["wall_clock_ms"], ["turns"]])("rejects a budget without %s (check 6)", (axis) => {
    const budget = Object.fromEntries(Object.entries({ tokens: 1, currency: 1, wall_clock_ms: 1, turns: 1 }).filter(([name]) => name !== axis));
    expect(failedChecks(request({ budget }))).toEqual(["schema"]);
  });
  it("rejects a request without a ttl (check 7)", () => {
    const rest = Object.fromEntries(Object.entries(request()).filter(([name]) => name !== "ttl"));
    expect(failedChecks(rest)).toEqual(["schema"]);
  });

  // proves §2.6: the criterion's slot names are reserved, so an operator constant cannot pose as a criterion literal
  it("rejects a constant named like a criterion slot", () => {
    expect(failedChecks(request({ constants: { criterion: { value: "x" } } }))).toContain("2.6");
  });
});

describe("derivations (§7.8, §10.2, §10.3)", () => {
  // proves §7.8: steer_capability from context mode and the provider's profile, every row of the table
  it.each([
    ["owned", "server_held", "server", false, "full"],
    ["native", "stateless", "server", false, "full"],
    ["native", "server_held", "client", false, "full"],
    ["native", "server_held", "server", true, "checkpoint_only"],
    ["native", "server_held", "server", false, "none"],
  ] as const)("%s / %s / turn_control %s / interrupt %s gives %s", (ownership, state, control, interrupt, expected) => {
    const profile = { ...PROFILE, conversation_state: state, turn_control: control, server_interrupt: interrupt };
    expect(deriveSteerCapability(ownership as ContextOwnership, profile)).toBe(expected);
  });

  // proves §10.2 / D-061: the direct strategy admits only constant and bound instruction arguments, so its tasks are native
  it("derives native context for the direct strategy, and nothing for an unknown one", () => {
    expect(deriveContextOwnership(DIRECT_STRATEGY)).toBe("native");
    expect(() => deriveContextOwnership("plan-then-execute")).toThrow();
  });

  // proves §10.3: confidential material needs a stateless provider
  it("routes confidential work only to a stateless provider", () => {
    const policy = { permitted_providers: [PROFILE.id], posture: PROFILE.posture, conversation_state: "any" as const };
    expect(routable(policy, "confidential", PROFILE)).toBe(true);
    expect(routable(policy, "confidential", { ...PROFILE, conversation_state: "server_held" })).toBe(false);
    expect(routable(policy, "internal", { ...PROFILE, conversation_state: "server_held" })).toBe(true);
  });
});

describe("tool call translation (§2.6, invariant 7, D-060)", () => {
  // proves invariant 7: provenance comes from the mechanism the model used, never from the value
  it("states provenance by mechanism", () => {
    expect(
      toProposal({ capability: "shell.run", arguments: { program: { slot: "cat" }, argv: ["a", { ref: "${3.stdout}" }, "${3.stdout}"], cwd: 7 } }),
    ).toEqual({
      capability: "shell.run",
      arguments: {
        program: { class: "constant", slot: "cat" },
        argv: [
          { class: "synthesized", value: "a" },
          { class: "bound", reference: "${3.stdout}" },
          { class: "synthesized", value: "${3.stdout}" },
        ],
        cwd: { class: "synthesized", value: 7 },
      },
    });
  });

  // proves invariant 1 / D-060: nothing the model writes becomes an argument source of its own
  it("never passes a model-written argument source through", () => {
    const forged = toProposal({ capability: "shell.run", arguments: { program: { class: "constant", slot: "cat" }, cwd: { slot: "x", extra: 1 } } });
    expect(forged.arguments["program"]).toEqual({ class: { class: "synthesized", value: "constant" }, slot: { class: "synthesized", value: "cat" } });
    expect(forged.arguments["cwd"]).toEqual({ slot: { class: "synthesized", value: "x" }, extra: { class: "synthesized", value: 1 } });
    expect(toProposal({ capability: "shell.run", arguments: { program: null } }).arguments["program"]).toBeNull();
  });
});
