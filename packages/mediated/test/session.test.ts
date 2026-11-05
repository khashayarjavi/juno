import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore, GrantStore, HostPathResolver, Workspace, execFileScript } from "../../enforcement/src/index.js";
import { JournalWriter, readPayload, readTrajectory } from "../../journal/src/index.js";
import { TEST_ANCHOR, signed } from "../../enforcement/test/test-keys.js";
import { type HookDecision, MediatedSessions, PathMap, type SessionRequest } from "../src/session.js";

// Mode C (§4.3) for Claude Code, at the protocol level: each test feeds the session the hook input Claude Code sends
// (hooks reference, D-139) and checks JUNO's answer and journal. The real binary is tested by `make mediated-e2e`.

const PRINCIPAL = "alireza";
const T0 = new Date("2026-11-05T09:00:00.000Z");
const SESSION = "0b6c2f6e-1d4e-4f6a-9a51-3c2f9b7d8e10";

let dir: string;
let work: string;
let journal: JournalWriter;
let grants: GrantStore;
let sessions: MediatedSessions;
let now: Date;

function grant(id: string, capabilities: readonly string[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return signed({
    id,
    principal: PRINCIPAL,
    capability_selector: { capabilities: [...capabilities] },
    resource_scope: [{ kind: "path", prefix: "/work/project" }],
    data_class_bounds: { max_sensitivity: "secret", min_integrity: "untrusted" },
    issuance: "preissued",
    issued_by: PRINCIPAL,
    issued_at: new Date(T0.getTime() - 60_000).toISOString(),
    expires_at: new Date(T0.getTime() + 86_400_000).toISOString(),
    max_invocations: 100,
    attenuation_parent: null,
    revoked_at: null,
    ...overrides,
  });
}

function request(overrides: Partial<SessionRequest> = {}): SessionRequest {
  return {
    session_id: SESSION,
    principal: PRINCIPAL,
    attendance: "gated",
    ttl: 3_600_000,
    grants: ["grant-cc"],
    budget: { tool_calls: 50, wall_clock_ms: 3_600_000 },
    unmetered_accepted: true,
    provider_clearance: "internal",
    sources: [
      { id: "project", selector: { kind: "path", prefix: "/work/project" }, data_class: { sensitivity: "internal", integrity: "untrusted" } },
      { id: "secrets", selector: { kind: "path", prefix: "/work/project/secrets" }, data_class: { sensitivity: "secret", integrity: "operator" } },
    ],
    name_map: [{ name: "cat", program: "/usr/bin/cat", side_effect: "read" }],
    ...overrides,
  };
}

let toolUses = 0;
function pre(tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  toolUses += 1;
  return { session_id: SESSION, hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: `toolu_${String(toolUses)}`, cwd: join(work, "project"), ...extra };
}
const post = (preInput: unknown, response: unknown = { ok: true }): unknown => ({ ...(preInput as Record<string, unknown>), hook_event_name: "PostToolUse", tool_response: response });

const entries = () => readTrajectory(journal.root, `session-${SESSION}`);
const payload = (entry: { payload_ref: string }): Record<string, unknown> => {
  const blob = readPayload(journal.root, entry.payload_ref);
  return blob.status === "present" ? (JSON.parse(new TextDecoder().decode(blob.bytes)) as Record<string, unknown>) : {};
};
const parks = () => entries().filter((entry) => entry.kind === "park").map(payload);

/** Asks, then reports the result when JUNO did not deny, as Claude Code would. */
async function call(tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<HookDecision> {
  const asked = pre(tool, input, extra);
  const decision = await sessions.preToolUse(asked);
  if (decision.decision === "none") expect(sessions.postToolUse(post(asked))).toEqual({ recorded: true });
  return decision;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "juno-mediated-"));
  work = join(dir, "work");
  mkdirSync(join(work, "project", "secrets"), { recursive: true });
  writeFileSync(join(work, "project", "notes.txt"), "notes\n");
  writeFileSync(join(work, "project", "secrets", "key.txt"), "secret\n");
  journal = JournalWriter.open(join(dir, "journal"));
  grants = new GrantStore(TEST_ANCHOR);
  grants.add(grant("grant-cc", ["cc.read", "cc.glob", "cc.write", "cc.edit", "cc.bash.read", "cc.bash.write", "cc.webfetch"]));
  now = T0;
  sessions = new MediatedSessions({
    journal,
    grants,
    paths: new PathMap([work, "\\\\wsl.localhost\\Ubuntu-24.04" + work.replace(/\//g, "\\")]),
    resolver: new HostPathResolver(work), protectedPaths: [join(dir, "checkpoints")],
    clock: () => now,
    checkpoints: { workspace: new Workspace(execFileScript(process.execPath, []), "/work", work), store: new CheckpointStore(join(dir, "checkpoints")) },
  });
  expect(await sessions.admit(request({ reversible_workspaces: ["/work/project"] }))).toMatchObject({ admitted: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("§4.3 a session is a Task (V6-6) and §7.8 E2", () => {
  // proves §4.3 V6-6: admission refuses a session whose operator has not accepted unmetered tokens and currency
  it("refuses a session without the operator's acceptance of unmetered axes", async () => {
    const other = new MediatedSessions({ journal, grants, paths: new PathMap([work]), resolver: new HostPathResolver(work), protectedPaths: [join(dir, "checkpoints")], clock: () => now });
    const refused = await other.admit({ ...request({ session_id: "other-1" }), unmetered_accepted: false });
    expect(refused).toMatchObject({ admitted: false });
  });

  // proves §4.3 V6-6 and §7.8 E2: the session closes only accepted, and a hook session's steer_capability is none
  it("admits the session as a Task that can only close accepted, with steer_capability none", () => {
    expect(sessions.task(SESSION)).toMatchObject({ closure_mode: "accepted", steer_capability: "none", criterion: null, objective: "operator session via claude-code" });
    expect(payload(entries()[0] ?? { payload_ref: "" })).toMatchObject({ type: "admission", mode: "hook", unmetered: ["tokens", "currency"] });
  });

  // proves §3.2 C1 in mode C: a forged grant does not exist, so a session naming it is refused
  it("refuses a session whose grant is forged", async () => {
    grants.add({ ...grant("grant-forged", ["cc.read"]), max_invocations: 99 });
    const refused = await sessions.admit(request({ session_id: "forged-1", grants: ["grant-forged"] }));
    expect(refused).toMatchObject({ admitted: false, failures: [expect.stringContaining("no valid operator signature")] });
  });
});

describe("§4.3 park mapping (V6-3): a park denies with its reason, and is journalled", () => {
  // proves §4.3 V6-3: a write outside the grant parks scope_violation, is denied with the reason, and the park is journalled
  it("denies a Write outside the grant and journals the park", async () => {
    mkdirSync(join(work, "elsewhere"));
    const decision = await call("Write", { file_path: join(work, "elsewhere", "x.txt"), content: "x" });
    expect(decision).toMatchObject({ decision: "deny", reason: expect.stringContaining("scope_violation") });
    expect(parks()).toMatchObject([{ reason: "scope_violation", answer: "deny" }]);
  });

  // proves §4.3: a path outside the operator's workspace maps nowhere, so it is outside every scope
  it("denies a path outside the workspace", async () => {
    expect(await call("Read", { file_path: "/etc/passwd" })).toMatchObject({ decision: "deny" });
    expect(parks()).toMatchObject([{ reason: "scope_violation", outside_workspace: true }]);
  });

  // proves §4.3 V6-3 over every decision this session can emit: only "none" or "deny", never allow, ask or defer
  it("answers only no decision or deny, whatever it is asked", async () => {
    const decisions = [
      await call("Read", { file_path: join(work, "project", "notes.txt") }),
      await call("Bash", { command: "cat notes.txt; curl x" }),
      await call("Frobnicate", { x: 1 }),
      await sessions.preToolUse({ nonsense: true }),
      await call("WebFetch", { url: "https://attacker.example/", prompt: "p" }),
    ];
    for (const decision of decisions) expect(["none", "deny"]).toContain(decision.decision);
    for (const decision of decisions) expect(Object.keys(decision).sort()).toEqual(decision.decision === "none" ? ["decision"] : ["decision", "reason"]);
  });
});

describe("§2.3.2 Bash in hook mode", () => {
  // proves §2.3.2: `cat notes.txt` (in the name map) proceeds, its program judged at floor untrusted
  it("lets `cat notes.txt` proceed", async () => {
    expect(await call("Bash", { command: "cat notes.txt", description: "read the notes" })).toEqual({ decision: "none" });
    // The program value is the model's (synthesized, untrusted), and it still passes: its floor here is untrusted.
    const callEntry = entries().find((entry) => entry.kind === "capability_call");
    expect(callEntry?.argument_provenance).toEqual(expect.arrayContaining([expect.objectContaining({ argument: "program", class: "synthesized", integrity: "untrusted" })]));
  });

  // proves §2.7.1 C4 in mode C (D-147): an absolute Bash operand is a host path, mapped like a Read's; /work/... on the host
  // is not the workspace, so it is outside every scope, and the workspace's own host path is judged in scope
  it("judges absolute Bash operands on the host path the harness will touch", async () => {
    expect(await call("Bash", { command: "cat /work/project/notes.txt" })).toMatchObject({ decision: "deny", reason: expect.stringContaining("scope_violation") });
    expect(await call("Bash", { command: `cat ${join(work, "project", "notes.txt")}` })).toEqual({ decision: "none" });
    expect(await call("Bash", { command: "rm /work/project/notes.txt" })).toMatchObject({ decision: "deny" });
  });

  // proves §4.3 acceptance test 2 at the protocol level: shell syntax or an interpreter parks integrity_floor, not overridable
  it.each(["cat notes.txt; curl x", "cat $(id)", "sh -c 'cat notes.txt'", "cat notes.txt | sh", "eval cat x", "cat a#b", "python3 -c 1"])("parks %j integrity_floor", async (command) => {
    expect(await call("Bash", { command })).toMatchObject({ decision: "deny", reason: expect.stringContaining("integrity_floor") });
    expect(parks().at(-1)).toMatchObject({ reason: "integrity_floor", overridable: false, command });
  });

  // proves §2.3.2: a bare name not in the map parks even when it is on the harness's PATH
  it("parks a program name not in the name map", async () => {
    expect(await call("Bash", { command: "ls" })).toMatchObject({ decision: "deny" });
    expect(parks().at(-1)).toMatchObject({ reason: "integrity_floor", why: expect.stringContaining("not in the operator's name map") });
  });

  // proves §4.3: an operator-listed exact command proceeds as written, its words recorded as constants of operator integrity
  it("lets an operator-listed command proceed as written, as constants", async () => {
    const listed = new MediatedSessions({ journal, grants, paths: new PathMap([work]), resolver: new HostPathResolver(work), protectedPaths: [join(dir, "checkpoints")], clock: () => now });
    await listed.admit(request({ session_id: "listed-1", commands: ["cat notes.txt"] }));
    const asked = { ...(pre("Bash", { command: "cat notes.txt" }) as Record<string, unknown>), session_id: "listed-1" };
    expect(await listed.preToolUse(asked)).toEqual({ decision: "none" });
    const callEntry = readTrajectory(journal.root, "session-listed-1").find((entry) => entry.kind === "capability_call");
    expect(callEntry?.argument_provenance).toEqual(expect.arrayContaining([expect.objectContaining({ argument: "program", class: "constant", integrity: "operator" })]));
  });

  // proves §2.3 with §2.3.2 and D-131: an interpreter or a signing/launching program cannot be put in the name map
  it("refuses a name map naming an interpreter or a barred program", async () => {
    expect(await sessions.admit(request({ session_id: "bad-1", name_map: [{ name: "node", program: "/usr/bin/node", side_effect: "read" }] }))).toMatchObject({ admitted: false });
    expect(await sessions.admit(request({ session_id: "bad-2", name_map: [{ name: "ssh-keygen", program: "/usr/bin/ssh-keygen", side_effect: "read" }] }))).toMatchObject({ admitted: false });
  });
});

describe("§2.3.2 V6-10: a Bash call takes the effect of the program it runs (D-146)", () => {
  const withRm = async (id: string, reversible: readonly string[] = []): Promise<MediatedSessions> => {
    const session = new MediatedSessions({
      journal,
      grants,
      paths: new PathMap([work]),
      resolver: new HostPathResolver(work), protectedPaths: [join(dir, "checkpoints")],
      clock: () => now,
      checkpoints: { workspace: new Workspace(execFileScript(process.execPath, []), "/work", work), store: new CheckpointStore(join(dir, "checkpoints")) },
    });
    const admitted = await session.admit(request({ session_id: id, reversible_workspaces: [...reversible], name_map: [{ name: "cat", program: "/usr/bin/cat", side_effect: "read" }, { name: "rm", program: "/usr/bin/rm", side_effect: "write" }] }));
    expect(admitted).toMatchObject({ admitted: true });
    return session;
  };
  const ask = (session: MediatedSessions, id: string, command: string) => session.preToolUse({ ...(pre("Bash", { command }) as Record<string, unknown>), session_id: id });

  // proves §2.3.2 V6-10: `rm x` takes rm's declared effect (write), so with no checkpoint its untrusted target parks, while `cat x` proceeds
  it("judges `rm notes.txt` as a write and `cat notes.txt` as a read", async () => {
    const session = await withRm("rm-1");
    expect(await ask(session, "rm-1", "rm notes.txt")).toMatchObject({ decision: "deny", reason: expect.stringContaining("integrity_floor") });
    expect(await ask(session, "rm-1", "cat notes.txt")).toEqual({ decision: "none" });
  });

  // proves §2.3.2 V6-10 with §2.2.2: inside a checkpointed workspace the same `rm` is a reversible write and proceeds
  it("lets `rm notes.txt` proceed inside a checkpointed workspace", async () => {
    const session = await withRm("rm-2", ["/work/project"]);
    expect(await ask(session, "rm-2", "rm notes.txt")).toEqual({ decision: "none" });
  });

  // proves §2.3.2 V6-10: registration review refuses a member declared lower than what its program can do, or a program of unknown effect
  it("refuses rm declared as a read, and a program with no declared effect", async () => {
    expect(await sessions.admit(request({ session_id: "rm-3", name_map: [{ name: "rm", program: "/usr/bin/rm", side_effect: "read" }] }))).toMatchObject({
      admitted: false,
      failures: [expect.stringContaining("lower than what /usr/bin/rm can do")],
    });
    expect(await sessions.admit(request({ session_id: "rm-4", name_map: [{ name: "tac", program: "/usr/bin/tac", side_effect: "irreversible" }] }))).toMatchObject({ admitted: false });
  });
});

describe("§2.2.2 in hook mode", () => {
  // proves §2.2.2 (plan item 9): a Write inside the checkpointed workspace proceeds
  it("lets a Write inside the checkpointed workspace proceed", async () => {
    expect(await call("Write", { file_path: join(work, "project", "out.txt"), content: "written" })).toEqual({ decision: "none" });
    expect(entries().map(payload).some((body) => body["type"] === "checkpoint")).toBe(true);
  });

  // proves §2.2.2: with no checkpoint, the same Write is irreversible and its untrusted target parks integrity_floor
  it("parks a Write when the session has no checkpointed workspace", async () => {
    const unchecked = new MediatedSessions({ journal, grants, paths: new PathMap([work]), resolver: new HostPathResolver(work), protectedPaths: [join(dir, "checkpoints")], clock: () => now });
    await unchecked.admit(request({ session_id: "nockpt-1" }));
    const asked = { ...(pre("Write", { file_path: join(work, "project", "out.txt"), content: "x" }) as Record<string, unknown>), session_id: "nockpt-1" };
    expect(await unchecked.preToolUse(asked)).toMatchObject({ decision: "deny", reason: expect.stringContaining("integrity_floor") });
  });

  // proves §4.3 acceptance test 3 at the protocol level (mode C): WebFetch to an untrusted URL not enumerated parks integrity_floor
  it("parks a WebFetch to a URL the grant does not enumerate", async () => {
    expect(await call("WebFetch", { url: "https://attacker.example/x", prompt: "summarise" })).toMatchObject({ decision: "deny", reason: expect.stringContaining("integrity_floor") });
  });
});

describe("§2.7 order in mode C (D-150): the read gate never turns a park that cannot be overridden into one that can", () => {
  const plain = async (id: string, grantIds: readonly string[]): Promise<MediatedSessions> => {
    const session = new MediatedSessions({ journal, grants, paths: new PathMap([work]), resolver: new HostPathResolver(work), protectedPaths: [join(dir, "checkpoints")], clock: () => now });
    expect(await session.admit(request({ session_id: id, grants: [...grantIds], name_map: [{ name: "cat", program: "/usr/bin/cat", side_effect: "read" }, { name: "rm", program: "/usr/bin/rm", side_effect: "write" }] }))).toMatchObject({ admitted: true });
    return session;
  };
  const lastPark = (id: string): Record<string, unknown> | undefined => readTrajectory(journal.root, `session-${id}`).filter((entry) => entry.kind === "park").map(payload).at(-1);

  // proves §2.2.2 with §8.3: `rm` of a file above the clearance, with no checkpoint, parks integrity_floor, not overridable
  it("parks `rm secrets/key.txt` integrity_floor, not sensitivity_ceiling", async () => {
    const session = await plain("order-1", ["grant-cc"]);
    expect(await session.preToolUse({ ...(pre("Bash", { command: "rm secrets/key.txt" }) as Record<string, unknown>), session_id: "order-1" })).toMatchObject({ reason: expect.stringContaining("integrity_floor") });
    expect(lastPark("order-1")).toMatchObject({ reason: "integrity_floor", overridable: false });
  });

  // proves the same for an Edit of a file above the clearance
  it("parks an Edit of a secret file integrity_floor, not sensitivity_ceiling", async () => {
    const session = await plain("order-2", ["grant-cc"]);
    const asked = { ...(pre("Edit", { file_path: join(work, "project", "secrets", "key.txt"), old_string: "a", new_string: "b", replace_all: false }) as Record<string, unknown>), session_id: "order-2" };
    expect(await session.preToolUse(asked)).toMatchObject({ reason: expect.stringContaining("integrity_floor") });
    expect(lastPark("order-2")).toMatchObject({ reason: "integrity_floor", overridable: false });
  });

  // proves §8.2 A2 with §2.7 order: a read of a secret file outside the grant parks scope_violation (grant remedy only)
  it("parks a Read of a secret file outside the grant scope_violation, not sensitivity_ceiling", async () => {
    grants.add(grant("grant-narrow", ["cc.read"], { resource_scope: [{ kind: "path", prefix: "/work/project/public" }] }));
    const session = await plain("order-3", ["grant-narrow"]);
    const asked = { ...(pre("Read", { file_path: join(work, "project", "secrets", "key.txt") }) as Record<string, unknown>), session_id: "order-3" };
    expect(await session.preToolUse(asked)).toMatchObject({ reason: expect.stringContaining("scope_violation") });
    expect(lastPark("order-3")).toMatchObject({ reason: "scope_violation", overridable: false });
  });

  // proves §4.3 V6-7: when everything else passes, the read gate still parks the read before it runs, as one boundary record
  it("still parks an in-scope read above the clearance, as the boundary's own step-5 park", async () => {
    const session = await plain("order-4", ["grant-cc"]);
    const asked = { ...(pre("Read", { file_path: join(work, "project", "secrets", "key.txt") }) as Record<string, unknown>), session_id: "order-4" };
    expect(await session.preToolUse(asked)).toMatchObject({ reason: expect.stringContaining("sensitivity_ceiling") });
    expect(lastPark("order-4")).toMatchObject({ reason: "sensitivity_ceiling", detail: { read_gate: true, aggregate: "secret", ceiling: "internal" } });
  });
});

describe("plan item 10 (D-148): JUNO's own state is outside every scope", () => {
  // proves plan item 10: sessions refuse to start when a workspace root would cover the journal or another protected path
  it("refuses a workspace root that covers the journal or a protected path", () => {
    expect(() => new MediatedSessions({ journal, grants, paths: new PathMap([dir]), resolver: new HostPathResolver(dir), protectedPaths: [] })).toThrow(/JUNO's own state/);
    expect(() => new MediatedSessions({ journal, grants, paths: new PathMap([work]), resolver: new HostPathResolver(work), protectedPaths: [join(work, "project", ".claude", "settings.json")] })).toThrow(/JUNO's own state/);
  });

  // proves plan item 10: a tool call naming the journal or the hook's settings parks scope_violation and is denied
  it("denies a tool call naming the journal or Claude Code's settings", async () => {
    expect(await call("Write", { file_path: join(dir, "journal", "x"), content: "x" })).toMatchObject({ decision: "deny", reason: expect.stringContaining("scope_violation") });
    expect(await call("Edit", { file_path: join(dir, "home", ".claude", "settings.json"), old_string: "block", new_string: "continue", replace_all: false })).toMatchObject({ decision: "deny" });
  });
});

describe("§4.3 sensitivity (V6-7), subagents, results and the rejection limit", () => {
  // proves §4.3 V6-7: a read of a source above the provider's clearance parks before it runs; a later permitted read is unaffected
  it("parks a read above the clearance, and later reads still proceed", async () => {
    expect(await call("Read", { file_path: join(work, "project", "secrets", "key.txt") })).toMatchObject({ decision: "deny", reason: expect.stringContaining("sensitivity_ceiling") });
    expect(await call("Read", { file_path: join(work, "project", "notes.txt") })).toEqual({ decision: "none" });
    // A call after a permitted read is unaffected by it.
    expect(await call("Read", { file_path: join(work, "project", "notes.txt") })).toEqual({ decision: "none" });
    expect(await call("Bash", { command: "cat notes.txt" })).toEqual({ decision: "none" });
  });

  // proves §4.3 and hooks reference point 7: a subagent's call (with agent_id) is mediated the same way
  it("mediates a subagent's call the same way", async () => {
    expect(await call("Bash", { command: "cat notes.txt; id" }, { agent_id: "agent-1", agent_type: "Explore" })).toMatchObject({ decision: "deny" });
  });

  // proves plan item 8: results are journalled against the call; a missing result is recorded and the next call denied
  it("journals results, and records a result that never arrived", async () => {
    await call("Read", { file_path: join(work, "project", "notes.txt") });
    expect(entries().filter((entry) => entry.kind === "capability_result").map(payload)).toMatchObject([{ outcome: "succeeded", tool: "Read" }]);
    expect(await sessions.preToolUse(pre("Read", { file_path: join(work, "project", "notes.txt") }))).toEqual({ decision: "none" });
    expect(await sessions.preToolUse(pre("Read", { file_path: join(work, "project", "notes.txt") }))).toMatchObject({ decision: "deny", reason: expect.stringContaining("did not receive the result") });
    expect(entries().map(payload).some((body) => body["type"] === "result_missing")).toBe(true);
  });

  // proves §2.7.1 A4 per session: three rejections in a row (unknown tools) park rejection_limit
  it("parks rejection_limit after three rejections in a row", async () => {
    for (let index = 0; index < 2; index += 1) expect(await call("Frobnicate", {})).toMatchObject({ decision: "deny", reason: expect.stringContaining("unknown_capability") });
    expect(await call("Frobnicate", {})).toMatchObject({ decision: "deny", reason: expect.stringContaining("rejection_limit") });
  });

  // proves §2.7.1 A4 "in hook and gateway modes the count is per session": another session's rejections do not count
  it("counts rejections per session", async () => {
    await sessions.admit(request({ session_id: "other-session" }));
    const other = (input: unknown): Promise<HookDecision> => sessions.preToolUse({ ...(input as Record<string, unknown>), session_id: "other-session" });
    expect(await call("Frobnicate", {})).toMatchObject({ reason: expect.stringContaining("unknown_capability") });
    expect(await call("Frobnicate", {})).toMatchObject({ reason: expect.stringContaining("unknown_capability") });
    expect(await other(pre("Frobnicate", {}))).toMatchObject({ reason: expect.stringContaining("unknown_capability") });
    expect(await other(pre("Frobnicate", {}))).toMatchObject({ reason: expect.stringContaining("unknown_capability") });
    expect(await call("Frobnicate", {})).toMatchObject({ reason: expect.stringContaining("rejection_limit") });
  });

  // proves §4.3: a session not admitted, or input JUNO cannot read, is denied (fail-closed)
  it("denies calls from a session that was never admitted", async () => {
    expect(await sessions.preToolUse({ ...(pre("Read", { file_path: join(work, "project", "notes.txt") }) as Record<string, unknown>), session_id: "unknown" })).toMatchObject({ decision: "deny" });
  });
});
