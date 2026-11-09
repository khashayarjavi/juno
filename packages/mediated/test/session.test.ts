import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore, GrantStore, HostPathResolver, Workspace, execFileScript } from "../../enforcement/src/index.js";
import { readPayload, readTrajectory } from "../../journal/src/index.js";
import { openTestLayer } from "../../enforcement/test/layer.js";
import type { SessionLayer } from "../../enforcement/src/index.js";
import { TEST_ANCHOR, signed } from "../../enforcement/test/test-keys.js";
import { type HookDecision, MediatedSessions, PathMap, type SessionRequest } from "../src/session.js";
import { type FilesystemIo, systemFilesystemIo } from "../src/filesystem.js";

// Mode C (§4.3) for Claude Code, at the protocol level: each test feeds the session the hook input Claude Code sends
// (hooks reference, D-139) and checks JUNO's answer and journal. The real binary is tested by `make mediated-e2e`.

const PRINCIPAL = "alireza";
const T0 = new Date("2026-11-05T09:00:00.000Z");
const SESSION = "0b6c2f6e-1d4e-4f6a-9a51-3c2f9b7d8e10";

let dir: string;
let work: string;
let journal: { readonly root: string };
let layer: SessionLayer;
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
  if (decision.decision !== "deny") expect(await sessions.postToolUse(post(asked))).toEqual({ recorded: true });
  return decision;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "juno-mediated-"));
  work = join(dir, "work");
  mkdirSync(join(work, "project", "secrets"), { recursive: true });
  writeFileSync(join(work, "project", "notes.txt"), "notes\n");
  writeFileSync(join(work, "project", "secrets", "key.txt"), "secret\n");
  now = T0;
  layer = openTestLayer("hook", { journal: join(dir, "journal"), workspaces: [work], state: [{ what: "the checkpoint store", path: join(dir, "checkpoints"), kind: "dir" }], clock: () => now });
  journal = { root: layer.root };
  grants = new GrantStore(TEST_ANCHOR);
  grants.add(grant("grant-cc", ["cc.read", "cc.glob", "cc.write", "cc.edit", "cc.bash.read", "cc.bash.write", "cc.webfetch"]));
  now = T0;
  sessions = new MediatedSessions({
    layer,
    grants,
    // D-173: Linux paths only; the `\\wsl.localhost` spelling of the root (D-141) is gone, and the map refuses one.
    paths: new PathMap([work]),
    resolver: new HostPathResolver(work), view: new Workspace(execFileScript(process.execPath, []), "/work", work), filesystem: systemFilesystemIo(),
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
    const other = new MediatedSessions({ layer, grants, paths: new PathMap([work]), resolver: new HostPathResolver(work), view: new Workspace(execFileScript(process.execPath, []), "/work", work), filesystem: systemFilesystemIo(), clock: () => now });
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

describe("D-178: admission refuses a workspace or source that is not on a case-sensitive Linux file system", () => {
  const described = (fsType: string, folding: string | null = null): FilesystemIo => ({
    ...systemFilesystemIo(),
    mountinfo: () => `20 1 0:20 / / rw - ${fsType} src rw`,
    attributes: (dirs) => Promise.resolve({ ok: true, flags: dirs.map((at) => (at === folding ? "-----F" : "------")) }),
  });
  const withFs = (filesystem: FilesystemIo) => new MediatedSessions({ layer, grants, paths: new PathMap([work]), resolver: new HostPathResolver(work), view: new Workspace(execFileScript(process.execPath, []), "/work", work), filesystem, clock: () => now });

  // proves D-178 (b): a workspace on a Windows folder mounted into WSL (drvfs or 9p) is refused, fail-closed, with a
  // plain reason, and the refusal is journalled; no call of that session is ever allowed
  it.each(["drvfs", "9p"])("refuses a workspace on %s and denies its calls", async (fsType) => {
    const other = withFs(described(fsType));
    const refused = await other.admit(request({ session_id: `win-${fsType}` }));
    expect(refused.admitted).toBe(false);
    // The workspace and each registered path source, each by name.
    const failures = refused.admitted ? [] : refused.failures;
    expect(failures).toEqual([expect.stringContaining("the workspace"), expect.stringContaining("source project"), expect.stringContaining("source secrets")]);
    for (const failure of failures) expect(failure).toMatch(/of type (drvfs|9p).*how WSL mounts a Windows folder.*D-178/);
    const decision = await other.preToolUse({ ...(pre("Read", { file_path: join(work, "project", "notes.txt") }) as Record<string, unknown>), session_id: `win-${fsType}` });
    expect(decision.decision).toBe("deny");
  });

  // proves D-178 (a): a folder with the case-folding attribute under the workspace, or a registered source in one, is refused
  it("refuses a workspace holding a case-folding folder, naming it", async () => {
    const refused = await withFs(described("ext4", join(work, "project", "secrets"))).admit(request({ session_id: "fold-1" }));
    expect(refused).toMatchObject({ admitted: false, failures: expect.arrayContaining([expect.stringContaining(`${join(work, "project", "secrets")} in the workspace`)]) as unknown });
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
    for (const decision of decisions) expect(Object.keys(decision).sort()).toEqual(decision.decision === "none" ? ["decision"] : decision.decision === "allow" ? ["decision", "updatedInput"] : ["decision", "reason"]);
  });
});

describe("§2.3.2 Bash in hook mode", () => {
  // proves §2.3.2: `cat notes.txt` (in the name map) proceeds, its program judged at floor untrusted; D-152: it is allowed
  // with the command rebuilt from what was judged (the name map's absolute path, each argument single-quoted), the
  // other fields passed on as given, and the rebuilt command recorded against the call
  it("lets `cat notes.txt` proceed, rebuilt as judged", async () => {
    expect(await call("Bash", { command: "cat notes.txt", description: "read the notes" })).toEqual({ decision: "allow", updatedInput: { command: "/usr/bin/cat 'notes.txt'", description: "read the notes" } });
    const rebuilt = entries().filter((entry) => entry.kind === "note").map(payload).find((item) => item["type"] === "updated_input");
    expect(rebuilt).toMatchObject({ command: "/usr/bin/cat 'notes.txt'", call_seq: entries().find((entry) => entry.kind === "capability_call")?.seq });
    // The program value is the model's (synthesized, untrusted), and it still passes: its floor here is untrusted.
    const callEntry = entries().find((entry) => entry.kind === "capability_call");
    expect(callEntry?.argument_provenance).toEqual(expect.arrayContaining([expect.objectContaining({ argument: "program", class: "synthesized", integrity: "untrusted" })]));
  });

  // proves §2.7.1 C4 in mode C (D-147): an absolute Bash operand is a host path, mapped like a Read's; /work/... on the host
  // is not the workspace, so it is outside every scope, and the workspace's own host path is judged in scope
  it("judges absolute Bash operands on the host path the harness will touch", async () => {
    expect(await call("Bash", { command: "cat /work/project/notes.txt" })).toMatchObject({ decision: "deny", reason: expect.stringContaining("scope_violation") });
    // The rebuilt command keeps the host path the harness will touch, quoted; the boundary judged its /work mapping.
    expect(await call("Bash", { command: `cat ${join(work, "project", "notes.txt")}` })).toEqual({ decision: "allow", updatedInput: { command: `/usr/bin/cat '${join(work, "project", "notes.txt")}'` } });
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
    const listed = new MediatedSessions({ layer, grants, paths: new PathMap([work]), resolver: new HostPathResolver(work), view: new Workspace(execFileScript(process.execPath, []), "/work", work), filesystem: systemFilesystemIo(), clock: () => now });
    await listed.admit(request({ session_id: "listed-1", commands: ["cat notes.txt"] }));
    const asked = { ...(pre("Bash", { command: "cat notes.txt" }) as Record<string, unknown>), session_id: "listed-1" };
    expect(await listed.preToolUse(asked)).toEqual({ decision: "allow", updatedInput: { command: "/usr/bin/cat 'notes.txt'" } });
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
      layer,
      grants,
      paths: new PathMap([work]),
      resolver: new HostPathResolver(work), view: new Workspace(execFileScript(process.execPath, []), "/work", work), filesystem: systemFilesystemIo(),
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
    expect(await ask(session, "rm-1", "cat notes.txt")).toEqual({ decision: "allow", updatedInput: { command: "/usr/bin/cat 'notes.txt'" } });
  });

  // proves §2.3.2 V6-10 with §2.2.2: inside a checkpointed workspace the same `rm` is a reversible write and proceeds
  it("lets `rm notes.txt` proceed inside a checkpointed workspace", async () => {
    const session = await withRm("rm-2", ["/work/project"]);
    expect(await ask(session, "rm-2", "rm notes.txt")).toEqual({ decision: "allow", updatedInput: { command: "/usr/bin/rm 'notes.txt'" } });
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

  // proves D-158 (autopilot ruling) in hook mode: inside the checkpointed workspace, a Write to a file that has a second
  // name outside it is irreversible (a restore would not undo it there) and parks integrity_floor; an ordinary file proceeds
  it("parks a Write to a hard-linked file inside the checkpointed workspace", async () => {
    writeFileSync(join(work, "outside.txt"), "outside\n");
    linkSync(join(work, "outside.txt"), join(work, "project", "shared.txt"));
    expect(await call("Write", { file_path: join(work, "project", "shared.txt"), content: "written" })).toMatchObject({ decision: "deny", reason: expect.stringContaining("integrity_floor") });
    expect(parks().at(-1)).toMatchObject({ reason: "integrity_floor", overridable: false });
    expect(await call("Write", { file_path: join(work, "project", "fresh.txt"), content: "written" })).toEqual({ decision: "none" });
  });

  // proves D-168 (operator ruling 2 of 2026-11-08) in hook mode: a Write through a symlink whose target lies inside the
  // checkpointed workspace is still judged at the safe default (irreversible) and parks integrity_floor; the target by its
  // own name proceeds
  it("parks a Write through a symlink inside the checkpointed workspace", async () => {
    mkdirSync(join(work, "project", "real"));
    symlinkSync(join(work, "project", "real"), join(work, "project", "alias"));
    expect(await call("Write", { file_path: join(work, "project", "alias", "out.txt"), content: "written" })).toMatchObject({ decision: "deny", reason: expect.stringContaining("integrity_floor") });
    expect(parks().at(-1)).toMatchObject({ reason: "integrity_floor", overridable: false });
    expect(await call("Write", { file_path: join(work, "project", "real", "out.txt"), content: "written" })).toEqual({ decision: "none" });
  });

  // proves §2.2.2: with no checkpoint, the same Write is irreversible and its untrusted target parks integrity_floor
  it("parks a Write when the session has no checkpointed workspace", async () => {
    const unchecked = new MediatedSessions({ layer, grants, paths: new PathMap([work]), resolver: new HostPathResolver(work), view: new Workspace(execFileScript(process.execPath, []), "/work", work), filesystem: systemFilesystemIo(), clock: () => now });
    await unchecked.admit(request({ session_id: "nockpt-1" }));
    const asked = { ...(pre("Write", { file_path: join(work, "project", "out.txt"), content: "x" }) as Record<string, unknown>), session_id: "nockpt-1" };
    expect(await unchecked.preToolUse(asked)).toMatchObject({ decision: "deny", reason: expect.stringContaining("integrity_floor") });
  });

  // proves §4.3 V6-7 with §1.5 (D-160, PR #39 review round 5): a fetched page lies in no declared source, so even an
  // enumerated URL is read at the highest declared class: above an internal clearance it parks before it runs, and at a
  // secret clearance it proceeds and its result is recorded secret, raising the session floor (§1.2)
  it("reads an enumerated WebFetch at the highest declared class", async () => {
    const url = "https://intranet.example/page";
    grants.add(grant("grant-fetch", ["cc.webfetch"], { enumerated_targets: [{ field: "url", value: url }] }));
    expect(await sessions.admit(request({ session_id: "fetch-1", grants: ["grant-fetch"] }))).toMatchObject({ admitted: true });
    const asked = (id: string) => ({ ...(pre("WebFetch", { url, prompt: "summarise" }) as Record<string, unknown>), session_id: id });
    expect(await sessions.preToolUse(asked("fetch-1"))).toMatchObject({ decision: "deny", reason: expect.stringContaining("sensitivity_ceiling") });
    const fetchParks = readTrajectory(journal.root, "session-fetch-1").filter((entry) => entry.kind === "park").map(payload);
    expect(fetchParks.at(-1)).toMatchObject({ reason: "sensitivity_ceiling", detail: expect.objectContaining({ read_gate: true, aggregate: "secret", ceiling: "internal" }) });
    // Control: with a secret clearance the same call proceeds, and what it fetched is recorded at the highest class.
    expect(await sessions.admit(request({ session_id: "fetch-2", grants: ["grant-fetch"], provider_clearance: "secret" }))).toMatchObject({ admitted: true });
    const second = asked("fetch-2");
    expect(await sessions.preToolUse(second)).toEqual({ decision: "none" });
    expect(await sessions.postToolUse(post(second, { content: "TOP SECRET page" }))).toEqual({ recorded: true });
    const result = readTrajectory(journal.root, "session-fetch-2").filter((entry) => entry.kind === "capability_result").at(-1);
    expect(result?.data_class).toEqual({ sensitivity: "secret", integrity: "untrusted" });
  });

  // proves §4.3 acceptance test 3 at the protocol level (mode C): WebFetch to an untrusted URL not enumerated parks integrity_floor
  it("parks a WebFetch to a URL the grant does not enumerate", async () => {
    expect(await call("WebFetch", { url: "https://attacker.example/x", prompt: "summarise" })).toMatchObject({ decision: "deny", reason: expect.stringContaining("integrity_floor") });
  });
});

describe("§2.7 order in mode C (D-150): the read gate never turns a park that cannot be overridden into one that can", () => {
  const plain = async (id: string, grantIds: readonly string[]): Promise<MediatedSessions> => {
    const session = new MediatedSessions({ layer, grants, paths: new PathMap([work]), resolver: new HostPathResolver(work), view: new Workspace(execFileScript(process.execPath, []), "/work", work), filesystem: systemFilesystemIo(), clock: () => now });
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

describe("§2.7.1 D5 in mode C (D-151): an injected command is judged before anything that could make its park retryable", () => {
  const injected = "cat notes.txt; sh -c 'touch pwned'";
  const lastPark = (): Record<string, unknown> | undefined => parks().at(-1);

  // proves §2.7.1 D5: an extra tool-input field Claude Code really offers does not turn integrity_floor into malformed_call
  it("parks integrity_floor even with an unknown extra field", async () => {
    expect(await call("Bash", { command: injected, dangerouslyDisableSandbox: true })).toMatchObject({ reason: expect.stringContaining("integrity_floor") });
    expect(lastPark()).toMatchObject({ reason: "integrity_floor", overridable: false });
  });

  // proves §2.7 order and §2.7.1 D4: a working directory outside the workspace does not present the injection as a scope problem
  it("parks integrity_floor even from a working directory outside the workspace", async () => {
    expect(await call("Bash", { command: injected }, { cwd: "/tmp" })).toMatchObject({ reason: expect.stringContaining("integrity_floor") });
    expect(lastPark()).toMatchObject({ reason: "integrity_floor", overridable: false });
  });

  // proves D-151: after the tool-call budget is spent, an injected command still parks integrity_floor, not budget_exceeded
  it("parks integrity_floor even after the budget is spent", async () => {
    const spent = new MediatedSessions({ layer, grants, paths: new PathMap([work]), resolver: new HostPathResolver(work), view: new Workspace(execFileScript(process.execPath, []), "/work", work), filesystem: systemFilesystemIo(), clock: () => now });
    await spent.admit(request({ session_id: "spent-1", budget: { tool_calls: 1, wall_clock_ms: 3_600_000 } }));
    const ask = (command: string) => spent.preToolUse({ ...(pre("Bash", { command }) as Record<string, unknown>), session_id: "spent-1" });
    const first = { ...(pre("Bash", { command: "cat notes.txt" }) as Record<string, unknown>), session_id: "spent-1" };
    expect(await spent.preToolUse(first)).toEqual({ decision: "allow", updatedInput: { command: "/usr/bin/cat 'notes.txt'" } });
    expect(await spent.postToolUse({ ...first, hook_event_name: "PostToolUse", tool_response: {} })).toEqual({ recorded: true });
    expect(await ask(injected)).toMatchObject({ reason: expect.stringContaining("integrity_floor") });
    expect(await ask("cat notes.txt")).toMatchObject({ reason: expect.stringContaining("budget_exceeded") });
  });
});

describe("plan item 10 (D-148): JUNO's own state is outside every scope", () => {
  // proves plan item 10: sessions refuse to start when a workspace root would cover the journal or another protected path
  // (D-194: the refusal now comes from the shared start-up check, which every service runs, and the sessions refuse a
  // workspace root that check did not judge.)
  it("refuses a workspace root that covers the journal or a protected path", () => {
    expect(() => openTestLayer("hook", { journal: join(dir, "journal"), workspaces: [dir] })).toThrow(/JUNO's own state/);
    expect(() => openTestLayer("hook", { journal: join(dir, "journal"), workspaces: [work], state: [{ what: "Claude Code's settings", path: join(work, "project", ".claude", "settings.json"), kind: "path" }] })).toThrow(/JUNO's own state/);
    expect(() => new MediatedSessions({ layer, grants, paths: new PathMap([dir]), resolver: new HostPathResolver(dir), view: new Workspace(execFileScript(process.execPath, []), "/work", dir), filesystem: systemFilesystemIo() })).toThrow(/not a workspace the start-up check judged/);
  });

  // proves plan item 10: a tool call naming the journal or the hook's settings parks scope_violation and is denied
  it("denies a tool call naming the journal or Claude Code's settings", async () => {
    expect(await call("Write", { file_path: join(dir, "journal", "x"), content: "x" })).toMatchObject({ decision: "deny", reason: expect.stringContaining("scope_violation") });
    expect(await call("Edit", { file_path: join(dir, "home", ".claude", "settings.json"), old_string: "block", new_string: "continue", replace_all: false })).toMatchObject({ decision: "deny" });
  });
});

describe("§4.3 V6-7 on what the call will read (D-156, PR #38 review round 4)", () => {
  const withLs = async (id: string): Promise<MediatedSessions> => {
    const session = new MediatedSessions({ layer, grants, paths: new PathMap([work]), resolver: new HostPathResolver(work), view: new Workspace(execFileScript(process.execPath, []), "/work", work), filesystem: systemFilesystemIo(), clock: () => now });
    const nameMap = [{ name: "cat", program: "/usr/bin/cat", side_effect: "read" as const }, { name: "ls", program: "/usr/bin/ls", side_effect: "read" as const }];
    expect(await session.admit(request({ session_id: id, name_map: nameMap }))).toMatchObject({ admitted: true });
    return session;
  };
  /** Asks, and reports the result when JUNO did not deny, as Claude Code would. */
  const ask = async (session: MediatedSessions, id: string, tool: string, input: Record<string, unknown>, cwd = join(work, "project")): Promise<HookDecision> => {
    const asked = { ...(pre(tool, input) as Record<string, unknown>), session_id: id, cwd };
    const decision = await session.preToolUse(asked);
    if (decision.decision !== "deny") expect(await session.postToolUse({ ...asked, hook_event_name: "PostToolUse", tool_response: {} })).toEqual({ recorded: true });
    return decision;
  };
  const lastPark = (id: string): Record<string, unknown> | undefined => readTrajectory(journal.root, `session-${id}`).filter((entry) => entry.kind === "park").map(payload).at(-1);
  const gated = { reason: "sensitivity_ceiling", detail: expect.objectContaining({ read_gate: true, aggregate: "secret", ceiling: "internal" }) };

  // proves §4.3 V6-7 with §2.7.1 C4: a symlink to a file above the clearance is judged as its target, by Read and by Bash
  it("parks a read of a secret file through a symlink, by Read and by Bash cat", async () => {
    symlinkSync(join(work, "project", "secrets", "key.txt"), join(work, "project", "link.txt"));
    const session = await withLs("gate-1");
    expect(await ask(session, "gate-1", "Read", { file_path: join(work, "project", "link.txt") })).toMatchObject({ decision: "deny", reason: expect.stringContaining("sensitivity_ceiling") });
    expect(lastPark("gate-1")).toMatchObject(gated);
    expect(await ask(session, "gate-1", "Bash", { command: "cat link.txt" })).toMatchObject({ decision: "deny", reason: expect.stringContaining("sensitivity_ceiling") });
    expect(lastPark("gate-1")).toMatchObject(gated);
    expect(await ask(session, "gate-1", "Edit", { file_path: join(work, "project", "link.txt"), old_string: "a", new_string: "b", replace_all: false })).toMatchObject({ decision: "deny" });
  });

  // proves §4.3 V6-7 with §2.7.1 C4 and D-113 (D-166, PR #40 review round 6): `..` after a symlink is taken by the file
  // system after the link, as `cat` takes it, so `pub/lnk/../key.txt` with `pub/lnk` → `secrets/sub` is the secret key
  it("parks a read of the secret file through a link followed by ..", async () => {
    mkdirSync(join(work, "project", "secrets", "sub"));
    mkdirSync(join(work, "project", "pub"));
    symlinkSync(join(work, "project", "secrets", "sub"), join(work, "project", "pub", "lnk"));
    const session = await withLs("gate-dotdot");
    expect(await ask(session, "gate-dotdot", "Bash", { command: "cat pub/lnk/../key.txt" })).toMatchObject({ decision: "deny", reason: expect.stringContaining("sensitivity_ceiling") });
    expect(lastPark("gate-dotdot")).toMatchObject(gated);
    // A Read naming `..` is refused by the path type (malformed_call); it never runs.
    expect(await ask(session, "gate-dotdot", "Read", { file_path: `${join(work, "project", "pub", "lnk")}/../key.txt` })).toMatchObject({ decision: "deny" });
    // Control: `..` with no link before it stays where the text says, an ordinary file read at its own class.
    expect(await ask(session, "gate-dotdot", "Bash", { command: "cat pub/../notes.txt" })).toMatchObject({ decision: "allow" });
  });

  // proves the same through a chain of links, and through a relative link
  it("follows a chain of links to the secret file", async () => {
    symlinkSync("secrets/key.txt", join(work, "project", "first.txt"));
    symlinkSync(join(work, "project", "first.txt"), join(work, "project", "second.txt"));
    const session = await withLs("gate-2");
    expect(await ask(session, "gate-2", "Bash", { command: "cat second.txt" })).toMatchObject({ decision: "deny", reason: expect.stringContaining("sensitivity_ceiling") });
    expect(lastPark("gate-2")).toMatchObject(gated);
  });

  // proves §4.3 V6-7 for directory reads: a link inside a listed tree is a read of its target's tree, for Glob and for ls
  it("parks a Glob or ls of a directory that holds a link into the secrets", async () => {
    mkdirSync(join(work, "project", "public"));
    writeFileSync(join(work, "project", "public", "a.txt"), "a\n");
    const session = await withLs("gate-3");
    // Without the link, the public tree is below the clearance.
    expect(await ask(session, "gate-3", "Glob", { pattern: "**/*", path: join(work, "project", "public") })).toEqual({ decision: "none" });
    symlinkSync(join(work, "project", "secrets"), join(work, "project", "public", "docs"));
    expect(await ask(session, "gate-3", "Glob", { pattern: "**/*", path: join(work, "project", "public") })).toMatchObject({ decision: "deny", reason: expect.stringContaining("sensitivity_ceiling") });
    expect(await ask(session, "gate-3", "Bash", { command: "ls -R public" })).toMatchObject({ decision: "deny", reason: expect.stringContaining("sensitivity_ceiling") });
    expect(await ask(session, "gate-3", "Bash", { command: "ls public/docs" })).toMatchObject({ decision: "deny", reason: expect.stringContaining("sensitivity_ceiling") });
    expect(lastPark("gate-3")).toMatchObject(gated);
  });

  // proves §4.3 V6-7 for ls (the round-4 note): ls with no operand lists its working directory, and ls of a directory lists it
  it("judges ls with no operand on its working directory, and ls of a directory on that directory", async () => {
    mkdirSync(join(work, "project", "public"));
    const session = await withLs("gate-4");
    expect(await ask(session, "gate-4", "Bash", { command: "ls -R" })).toMatchObject({ decision: "deny", reason: expect.stringContaining("sensitivity_ceiling") });
    expect(await ask(session, "gate-4", "Bash", { command: "ls" })).toMatchObject({ decision: "deny", reason: expect.stringContaining("sensitivity_ceiling") });
    expect(await ask(session, "gate-4", "Bash", { command: "ls secrets" })).toMatchObject({ decision: "deny", reason: expect.stringContaining("sensitivity_ceiling") });
    expect(lastPark("gate-4")).toMatchObject(gated);
    expect(await ask(session, "gate-4", "Bash", { command: "ls -R public" })).toEqual({ decision: "allow", updatedInput: { command: "/usr/bin/ls '-R' 'public'" } });
    expect(await ask(session, "gate-4", "Bash", { command: "ls" }, join(work, "project", "public"))).toEqual({ decision: "allow", updatedInput: { command: "/usr/bin/ls" } });
  });

  // proves D-174 (operator ruling 2 of 2026-11-08, second set), which refines D-168 and so reverses this test's D-168
  // expectation back to D-156's: a link whose text and target both lie in exactly the source `project` keeps `internal`,
  // proceeds, and is recorded internal; the crossing control, a link in `project` to a file in `project/secrets`, still
  // parks at the highest declared class; the file by its own name keeps its class
  it("reads a link inside one source at that source's class, and a link that leaves it at the highest declared class", async () => {
    symlinkSync(join(work, "project", "notes.txt"), join(work, "project", "alias.txt"));
    symlinkSync(join(work, "project", "secrets", "key.txt"), join(work, "project", "key-alias.txt"));
    const session = await withLs("gate-5");
    const asked = { ...(pre("Read", { file_path: join(work, "project", "alias.txt") }) as Record<string, unknown>), session_id: "gate-5" };
    expect(await session.preToolUse(asked)).toEqual({ decision: "none" });
    expect(await session.postToolUse({ ...asked, hook_event_name: "PostToolUse", tool_response: { content: "notes" } })).toEqual({ recorded: true });
    expect(readTrajectory(journal.root, "session-gate-5").filter((entry) => entry.kind === "capability_result").at(-1)?.data_class).toEqual({ sensitivity: "internal", integrity: "untrusted" });
    const crossing = { ...(pre("Read", { file_path: join(work, "project", "key-alias.txt") }) as Record<string, unknown>), session_id: "gate-5" };
    expect(await session.preToolUse(crossing)).toMatchObject({ decision: "deny", reason: expect.stringContaining("sensitivity_ceiling") });
    expect(lastPark("gate-5")).toMatchObject(gated);
    const plain = { ...(pre("Read", { file_path: join(work, "project", "notes.txt") }) as Record<string, unknown>), session_id: "gate-5" };
    expect(await session.preToolUse(plain)).toEqual({ decision: "none" });
    expect(await session.postToolUse({ ...plain, hook_event_name: "PostToolUse", tool_response: { content: "notes" } })).toEqual({ recorded: true });
    const result = readTrajectory(journal.root, "session-gate-5").filter((entry) => entry.kind === "capability_result").at(-1);
    expect(result?.data_class).toEqual({ sensitivity: "internal", integrity: "untrusted" });
  });

  // proves D-156 fail-closed: a link that leaves every declared source is read at the highest declared class
  it("reads a link to an undeclared place at the highest declared class", async () => {
    mkdirSync(join(work, "project", "public"));
    mkdirSync(join(work, "elsewhere"));
    symlinkSync(join(work, "elsewhere"), join(work, "project", "public", "out"));
    const session = await withLs("gate-6");
    expect(await ask(session, "gate-6", "Glob", { pattern: "*", path: join(work, "project", "public") })).toMatchObject({ decision: "deny", reason: expect.stringContaining("sensitivity_ceiling") });
  });
});

describe("refuse cleverness (D-168, refined by D-174: a shortcut inside one source keeps its class)", () => {
  const withLs = async (id: string): Promise<MediatedSessions> => {
    const session = new MediatedSessions({ layer, grants, paths: new PathMap([work]), resolver: new HostPathResolver(work), view: new Workspace(execFileScript(process.execPath, []), "/work", work), filesystem: systemFilesystemIo(), clock: () => now });
    const nameMap = [{ name: "cat", program: "/usr/bin/cat", side_effect: "read" as const }, { name: "ls", program: "/usr/bin/ls", side_effect: "read" as const }];
    expect(await session.admit(request({ session_id: id, name_map: nameMap }))).toMatchObject({ admitted: true });
    return session;
  };
  const ask = async (session: MediatedSessions, id: string, tool: string, input: Record<string, unknown>): Promise<HookDecision> => {
    const asked = { ...(pre(tool, input) as Record<string, unknown>), session_id: id, cwd: join(work, "project") };
    const decision = await session.preToolUse(asked);
    if (decision.decision !== "deny") expect(await session.postToolUse({ ...asked, hook_event_name: "PostToolUse", tool_response: {} })).toEqual({ recorded: true });
    return decision;
  };
  const lastResult = (id: string) => readTrajectory(journal.root, `session-${id}`).filter((entry) => entry.kind === "capability_result").at(-1);
  const parked = { decision: "deny", reason: expect.stringContaining("sensitivity_ceiling") };

  // proves D-168's positive control: plain paths keep their registered class, written with `.`, `//`, a trailing slash on
  // a directory, or `..` with no link before it; each proceeds below the highest clearance and is recorded internal
  it("keeps the registered class of plain paths, however they are spelled", async () => {
    mkdirSync(join(work, "project", "docs"));
    writeFileSync(join(work, "project", "docs", "a.txt"), "a\n");
    const session = await withLs("clever-1");
    for (const command of ["cat ./notes.txt", "cat docs//a.txt", "cat docs/../notes.txt", "ls -R docs/", "ls -R ./docs//"]) {
      expect(await ask(session, "clever-1", "Bash", { command })).toMatchObject({ decision: "allow" });
      expect(lastResult("clever-1")?.data_class).toEqual({ sensitivity: "internal", integrity: "untrusted" });
    }
    // (A typed path field refuses `.`, `..`, `//` and a trailing slash outright, malformed_call; Bash operands carry them.)
    expect(await ask(session, "clever-1", "Glob", { pattern: "*", path: join(work, "project", "docs") })).toEqual({ decision: "none" });
    expect(lastResult("clever-1")?.data_class).toEqual({ sensitivity: "internal", integrity: "untrusted" });
  });

  // proves D-174 (refining D-168; this test's D-168 expectation is reversed on purpose): a symlink in a path, in a middle
  // component, inside a tree read, or before `..`, whose text and kernel-resolved place both lie in exactly the source
  // `project`, keeps `internal` and proceeds (`e/../a.txt` with `e` → `docs/sub` is `docs/a.txt` to the kernel, `a.txt`
  // to the text: both in `project` only)
  it("keeps the class of a symlink by name, in a middle component, inside a tree, or before .., that stays inside one source", async () => {
    mkdirSync(join(work, "project", "docs"));
    mkdirSync(join(work, "project", "tree"));
    writeFileSync(join(work, "project", "docs", "a.txt"), "a\n");
    symlinkSync(join(work, "project", "docs"), join(work, "project", "d"));
    symlinkSync(join(work, "project", "docs", "a.txt"), join(work, "project", "tree", "a.lnk"));
    const session = await withLs("clever-2");
    mkdirSync(join(work, "project", "docs", "sub"));
    symlinkSync(join(work, "project", "docs", "sub"), join(work, "project", "e"));
    for (const command of ["cat d/a.txt", "ls -R d", "ls -R tree", "cat e/../a.txt"]) {
      expect(await ask(session, "clever-2", "Bash", { command }), command).toMatchObject({ decision: "allow" });
      expect(lastResult("clever-2")?.data_class, command).toEqual({ sensitivity: "internal", integrity: "untrusted" });
    }
    expect(await ask(session, "clever-2", "Read", { file_path: join(work, "project", "d", "a.txt") })).toEqual({ decision: "none" });
    expect(await ask(session, "clever-2", "Glob", { pattern: "*", path: join(work, "project", "tree") })).toEqual({ decision: "none" });
    expect(lastResult("clever-2")?.data_class).toEqual({ sensitivity: "internal", integrity: "untrusted" });
    expect(await ask(session, "clever-2", "Bash", { command: "cat docs/a.txt" })).toMatchObject({ decision: "allow" });
    expect(lastResult("clever-2")?.data_class).toEqual({ sensitivity: "internal", integrity: "untrusted" });
  });

  // proves D-174 (the crossing controls, same shapes): a symlink that leaves its source, by name, in a middle component,
  // inside a tree, or before `..`, is read at the highest declared class and parks under an internal clearance; and so
  // does a tree whose shortcut is in `project` while a source (`project/secrets`) lies under its target
  it("reads a symlink that leaves its source, in each of those shapes, at the highest declared class", async () => {
    mkdirSync(join(work, "project", "tree"));
    mkdirSync(join(work, "project", "secrets", "sub"));
    symlinkSync(join(work, "project", "secrets"), join(work, "project", "s"));
    symlinkSync(join(work, "project", "secrets", "key.txt"), join(work, "project", "tree", "k.lnk"));
    symlinkSync(join(work, "project", "secrets", "sub"), join(work, "project", "x"));
    writeFileSync(join(work, "project", "key.txt"), "not the key\n");
    // A link from inside the secrets folder back to an internal file leaves `project/secrets` too.
    symlinkSync(join(work, "project", "notes.txt"), join(work, "project", "secrets", "back.lnk"));
    symlinkSync(join(work, "project"), join(work, "project", "tree", "up"));
    const session = await withLs("clever-3");
    for (const command of ["cat s/key.txt", "ls -R s", "ls -R tree", "cat x/../key.txt", "cat secrets/back.lnk"]) {
      expect(await ask(session, "clever-3", "Bash", { command }), command).toMatchObject(parked);
    }
    expect(await ask(session, "clever-3", "Read", { file_path: join(work, "project", "s", "key.txt") })).toMatchObject(parked);
    expect(await ask(session, "clever-3", "Glob", { pattern: "*", path: join(work, "project", "tree") })).toMatchObject(parked);
    // The text `key.txt` names an internal file; the kernel opens the secret one: never read below the secret class.
    expect(await ask(session, "clever-3", "Bash", { command: "cat key.txt" })).toMatchObject({ decision: "allow" });
  });

  // proves D-174 with a node_modules/.bin layout: file links into a package and a folder alias, all inside `project`,
  // keep `internal`; a .bin link that leaves the workspace's sources is the highest class
  it("keeps the class of a node_modules/.bin layout inside one source, and not of a .bin link that leaves it", async () => {
    mkdirSync(join(work, "project", "node_modules", ".bin"), { recursive: true });
    mkdirSync(join(work, "project", "node_modules", "pkg", "bin"), { recursive: true });
    writeFileSync(join(work, "project", "node_modules", "pkg", "bin", "tool.js"), "tool\n");
    writeFileSync(join(work, "project", "node_modules", "pkg", "package.json"), "{}\n");
    symlinkSync("../pkg/bin/tool.js", join(work, "project", "node_modules", ".bin", "tool"));
    symlinkSync("../pkg/bin/tool.js", join(work, "project", "node_modules", ".bin", "tool2"));
    symlinkSync("pkg", join(work, "project", "node_modules", "alias"));
    const session = await withLs("clever-4");
    for (const command of ["cat node_modules/.bin/tool", "ls -R node_modules", "cat node_modules/alias/package.json", "ls -R node_modules/alias"]) {
      expect(await ask(session, "clever-4", "Bash", { command }), command).toMatchObject({ decision: "allow" });
      expect(lastResult("clever-4")?.data_class, command).toEqual({ sensitivity: "internal", integrity: "untrusted" });
    }
    mkdirSync(join(work, "elsewhere"));
    writeFileSync(join(work, "elsewhere", "tool.js"), "x\n");
    symlinkSync(join(work, "elsewhere", "tool.js"), join(work, "project", "node_modules", ".bin", "outside"));
    // By name it resolves outside the grant's scope too, so scope stops it first, not overridable (§2.7.1 C4).
    expect(await ask(session, "clever-4", "Bash", { command: "cat node_modules/.bin/outside" })).toMatchObject({ decision: "deny", reason: expect.stringContaining("scope_violation") });
    // Inside a tree read, the scope holds (the operand is node_modules) and the read gate parks it at the highest class.
    expect(await ask(session, "clever-4", "Bash", { command: "ls -R node_modules" })).toMatchObject(parked);
  });
});

describe("§4.3 V6-7 and hard links (D-157, operator ruling of 2026-11-07, amends D-156)", () => {
  const withLs = async (id: string): Promise<MediatedSessions> => {
    const session = new MediatedSessions({ layer, grants, paths: new PathMap([work]), resolver: new HostPathResolver(work), view: new Workspace(execFileScript(process.execPath, []), "/work", work), filesystem: systemFilesystemIo(), clock: () => now });
    const nameMap = [{ name: "cat", program: "/usr/bin/cat", side_effect: "read" as const }, { name: "ls", program: "/usr/bin/ls", side_effect: "read" as const }];
    expect(await session.admit(request({ session_id: id, name_map: nameMap }))).toMatchObject({ admitted: true });
    return session;
  };
  const ask = async (session: MediatedSessions, id: string, tool: string, input: Record<string, unknown>, response: unknown = {}): Promise<HookDecision> => {
    const asked = { ...(pre(tool, input) as Record<string, unknown>), session_id: id, cwd: join(work, "project") };
    const decision = await session.preToolUse(asked);
    if (decision.decision !== "deny") expect(await session.postToolUse({ ...asked, hook_event_name: "PostToolUse", tool_response: response })).toEqual({ recorded: true });
    return decision;
  };
  const lastPark = (id: string): Record<string, unknown> | undefined => readTrajectory(journal.root, `session-${id}`).filter((entry) => entry.kind === "park").map(payload).at(-1);
  const lastResult = (id: string) => readTrajectory(journal.root, `session-${id}`).filter((entry) => entry.kind === "capability_result").at(-1);
  const gated = { reason: "sensitivity_ceiling", detail: expect.objectContaining({ read_gate: true, aggregate: "secret", ceiling: "internal" }) };
  const parked = { decision: "deny", reason: expect.stringContaining("sensitivity_ceiling") };

  // proves D-157 with §4.3 V6-7: a hard link in an internal folder to a secret file is read at the highest declared class,
  // by Read, Bash cat and Edit, and as part of a directory read (Glob, ls -R)
  it("parks a read of a hard link to a secret file, by name and inside a tree", async () => {
    mkdirSync(join(work, "project", "public"));
    linkSync(join(work, "project", "secrets", "key.txt"), join(work, "project", "public", "copy.txt"));
    const session = await withLs("hard-1");
    expect(await ask(session, "hard-1", "Read", { file_path: join(work, "project", "public", "copy.txt") })).toMatchObject(parked);
    expect(lastPark("hard-1")).toMatchObject(gated);
    expect(await ask(session, "hard-1", "Bash", { command: "cat public/copy.txt" })).toMatchObject(parked);
    expect(lastPark("hard-1")).toMatchObject(gated);
    // An Edit is also a write with no reversible workspace here, so step 4's integrity_floor comes first (D-150's order).
    expect(await ask(session, "hard-1", "Edit", { file_path: join(work, "project", "public", "copy.txt"), old_string: "a", new_string: "b", replace_all: false })).toMatchObject({ decision: "deny" });
    expect(await ask(session, "hard-1", "Glob", { pattern: "**/*", path: join(work, "project", "public") })).toMatchObject(parked);
    expect(await ask(session, "hard-1", "Bash", { command: "ls -R public" })).toMatchObject(parked);
    expect(lastPark("hard-1")).toMatchObject(gated);
  });

  // proves D-157's positive control: an ordinary file in the same folder proceeds and is recorded at its own class
  it("leaves an ordinary file unaffected, by name and inside a tree", async () => {
    mkdirSync(join(work, "project", "public"));
    writeFileSync(join(work, "project", "public", "plain.txt"), "plain\n");
    const session = await withLs("hard-2");
    expect(await ask(session, "hard-2", "Read", { file_path: join(work, "project", "public", "plain.txt") }, { content: "plain" })).toEqual({ decision: "none" });
    expect(lastResult("hard-2")?.data_class).toEqual({ sensitivity: "internal", integrity: "untrusted" });
    expect(await ask(session, "hard-2", "Bash", { command: "cat public/plain.txt" })).toEqual({ decision: "allow", updatedInput: { command: "/usr/bin/cat 'public/plain.txt'" } });
    expect(await ask(session, "hard-2", "Glob", { pattern: "**/*", path: join(work, "project", "public") })).toEqual({ decision: "none" });
    expect(lastPark("hard-2")).toBeUndefined();
  });

  // proves D-157 as ruled: the class is the highest declared whatever the other name is, since JUNO cannot see it by path;
  // two names for one internal file are read at the highest class too
  it("reads any regular file with more than one link at the highest declared class", async () => {
    linkSync(join(work, "project", "notes.txt"), join(work, "project", "notes-again.txt"));
    const session = await withLs("hard-3");
    expect(await ask(session, "hard-3", "Read", { file_path: join(work, "project", "notes.txt") })).toMatchObject(parked);
    expect(lastPark("hard-3")).toMatchObject(gated);
  });
});

describe("§4.3 sensitivity (V6-7), subagents, results and the rejection limit", () => {
  // proves §4.3 V6-7: a read of a source above the provider's clearance parks before it runs; a later permitted read is unaffected
  it("parks a read above the clearance, and later reads still proceed", async () => {
    expect(await call("Read", { file_path: join(work, "project", "secrets", "key.txt") })).toMatchObject({ decision: "deny", reason: expect.stringContaining("sensitivity_ceiling") });
    expect(await call("Read", { file_path: join(work, "project", "notes.txt") })).toEqual({ decision: "none" });
    // A call after a permitted read is unaffected by it.
    expect(await call("Read", { file_path: join(work, "project", "notes.txt") })).toEqual({ decision: "none" });
    expect(await call("Bash", { command: "cat notes.txt" })).toEqual({ decision: "allow", updatedInput: { command: "/usr/bin/cat 'notes.txt'" } });
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

describe("D-173 (operator ruling on D-172, option b): Claude Code is governed only inside WSL2; JUNO accepts only Linux absolute paths", () => {
  const WINDOWS_FORMS = (): readonly string[] => [
    "\\\\wsl.localhost\\Ubuntu-24.04" + join(work, "project", "notes.txt").replace(/\//g, "\\"),
    "\\\\wsl$\\Ubuntu-24.04" + join(work, "project", "notes.txt").replace(/\//g, "\\"),
    "\\\\?\\C:\\project\\notes.txt",
    "\\\\.\\C:\\project\\notes.txt",
    "\\\\server\\share\\notes.txt",
    "//server/share/notes.txt",
    "//?/C:/project/notes.txt",
    "C:\\project\\notes.txt",
    "c:/project/notes.txt",
    "C:notes.txt",
    join(work, "project") + "\\secrets.\\key.txt",
    join(work, "project", "secrets") + "\\key.txt",
  ];

  // proves D-173: every Windows spelling of a path a tool names is refused, not overridable, with a reason that says so; nothing reaches the classifier as an allowed read
  it("refuses a Windows-form path in Read, Write, Edit and Glob, fail-closed, with a clear reason", async () => {
    for (const path of WINDOWS_FORMS()) {
      for (const [tool, input] of [
        ["Read", { file_path: path }],
        ["Write", { file_path: path, content: "x" }],
        ["Edit", { file_path: path, old_string: "a", new_string: "b" }],
        ["Glob", { pattern: "*", path }],
      ] as const) {
        const decision = await sessions.preToolUse(pre(tool, input));
        expect(decision, `${tool} ${path}`).toMatchObject({ decision: "deny", reason: expect.stringContaining("Windows-form path") });
        expect(decision).toMatchObject({ reason: expect.stringContaining("only inside WSL2") });
        expect(decision).toMatchObject({ reason: expect.stringContaining("cannot be overridden") });
      }
    }
    const recorded = parks();
    expect(recorded.length).toBe(WINDOWS_FORMS().length * 4);
    expect(recorded.every((park) => park["reason"] === "scope_violation" && park["overridable"] === false && park["windows_path"] === true)).toBe(true);
    // Nothing was authorized, so no result can be recorded against any of these calls.
    expect(entries().filter((entry) => entry.kind === "capability_result")).toEqual([]);
  });

  // proves D-173: a Glob pattern with a backslash or a drive letter is refused the same way
  it("refuses a Glob pattern in Windows form", async () => {
    for (const pattern of ["secrets\\*", "C:*"]) {
      expect(await sessions.preToolUse(pre("Glob", { pattern, path: join(work, "project") }))).toMatchObject({ decision: "deny", reason: expect.stringContaining("Windows-form path") });
    }
  });

  // proves D-173: a Bash operand in Windows form is refused, absolute or not, and so is a Windows-form working directory
  it("refuses a Windows-form Bash operand or working directory", async () => {
    for (const command of ["cat 'C:\\project\\notes.txt'", "cat C:/project/notes.txt", "cat C:notes.txt", "cat '\\\\wsl.localhost\\Ubuntu-24.04\\work\\notes.txt'", "cat //server/share/notes.txt", "cat 'secrets\\key.txt'"]) {
      const decision = await sessions.preToolUse(pre("Bash", { command }));
      expect(decision, command).toMatchObject({ decision: "deny", reason: expect.stringContaining("Windows-form path") });
    }
    const cwd = "\\\\wsl.localhost\\Ubuntu-24.04" + join(work, "project").replace(/\//g, "\\");
    expect(await sessions.preToolUse(pre("Bash", { command: "cat notes.txt" }, { cwd }))).toMatchObject({ decision: "deny", reason: expect.stringContaining("cwd") });
    expect(await sessions.preToolUse(pre("Read", { file_path: join(work, "project", "notes.txt") }, { cwd: "C:\\Users\\me" }))).toMatchObject({ decision: "deny", reason: expect.stringContaining("Windows-form path") });
  });

  // proves D-173 (positive control): the same files by their Linux paths are judged as before
  it("still judges the same files by their Linux paths", async () => {
    expect(await call("Read", { file_path: join(work, "project", "notes.txt") })).toEqual({ decision: "none" });
    expect(await call("Bash", { command: "cat notes.txt" })).toMatchObject({ decision: "allow" });
    expect(await sessions.preToolUse(pre("Read", { file_path: join(work, "project", "secrets", "key.txt") }))).toMatchObject({ decision: "deny", reason: expect.stringContaining("sensitivity_ceiling") });
  });

  // proves D-173: the operator's configuration is Linux paths too; a backslash in a source prefix is refused at admission
  it("refuses at admission a source written with a backslash", async () => {
    const refused = await sessions.admit(request({ session_id: "windows-source", sources: [{ id: "project", selector: { kind: "path", prefix: "/work/project\\secrets" }, data_class: { sensitivity: "internal", integrity: "untrusted" } }] }));
    expect(refused).toMatchObject({ admitted: false, failures: expect.arrayContaining([expect.stringContaining("Windows-form path")]) });
  });

  // proves D-173: a workspace root in Windows form is refused when the map is built (D-141's second spelling is gone)
  it("refuses a Windows-form workspace root", () => {
    for (const root of ["\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\work", "C:\\work", "c:/work", "//server/share", "relative/work", "/home/me\\work"]) {
      expect(() => new PathMap([root]), root).toThrow(/Linux/);
    }
    expect(new PathMap([work]).toWork(join(work, "project"))).toBe("/work/project");
    expect(new PathMap([work]).toWork(work + "\\project")).toBeNull();
  });
});
