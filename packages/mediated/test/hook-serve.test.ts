import { execFile } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionLayer } from "../../enforcement/src/index.js";
import { MemoryAnchorSink, testAnchoring, testJournalKey } from "../../enforcement/test/anchoring.js";
import { ordinaryHost } from "../../enforcement/test/layer.js";
import { TEST_ANCHOR, signed } from "../../enforcement/test/test-keys.js";
import { readPayload, readTrajectory } from "../../journal/src/index.js";
import { caseFoldingRefusals, systemFilesystemIo } from "../src/filesystem.js";
import { runHookClient } from "../src/hook-client.js";
import { unsealedLauncher } from "../../enforcement/test/sealed.js";
import { type HookServeIo, runHookAdmitCli, runHookServeCli } from "../src/hook-serve.js";
import { HookSessionFile } from "../src/hook-session-file.js";

import { fileURLToPath } from "node:url";

// Plan Increment 6, operator ruling D-180 (DECISIONS.md D-196): `juno hook serve` starts JUNO's hook service on the
// operator's machine and `juno hook admit` admits one session the operator wrote. Here: the real commands, the real
// shared start-up check, the real sockets and the real hook client (juno-hook's `runHookClient`); only the uid (an
// ordinary user), the container runtime's report and the stop signal are given.

const PRINCIPAL = "alireza";
const SESSION = "6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab";
/** The in-memory anchor destination of each test (D-198). */
let anchors = new MemoryAnchorSink();
let dir: string;
let work: string;
let sockets: string;
let said: string[];

