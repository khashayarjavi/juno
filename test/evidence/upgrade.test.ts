import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryAnchorSink, testAnchoring, testJournalKey } from "../../packages/enforcement/test/anchoring.js";
import { ordinaryHost } from "../../packages/enforcement/test/layer.js";
import { TEST_ANCHOR, signed } from "../../packages/enforcement/test/test-keys.js";
import { readPayload, readTrajectory } from "../../packages/journal/src/index.js";
import { systemFilesystemIo } from "../../packages/mediated/src/filesystem.js";
import { runHookClient } from "../../packages/mediated/src/hook-client.js";
import { type HookServeIo, runHookAdmitCli, runHookServeCli } from "../../packages/mediated/src/hook-serve.js";
import { runCheckpointCli } from "../../packages/runner/src/restore.js";

// Operator's increment 1.5-field, item 3 (DECISIONS.md D-222): "Prove in CI that the service starts on its old journal
// after an upgrade." The commit installed on the operator's machine (6706b5a, the merge of PR #57) is taken from this
// repository's own history, built exactly as `make build` builds it, and its real `juno hook serve` writes a journal:
// a session admitted with a reversible workspace (so a checkpoint), a call judged, the service stopped. Then this
// commit's `juno hook serve` starts on that same journal, with the same grants, checkpoint store, journal key and
// anchors, as the guide's "Upgrading JUNO to a new commit" keeps them. It must start, carry the old session on, admit a
// new one, and say plainly why the old checkpoint is not restorable by the host form (it records no folder, D-221).

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** The commit on the operator's machine, from issue #59. CI fetches the whole history for it (verify.yml). */
const INSTALLED = "6706b5a30a9d6aca96d046a31de85a741a9804ef";
const PRINCIPAL = "alireza";
const OLD_SESSION = "11111111-2222-4333-8444-555555555555";
const NEW_SESSION = "66666666-7777-4888-8999-aaaaaaaaaaaa";

let dir: string;
let old: string;
let work: string;
let sockets: string;
const anchors = new MemoryAnchorSink();
const key = testJournalKey();
const said: string[] = [];
const quiet = { out: (text: string) => said.push(text), err: (text: string) => said.push(text) };

type ServeCli = (args: readonly string[], io: HookServeIo) => Promise<number>;
type AdmitCli = typeof runHookAdmitCli;

const args = (): string[] => ["--socket", join(sockets, "hook.sock"), "--control", join(sockets, "admit.sock"), "--journal", join(dir, "state", "journal"), "--anchor", join(dir, "anchor", "operator.pub"), "--workspace", work, "--checkpoints", join(dir, "state", "checkpoints"), "--journal-key", join(dir, "state", "journal-key"), "--anchors", join(dir, "state", "juno-anchors"), "--anchor-pin", join(dir, "root-owned", "anchors.json"), "--protect", join(dir, "claude-home")];

function serve(cli: ServeCli, drive: () => Promise<void>): Promise<number> {
  let driving: Promise<void> = Promise.resolve();
  return cli(args(), {
    host: ordinaryHost(),
    filesystem: systemFilesystemIo(),
    runtime: () => Promise.resolve({ cgroupDriver: "systemd", cgroupVersion: "2", rootless: true }),
    // The journal key and the anchors persist across the upgrade, as the key file and juno-anchors do.
    anchoring: testAnchoring({ sink: anchors, journalKey: key }),
    ready: () => {
      driving = drive();
    },
    stopped: () => driving,
    ...quiet,
  });
}

