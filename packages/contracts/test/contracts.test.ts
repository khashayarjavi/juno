import { describe, expect, it } from "vitest";
import { Artifact, Closure, Task, TrajectoryEntry, closureSchemaFor } from "../src/index.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

const task = {
  id: "task-1",
  principal: "alireza",
  objective: "List the files in the repository.",
  criterion: { command: "test -s listing.txt", exit_code: 0 },
  criterion_integrity: "operator",
  verification: "verify.command",
  closure_mode: "verified",
  attendance: "autonomous",
  strategy: "direct",
  sensitivity_floor: "internal",
  context_ownership: "native",
  model_policy: { permitted_providers: ["provider.fake"], posture: "default", conversation_state: "stateless" },
  budget: { tokens: 100_000, currency: 5, wall_clock_ms: 3_600_000, turns: 20 },
  ttl: 86_400_000,
  grants: ["grant-1"],
  parent: null,
  state: "admitted",
  runtime_substate: null,
  steer_capability: "full",
  trajectory: "trajectory-task-1",
};

describe("Task (§3.1)", () => {
  // proves §3.1: a task record with every field parses
  it("parses a complete task", () => {
    expect(Task.parse(task).id).toBe("task-1");
  });

  // proves §1.2: integrity is not a property of tasks, so a task cannot carry one
  it("rejects a task-level integrity field", () => {
    expect(Task.safeParse({ ...task, integrity: "operator" }).success).toBe(false);
  });

  // proves §3.1: requires_live_steer defaults to true when gated and false otherwise
  it("defaults requires_live_steer from attendance", () => {
    expect(Task.parse({ ...task, attendance: "gated" }).requires_live_steer).toBe(true);
    expect(Task.parse({ ...task, attendance: "autonomous" }).requires_live_steer).toBe(false);
  });

  // proves §3.1: requires_live_steer is overridable in either direction
  it("keeps an explicit requires_live_steer in either direction", () => {
    expect(Task.parse({ ...task, attendance: "gated", requires_live_steer: false }).requires_live_steer).toBe(false);
    expect(Task.parse({ ...task, attendance: "autonomous", requires_live_steer: true }).requires_live_steer).toBe(true);
  });

  // proves §3.1 / §9: the budget is declared on all four axes
  it.each(["tokens", "currency", "wall_clock_ms", "turns"])("rejects a budget missing %s", (axis) => {
    const budget = Object.fromEntries(Object.entries(task.budget).filter(([key]) => key !== axis));
    expect(Task.safeParse({ ...task, budget }).success).toBe(false);
  });

  // proves §3.3: blocked is a sub-state of running, never of any other state
  it("rejects a runtime_substate outside running", () => {
    expect(Task.safeParse({ ...task, state: "running", runtime_substate: "blocked" }).success).toBe(true);
    expect(Task.safeParse({ ...task, state: "parked", runtime_substate: "blocked" }).success).toBe(false);
  });

  // proves §3.1: context_ownership and steer_capability are derived at admission, so only a draft lacks them
  it("requires the derived fields on every task past draft", () => {
    expect(Task.safeParse({ ...task, context_ownership: null }).success).toBe(false);
    expect(Task.safeParse({ ...task, steer_capability: null }).success).toBe(false);
    expect(Task.safeParse({ ...task, state: "draft", context_ownership: null, steer_capability: null }).success).toBe(true);
    expect(Task.safeParse({ ...task, state: "draft" }).success).toBe(false);
  });

  // proves §3.1: ttl and model_policy are required
  it("rejects a task without ttl or with no permitted provider", () => {
    expect(Task.safeParse({ ...task, ttl: undefined }).success).toBe(false);
    expect(Task.safeParse({ ...task, model_policy: { ...task.model_policy, permitted_providers: [] } }).success).toBe(false);
  });
});

const nonCallEntry = {
  seq: 3,
  task_id: "task-1",
  kind: "capability_call",
  actor: "model.fake",
  provider: "provider.fake",
  payload_ref: HASH_A,
  data_class: { sensitivity: "internal", integrity: "derived" },
  cost: { tokens_in: 10, tokens_out: 5, tokens_cached: 0, currency: 0.01, duration_ms: 20 },
  hash_prev: HASH_B,
  timestamp: "2026-10-28T09:00:00Z",
};

const entry = {
  ...nonCallEntry,
  argument_provenance: [
    { argument: "program", class: "constant", integrity: "operator" },
    { argument: "argv[0]", class: "bound", integrity: "untrusted" },
  ],
};

