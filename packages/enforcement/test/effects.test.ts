import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DataClass, type SideEffect, Task, type TrajectoryEntry } from "../../contracts/src/index.js";
import { JournalWriter, canonicalJson } from "../../journal/src/index.js";
import { type Adapter, type CapabilityCall, CapabilityRegistry, RegistryEntry } from "../../registry/src/index.js";
import { type ArgumentSource, type CanonicalPath, type CanonicalPaths, EnforcementBoundary, GrantStore, type TaskContext, type Verdict, operandPath } from "../src/index.js";
import { TEST_ANCHOR, signed } from "./test-keys.js";

// §2.2.2 (v0.6, A1) and §2.7.1 "Effects": step 4 applies the effect table to target fields (D-135). The capabilities
// here are test-only typed entries (D-134), one per side-effect class, each with one target and one payload field.
// Their adapters hand every value to the provider as its own argv element (§2.4), so each registers.

const PRINCIPAL = "alireza";
const T0 = "2026-10-28T09:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;
const INTERNAL_OPERATOR: DataClass = { sensitivity: "internal", integrity: "operator" };

function definition(id: string, sideEffect: SideEffect, target: "path" | "string"): unknown {
  return RegistryEntry.parse({
    capability: {
      id,
      interface: {
        to: { type: { kind: target }, role: "data" },
        body: { type: { kind: "string" }, role: "data", data_effect: "payload" },
      },
      providers: [`${id}.adapter`],
      side_effect: sideEffect,
      isolation_tier: 1,
      max_input_sensitivity: "internal",
      min_argument_integrity: "attested",
      output_class: { sensitivity: "input", integrity: "untrusted" },
      cost_model: { expected_cost: 0, expected_latency_ms: 10, cost_of_failure: 0 },
    },
  });
}

const adapterFor = (id: string): Adapter => ({
  id: `${id}.adapter`,
  plan: (call: CapabilityCall) => ({ file: "/usr/bin/true", args: ["--", String(call["to"]), String(call["body"])] }),
});

const CAPABILITIES = [
  ["test.write", "write", "path"],
  ["test.delete", "irreversible", "path"],
  ["test.send", "external", "string"],
] as const;

function grant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return signed({
    id: "grant-1",
    principal: PRINCIPAL,
    capability_selector: { capabilities: CAPABILITIES.map(([id]) => id) },
    resource_scope: [{ kind: "path", prefix: "/work/project" }],
    data_class_bounds: { max_sensitivity: "secret", min_integrity: "untrusted" },
    issuance: "preissued",
    issued_by: PRINCIPAL,
    issued_at: T0,
    expires_at: new Date(Date.parse(T0) + DAY_MS).toISOString(),
    max_invocations: 100,
    attenuation_parent: null,
    revoked_at: null,
    ...overrides,
  });
}

const task = (grantIds: readonly string[] = ["grant-1"]): Task =>
  Task.parse({
    id: "task-1",
    principal: PRINCIPAL,
    objective: "write and send",
    criterion: null,
    criterion_integrity: "operator",
    verification: null,
    closure_mode: "accepted",
    attendance: "autonomous",
    strategy: "direct",
    sensitivity_floor: "internal",
    context_ownership: "native",
    model_policy: { permitted_providers: ["fake-provider"], posture: "local", conversation_state: "any" },
    budget: { tokens: 10000, currency: 1, wall_clock_ms: 600000, turns: 20 },
    ttl: DAY_MS,
    grants: [...grantIds],
    parent: null,
    state: "running",
    runtime_substate: "active",
    steer_capability: "none",
    trajectory: "task-1",
  });

const CONSTANTS: TaskContext["constants"] = {
  notes: { value: "/work/project/notes.txt", data_class: INTERNAL_OPERATOR },
  ops: { value: "ops@example.com", data_class: INTERNAL_OPERATOR },
};

const constant = (slot: string): ArgumentSource => ({ class: "constant", slot });
const bound = (reference: string): ArgumentSource => ({ class: "bound", reference });
const synthesized = (value: string): ArgumentSource => ({ class: "synthesized", value });
const call = (capability: string, to: ArgumentSource, body: ArgumentSource = synthesized("hello")): unknown => ({ capability, arguments: { to, body } });