const sessionFile = (id: string): string => {
  const path = join(dir, "state", `session-${id}.json`);
  writeFileSync(path, JSON.stringify({
    comments: ["The operator's session file."],
    session: { session_id: id, principal: PRINCIPAL, attendance: "gated", ttl: 3_600_000, grants: ["grant-cc"], budget: { tool_calls: 20, wall_clock_ms: 3_600_000 }, unmetered_accepted: true, provider_clearance: "internal", sources: [{ id: "project", selector: { kind: "path", prefix: "/work/project" }, data_class: { sensitivity: "internal", integrity: "untrusted" } }], name_map: [], reversible_workspaces: ["/work/project"] },
    grants: [join(dir, "state", "grant-cc.json")],
  }), { mode: 0o600 });
  return path;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "juno-upgrade-"));
  // The installed commit, from history, built as `make build` builds it (its dependencies are this commit's: the
  // lockfile is unchanged since, which the first test asserts).
  old = join(dir, "installed");
  mkdirSync(old);
  execFileSync("git", ["-C", ROOT, "archive", "--format=tar", "-o", join(dir, "installed.tar"), INSTALLED]);
  execFileSync("tar", ["-xf", join(dir, "installed.tar"), "-C", old]);
  symlinkSync(join(ROOT, "node_modules"), join(old, "node_modules"));
  execFileSync(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"], { cwd: old });
  cpSync(join(old, "packages", "mediated", "definitions"), join(old, "dist", "mediated", "definitions"), { recursive: true });
  cpSync(join(old, "packages", "registry", "definitions"), join(old, "dist", "registry", "definitions"), { recursive: true });
  // The machine: workspace, runner state, the operator's public key and root's pin.
  work = join(dir, "work");
  sockets = join(dir, "sock");
  mkdirSync(join(work, "project"), { recursive: true });
  writeFileSync(join(work, "project", "notes.txt"), "notes\n");
  mkdirSync(join(dir, "state"), { mode: 0o700 });
  mkdirSync(join(dir, "claude-home"), { mode: 0o700 });
  mkdirSync(sockets, { mode: 0o750 });
  mkdirSync(join(dir, "anchor"));
  writeFileSync(join(dir, "anchor", "operator.pub"), TEST_ANCHOR.export({ type: "spki", format: "pem" }), { mode: 0o444 });
  chmodSync(join(dir, "anchor"), 0o555);
  mkdirSync(join(dir, "root-owned"), { mode: 0o755 });
  writeFileSync(join(dir, "root-owned", "anchors.json"), JSON.stringify({ url: join(dir, "pinned-juno-anchors.git"), branch: "main", host_key_fingerprint: null, known_hosts: null, push_key: null, git: "/usr/bin/git", journals: [{ path: join(dir, "state", "journal"), recovery_epoch: "2020-01-01T00:00:00Z" }] }), { mode: 0o644 });
  writeFileSync(join(dir, "state", "grant-cc.json"), JSON.stringify(signed({ id: "grant-cc", principal: PRINCIPAL, capability_selector: { capabilities: ["cc.read", "cc.write"] }, resource_scope: [{ kind: "path", prefix: "/work/project" }], data_class_bounds: { max_sensitivity: "secret", min_integrity: "untrusted" }, issuance: "preissued", issued_by: PRINCIPAL, issued_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString(), max_invocations: 100, attenuation_parent: null, revoked_at: null })), { mode: 0o600 });
}, 300_000);

afterAll(() => {
  chmodSync(join(dir, "anchor"), 0o755);
  rmSync(dir, { recursive: true, force: true });
});