describe("TrajectoryEntry (§3.4.2)", () => {
  // proves §3.4.2: a capability_call entry carries per-argument provenance class and computed integrity
  it("parses a capability_call with argument provenance", () => {
    expect(TrajectoryEntry.parse(entry).argument_provenance?.[1]).toEqual({ argument: "argv[0]", class: "bound", integrity: "untrusted" });
  });

  // proves §3.4.2: argument provenance is mandatory on capability_call and belongs nowhere else
  it("ties argument_provenance to capability_call", () => {
    expect(TrajectoryEntry.safeParse(nonCallEntry).success).toBe(false);
    expect(TrajectoryEntry.safeParse({ ...entry, kind: "note" }).success).toBe(false);
    expect(TrajectoryEntry.safeParse({ ...nonCallEntry, kind: "note" }).success).toBe(true);
  });

  // proves §2.6: provenance classes are constant, bound and synthesized only
  it("rejects an unknown provenance class", () => {
    const bad = { ...entry, argument_provenance: [{ argument: "program", class: "trusted", integrity: "operator" }] };
    expect(TrajectoryEntry.safeParse(bad).success).toBe(false);
  });

  // proves §2.7 step 1: a binding_resolution records the candidate set — prior entries, more than one
  it("records binding candidates only on binding_resolution, and only prior entries", () => {
    const base = nonCallEntry;
    expect(TrajectoryEntry.safeParse({ ...base, kind: "binding_resolution", binding_candidates: [1, 2] }).success).toBe(true);
    expect(TrajectoryEntry.safeParse({ ...base, kind: "binding_resolution", binding_candidates: [1] }).success).toBe(false);
    expect(TrajectoryEntry.safeParse({ ...base, kind: "binding_resolution", binding_candidates: [1, 3] }).success).toBe(false);
    expect(TrajectoryEntry.safeParse({ ...base, kind: "note", binding_candidates: [1, 2] }).success).toBe(false);
  });

  // proves §3.4.2: entry kinds are the enumerated set
  it("rejects an unknown entry kind", () => {
    expect(TrajectoryEntry.safeParse({ ...entry, kind: "delete_history" }).success).toBe(false);
  });

  // proves §3.4.2: payloads are content-addressed
  it("rejects a payload_ref that is not a content address", () => {
    expect(TrajectoryEntry.safeParse({ ...entry, payload_ref: "blob-17" }).success).toBe(false);
  });
});

const closure = {
  task_id: "task-1",
  criterion_ref: HASH_A,
  criterion_integrity: "operator",
  verification_method: "verify.command",
  verification_result: "pass",
  closure_mode: "verified",
  verifier_identity: "runner.verifier",
  replay_fidelity: "partial",
  artifacts: [HASH_B],
  cost_actual: { tokens: 1000, currency: 0.2, wall_clock_ms: 60_000, turns: 4 },
};

describe("Closure (§3.4.4)", () => {
  // proves §3.4.4: a passing check against an operator-integrity criterion licenses verified closure
  it("accepts verified closure with a passing check and an operator criterion", () => {
    expect(Closure.parse(closure).closure_mode).toBe("verified");
  });

  // proves §3.4.4 and §5.2: a model-drafted (derived) criterion cannot produce verified closure
  it.each(["derived", "attested", "untrusted"])("rejects verified closure when criterion_integrity is %s", (integrity) => {
    expect(Closure.safeParse({ ...closure, criterion_integrity: integrity }).success).toBe(false);
  });

  // proves §3.4.4 / §6.1: verified is never conferred without a passing deterministic check
  it.each(["fail", "inconclusive"])("rejects verified closure when the check result is %s", (result) => {
    expect(Closure.safeParse({ ...closure, verification_result: result }).success).toBe(false);
  });

  // proves §5.1: a task admitted without criterion or verification method cannot close verified
  it("rejects verified closure without a criterion or a verification method", () => {
    expect(Closure.safeParse({ ...closure, criterion_ref: null }).success).toBe(false);
    expect(Closure.safeParse({ ...closure, verification_method: null }).success).toBe(false);
  });

  // proves §3.4.4: weaker modes are recorded as such whatever the criterion's integrity
  it("accepts accepted and attested closure with a derived criterion", () => {
    expect(Closure.safeParse({ ...closure, closure_mode: "accepted", criterion_integrity: "derived" }).success).toBe(true);
    expect(Closure.safeParse({ ...closure, closure_mode: "attested", criterion_integrity: "derived", verification_result: "inconclusive" }).success).toBe(true);
  });

  // proves §3.4.4 and invariant 3: verifier_identity must not equal the executing actor
  it("rejects a closure whose verifier is the executing actor", () => {
    const schema = closureSchemaFor(["model.fake"]);
    expect(schema.safeParse(closure).success).toBe(true);
    expect(schema.safeParse({ ...closure, verifier_identity: "model.fake" }).success).toBe(false);
  });
});

const artifact = {
  hash: HASH_A,
  type: "file.listing",
  producing_task: "task-1",
  data_class: { sensitivity: "internal", integrity: "untrusted" },
  inputs: [{ kind: "trajectory_entry", task_id: "task-1", seq: 4 }],
  supersedes: null,
};

describe("Artifact (§3.5)", () => {
  // proves §3.5: an artifact carries content address, producing task, data class and provenance
  it("parses an artifact", () => {
    expect(Artifact.parse(artifact).hash).toBe(HASH_A);
  });

  // proves §3.5: a revision is a new artifact, so an artifact cannot supersede itself
  it("rejects an artifact that supersedes itself and accepts one that supersedes another", () => {
    expect(Artifact.safeParse({ ...artifact, supersedes: HASH_A }).success).toBe(false);
    expect(Artifact.safeParse({ ...artifact, hash: HASH_B, supersedes: HASH_A }).success).toBe(true);
  });

  // proves §3.5: identity is a content address
  it("rejects an artifact whose hash is not a content address", () => {
    expect(Artifact.safeParse({ ...artifact, hash: "artifact-1" }).success).toBe(false);
  });
});