let dir: string;
let journal: JournalWriter;
let grants: GrantStore;
let boundary: EnforcementBoundary;

function setUp(...grantRecords: Record<string, unknown>[]): void {
  const registry = new CapabilityRegistry();
  for (const [id, effect, target] of CAPABILITIES) {
    expect(registry.register(definition(id, effect, target), [adapterFor(id)])).toEqual({ registered: true, id });
  }
  grants = new GrantStore(TEST_ANCHOR);
  for (const record of grantRecords) grants.add(record);
  boundary = new EnforcementBoundary({ registry, grants, journal, clock: () => new Date(Date.parse(T0) + 60_000) });
}

/** The context the runner gives: canonical paths as if the content held no symlinks, and the task's reversible roots. */
function judge(input: unknown, reversible: readonly string[] = [], grantIds?: readonly string[], resolve?: (raw: string) => CanonicalPath): Verdict {
  const base: TaskContext = { task: task(grantIds), constants: CONSTANTS, synthesis: { sensitivity: "internal" }, reversible };
  const canonical: CanonicalPaths = new Map(boundary.pathsToResolve(base, input).map((path) => [path, resolve?.(path) ?? { ok: true, canonical: operandPath("/", path) }]));
  return boundary.authorize({ ...base, canonical }, input);
}

function seed(payload: unknown, dataClass: DataClass): TrajectoryEntry {
  return journal.append(
    "task-1",
    { kind: "capability_result", actor: "juno.runner", provider: null, data_class: dataClass, cost: { tokens_in: 0, tokens_out: 0, tokens_cached: 0, currency: 0, duration_ms: 0 } },
    new TextEncoder().encode(canonicalJson(payload)),
  );
}