const grant = (id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  signed({ id, principal: PRINCIPAL, capability_selector: { capabilities: ["cc.read", "cc.write"] }, resource_scope: [{ kind: "path", prefix: "/work/project" }], data_class_bounds: { max_sensitivity: "secret", min_integrity: "untrusted" }, issuance: "preissued", issued_by: PRINCIPAL, issued_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString(), max_invocations: 100, attenuation_parent: null, revoked_at: null, ...overrides });

const sessionFile = (overrides: Record<string, unknown> = {}, grants: readonly string[] = [join(dir, "state", "grant-cc.json")]): Record<string, unknown> => ({
  comments: ["The operator's session file (plan Increment 6)."],
  session: { session_id: SESSION, principal: PRINCIPAL, attendance: "gated", ttl: 3_600_000, grants: ["grant-cc"], budget: { tool_calls: 20, wall_clock_ms: 3_600_000 }, unmetered_accepted: true, provider_clearance: "internal", sources: [{ id: "project", selector: { kind: "path", prefix: "/work/project" }, data_class: { sensitivity: "internal", integrity: "untrusted" } }], name_map: [], ...overrides },
  grants,
});

/** The anchor pin, as the operator writes it as root (D-208): under a folder the test host reports as root's own. */
function writePin(dir: string, journal: string): string {
  const path = join(dir, "root-owned", "anchors.json");
  mkdirSync(join(dir, "root-owned"), { recursive: true, mode: 0o755 });
  writeFileSync(path, JSON.stringify({ url: join(dir, "pinned-juno-anchors.git"), branch: "main", host_key_fingerprint: null, known_hosts: null, push_key: null, git: "/usr/bin/git", journals: [{ path: journal, recovery_epoch: "2020-01-01T00:00:00Z" }] }), { mode: 0o644 });
  return path;
}

const args = (): string[] => ["--socket", join(sockets, "hook.sock"), "--control", join(sockets, "admit.sock"), "--journal", join(dir, "state", "journal"), "--anchor", join(dir, "anchor", "operator.pub"), "--workspace", work, "--checkpoints", join(dir, "state", "checkpoints"), "--journal-key", join(dir, "state", "journal-key"), "--anchors", join(dir, "state", "juno-anchors"), "--anchor-pin", writePin(dir, join(dir, "state", "journal")), "--protect", join(dir, "claude-home")];

const quiet = { out: (text: string) => said.push(text), err: (text: string) => said.push(text) };

/** Runs `juno hook serve` until `drive` finishes, handing it the service's layer; returns the exit code. */
async function serving(drive: (layer: SessionLayer) => Promise<void>, overrides: Partial<HookServeIo> = {}): Promise<number> {
  let driving: Promise<void> = Promise.resolve();
  return runHookServeCli(args(), {
    host: ordinaryHost(),
    filesystem: systemFilesystemIo(),
    runtime: () => Promise.resolve({ cgroupDriver: "systemd", cgroupVersion: "2", rootless: true }),
    // D-228: the sealed program, run without its container here (the seal is proven by test/containers/sealed-copy.test.ts).
    sealed: unsealedLauncher,
    // §3.4.1 (D-198): every service anchors; here to an in-memory destination (the flags are still judged).
    anchoring: testAnchoring({ sink: anchors }),
    ready: ({ layer }) => {
      driving = drive(layer);
    },
    stopped: () => driving,
    ...quiet,
    ...overrides,
  });
}

let toolUses = 0;
const pre = (tool: string, input: Record<string, unknown>): string => {
  toolUses += 1;
  return JSON.stringify({ session_id: SESSION, hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: `toolu_${String(toolUses)}`, cwd: join(work, "project") });
};

const entries = (root: string): Record<string, unknown>[] =>
  readTrajectory(root, `session-${SESSION}`).map((entry) => {
    const blob = readPayload(root, entry.payload_ref);
    return { kind: entry.kind, ...(blob.status === "present" ? (JSON.parse(new TextDecoder().decode(blob.bytes)) as Record<string, unknown>) : {}) };
  });

beforeEach(() => {
  anchors = new MemoryAnchorSink();
  dir = mkdtempSync(join(tmpdir(), "juno-hook-serve-"));
  work = join(dir, "work");
  sockets = join(dir, "sock");
  said = [];
  mkdirSync(join(work, "project"), { recursive: true });
  writeFileSync(join(work, "project", "notes.txt"), "notes\n");
  mkdirSync(join(dir, "state"), { mode: 0o700 });
  mkdirSync(join(dir, "claude-home"), { mode: 0o700 });
  mkdirSync(sockets, { mode: 0o750 });
  mkdirSync(join(dir, "anchor"));
  writeFileSync(join(dir, "anchor", "operator.pub"), TEST_ANCHOR.export({ type: "spki", format: "pem" }), { mode: 0o444 });
  chmodSync(join(dir, "anchor", "operator.pub"), 0o444);
  chmodSync(join(dir, "anchor"), 0o555);
  writeFileSync(join(dir, "state", "grant-cc.json"), JSON.stringify(grant("grant-cc")), { mode: 0o600 });
  writeFileSync(join(dir, "state", "session.json"), JSON.stringify(sessionFile()), { mode: 0o600 });
});

afterEach(() => {
  chmodSync(join(dir, "anchor"), 0o755);
  rmSync(dir, { recursive: true, force: true });
});

describe("juno hook serve and juno hook admit (plan Increment 6, D-180, D-196)", () => {
  // proves §4.3 acceptance test 1 through the commands that run it on the operator's machine: an admitted session's read
  // inside its grant gets no decision and a write outside it is denied, both journalled; a session JUNO did not admit is
  // denied every call
  it("serves the hook, admits the operator's session, allows an in-grant read and denies an out-of-grant write", async () => {
    const hookSocket = join(sockets, "hook.sock");
    let root = "";
    const code = await serving(async (layer) => {
      root = layer.root;
      // Before admission, every call is denied (§4.3).
      const early = await runHookClient(pre("Read", { file_path: join(work, "project", "notes.txt") }), hookSocket);
      expect(JSON.parse(early.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("not admitted") } });
      expect(await runHookAdmitCli(["--control", join(sockets, "admit.sock"), join(dir, "state", "session.json")], quiet)).toBe(0);
      expect(said.join("")).toContain(`claude --session-id ${SESSION}`);
      // §3.4.1 (D-198): it prints the operator's journal check for this session, with the paths the service uses.
      expect(said.join("")).toContain(`journal check --journal ${join(dir, "state", "journal")} --anchors ${join(dir, "state", "juno-anchors")} --key ${join(dir, "state", "journal-key", "journal-key.pub.pem")} session-${SESSION}`);
      const read = await runHookClient(pre("Read", { file_path: join(work, "project", "notes.txt") }), hookSocket);
      expect(read).toMatchObject({ exitCode: 0, stdout: "" });
      // Claude Code reports the read's result, as it does after every call it ran (plan item 8).
      const asked = JSON.parse(pre("Read", { file_path: join(work, "project", "notes.txt") })) as Record<string, unknown>;
      expect((await runHookClient(JSON.stringify({ ...asked, tool_use_id: `toolu_${String(toolUses - 1)}`, hook_event_name: "PostToolUse", tool_response: { content: "notes" } }), hookSocket)).exitCode).toBe(0);
      const write = await runHookClient(pre("Write", { file_path: join(dir, "outside.txt"), content: "x" }), hookSocket);
      expect(JSON.parse(write.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("scope_violation") } });
      expect(layer.sessions().map((session) => session.id)).toEqual([`session-${SESSION}`]);
    });
    expect(code).toBe(0);
    const journalled = entries(root);
    expect(journalled[0]).toMatchObject({ kind: "note", type: "admission", outcome: "admitted", mode: "hook" });
    expect(journalled.filter((entry) => entry["kind"] === "capability_result")).toEqual([expect.objectContaining({ tool: "Read", outcome: "succeeded" })]);
    expect(journalled.filter((entry) => entry["kind"] === "park")).toEqual([expect.objectContaining({ reason: "scope_violation", mode: "hook", answer: "deny" })]);
    expect(existsSync(join(dir, "outside.txt"))).toBe(false);
  }, 60_000);

  // proves D-196 (§3.2, D-148, D-191): the service refuses a session file or grant file others could change, one inside
  // the workspace, a forged grant, a file that is not a session file, and the same session twice; nothing is admitted
  it("refuses session and grant files it must not trust, and admits a session once", async () => {
    const control = join(sockets, "admit.sock");
    const admit = (file: string) => runHookAdmitCli(["--control", control, file], quiet);
    const write = (path: string, value: unknown, mode = 0o600): string => {
      writeFileSync(path, JSON.stringify(value), { mode });
      chmodSync(path, mode);
      return path;
    };
    const code = await serving(async (layer) => {
      expect(await admit(write(join(dir, "state", "open.json"), sessionFile(), 0o666))).toBe(1);
      expect(await admit(write(join(work, "project", "inside.json"), sessionFile()))).toBe(1);
      expect(await admit(write(join(dir, "state", "loose-grant.json"), sessionFile({}, [write(join(dir, "state", "g-open.json"), grant("grant-cc"), 0o666)])))).toBe(1);
      expect(await admit(write(join(dir, "state", "forged.json"), sessionFile({}, [write(join(dir, "state", "g-forged.json"), { ...grant("grant-cc"), max_invocations: 9999 })])))).toBe(1);
      expect(await admit(write(join(dir, "state", "not-a-session.json"), { session: { session_id: SESSION } }))).toBe(1);
      expect(await admit("relative.json")).toBe(2);
      expect(layer.sessions()).toEqual([]);
      expect(await admit(join(dir, "state", "session.json")), said.join("")).toBe(0);
      expect(await admit(join(dir, "state", "session.json"))).toBe(1);
      expect(layer.sessions()).toHaveLength(1);
    });
    expect(code).toBe(0);
    const out = said.join("");
    expect(out).toMatch(/session file .*open\.json is writable by group or others/);
    expect(out).toMatch(/inside\.json is JUNO's own state and overlaps the workspace/);
    expect(out).toMatch(/g-open\.json is writable by group or others/);
    expect(out).toMatch(/g-forged\.json holds grant grant-cc without a valid operator signature/);
    expect(out).toContain("already admitted");
  }, 60_000);

  // proves D-131 (plan Increment 6): a container runtime that would ignore the workloads' limits, or one that cannot be
  // checked, stops the service from starting; nothing listens
  it("refuses to start on a runtime that ignores limits or cannot be checked", async () => {
    expect(await serving(() => Promise.resolve(), { runtime: () => Promise.resolve({ cgroupDriver: "none", cgroupVersion: "2", rootless: false }) })).toBe(1);
    expect(await serving(() => Promise.resolve(), { runtime: () => Promise.reject(new Error("docker is not running")) })).toBe(1);
    expect(said.join("")).toMatch(/cgroup driver "none"/);
    expect(said.join("")).toMatch(/could not be checked/);
    expect(existsSync(join(sockets, "hook.sock"))).toBe(false);
  });

  // proves D-178 (plan Increment 6): the command refuses to start on a workspace whose file system JUNO cannot check;
  // nothing listens
  it("refuses to start on a workspace D-178 refuses", async () => {
    expect(await serving(() => Promise.resolve(), { filesystem: { ...systemFilesystemIo(), mountinfo: () => null } })).toBe(1);
    expect(said.join("")).toMatch(/juno hook serve: refused:[\s\S]*workspace/);
    expect(existsSync(join(sockets, "hook.sock"))).toBe(false);
  });

  // proves D-178 at the command: a workspace whose file system JUNO cannot check (as on a case-folding or non-Linux one) is
  // refused at admission, so the session is never admitted
  it("refuses at admission a workspace D-178 refuses", async () => {
    // A host whose mount table JUNO can read at start but not afterwards: D-178 refuses what it cannot check.
    let reads = 0;
    const real = systemFilesystemIo();
    const folding = { ...real, mountinfo: () => (reads++ === 0 ? real.mountinfo() : null) };
    const code = await serving(async (layer) => {
      expect(await runHookAdmitCli(["--control", join(sockets, "admit.sock"), join(dir, "state", "session.json")], quiet)).toBe(1);
      expect(layer.sessions()).toEqual([]);
    }, { filesystem: folding });
    expect(code).toBe(0);
    expect(said.join("")).toMatch(/workspace/);
  }, 60_000);

  // proves D-180: without every required option it is bad usage, and an unreachable service is a refusal
  it("is bad usage without its options, and refuses when the service is not running", async () => {
    expect(await runHookServeCli(["--socket", join(sockets, "hook.sock")], { ...quiet, host: ordinaryHost(), filesystem: systemFilesystemIo(), runtime: () => Promise.reject(new Error("unused")), stopped: () => Promise.resolve() })).toBe(2);
    // proves D-211 item 1 (D-213): the git program is named only in the root-owned pin; `--git` is not an option any more
    expect(await runHookServeCli([...args(), "--git", "/usr/bin/git"], { ...quiet, host: ordinaryHost(), filesystem: systemFilesystemIo(), runtime: () => Promise.reject(new Error("unused")), stopped: () => Promise.resolve() })).toBe(2);
    expect(await runHookAdmitCli(["--control", join(sockets, "missing.sock"), join(dir, "state", "session.json")], quiet)).toBe(1);
    expect(said.join("")).toMatch(/not reachable/);
  });

  // proves plan Increment 6 step 2: the example session file the operator copies is a valid hook session file
  it("ships an example session file that parses", () => {
    const example = JSON.parse(readFileSync(fileURLToPath(new URL("../../../docs/examples/session.example.json", import.meta.url)), "utf8")) as unknown;
    expect(HookSessionFile.safeParse(example).success).toBe(true);
  });

  // proves docs/operator-setup.md Parts C and G (D-199): the example grant the operator signs, with the example session
  // file, admits a Claude Code session that JUNO then governs: an in-grant read and a Bash `cat` proceed (with the
  // example's name map), and a write outside the grant is denied with scope_violation. Only the dates and the session's
  // id and grant file path are the test's; everything else is the shipped examples'.
  it("governs a session from the shipped example grant and example session file", async () => {
    const read = (name: string): Record<string, unknown> => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../docs/examples/${name}`, import.meta.url)), "utf8")) as Record<string, unknown>;
    const example = read("grant-claude-code.example.json");
    const signedExample = signed({ ...example, issued_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString() });
    writeFileSync(join(dir, "state", "grant-example.json"), JSON.stringify(signedExample), { mode: 0o600 });
    const session = read("session.example.json") as { session: Record<string, unknown>; grants: string[] };
    expect(session.session["grants"]).toEqual([example["id"]]);
    expect(session.session["principal"]).toBe(example["principal"]);
    writeFileSync(join(dir, "state", "session-example.json"), JSON.stringify({ ...session, session: { ...session.session, session_id: SESSION }, grants: [join(dir, "state", "grant-example.json")] }), { mode: 0o600 });
    const hookSocket = join(sockets, "hook.sock");
    const code = await serving(async () => {
      expect(await runHookAdmitCli(["--control", join(sockets, "admit.sock"), join(dir, "state", "session-example.json")], quiet)).toBe(0);
      expect(await runHookClient(pre("Read", { file_path: join(work, "project", "notes.txt") }), hookSocket)).toMatchObject({ exitCode: 0, stdout: "" });
      const asked = JSON.parse(pre("Read", { file_path: join(work, "project", "notes.txt") })) as Record<string, unknown>;
      await runHookClient(JSON.stringify({ ...asked, tool_use_id: `toolu_${String(toolUses - 1)}`, hook_event_name: "PostToolUse", tool_response: { content: "notes" } }), hookSocket);
      const bash = await runHookClient(pre("Bash", { command: "cat notes.txt" }), hookSocket);
      expect(JSON.parse(bash.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
      await runHookClient(JSON.stringify({ ...(JSON.parse(pre("Bash", { command: "cat notes.txt" })) as Record<string, unknown>), tool_use_id: `toolu_${String(toolUses - 1)}`, hook_event_name: "PostToolUse", tool_response: { stdout: "notes" } }), hookSocket);
      const write = await runHookClient(pre("Write", { file_path: join(work, "outside.txt"), content: "x" }), hookSocket);
      expect(JSON.parse(write.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("scope_violation") } });
    });
    expect(code).toBe(0);
  }, 60_000);
});

describe("juno checkpoint restore for a hook session's host folder (§2.2.2, D-221)", () => {
  const cliIo = (): { text: () => string; io: { readFile: () => string; out: (text: string) => void; err: (text: string) => void } } => {
    const said: string[] = [];
    return { text: () => said.join(""), io: { readFile: () => "", out: (text) => said.push(text), err: (text) => said.push(text) } };
  };
  // The user running the command owns the journal and the checkpoint store (the runner); never root (D-221).
  const runner = { uid: () => 4242, ownerOf: () => 4242, filesystem: systemFilesystemIo(), launcher: () => Promise.resolve(unsealedLauncher) };
  const journal = (): string => join(dir, "state", "journal");
  const restoreArgs = (checkpoint: string, overrides: { principal?: string; workspace?: string } = {}): string[] => ["restore", "--journal", journal(), "--checkpoints", join(dir, "state", "checkpoints"), "--workspace", overrides.workspace ?? work, "--principal", overrides.principal ?? PRINCIPAL, `session-${SESSION}`, checkpoint];

  // proves §2.2.2 "restoring that checkpoint is an operator action recorded in the journal" for hook mode, through the
  // real service and the operator's command: refused while the service runs; once it is stopped, the folder's full
  // content comes back (created files removed, changed and deleted ones put back), the restore is journalled with the
  // operator as actor, and the service starts again on that journal with the session going on
  it("restores the session's folder only once the service is stopped, journals it, and the service starts again", async () => {
    writeFileSync(join(dir, "state", "session.json"), JSON.stringify(sessionFile({ reversible_workspaces: ["/work/project"] })), { mode: 0o600 });
    const { runCheckpointCli } = await import("../../runner/src/restore.js");
    let held = "";
    const key = testJournalKey();
    const code = await serving(async () => {
      expect(await runHookAdmitCli(["--control", join(sockets, "admit.sock"), join(dir, "state", "session.json")], quiet), said.join("")).toBe(0);
      // What Claude Code did in the folder (the hook judged each call; Claude Code itself writes).
      writeFileSync(join(work, "project", "created.txt"), "made by Claude\n");
      writeFileSync(join(work, "project", "notes.txt"), "changed by Claude\n");
      // While the service runs, the restore is refused and changes nothing.
      const listed = cliIo();
      expect(await runCheckpointCli(["list", "--journal", journal(), `session-${SESSION}`], listed.io)).toBe(0);
      const checkpoint = (JSON.parse(listed.text()) as { checkpoints: { checkpoint: string; workspace: string }[] }).checkpoints[0];
      expect(checkpoint?.workspace).toBe(work);
      held = checkpoint?.checkpoint ?? "";
      const running = cliIo();
      expect(await runCheckpointCli(restoreArgs(held), running.io, undefined, undefined, runner)).toBe(1);
      expect(running.text()).toContain("its service is running");
      expect(readFileSync(join(work, "project", "notes.txt"), "utf8")).toBe("changed by Claude\n");
    }, { anchoring: testAnchoring({ sink: anchors, journalKey: key }) });
    expect(code).toBe(0);
    rmSync(join(work, "project", "notes.txt"));
    // Mismatches are refused and change nothing: another principal, another folder, root.
    const other = cliIo();
    expect(await runCheckpointCli(restoreArgs(held, { principal: "someone-else" }), other.io, undefined, undefined, runner)).toBe(1);
    mkdirSync(join(dir, "elsewhere", "project"), { recursive: true });
    const elsewhere = cliIo();
    expect(await runCheckpointCli(restoreArgs(held, { workspace: join(dir, "elsewhere") }), elsewhere.io, undefined, undefined, runner)).toBe(1);
    expect(elsewhere.text()).toContain(`was taken in ${work}`);
    // Journalled, once the checkpoint was found (D-224, F2).
    expect(entries(journal()).filter((entry) => entry["type"] === "checkpoint_restore")).toEqual([expect.objectContaining({ outcome: "refused", reason: expect.stringContaining("was taken in") })]);
    const asRoot = cliIo();
    expect(await runCheckpointCli(restoreArgs(held), asRoot.io, undefined, undefined, { ...runner, uid: () => 0, ownerOf: () => 0 })).toBe(1);
    expect(asRoot.text()).toContain("never as root");
    const notOwner = cliIo();
    expect(await runCheckpointCli(restoreArgs(held), notOwner.io, undefined, undefined, { ...runner, ownerOf: () => 1 })).toBe(1);
    expect(existsSync(join(work, "project", "created.txt"))).toBe(true);
    // Stopped: restored.
    const done = cliIo();
    expect(await runCheckpointCli(restoreArgs(held), done.io, undefined, undefined, runner), done.text()).toBe(0);
    // D-234: the folder as it stood is kept, whole, beside it; the answer and the journal name where.
    const kept = (JSON.parse(done.text()) as { kept?: string }).kept ?? "";
    expect(JSON.parse(done.text())).toEqual({ ok: true, root: "/work/project", kept: expect.stringMatching(new RegExp(`^${work.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}/project\\.juno-undone-\\d{8}T\\d{6}Z-[0-9a-f]{8}$`)) });
    expect(readFileSync(join(kept, "created.txt"), "utf8")).toBe("made by Claude\n");
    expect(existsSync(join(work, "project", "created.txt"))).toBe(false);
    expect(readFileSync(join(work, "project", "notes.txt"), "utf8")).toBe("notes\n");
    const recorded = entries(journal()).filter((entry) => entry["type"] === "checkpoint_restore");
    expect(recorded).toEqual([expect.objectContaining({ outcome: "refused" }), expect.objectContaining({ checkpoint: held, outcome: "restored", principal: PRINCIPAL, workspace: work, root: "/work/project", kept })]);
    expect(readTrajectory(journal(), `session-${SESSION}`).at(-1)?.actor).toBe(PRINCIPAL);
    // D-243: the list names who restored, for the refused and the done restore alike.
    const relisted = cliIo();
    expect(await runCheckpointCli(["list", "--journal", journal(), `session-${SESSION}`], relisted.io)).toBe(0);
    expect((JSON.parse(relisted.text()) as { restores: unknown[] }).restores).toEqual([expect.objectContaining({ outcome: "refused", by: PRINCIPAL }), expect.objectContaining({ checkpoint: held, outcome: "restored", by: PRINCIPAL, kept })]);
    // The service starts again on the journal the restore wrote to; the session goes on from it (D-201).
    // (The same journal key as the first start: the in-memory anchors were signed with it, as the real key file persists.)
    said = [];
    // The rebuilt session's checkpoint records this folder and can be restored, so its workspace stays reversible: an
    // untrusted write inside it proceeds after the restart (D-224).
    let after: { exitCode: number; stdout: string } | null = null;
    expect(await serving(async () => {
      after = await runHookClient(pre("Write", { file_path: join(work, "project", "later.txt"), content: "x" }), join(sockets, "hook.sock"));
    }, { anchoring: testAnchoring({ sink: anchors, journalKey: key }) }), said.join("")).toBe(0);
    expect(after).toMatchObject({ exitCode: 0, stdout: "" });
    expect(said.join("")).toContain("1 session(s) admitted before this start go on from the journal");
  }, 90_000);

  // proves D-223 (F1): a reversible workspace holding a set-user-ID file is refused at admission, before any effect
  it("refuses to admit a reversible workspace holding a set-user-ID file", async () => {
    writeFileSync(join(dir, "state", "session.json"), JSON.stringify(sessionFile({ reversible_workspaces: ["/work/project"] })), { mode: 0o600 });
    writeFileSync(join(work, "project", "tool"), "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(join(work, "project", "tool"), 0o4755);
    expect(await serving(async (layer) => {
      expect(await runHookAdmitCli(["--control", join(sockets, "admit.sock"), join(dir, "state", "session.json")], quiet)).toBe(1);
      expect(layer.sessions()).toEqual([]);
    })).toBe(0);
    // D-228: the sealed copy itself refuses the bit, so the checkpoint is never taken.
    expect(said.join("")).toMatch(/could not be checkpointed: "tool" has a set-user-ID/);
  });

  // proves D-237 (review round 11 on PR #62) with D-234 rulings 1 and 2, through the operator's real command: what the
  // session's folder holds cannot stop the undo, which only judges the way to it and the folder holding it. With more
  // than 50,000 folders in it, a chain 2,500 levels deep, a folder whose name holds a line break, and a folder the
  // runner cannot list, `juno checkpoint restore --workspace` restores it and keeps the old folder aside; the service's
  // own start-up check still judges the whole workspace (D-178, fail-closed) and refuses until the kept folder is gone
  it("undoes through the real command whatever the folder holds", async () => {
    writeFileSync(join(dir, "state", "session.json"), JSON.stringify(sessionFile({ reversible_workspaces: ["/work/project"] })), { mode: 0o600 });
    const { runCheckpointCli } = await import("../../runner/src/restore.js");
    const { removeEntry } = await import("../../enforcement/src/index.js");
    const key = testJournalKey();
    let held = "";
    expect(await serving(async () => {
      expect(await runHookAdmitCli(["--control", join(sockets, "admit.sock"), join(dir, "state", "session.json")], quiet), said.join("")).toBe(0);
      const listed = cliIo();
      expect(await runCheckpointCli(["list", "--journal", journal(), `session-${SESSION}`], listed.io)).toBe(0);
      held = (JSON.parse(listed.text()) as { checkpoints: { checkpoint: string }[] }).checkpoints[0]?.checkpoint ?? "";
    }, { anchoring: testAnchoring({ sink: anchors, journalKey: key }) })).toBe(0);
    writeFileSync(join(work, "project", "notes.txt"), "changed by Claude\n");
    for (let folder = 0; folder < 251; folder += 1) for (let inner = 0; inner < 200; inner += 1) mkdirSync(join(work, "project", "node_modules", `p${String(folder)}`, `d${String(inner)}`), { recursive: true });
    let fd = openSync(join(work, "project"), constants.O_RDONLY | constants.O_DIRECTORY);
    for (let level = 0; level < 2500; level += 1) {
      mkdirSync(`/proc/self/fd/${String(fd)}/d`);
      const next = openSync(`/proc/self/fd/${String(fd)}/d`, constants.O_RDONLY | constants.O_DIRECTORY);
      closeSync(fd);
      fd = next;
    }
    closeSync(fd);
    mkdirSync(join(work, "project", "a\nb"));
    mkdirSync(join(work, "project", "locked"));
    const system = systemFilesystemIo();
    // The runner's view of a folder the Claude Code user locked (chmod 700): it cannot list it. (This process is root,
    // which the kernel lets list anything, so the runner's view is given.)
    const blind = { ...runner, filesystem: { ...system, list: (folder: string) => (folder.endsWith("/locked") ? null : system.list(folder)) } };
    const before = await caseFoldingRefusals([{ what: "the workspace", path: join(work, "project") }], blind.filesystem);
    expect(before.join("; ")).toMatch(/more than 50000 folders|cannot list|line break/);
    const done = cliIo();
    expect(await runCheckpointCli(restoreArgs(held), done.io, undefined, undefined, blind), done.text()).toBe(0);
    const kept = (JSON.parse(done.text()) as { kept?: string }).kept ?? "";
    expect(readFileSync(join(work, "project", "notes.txt"), "utf8")).toBe("notes\n");
    expect(existsSync(join(work, "project", "node_modules"))).toBe(false);
    expect(existsSync(join(kept, "node_modules", "p250", "d199"))).toBe(true);
    expect(existsSync(join(kept, "a\nb"))).toBe(true);
    expect(entries(journal()).filter((entry) => entry["type"] === "checkpoint_restore")).toEqual([expect.objectContaining({ outcome: "restored", kept })]);
    // The start-up check judges the whole workspace, the kept folder included, and refuses (fail-closed, D-178) until
    // the operator removes it, as the guide's undo step 5 says; then the service starts and the session goes on.
    said = [];
    expect(await serving(() => Promise.resolve(), { anchoring: testAnchoring({ sink: anchors, journalKey: key }) })).not.toBe(0);
    expect(said.join("")).toContain("holds more than 50000 folders");
    const base = openSync(work, constants.O_RDONLY | constants.O_DIRECTORY);
    removeEntry(base, kept.slice(work.length + 1));
    closeSync(base);
    said = [];
    expect(await serving(() => Promise.resolve(), { anchoring: testAnchoring({ sink: anchors, journalKey: key }) }), said.join("")).toBe(0);
    expect(said.join("")).toContain("go on from the journal");
  }, 180_000);

  // proves D-221: a checkpoint that does not record the host folder it was taken in (one taken before 1.5-field) is
  // refused by the host form, and nothing is changed
  it("refuses a checkpoint that does not record its host folder", async () => {
    writeFileSync(join(dir, "state", "session.json"), JSON.stringify(sessionFile({ reversible_workspaces: ["/work/project"] })), { mode: 0o600 });
    const { runCheckpointCli } = await import("../../runner/src/restore.js");
    const { JournalWriter } = await import("../../journal/src/index.js");
    const { checkpointId } = await import("../../enforcement/src/index.js");
    expect(await serving(async () => {
      expect(await runHookAdmitCli(["--control", join(sockets, "admit.sock"), join(dir, "state", "session.json")], quiet)).toBe(0);
    })).toBe(0);
    const manifest = [{ path: "", type: "directory", mode: 0o755 }];
    const old = checkpointId("/work/project", manifest as never);
    JournalWriter.open(journal()).append(`session-${SESSION}`, { kind: "note", actor: "juno.hook", provider: null, data_class: { sensitivity: "internal", integrity: "derived" }, cost: { tokens_in: 0, tokens_out: 0, tokens_cached: 0, currency: 0, duration_ms: 0 } }, new TextEncoder().encode(JSON.stringify({ type: "checkpoint", root: "/work/project", checkpoint: old, manifest })));
    writeFileSync(join(work, "project", "created.txt"), "kept\n");
    const refused = cliIo();
    expect(await runCheckpointCli(restoreArgs(old), refused.io, undefined, undefined, runner)).toBe(1);
    expect(refused.text()).toContain("does not record the host folder it was taken in");
    expect(readFileSync(join(work, "project", "created.txt"), "utf8")).toBe("kept\n");
  }, 60_000);
});

describe("the hook service holds the journal's lock (D-221)", () => {
  // proves D-221: while another process holds the journal (a restore in progress, or a service already running on it),
  // the service refuses to start and listens on nothing; once it is released, it starts
  it("refuses to start on a journal another process holds", async () => {
    const { acquireRunnerLock } = await import("../../journal/src/index.js");
    const key = testJournalKey();
    expect(await serving(() => Promise.resolve(), { anchoring: testAnchoring({ sink: anchors, journalKey: key }) })).toBe(0);
    const lock = acquireRunnerLock(join(dir, "state", "journal") as never);
    said = [];
    expect(await serving(() => Promise.resolve())).toBe(1);
    expect(said.join("")).toContain("is in use by another process");
    expect(existsSync(join(sockets, "hook.sock"))).toBe(false);
    lock.release();
    said = [];
    expect(await serving(() => Promise.resolve(), { anchoring: testAnchoring({ sink: anchors, journalKey: key }) }), said.join("")).toBe(0);
  });

  // proves D-243: a lock left by a service killed without a stop (its process gone, same host, boot and PID namespace) is
  // refused by the checkpoint restore, changing nothing and saying to start the service once; the next start takes it
  // over, records that in the journal's own record after checking the journal, says so, and the start after reads it back
  it("takes over a dead service's lock at the next start and records it; the restore refuses it with a working remedy", async () => {
    const { systemProbe } = await import("../../journal/src/lock.js");
    const { listRecords } = await import("../../journal/src/index.js");
    const { runCheckpointCli } = await import("../../runner/src/restore.js");
    const journal = (): string => join(dir, "state", "journal");
    const cliIo = (): { text: () => string; io: { readFile: () => string; out: (text: string) => void; err: (text: string) => void } } => {
      const lines: string[] = [];
      return { text: () => lines.join(""), io: { readFile: () => "", out: (text) => lines.push(text), err: (text) => lines.push(text) } };
    };
    const key = testJournalKey();
    expect(await serving(() => Promise.resolve(), { anchoring: testAnchoring({ sink: anchors, journalKey: key }) })).toBe(0);
    const dead = await new Promise<number>((resolve, reject) => {
      const child = execFile(process.execPath, ["-e", "0"]);
      child.on("error", reject);
      child.on("exit", () => (child.pid === undefined ? reject(new Error("no pid")) : resolve(child.pid)));
    });
    const stale = JSON.stringify({ pid: dead, host: systemProbe.hostId(), boot: systemProbe.bootId(), pid_ns: systemProbe.pidNamespace(), pid_start: 1, started_at: "2026-11-24T09:00:00.000Z", nonce: "killed" });
    const lockFile = join(journal(), "runner.lock");
    writeFileSync(lockFile, stale, { mode: 0o600 });
    const restore = cliIo();
    const runner = { uid: () => 4242, ownerOf: () => 4242, filesystem: systemFilesystemIo(), launcher: () => Promise.resolve(unsealedLauncher) };
    expect(await runCheckpointCli(["restore", "--journal", journal(), "--checkpoints", join(dir, "state", "checkpoints"), "--workspace", work, "--principal", PRINCIPAL, `session-${SESSION}`, "0".repeat(64)], restore.io, undefined, undefined, runner)).toBe(1);
    expect(restore.text()).toContain("stopped without releasing the journal's lock");
    expect(restore.text()).toContain("systemctl --user start juno-hook.service");
    expect(restore.text()).toContain(`${journal()}/runner.lock`);
    expect(restore.text()).not.toContain("/proc/self/fd");
    expect(readFileSync(lockFile, "utf8")).toBe(stale);
    said = [];
    expect(await serving(() => Promise.resolve(), { anchoring: testAnchoring({ sink: anchors, journalKey: key }) }), said.join("")).toBe(0);
    expect(said.join("")).toContain(`the journal's lock was left by a JUNO process that is no longer running (owner_not_running, process ${String(dead)})`);
    expect(existsSync(lockFile)).toBe(false);
    const notes = listRecords(journal()).flatMap((record) => (record.taskId === null ? [] : readTrajectory(journal(), record.taskId)).map((entry) => {
      const blob = readPayload(journal(), entry.payload_ref);
      return blob.status === "present" ? (JSON.parse(new TextDecoder().decode(blob.bytes)) as Record<string, unknown>) : {};
    })).filter((payload) => payload["type"] === "stale_lock_reclaimed");
    expect(notes).toEqual([{ type: "stale_lock_reclaimed", reason: "owner_not_running", holder: expect.objectContaining({ pid: dead, nonce: "killed" }) }]);
    // The next start verifies the journal's own record with that note in it, and takes nothing over.
    said = [];
    expect(await serving(() => Promise.resolve(), { anchoring: testAnchoring({ sink: anchors, journalKey: key }) }), said.join("")).toBe(0);
    expect(said.join("")).not.toContain("no longer running");
  });
});
