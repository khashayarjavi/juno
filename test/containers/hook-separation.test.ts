import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

// D-173 (operator ruling 1 of 2026-11-08, second set, on D-172 option (b)): Claude Code is governed only inside WSL2, as
// a Linux user other than the runner's, that is not root and cannot write JUNO's journal, grants, socket permissions or
// hook configuration (the hooks live in root-owned managed settings). In one sealed container from the runner image
// (no network; root holds only CHOWN, SETUID, SETGID, FSETID and DAC_READ_SEARCH, for setup and the check), the driver
// (hook-separation/driver.mjs) builds STATE.md Part E's layout, installs the hook with the real `juno hook install`,
// starts JUNO's real hook service as the runner (uid 1000, no supplementary group), runs the real `juno hook check`,
// and runs every attempt of the Claude Code user (uid 1001, group juno-hook only for the socket) against the kernel.
// Every Docker call goes through execFile with an argv array; there is no shell.

const run = promisify(execFile);
const fixtures = fileURLToPath(new URL("./hook-separation", import.meta.url));

type Exit = { code: number; stdout: string; stderr: string };
type Attempt = { done: boolean; code?: string };
type Results = {
  install: Exit;
  settings: Record<string, unknown>;
  modes: Record<string, { uid: number; gid: number; mode: string }>;
  check: Exit;
  checkBeforeService: Exit;
  recheck: Exit;
  agent: Record<string, Attempt> & { identity: { uid: number; gid: number; groups: number[]; capEff: string | null }; hook: Exit };
  negative: Record<string, Exit>;
  serve: {
    overlay: Exit;
    overlayJournalCreated: boolean;
    started: { ok: boolean; text: string };
    beforeAdmission?: Exit;
    agentAdmit?: Exit;
    admit?: Exit;
    read?: Exit;
    readResult?: Exit;
    write?: Exit;
    journal?: { kind: string; type: string | null; outcome: string | null; reason: string | null; tool: string | null }[];
    socketMode?: string;
    controlMode?: string;
    stopped?: Exit;
    stoppedText?: string;
    journalCheck?: Exit;
    anchoringNote?: boolean;
  };
};

let results: Results;

beforeAll(async () => {
  const { stdout } = await run(
    "docker",
    [
      "run", "--rm", "--user", "0", "--network", "none",
      "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "FSETID", "--cap-add", "DAC_READ_SEARCH",
      "--security-opt", "no-new-privileges:true",
      "--mount", ["type=bind", ["source", fixtures].join("="), "target=/t", "readonly"].join(","),
      // The workspace: a tmpfs, a case-sensitive Linux file system (D-178).
      "--tmpfs", "/srv/work:mode=0755",
      "--entrypoint", "/usr/local/bin/node", "juno-runner:local", "/t/driver.mjs",
    ],
    { maxBuffer: 16 * 1024 * 1024, timeout: 240_000 },
  );
  results = JSON.parse(stdout) as Results;
}, 300_000);

const REFUSED = [
  // The hook configuration.
  "write managed settings", "append to managed settings", "chmod managed settings", "remove managed settings", "rename managed settings",
  "create a managed drop-in", "create beside managed settings", "replace the managed folder",
  // What the hook runs.
  "replace the hook client", "replace the hook client's import", "remove the hook client", "change the client's module type", "add a file beside the hook client", "replace node",
  // JUNO's state.
  "list the runner's state", "list the journal", "write the journal", "list the grants", "read a grant", "write a grant", "write a checkpoint",
  "remove the runner's state", "write the trust anchor", "replace the trust anchor",
  // The socket's permissions and folder.
  "chmod the socket", "remove the socket", "create in the socket folder", "chmod the socket folder", "replace the socket folder",
  // The runner's process.
  "signal the runner", "read the runner's environment", "read the runner's memory map",
] as const;