const effects = (verdict: Verdict): unknown => (verdict.outcome === "park" && verdict.detail.reason === "integrity_floor" ? verdict.detail.effects : undefined);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "juno-effects-"));
  journal = JournalWriter.open(join(dir, "journal"));
  setUp(grant());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("§2.2.2 write: an untrusted target is permitted only inside a reversible workspace (D-135)", () => {
  // proves §2.2.2 write row: a synthesized (untrusted) path inside a checkpointed scope proceeds
  it("lets an untrusted path proceed inside a reversible workspace", () => {
    expect(judge(call("test.write", synthesized("/work/project/out.txt")), ["/work/project"]).outcome).toBe("proceed");
  });

  // proves §2.2.2 write row: the same path in a scope with no checkpoint is irreversible, so it parks integrity_floor
  it("parks the same untrusted path when the scope has no checkpoint", () => {
    const verdict = judge(call("test.write", synthesized("/work/project/out.txt")), []);
    expect(verdict).toMatchObject({ outcome: "park", detail: { reason: "integrity_floor", violations: [], grants: [] } });
    expect(effects(verdict)).toEqual([
      {
        grant: "grant-1",
        refused: [
          { argument: "to", field: "to", value: "/work/project/out.txt", judged_as: "irreversible", not_reversible: "/work/project/out.txt lies in no reversible workspace of the task" },
        ],
      },
    ]);
  });

  // proves §2.2.2 "A write outside a reversible workspace is irreversible": inside the grant but outside the checkpointed root parks
  it("parks an untrusted path in scope but outside every reversible root", () => {
    expect(effects(judge(call("test.write", synthesized("/work/project/b/out.txt")), ["/work/project/a"]))).toMatchObject([
      { refused: [{ argument: "to", judged_as: "irreversible" }] },
    ]);
  });

  // proves §2.2.2 (D-135): a write outside a reversible workspace takes the irreversible row, so an operator value still proceeds
  it("lets a constant path proceed with no reversible workspace", () => {
    expect(judge(call("test.write", constant("notes")), []).outcome).toBe("proceed");
  });

  // proves §2.2.2: the reversible-workspace rule is judged on the canonical path, so a symlink out of the root is not reversible
  it("judges reversibility on the canonical path", () => {
    const input = call("test.write", synthesized("/work/project/link/out.txt"));
    const base: TaskContext = { task: task(), constants: CONSTANTS, synthesis: { sensitivity: "internal" }, reversible: ["/work/project/safe"] };
    const canonical: CanonicalPaths = new Map([["/work/project/link/out.txt", { ok: true, canonical: "/work/project/other/out.txt" }]]);
    expect(effects(boundary.authorize({ ...base, canonical }, input))).toMatchObject([{ refused: [{ argument: "to" }] }]);
  });

  // proves D-158 (autopilot ruling): a write through a hard-linked file is never reversible, since a restore replaces the
  // workspace's name only and the file's other name keeps the write; an ordinary file at the same path is the control
  it("judges a write to a hard-linked file inside a reversible workspace as irreversible", () => {
    const input = call("test.write", synthesized("/work/project/safe/out.txt"));
    const base: TaskContext = { task: task(), constants: CONSTANTS, synthesis: { sensitivity: "internal" }, reversible: ["/work/project/safe"] };
    const linked: CanonicalPaths = new Map([["/work/project/safe/out.txt", { ok: true, canonical: "/work/project/safe/out.txt", hardLinked: true }]]);
    const verdict = boundary.authorize({ ...base, canonical: linked }, input);
    expect(verdict.outcome === "park" ? verdict.detail.reason : verdict.outcome).toBe("integrity_floor");
    expect(effects(verdict)).toMatchObject([{ refused: [{ argument: "to", judged_as: "irreversible" }] }]);
    const plain: CanonicalPaths = new Map([["/work/project/safe/out.txt", { ok: true, canonical: "/work/project/safe/out.txt" }]]);
    expect(boundary.authorize({ ...base, canonical: plain }, input).outcome).toBe("proceed");
  });

  // proves D-221 (§2.2.2 "restoring that checkpoint is an operator action"): a write below a folder of the reversible
  // workspace that the restore's user could not change is never reversible; none is the control (a folder above the
  // workspace is no longer one: since D-234 it stops the undo too, next test)
  it("judges a write below a folder the restore could not change as irreversible", () => {
    const input = call("test.write", synthesized("/work/project/safe/sub/out.txt"));
    const base: TaskContext = { task: task(), constants: CONSTANTS, synthesis: { sensitivity: "internal" }, reversible: ["/work/project/safe"] };
    const at = (unwritable: readonly string[]): CanonicalPaths => new Map([["/work/project/safe/sub/out.txt", { ok: true, canonical: "/work/project/safe/sub/out.txt", unwritable }]]);
    const verdict = boundary.authorize({ ...base, canonical: at(["/work/project/safe/sub"]) }, input);
    expect(verdict.outcome === "park" ? verdict.detail.reason : verdict.outcome).toBe("integrity_floor");
    expect(effects(verdict)).toMatchObject([{ refused: [{ argument: "to", judged_as: "irreversible", not_reversible: expect.stringContaining("the restore could not change /work/project/safe/sub") }] }]);
    expect(boundary.authorize({ ...base, canonical: at([]) }, input).outcome).toBe("proceed");
  });

  // proves operator ruling 1 of D-234 (§2.2.2): the undo moves the workspace aside with one rename in the folder that
  // holds it, so a folder on the way to the workspace that the restore's user could not change (the folder holding it,
  // or one above), a folder on another file system on the way or inside, or a workspace whose checkpoint JUNO can no
  // longer restore, makes a write there irreversible, with the reason; none of them is the control
  it("judges a write irreversible when the workspace can no longer be undone", () => {
    const input = call("test.write", synthesized("/work/project/safe/sub/out.txt"));
    const base: TaskContext = { task: task(), constants: CONSTANTS, synthesis: { sensitivity: "internal" }, reversible: ["/work/project/safe"] };
    const at = (extra: { unwritable?: readonly string[]; mounts?: readonly string[] }): CanonicalPaths => new Map([["/work/project/safe/sub/out.txt", { ok: true, canonical: "/work/project/safe/sub/out.txt", ...extra }]]);
    const refusal = (context: TaskContext): unknown => {
      const verdict = boundary.authorize(context, input);
      expect(verdict.outcome === "park" ? verdict.detail.reason : verdict.outcome).toBe("integrity_floor");
      return effects(verdict);
    };
    for (const folder of ["/work/project", "/work"]) {
      expect(refusal({ ...base, canonical: at({ unwritable: [folder] }) })).toMatchObject([{ refused: [{ judged_as: "irreversible", not_reversible: `the restore could not move /work/project/safe aside: it could not change ${folder}, so a write there could not be undone (D-234)` }] }]);
    }
    expect(refusal({ ...base, canonical: at({ unwritable: ["/work/project/safe"] }) })).toMatchObject([{ refused: [{ not_reversible: expect.stringContaining("could not move /work/project/safe aside") }] }]);
    for (const folder of ["/work/project", "/work/project/safe", "/work/project/safe/sub"]) {
      expect(refusal({ ...base, canonical: at({ mounts: [folder] }) })).toMatchObject([{ refused: [{ not_reversible: `${folder} is on another file system (a mount), so the restore could not show it can undo a write there (D-234)` }] }]);
    }
    expect(refusal({ ...base, canonical: at({}), unrestorable: { "/work/project/safe": "2 of its checkpoint's files are gone from the checkpoint store" } })).toMatchObject([{ refused: [{ not_reversible: "/work/project/safe can no longer be undone: 2 of its checkpoint's files are gone from the checkpoint store (D-234)" }] }]);
    // Controls: nothing in the way, and an unrestorable workspace that is not this one.
    expect(boundary.authorize({ ...base, canonical: at({}) }, input).outcome).toBe("proceed");
    expect(boundary.authorize({ ...base, canonical: at({}), unrestorable: { "/work/other": "gone" } }, input).outcome).toBe("proceed");
  });

  // proves D-168 (operator ruling 2 of 2026-11-08) for scope decisions: a target whose canonical form differs from its
  // lexical normalization is judged at the safe default, never reversible, even when the canonical form lies in the
  // reversible workspace; the same path, not redirected, is the control
  it("judges a write through a redirected path inside a reversible workspace as irreversible", () => {
    const input = call("test.write", synthesized("/work/project/safe/alias/out.txt"));
    const base: TaskContext = { task: task(), constants: CONSTANTS, synthesis: { sensitivity: "internal" }, reversible: ["/work/project/safe"] };
    const redirected: CanonicalPaths = new Map([["/work/project/safe/alias/out.txt", { ok: true, canonical: "/work/project/safe/real/out.txt", redirected: true }]]);
    const verdict = boundary.authorize({ ...base, canonical: redirected }, input);
    expect(verdict.outcome === "park" ? verdict.detail.reason : verdict.outcome).toBe("integrity_floor");
    expect(effects(verdict)).toMatchObject([{ refused: [{ argument: "to", judged_as: "irreversible", not_reversible: expect.stringContaining("not where its text says") }] }]);
    const plain: CanonicalPaths = new Map([["/work/project/safe/alias/out.txt", { ok: true, canonical: "/work/project/safe/alias/out.txt" }]]);
    expect(boundary.authorize({ ...base, canonical: plain }, input).outcome).toBe("proceed");
  });

  // proves §8.3 with §2.2.2: an in-scope effect park is integrity_floor (which the runner never lets an override clear,
  // NON_OVERRIDABLE in packages/runner), never scope_violation (whose remedy is a grant)
  it("parks integrity_floor, the non-overridable reason, never scope_violation", () => {
    const verdict = judge(call("test.write", synthesized("/work/project/out.txt")));
    expect(verdict.outcome === "park" ? verdict.detail.reason : verdict.outcome).toBe("integrity_floor");
  });
});