describe("upgrading an installed JUNO to this commit keeps the journal, grants and checkpoints (D-222)", () => {
  // proves D-222's premise: the installed commit's dependencies are this commit's, so the guide's upgrade reinstalls
  // nothing it did not install before, and this test builds the installed commit as the machine built it
  it("has the installed commit's lockfile", () => {
    const installed = execFileSync("git", ["-C", ROOT, "show", `${INSTALLED}:package-lock.json`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    expect(installed).toBe(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  });

  // proves the operator's item 3: the service starts on its old journal after an upgrade, with the session admitted
  // before it going on (D-201), a new session admitted beside it, and the old checkpoint refused by the host restore
  // with a plain reason and nothing changed
  it("starts this commit's hook service on the journal the installed commit wrote", async () => {
    const installed = (await import(join(old, "dist", "mediated", "src", "hook-serve.js"))) as { runHookServeCli: ServeCli; runHookAdmitCli: AdmitCli };
    const hookSocket = join(sockets, "hook.sock");
    const pre = (session: string, path: string, id: string): string => JSON.stringify({ session_id: session, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path, content: "x" }, tool_use_id: id, cwd: join(work, "project") });
    const post = (session: string, path: string, id: string): string => JSON.stringify({ ...(JSON.parse(pre(session, path, id)) as Record<string, unknown>), hook_event_name: "PostToolUse", tool_response: { success: true } });
    // The installed commit: admit, judge one write inside the reversible workspace, stop.
    expect(await serve(installed.runHookServeCli, async () => {
      expect(await installed.runHookAdmitCli(["--control", join(sockets, "admit.sock"), sessionFile(OLD_SESSION)], quiet), said.join("")).toBe(0);
      expect(await runHookClient(pre(OLD_SESSION, join(work, "project", "a.txt"), "toolu_old"), hookSocket)).toMatchObject({ exitCode: 0, stdout: "" });
      // Claude Code reports the result of every call it ran.
      expect((await runHookClient(post(OLD_SESSION, join(work, "project", "a.txt"), "toolu_old"), hookSocket)).exitCode).toBe(0);
    }), said.join("")).toBe(0);
    const journal = join(dir, "state", "journal");
    const before = readTrajectory(journal, `session-${OLD_SESSION}`).length;
    expect(before).toBeGreaterThan(2);
    // The upgrade: this commit, on the same journal, grants, checkpoints, journal key and anchors.
    said.length = 0;
    expect(await serve(runHookServeCli, async () => {
      expect(await runHookAdmitCli(["--control", join(sockets, "admit.sock"), sessionFile(NEW_SESSION)], quiet), said.join("")).toBe(0);
      // The old session goes on: a call is judged for it, not refused as unknown.
      expect(await runHookClient(pre(OLD_SESSION, join(work, "project", "b.txt"), "toolu_old_2"), hookSocket)).toMatchObject({ exitCode: 0, stdout: "" });
    }), said.join("")).toBe(0);
    expect(said.join("")).toContain("1 session(s) admitted before this start go on from the journal");
    expect(readTrajectory(journal, `session-${OLD_SESSION}`).length).toBeGreaterThan(before);
    // The old checkpoint records no folder (the installed commit did not write one): refused, with the reason, changing nothing.
    const checkpoint = readTrajectory(journal, `session-${OLD_SESSION}`).map((entry) => {
      const blob = readPayload(journal, entry.payload_ref);
      return blob.status === "present" ? (JSON.parse(new TextDecoder().decode(blob.bytes)) as Record<string, unknown>) : {};
    }).find((payload) => payload["type"] === "checkpoint");
    expect(checkpoint?.["workspace"]).toBeUndefined();
    writeFileSync(join(work, "project", "after.txt"), "kept\n");
    const out: string[] = [];
    const io = { readFile: () => "", out: (text: string) => out.push(text), err: (text: string) => out.push(text) };
    expect(await runCheckpointCli(["restore", "--journal", journal, "--checkpoints", join(dir, "state", "checkpoints"), "--workspace", work, "--principal", PRINCIPAL, `session-${OLD_SESSION}`, String(checkpoint?.["checkpoint"])], io, undefined, undefined, { uid: () => 4242, ownerOf: () => 4242, filesystem: systemFilesystemIo() })).toBe(1);
    expect(out.join("")).toContain("taken by JUNO before 1.5-field");
    expect(existsSync(join(work, "project", "after.txt"))).toBe(true);
    // The new session's checkpoint records the folder, and is restorable.
    const listed: string[] = [];
    expect(await runCheckpointCli(["list", "--journal", journal, `session-${NEW_SESSION}`], { readFile: () => "", out: (text) => listed.push(text), err: (text) => listed.push(text) })).toBe(0);
    expect(JSON.parse(listed.join(""))).toMatchObject({ checkpoints: [{ root: "/work/project", workspace: work }] });
  }, 120_000);
});