describe("D-173: the Claude Code user cannot modify the hook settings or reach the runner's state (container, kernel-checked)", () => {
  // proves D-173: `juno hook install` writes JUNO's fail-closed hook into root-owned managed settings, with no bridge
  it("installs the hook into root-owned managed settings, readable and not writable by others", () => {
    expect(results.install.code).toBe(0);
    expect(results.modes["/etc/claude-code/managed-settings.json"]).toEqual({ uid: 0, gid: 0, mode: "644" });
    expect(results.modes["/etc/claude-code"]).toEqual({ uid: 0, gid: 0, mode: "755" });
    expect(results.settings).toMatchObject({ allowManagedHooksOnly: true, env: { CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1" } });
    expect(JSON.stringify(results.settings)).not.toMatch(/wsl/i);
  });

  // proves D-173: the Claude Code user is an ordinary user, not root and not the runner, with no capability
  it("runs the Claude Code user as an ordinary user other than the runner, holding no capability", () => {
    expect(results.agent.identity).toEqual({ uid: 1001, gid: 1001, groups: expect.arrayContaining([1001, 1500]) as unknown as number[], capEff: "0000000000000000" });
    expect(results.agent.identity.groups).not.toContain(1000);
  });

  // proves D-173: the kernel refuses every attempt to change the hook's configuration or what it runs, or to reach JUNO's state, the socket's permissions or the runner
  it.each(REFUSED)("refuses: %s", (name) => {
    const attempt = results.agent[name];
    expect(attempt, name).toBeDefined();
    expect(attempt?.done, name).toBe(false);
    expect(["EACCES", "EPERM"], name).toContain(attempt?.code);
  });

  // proves D-173 (positive controls): Claude Code can read its managed settings and the public anchor, and the real hook client reaches JUNO and gets JUNO's answer
  it("still lets the Claude Code user read its settings and reach JUNO through the hook", () => {
    expect(results.agent["read managed settings"]).toEqual({ done: true });
    expect(results.agent["read the trust anchor"]).toEqual({ done: true });
    expect(results.agent.hook.code).toBe(0);
    expect(JSON.parse(results.agent.hook.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("not admitted") } });
  });

  // proves D-173: `juno hook check` passes this layout, and refuses each broken one
  it("passes juno hook check on this layout and refuses an agent that is root, is the runner, holds its group, or can write the settings", () => {
    expect(results.check).toMatchObject({ code: 0, stdout: expect.stringContaining("separated from the runner") });
    // STATE.md Part E step 14, as it stands before the service exists: one refusal, the missing socket, and nothing else.
    expect(results.checkBeforeService.code).toBe(1);
    expect(results.checkBeforeService.stderr.split("\n").filter((line) => line.startsWith("  - "))).toEqual([expect.stringContaining("is not a listening socket")]);
    expect(results.recheck.code).toBe(0);
    expect(results.negative["agentIsRoot"]).toMatchObject({ code: 1, stderr: expect.stringContaining("is root") });
    expect(results.negative["agentIsRunner"]).toMatchObject({ code: 1, stderr: expect.stringContaining("same user") });
    expect(results.negative["agentInRunnersGroup"]).toMatchObject({ code: 1, stderr: expect.stringContaining("runner's group") });
    expect(results.negative["settingsWritable"]).toMatchObject({ code: 1, stderr: expect.stringContaining("managed settings") });
  });

  // proves D-178 against the kernel's own mount table: the check passes the workspace on a tmpfs, and refuses one on a
  // file system that is not a native case-sensitive Linux one, with a plain reason
  it("refuses a workspace that is not on a case-sensitive Linux file system (D-178)", () => {
    expect(results.check.stdout).toContain("case-sensitive Linux file system");
    // proves D-206 item 2 (D-208), on the real kernel's ownership: the check refuses a pin that names no SSH address,
    // and a pin that is the runner's own file instead of root's
    expect(results.negative["pinIsLocal"]).toMatchObject({ code: 1, stderr: expect.stringContaining("names a local path") });
    expect(results.negative["pinIsRunners"]).toMatchObject({ code: 1, stderr: expect.stringContaining("the anchor pin: /var/lib/juno-runner-pin/anchors.json must be owned by root") });
    expect(results.negative["workspaceOnOverlay"]?.code).toBe(1);
    const lines = (results.negative["workspaceOnOverlay"]?.stderr ?? "").split("\n").filter((line) => line.startsWith("  - "));
    expect(lines).toEqual([expect.stringContaining("/srv/overlay-work is on a file system of type overlay")]);
    expect(lines[0]).toContain("D-178");
  });
});

describe("plan Increment 6 (D-180, D-196): the real juno hook serve and juno hook admit on Part E's layout (container)", () => {
  // proves D-178 at start (plan Increment 6): on a workspace that is not a native case-sensitive Linux file system the
  // command refuses to start, and creates nothing
  it("refuses to start on a workspace D-178 refuses", () => {
    expect(results.serve.overlay.code).toBe(1);
    expect(results.serve.overlay.stderr).toMatch(/juno hook serve: refused:[\s\S]*workspace/);
    expect(results.serve.overlayJournalCreated).toBe(false);
  });

  // proves §4.3 acceptance test 1 through the commands that run it on the operator's machine: as the runner the service
  // starts, the runner admits the operator's session, and the real hook client as the Claude Code user gets an allowed
  // read and a denied out-of-grant write, both journalled; before admission every call is denied
  it("serves as the runner, admits the session, allows an in-grant read and denies an out-of-grant write, journalled", () => {
    expect(results.serve.started, results.serve.started.text).toMatchObject({ ok: true });
    expect(results.serve.socketMode).toBe("660");
    expect(results.serve.controlMode).toBe("600");
    expect(JSON.parse(results.serve.beforeAdmission?.stdout ?? "{}")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("not admitted") } });
    expect(results.serve.admit).toMatchObject({ code: 0, stdout: expect.stringContaining("admitted session-7d2c4b1a-0e3f-4a5b-9c6d-112233445566") });
    expect(results.serve.read).toMatchObject({ code: 0, stdout: "" });
    expect(results.serve.readResult).toMatchObject({ code: 0 });
    expect(JSON.parse(results.serve.write?.stdout ?? "{}")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("scope_violation") } });
    const journal = results.serve.journal ?? [];
    expect(journal[0]).toMatchObject({ kind: "note", type: "admission", outcome: "admitted" });
    expect(journal.filter((entry) => entry.kind === "capability_result")).toEqual([expect.objectContaining({ tool: "Read", outcome: "succeeded" })]);
    expect(journal.filter((entry) => entry.kind === "park")).toEqual([expect.objectContaining({ reason: "scope_violation" })]);
  });

  // proves D-196: the Claude Code user cannot reach the admission socket, so it cannot admit a session for itself
  it("keeps the admission socket out of the Claude Code user's reach", () => {
    expect(results.serve.agentAdmit?.code).toBe(1);
    expect(results.serve.agentAdmit?.stderr).toMatch(/not reachable/);
  });

  // proves §3.4.1 (D-198) through the commands: the session's journal records the anchoring interval and key; when the
  // runner stops the service it anchors what is pending; and the operator's `juno journal check` finds the chain agrees
  // with the anchors at the destination, with nothing left unanchored
  it("anchors the session's journal off the host, and the operator's journal check passes", () => {
    expect(results.serve.anchoringNote).toBe(true);
    expect(results.serve.stopped, results.serve.stopped?.stderr).toMatchObject({ code: 0 });
    expect(results.serve.stoppedText).toContain("juno hook: stopped.");
    expect(results.serve.journalCheck, results.serve.journalCheck?.stderr).toMatchObject({ code: 0 });
    expect(JSON.parse(results.serve.journalCheck?.stdout ?? "{}")).toMatchObject({ ok: true, unanchored: 0 });
  });
});