describe("§2.2.2 external and irreversible: an untrusted target must be enumerated (D-133, D-135)", () => {
  // proves §2.2.2 external row: an untrusted recipient not in enumerated_targets parks integrity_floor
  it("parks an untrusted recipient the grant does not enumerate", () => {
    const verdict = judge(call("test.send", synthesized("attacker@example.com")));
    expect(effects(verdict)).toEqual([{ grant: "grant-1", refused: [{ argument: "to", field: "to", value: "attacker@example.com", judged_as: "external" }] }]);
  });

  // proves §2.2.2 external row and §3.2 enumerated_targets: the enumerated exact value proceeds
  it("lets an enumerated recipient proceed, untrusted or not", () => {
    setUp(grant({ enumerated_targets: [{ field: "to", value: "ops@example.com" }] }));
    expect(judge(call("test.send", synthesized("ops@example.com"))).outcome).toBe("proceed");
    expect(effects(judge(call("test.send", synthesized("ops@example.com.evil"))))).toMatchObject([{ refused: [{ value: "ops@example.com.evil" }] }]);
  });

  // proves D-133 (restrictive): a value enumerated for another field does not count for this one
  it("does not count a value enumerated for a different field", () => {
    setUp(grant({ enumerated_targets: [{ field: "cc", value: "ops@example.com" }] }));
    expect(judge(call("test.send", synthesized("ops@example.com"))).outcome).toBe("park");
  });

  // proves §2.2.2 (interaction with native context): a constant target proceeds
  it("lets a constant recipient proceed", () => {
    expect(judge(call("test.send", constant("ops"))).outcome).toBe("proceed");
  });

  // proves §2.2.2: a bound target whose entry is not untrusted proceeds; one bound to an untrusted entry parks
  it("judges a bound target by its entry's integrity", () => {
    const attested = seed({ stdout_lines: ["ops@example.com"] }, { sensitivity: "internal", integrity: "attested" });
    expect(judge(call("test.send", bound(`\${${String(attested.seq)}.stdout_lines[0]}`))).outcome).toBe("proceed");
    const untrusted = seed({ stdout_lines: ["attacker@example.com"] }, { sensitivity: "internal", integrity: "untrusted" });
    expect(effects(judge(call("test.send", bound(`\${${String(untrusted.seq)}.stdout_lines[0]}`))))).toMatchObject([{ refused: [{ argument: "to" }] }]);
  });

  // proves §2.2.2 irreversible row: an untrusted path to delete parks unless enumerated; a reversible workspace does not lift it
  it("parks an untrusted irreversible target unless the grant enumerates it", () => {
    expect(effects(judge(call("test.delete", synthesized("/work/project/a.txt")), ["/work/project"]))).toMatchObject([
      { refused: [{ argument: "to", judged_as: "irreversible" }] },
    ]);
    setUp(grant({ enumerated_targets: [{ field: "to", value: "/work/project/a.txt" }] }));
    expect(judge(call("test.delete", synthesized("/work/project/a.txt"))).outcome).toBe("proceed");
  });

  // proves D-133: enumeration lifts the integrity condition, not the scope: an enumerated path outside scope still parks scope_violation
  it("still applies resource_scope to an enumerated value", () => {
    setUp(grant({ enumerated_targets: [{ field: "to", value: "/work/elsewhere/a.txt" }] }));
    expect(judge(call("test.delete", synthesized("/work/elsewhere/a.txt")))).toMatchObject({ outcome: "park", detail: { reason: "scope_violation" } });
  });

  // proves §2.7.1 D4 with §2.2.2: when several grants cover the call, it proceeds under one whose effect rule it meets
  it("proceeds under the grant that enumerates the target, and charges that one", () => {
    setUp(grant({ id: "grant-a" }), grant({ id: "grant-b", enumerated_targets: [{ field: "to", value: "ops@example.com" }] }));
    const verdict = judge(call("test.send", synthesized("ops@example.com")), [], ["grant-a", "grant-b"]);
    expect(verdict).toMatchObject({ outcome: "proceed", authorization: { grant: "grant-b" } });
    expect([grants.invocations("grant-a"), grants.invocations("grant-b")]).toEqual([0, 1]);
  });
});

