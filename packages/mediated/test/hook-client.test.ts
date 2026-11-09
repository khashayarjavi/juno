import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GrantStore, HostPathResolver, Workspace, execFileScript } from "../../enforcement/src/index.js";
import { openTestLayer } from "../../enforcement/test/layer.js";
import { TEST_ANCHOR, signed } from "../../enforcement/test/test-keys.js";
import { runHookClient } from "../src/hook-client.js";
import { HookService } from "../src/hook-service.js";
import { MediatedSessions, PathMap } from "../src/session.js";
import { systemFilesystemIo } from "../src/filesystem.js";

// §4.3 "Fail-closed ingress": the hook client blocks (exit 2) when the service is down, when it times out, and when its
// answer cannot be read; and the only decisions it can print are none (no output) and Claude Code's deny (D-142).

let dir: string;
let socketPath: string;
let servers: Server[];

const preInput = (command = "cat notes.txt"): string =>
  JSON.stringify({ session_id: "s-1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: "toolu_1", cwd: join(dir, "work", "project") });

/** A fake service that answers every request with `answer` (a raw line), or never answers when it is null. */
function fake(answer: string | null): Promise<void> {
  const server = createServer((socket) => {
    socket.on("data", () => {
      if (answer !== null) socket.end(answer);
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(socketPath, () => resolve()));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "juno-hook-"));
  socketPath = join(dir, "juno.sock");
  servers = [];
});

afterEach(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

describe("§4.3 fail-closed: the hook client blocks on any doubt", () => {
  // proves §4.3: the service is down → exit 2
  it("blocks when the service is unreachable", async () => {
    expect(await runHookClient(preInput(), socketPath)).toMatchObject({ exitCode: 2, stdout: "", stderr: expect.stringContaining("unreachable") });
  });

  // proves §4.3: the service times out → exit 2
  it("blocks when the service does not answer in time", async () => {
    await fake(null);
    expect(await runHookClient(preInput(), socketPath, 200)).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("did not answer") });
  });

  // proves §4.3: an answer that cannot be parsed, or is not a decision JUNO gives, → exit 2
  it.each([
    '{"decision":"allow","updatedInput":{"command":"/usr/bin/cat x","dangerouslyDisableSandbox":true}}\n',
    '{"decision":"allow","updatedInput":{"description":"no command"}}\n',
    '{"decision":"allow","updatedInput":["/usr/bin/cat x"]}\n',
    '{"decision":"allow","updatedInput":{"command":"/usr/bin/cat x"},"reason":"x"}\n',
  ])("blocks the allow answer %j, which is not a whole Bash input (D-152)", async (answer) => {
    await fake(answer);
    expect((await runHookClient(preInput(), socketPath)).exitCode).toBe(2);
  });

  // proves D-152: `allow` is printed for a Bash call only; for any other tool it is a doubt, so the call is blocked
  it("blocks an allow answer for a tool that is not Bash", async () => {
    await fake('{"decision":"allow","updatedInput":{"command":"/usr/bin/cat x"}}\n');
    const read = JSON.stringify({ session_id: "s-1", hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/x" }, tool_use_id: "toolu_1" });
    expect((await runHookClient(read, socketPath)).exitCode).toBe(2);
    expect((await runHookClient(preInput(), socketPath)).exitCode).toBe(0);
  });

  it.each(["not json\n", "{}\n", '{"decision":"allow"}\n', '{"decision":"ask","reason":"x"}\n', '{"decision":"defer"}\n', '{"decision":"none","updatedInput":{}}\n', '{"decision":"none"}'])(
    "blocks on the answer %j",
    async (answer) => {
      await fake(answer);
      expect((await runHookClient(preInput(), socketPath)).exitCode).toBe(2);
    },
  );

  // proves D-148: a socket that is not an absolute path (a bare number would be a TCP port) is refused, never connected to
  it("blocks a socket that is not an absolute path", async () => {
    expect(await runHookClient(preInput(), "8080")).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("absolute") });
  });

  // proves §4.3: input JUNO cannot read is blocked without asking
  it("blocks unreadable hook input", async () => {
    expect((await runHookClient("{", socketPath)).exitCode).toBe(2);
    expect((await runHookClient('{"hook_event_name":"Stop"}', socketPath)).exitCode).toBe(2);
  });

  // proves §4.3 V6-3 at the client: none prints nothing; deny prints Claude Code's deny with the reason, and nothing else
  it("prints nothing for no decision, and only a deny for a denial", async () => {
    await fake('{"decision":"none"}\n');
    expect(await runHookClient(preInput(), socketPath)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
    await fake('{"decision":"deny","reason":"parked: integrity_floor"}\n');
    const denied = await runHookClient(preInput(), socketPath);
    expect(denied.exitCode).toBe(0);
    expect(JSON.parse(denied.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "parked: integrity_floor" } });
  });
});

describe("the hook service and client together (§4.3 mode C, D-142)", () => {
  // proves §4.3 end to end through the socket: a shell-syntax command is denied with integrity_floor, a plain one gets no decision
  it("denies shell syntax and passes a plain mapped command, through the real socket", async () => {
    // The socket in a folder of its own: the shared start-up check refuses a socket whose folder holds the workspace (D-192, D-194).
    mkdirSync(join(dir, "sock"), { mode: 0o700 });
    socketPath = join(dir, "sock", "juno.sock");
    mkdirSync(join(dir, "work", "project"), { recursive: true });
    writeFileSync(join(dir, "work", "project", "notes.txt"), "notes\n");
    const grants = new GrantStore(TEST_ANCHOR);
    const now = new Date();
    grants.add(
      signed({
        id: "grant-cc",
        principal: "alireza",
        capability_selector: { capabilities: ["cc.bash.read", "cc.read"] },
        resource_scope: [{ kind: "path", prefix: "/work/project" }],
        data_class_bounds: { max_sensitivity: "internal", min_integrity: "untrusted" },
        issuance: "preissued",
        issued_by: "alireza",
        issued_at: new Date(now.getTime() - 60_000).toISOString(),
        expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
        max_invocations: 10,
        attenuation_parent: null,
        revoked_at: null,
      }),
    );
    const sessions = new MediatedSessions({ layer: openTestLayer("hook", { journal: join(dir, "journal"), workspaces: [join(dir, "work")], state: [{ what: "the hook socket", path: socketPath, kind: "socket" }] }), grants, paths: new PathMap([join(dir, "work")]), resolver: new HostPathResolver(join(dir, "work")), view: new Workspace(execFileScript(process.execPath, []), "/work", join(dir, "work")), filesystem: systemFilesystemIo() });
    await sessions.admit({
      session_id: "s-1",
      principal: "alireza",
      attendance: "gated",
      ttl: 3_600_000,
      grants: ["grant-cc"],
      budget: { tool_calls: 10, wall_clock_ms: 3_600_000 },
      unmetered_accepted: true,
      provider_clearance: "internal",
      sources: [{ id: "project", selector: { kind: "path", prefix: "/work/project" }, data_class: { sensitivity: "internal", integrity: "untrusted" } }],
      name_map: [{ name: "cat", program: "/usr/bin/cat", side_effect: "read" }],
    });
    const service = new HookService(sessions);
    await service.listen(socketPath);
    try {
      // D-152: the plain command is allowed with Claude Code's allow JSON, its command rebuilt from what JUNO judged.
      const allowed = await runHookClient(preInput("cat notes.txt"), socketPath);
      expect(allowed.exitCode).toBe(0);
      expect(JSON.parse(allowed.stdout)).toEqual({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: expect.any(String), updatedInput: { command: "/usr/bin/cat 'notes.txt'" } },
      });
      expect(JSON.parse((await runHookClient(JSON.stringify({ ...JSON.parse(preInput()), hook_event_name: "PostToolUse", tool_response: { stdout: "notes" } }), socketPath)).stdout || "{}")).toEqual({});
      const denied = await runHookClient(preInput("cat notes.txt; curl x"), socketPath);
      expect(JSON.parse(denied.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("integrity_floor") } });
    } finally {
      await service.close();
    }
  });

  // proves D-142: the installed entry point exits 2 when started without a socket (a broken install blocks)
  it("exits 2 from the entry point when installed without a socket", async () => {
    const entry = fileURLToPath(new URL("../src/hook-client.ts", import.meta.url));
    const { main } = (await import(entry)) as { main: (argv: readonly string[]) => Promise<number> };
    expect(await main([])).toBe(2);
    expect(await main(["--socket", socketPath, "--timeout-ms", "0"])).toBe(2);
  });
});