describe("D-154 (operator ruling): enumerated targets match on the resolved path; other values only exactly, an email's domain case-insensitively", () => {
  const ENUMERATED = "/work/project/a.txt";
  const resolvesTo = (canonical: string, extra: Partial<{ hardLinked: true; redirected: true }> = {}) => (): CanonicalPath => ({ ok: true, canonical, ...extra });

  // proves D-154: a path target is matched by its canonical path, never as typed
  it("matches a path target on its resolved path, not its text", () => {
    setUp(grant({ enumerated_targets: [{ field: "to", value: ENUMERATED }] }));
    // Typed as the enumerated value, but the kernel resolves it elsewhere: parks.
    expect(effects(judge(call("test.delete", synthesized(ENUMERATED)), [], undefined, resolvesTo("/work/project/other.txt", { redirected: true })))).toMatchObject([{ refused: [{ argument: "to" }] }]);
    // Typed otherwise, resolved to the enumerated path: matches.
    expect(judge(call("test.delete", synthesized("/work/project/link")), [], undefined, resolvesTo(ENUMERATED, { redirected: true })).outcome).toBe("proceed");
  });

  // proves D-154 with D-157: a path that did not resolve, or a hard-linked file, never matches
  it("never matches an unresolved path or a hard-linked file", () => {
    setUp(grant({ enumerated_targets: [{ field: "to", value: ENUMERATED }] }));
    expect(judge(call("test.delete", synthesized(ENUMERATED)), [], undefined, () => ({ ok: false, reason: "cannot be resolved" })).outcome).toBe("park");
    expect(effects(judge(call("test.delete", synthesized(ENUMERATED)), [], undefined, resolvesTo(ENUMERATED, { hardLinked: true })))).toMatchObject([{ refused: [{ argument: "to" }] }]);
  });

  // proves D-154: an email address's domain is compared case-insensitively; the local part, subdomains and anything else stay exact
  it("compares an email address's domain case-insensitively and nothing else", () => {
    setUp(grant({ enumerated_targets: [{ field: "to", value: "ops@example.com" }] }));
    expect(judge(call("test.send", synthesized("ops@EXAMPLE.Com"))).outcome).toBe("proceed");
    for (const value of ["OPS@example.com", "ops@sub.example.com", "ops@example.com.", " ops@example.com", "ops@example.co", "ops@exаmple.com"]) {
      expect(effects(judge(call("test.send", synthesized(value)))), value).toMatchObject([{ refused: [{ argument: "to", value }] }]);
    }
  });

  // proves D-154: a URL or any other non-path destination matches only an exactly equal value (no host case folding, prefix or wildcard)
  it("matches a URL only exactly", () => {
    setUp(grant({ enumerated_targets: [{ field: "to", value: "https://hooks.example.com/notify" }] }));
    expect(judge(call("test.send", synthesized("https://hooks.example.com/notify"))).outcome).toBe("proceed");
    for (const value of ["https://HOOKS.example.com/notify", "https://hooks.example.com/notify/x", "https://hooks.example.com/", "https://evil.hooks.example.com/notify"]) {
      expect(judge(call("test.send", synthesized(value))).outcome, value).toBe("park");
    }
  });
});

describe("§2.2.2 payload fields: untrusted content is permitted, under max_input_sensitivity", () => {
  // proves §2.2.2 payload column: an untrusted payload proceeds for every side-effect class
  it("lets an untrusted payload proceed", () => {
    expect(judge(call("test.send", constant("ops"), synthesized("injected words")))).toMatchObject({ outcome: "proceed" });
    expect(judge(call("test.delete", constant("notes"), synthesized("injected words")))).toMatchObject({ outcome: "proceed" });
  });

  // proves §2.2.2 payload column "under max_input_sensitivity": a payload above the ceiling parks sensitivity_ceiling
  it("parks a payload above the capability's ceiling", () => {
    const secret = seed({ stdout_lines: ["the secret"] }, { sensitivity: "secret", integrity: "untrusted" });
    expect(judge(call("test.send", constant("ops"), bound(`\${${String(secret.seq)}.stdout_lines[0]}`)))).toMatchObject({
      outcome: "park",
      detail: { reason: "sensitivity_ceiling" },
    });
  });
});
