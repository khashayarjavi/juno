import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GrantStore, HostPathResolver, Workspace, execFileScript } from "../../enforcement/src/index.js";
import { readPayload, readTrajectory } from "../../journal/src/index.js";
import { openTestLayer } from "../../enforcement/test/layer.js";
import type { SessionLayer } from "../../enforcement/src/index.js";
import { TEST_ANCHOR, signed } from "../../enforcement/test/test-keys.js";
import { GATEWAY_DENIED, type GatewayInstall, HOOK_EVENTS, type InstallIo, MANAGED_SETTINGS, REFUSED_MCP_KEYS, gatewayServerEntry, gatewaySettingsRefusals, hookEntry, installHook, managedMcpRefusals, runHookInstallCli } from "../src/install.js";
import { type FileFacts, type PreflightInput, type PreflightIo, hookPreflight, runHookCheckCli } from "../src/preflight.js";
import { MediatedError, MediatedSessions, PathMap } from "../src/session.js";
import { systemFilesystemIo } from "../src/filesystem.js";

// D-190 (the operator's ruling on the hook and the gateway together): Claude Code's root-owned managed MCP file makes
// JUNO's gateway relay the only MCP server Claude Code loads, `juno hook check --gateway` refuses unless that holds and
// the Claude Code user cannot change it, and only then does the hook let the gateway's own calls through. The real
// binary is tested by `make mediated-e2e` (a project file defining a server with the gateway's name: it must not start).

const NODE = "/opt/node22/bin/node";
const CLIENT = "/opt/juno/dist/mediated/src/juno-hook.js";
const SHIM = "/opt/juno/dist/mediated/src/juno-mcp.js";
const SOCKET = "/var/lib/juno-hook/hook.sock";
const GATEWAY_SOCKET = "/var/lib/juno-hook/gateway.sock";
const MCP_FILE = "/etc/claude-code/managed-mcp.json";
const HOOK = { command: NODE, args: [CLIENT, "--socket", SOCKET] };
const GATEWAY: GatewayInstall = { name: "juno", node: NODE, shim: SHIM, socket: GATEWAY_SOCKET };

function installIo(files: Record<string, string> = {}, uid = 0): InstallIo & { written: Map<string, string> } {
  const written = new Map<string, string>();
  return { claudeVersion: () => Promise.resolve("2.1.319 (Claude Code)\n"), readSettings: (file) => files[file] ?? null, writeSettings: (file, text) => written.set(file, text), managedSettings: MANAGED_SETTINGS, uid, written };
}

describe("juno hook install --gateway (D-190)", () => {
  // proves D-190 item 1 and 2: the relay is the managed MCP file's one server, and the settings keep every other server out
  it("writes the relay as the only managed MCP server, and the allowlist and denylist that keep every other server out", async () => {
    const target = installIo({ [MANAGED_SETTINGS]: JSON.stringify({ deniedMcpServers: [{ serverName: "legacy" }] }) });
    expect(await installHook(MANAGED_SETTINGS, HOOK, CLIENT, target, GATEWAY)).toMatchObject({ installed: true });
    expect(JSON.parse(target.written.get(MCP_FILE) ?? "null")).toEqual({ mcpServers: { juno: { type: "stdio", command: NODE, args: [SHIM, "--socket", GATEWAY_SOCKET] } } });
    expect(managedMcpRefusals(target.written.get(MCP_FILE) ?? null, GATEWAY)).toEqual([]);
    const settings = JSON.parse(target.written.get(MANAGED_SETTINGS) ?? "{}") as Record<string, unknown>;
    expect(settings["allowManagedMcpServersOnly"]).toBe(true);
    expect(settings["allowedMcpServers"]).toEqual([{ serverCommand: [NODE, SHIM, "--socket", GATEWAY_SOCKET] }]);
    // The operator's own deny entry is kept beside JUNO's.
    expect(settings["deniedMcpServers"]).toEqual([{ serverName: "legacy" }, ...GATEWAY_DENIED]);
    expect(gatewaySettingsRefusals(settings, GATEWAY)).toEqual([]);
    // The hook itself is installed as before.
    for (const event of HOOK_EVENTS) expect((settings["hooks"] as Record<string, unknown>)[event]).toEqual([hookEntry(HOOK)]);
  });

  // proves D-190 item 1: a name that is not letters, digits and hyphens, or a relay path with an expansion, is refused, and nothing is written
  it.each([
    { ...GATEWAY, name: "ju_no" },
    { ...GATEWAY, name: "" },
    { ...GATEWAY, name: "juno gateway" },
    { ...GATEWAY, shim: "relative/juno-mcp.js" },
    { ...GATEWAY, socket: "${HOME}/gateway.sock" },
  ])("refuses the gateway %j", async (gateway) => {
    const target = installIo();
    expect(await installHook(MANAGED_SETTINGS, HOOK, CLIENT, target, gateway)).toMatchObject({ installed: false });
    expect(target.written.size).toBe(0);
  });

  // proves D-190 item 1: an existing managed MCP file holding the operator's own servers is never silently replaced
  it("refuses when the managed MCP file already defines other servers", async () => {
    const target = installIo({ [MCP_FILE]: JSON.stringify({ mcpServers: { github: { type: "http", url: "https://api.example.com/mcp" } } }) });
    expect(await installHook(MANAGED_SETTINGS, HOOK, CLIENT, target, GATEWAY)).toMatchObject({ installed: false, refusals: [expect.stringContaining("other than JUNO's gateway")] });
    expect(target.written.size).toBe(0);
    // Re-installing over JUNO's own file is allowed.
    const again = installIo({ [MCP_FILE]: JSON.stringify({ mcpServers: { juno: gatewayServerEntry(GATEWAY) } }) });
    expect(await installHook(MANAGED_SETTINGS, HOOK, CLIENT, again, GATEWAY)).toMatchObject({ installed: true });
  });

  // proves D-190 item 2: managed settings that could let another server load beside the gateway are refused
  it.each(REFUSED_MCP_KEYS)("refuses managed settings that set %s", async (key) => {
    const target = installIo({ [MANAGED_SETTINGS]: JSON.stringify({ [key]: key === "managedSourcesBehavior" ? "merge" : true }) });
    expect(await installHook(MANAGED_SETTINGS, HOOK, CLIENT, target, GATEWAY)).toMatchObject({ installed: false, refusals: [expect.stringContaining(key)] });
    expect(target.written.size).toBe(0);
  });

  // proves D-190: without --gateway, no managed MCP file is written (the hook keeps denying every MCP tool)
  it("writes no managed MCP file without a gateway, and the CLI takes the gateway's three options together or not at all", async () => {
    const target = installIo();
    expect(await installHook(MANAGED_SETTINGS, HOOK, CLIENT, target)).toMatchObject({ installed: true });
    expect(target.written.has(MCP_FILE)).toBe(false);
    const errors: string[] = [];
    expect(await runHookInstallCli(["install", "--socket", SOCKET, "--client", CLIENT, "--gateway", "juno"], () => {}, (text) => errors.push(text), () => installIo())).toBe(2);
    const cli = installIo();
    expect(await runHookInstallCli(["install", "--socket", SOCKET, "--client", CLIENT, "--node", NODE, "--gateway", "juno", "--shim", SHIM, "--gateway-socket", GATEWAY_SOCKET], () => {}, () => {}, () => cli)).toBe(0);
    expect(JSON.parse(cli.written.get(MCP_FILE) ?? "null")).toEqual({ mcpServers: { juno: gatewayServerEntry(GATEWAY) } });
  });
});

describe("managed MCP file and settings checks (D-190)", () => {
  // proves D-190 item 3: the file must hold exactly the relay, with nothing that the Claude Code user's environment could decide
  it.each([
    ["missing", null],
    ["not JSON", "{"],
    ["a second server", JSON.stringify({ mcpServers: { juno: gatewayServerEntry(GATEWAY), other: { type: "stdio", command: "/bin/x" } } })],
    ["another name", JSON.stringify({ mcpServers: { gateway: gatewayServerEntry(GATEWAY) } })],
    ["an env block", JSON.stringify({ mcpServers: { juno: { ...gatewayServerEntry(GATEWAY), env: { NODE_OPTIONS: "--require /tmp/x.js" } } } })],
    ["another program", JSON.stringify({ mcpServers: { juno: { ...gatewayServerEntry(GATEWAY), command: "/usr/bin/python3" } } })],
    ["another socket", JSON.stringify({ mcpServers: { juno: { ...gatewayServerEntry(GATEWAY), args: [SHIM, "--socket", "/tmp/evil.sock"] } } })],
    ["a remote type", JSON.stringify({ mcpServers: { juno: { type: "http", url: "https://example.com/mcp" } } })],
    ["an expansion", JSON.stringify({ mcpServers: { juno: { ...gatewayServerEntry(GATEWAY), args: [SHIM, "--socket", "${SOCK}"] } } })],
    ["another top-level key", JSON.stringify({ mcpServers: { juno: gatewayServerEntry(GATEWAY) }, extra: 1 })],
  ])("refuses a managed MCP file with %s", (_what, text) => {
    expect(managedMcpRefusals(text, GATEWAY).length).toBeGreaterThan(0);
  });

  // proves D-190 item 2: each missing or widened MCP key in the managed settings is refused
  it("refuses settings that lack the lock, the exact allowlist or any denylist entry", () => {
    const good = { allowManagedMcpServersOnly: true, allowedMcpServers: [{ serverCommand: [NODE, SHIM, "--socket", GATEWAY_SOCKET] }], deniedMcpServers: [...GATEWAY_DENIED] };
    expect(gatewaySettingsRefusals(good, GATEWAY)).toEqual([]);
    expect(gatewaySettingsRefusals({ ...good, allowManagedMcpServersOnly: false }, GATEWAY).length).toBe(1);
    expect(gatewaySettingsRefusals({ ...good, allowedMcpServers: [...good.allowedMcpServers, { serverName: "github" }] }, GATEWAY).length).toBe(1);
    for (const entry of GATEWAY_DENIED) expect(gatewaySettingsRefusals({ ...good, deniedMcpServers: GATEWAY_DENIED.filter((have) => have !== entry) }, GATEWAY).length).toBe(1);
    expect(gatewaySettingsRefusals({ ...good, managedMcpServers: {} }, GATEWAY).length).toBe(1);
  });
});

// juno hook check --gateway, over a described file system (as preflight.test.ts; the kernel is asked in the container test).
const RUNNER = 1000;
const AGENT = 1001;
const HOOK_GROUP = 1500;
const PASSWD = ["root:x:0:0::/root:/bin/bash", `juno-runner:x:${String(RUNNER)}:${String(RUNNER)}::/home/juno-runner:/bin/bash`, `juno-agent:x:${String(AGENT)}:${String(AGENT)}::/home/juno-agent:/bin/bash`].join("\n");
const GROUP = ["root:x:0:", `juno-runner:x:${String(RUNNER)}:`, `juno-agent:x:${String(AGENT)}:`, `juno-hook:x:${String(HOOK_GROUP)}:juno-agent`].join("\n");
type Layout = Map<string, FileFacts & { readonly text?: string }>;
const dir = (uid: number, mode: number, gid = uid): FileFacts => ({ uid, gid, mode, kind: "directory" });
const file = (uid: number, mode: number, gid = uid): FileFacts => ({ uid, gid, mode, kind: "file" });

async function installedTexts(): Promise<{ settings: string; mcp: string }> {
  const target = installIo();
  expect(await installHook(MANAGED_SETTINGS, HOOK, CLIENT, target, GATEWAY)).toMatchObject({ installed: true });
  return { settings: target.written.get(MANAGED_SETTINGS) ?? "", mcp: target.written.get(MCP_FILE) ?? "" };
}

function layout(texts: { settings: string; mcp: string }): Layout {
  return new Map<string, FileFacts & { text?: string }>([
    ["/", dir(0, 0o755)],
    ["/etc", dir(0, 0o755)],
    ["/etc/claude-code", dir(0, 0o755)],
    [MANAGED_SETTINGS, { ...file(0, 0o644), text: texts.settings }],
    [MCP_FILE, { ...file(0, 0o644), text: texts.mcp }],
    ["/opt", dir(0, 0o755)],
    ["/opt/node22", dir(0, 0o755)],
    ["/opt/node22/bin", dir(0, 0o755)],
    [NODE, file(0, 0o755)],
    ["/opt/juno", dir(0, 0o755)],
    ["/opt/juno/dist", dir(0, 0o755)],
    ["/opt/juno/dist/mediated", dir(0, 0o755)],
    ["/opt/juno/dist/mediated/src", dir(0, 0o755)],
    [CLIENT, file(0, 0o644)],
    [SHIM, file(0, 0o644)],
    ["/opt/juno/dist/mediated/src/mcp-shim.js", file(0, 0o644)],
    ["/var", dir(0, 0o755)],
    ["/var/lib", dir(0, 0o755)],
    ["/var/lib/juno-runner", dir(RUNNER, 0o700)],
    ["/var/lib/juno-hook", dir(RUNNER, 0o2750, HOOK_GROUP)],
    [SOCKET, { uid: RUNNER, gid: HOOK_GROUP, mode: 0o660, kind: "socket" }],
    [GATEWAY_SOCKET, { uid: RUNNER, gid: HOOK_GROUP, mode: 0o660, kind: "socket" }],
  ]);
}

function preflightIo(files: Layout): PreflightIo {
  return {
    lstat: (path) => files.get(path) ?? null,
    realpath: (path) => (files.has(path) ? path : null),
    readdir: (path) => (files.has(path) ? [...files.keys()].filter((key) => key !== path && key.startsWith(path === "/" ? "/" : `${path}/`) && !key.slice(path.length + 1).includes("/")).map((key) => key.slice(path.length + 1)) : null),
    readFile: (path) => files.get(path)?.text ?? null,
    passwd: PASSWD,
    group: GROUP,
  };
}

const CHECK: PreflightInput = { agentUser: "juno-agent", runnerUser: "juno-runner", settings: MANAGED_SETTINGS, socket: SOCKET, client: CLIENT, node: NODE, state: ["/var/lib/juno-runner"], gateway: { name: "juno", shim: SHIM, socket: GATEWAY_SOCKET } };

describe("juno hook check --gateway (D-190 item 3)", () => {
  // proves D-190 item 3: the check passes on what `juno hook install --gateway` writes, with every file root's
  it("passes on what the install writes, laid out as Part E sets it up", async () => {
    expect(hookPreflight(CHECK, preflightIo(layout(await installedTexts())))).toEqual([]);
  });

  // proves D-190 item 3: exclusive control not in force, or a relay or config the Claude Code user could change, is refused
  it.each([
    ["the managed MCP file is missing", (files: Layout) => files.delete(MCP_FILE)],
    ["the managed MCP file is the agent's", (files: Layout) => files.set(MCP_FILE, { ...(files.get(MCP_FILE) ?? file(0, 0o644)), uid: AGENT })],
    ["the managed MCP file is group-writable", (files: Layout) => files.set(MCP_FILE, { ...(files.get(MCP_FILE) ?? file(0, 0o644)), mode: 0o664 })],
    ["the managed MCP file defines a second server", (files: Layout) => files.set(MCP_FILE, { ...file(0, 0o644), text: JSON.stringify({ mcpServers: { juno: gatewayServerEntry(GATEWAY), extra: { type: "stdio", command: "/bin/x" } } }) })],
    ["the shim is the agent's", (files: Layout) => files.set(SHIM, file(AGENT, 0o644))],
    ["a file beside the shim is writable by others", (files: Layout) => files.set("/opt/juno/dist/mediated/src/mcp-shim.js", file(0, 0o666))],
    ["the gateway socket is not the runner's", (files: Layout) => files.set(GATEWAY_SOCKET, { uid: AGENT, gid: HOOK_GROUP, mode: 0o660, kind: "socket" })],
    ["the gateway socket is missing", (files: Layout) => files.delete(GATEWAY_SOCKET)],
    ["the gateway socket is open to everyone", (files: Layout) => files.set(GATEWAY_SOCKET, { uid: RUNNER, gid: HOOK_GROUP, mode: 0o666, kind: "socket" })],
  ])("refuses when %s", async (_what, change) => {
    const files = layout(await installedTexts());
    change(files);
    expect(hookPreflight(CHECK, preflightIo(files)).length).toBeGreaterThan(0);
  });

  // proves D-190 item 3: managed settings that lack the MCP keys, or that add a server beside the gateway, are refused
  it("refuses managed settings without the MCP lock, or with a server provided beside the gateway", async () => {
    const texts = await installedTexts();
    const settings = JSON.parse(texts.settings) as Record<string, unknown>;
    const unlocked = Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "allowManagedMcpServersOnly"));
    expect(hookPreflight(CHECK, preflightIo(layout({ ...texts, settings: JSON.stringify(unlocked) }))).join("\n")).toContain("allowManagedMcpServersOnly");
    const provided = { ...settings, managedMcpServers: { remote: { type: "http", url: "https://mcp.example.com/mcp" } } };
    expect(hookPreflight(CHECK, preflightIo(layout({ ...texts, settings: JSON.stringify(provided) }))).join("\n")).toContain("managedMcpServers");
  });

  // proves D-190 item 3: the CLI takes the gateway's three options together or not at all
  it("is bad usage to name the gateway without its shim and socket", async () => {
    const base = ["--agent-user", "juno-agent", "--runner-user", "juno-runner", "--socket", SOCKET, "--client", CLIENT, "--node", NODE, "--state", "/var/lib/juno-runner", "--workspace", "/srv/juno-work"];
    expect(await runHookCheckCli([...base, "--gateway", "juno"], () => {}, () => {}, preflightIo(layout(await installedTexts())))).toBe(2);
    expect(await runHookCheckCli([...base, "--shim", SHIM, "--gateway-socket", GATEWAY_SOCKET], () => {}, () => {}, preflightIo(layout(await installedTexts())))).toBe(2);
  });
});

// The hook's pass-through (D-190 item 4), at the protocol level: each test feeds the session the hook input Claude Code
// sends, with the `mcp_server` object observed from the 2.1.319 binary.
const PRINCIPAL = "alireza";
const SESSION = "6f2b8a3e-0c1d-4e5f-9a7b-2c3d4e5f6a7b";
let tmp: string;
let work: string;
let journal: { readonly root: string };
let layer: SessionLayer;
let grants: GrantStore;
let uses = 0;

function sessionsWith(gateway?: { server: string }): MediatedSessions {
  return new MediatedSessions({
    layer,
    grants,
    paths: new PathMap([work]),
    resolver: new HostPathResolver(work),
    view: new Workspace(execFileScript(process.execPath, []), "/work", work),
    filesystem: systemFilesystemIo(),
    ...(gateway === undefined ? {} : { gateway }),
  });
}

async function admitted(gateway?: { server: string }, toolCalls = 50): Promise<MediatedSessions> {
  const sessions = sessionsWith(gateway);
  const result = await sessions.admit({
    session_id: SESSION,
    principal: PRINCIPAL,
    attendance: "gated",
    ttl: 3_600_000,
    grants: ["grant-cc"],
    budget: { tool_calls: toolCalls, wall_clock_ms: 3_600_000 },
    unmetered_accepted: true,
    provider_clearance: "internal",
    sources: [{ id: "project", selector: { kind: "path", prefix: "/work/project" }, data_class: { sensitivity: "internal", integrity: "untrusted" } }],
  });
  expect(result).toMatchObject({ admitted: true });
  return sessions;
}

function mcpCall(tool: string, server?: { name: string; source: string }, session = SESSION): Record<string, unknown> {
  uses += 1;
  return { session_id: session, hook_event_name: "PreToolUse", tool_name: tool, tool_input: { to: "a@example.com", body: "hi" }, tool_use_id: `toolu_gw_${String(uses)}`, cwd: join(work, "project"), ...(server === undefined ? {} : { mcp_server: server }) };
}

const notes = (): Record<string, unknown>[] =>
  readTrajectory(journal.root, `session-${SESSION}`).map((entry) => {
    const blob = readPayload(journal.root, entry.payload_ref);
    return { kind: entry.kind, ...(blob.status === "present" ? (JSON.parse(new TextDecoder().decode(blob.bytes)) as Record<string, unknown>) : {}) };
  });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "juno-gateway-hook-"));
  work = join(tmp, "work");
  mkdirSync(join(work, "project"), { recursive: true });
  writeFileSync(join(work, "project", "notes.txt"), "notes\n");
  layer = openTestLayer("hook", { journal: join(tmp, "journal"), workspaces: [work] });
  journal = { root: layer.root };
  grants = new GrantStore(TEST_ANCHOR);
  grants.add(signed({
    id: "grant-cc",
    principal: PRINCIPAL,
    capability_selector: { capabilities: ["cc.read"] },
    resource_scope: [{ kind: "path", prefix: "/work/project" }],
    data_class_bounds: { max_sensitivity: "internal", min_integrity: "untrusted" },
    issuance: "preissued",
    issued_by: PRINCIPAL,
    issued_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    max_invocations: 100,
    attenuation_parent: null,
    revoked_at: null,
  }));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("the hook passes only the gateway's own calls (D-190 item 4)", () => {
  // proves D-190 item 4: a call to the gateway's tool, from the server the managed MCP file defines, gets no decision and is journalled
  it("gives no decision to the gateway's tool from the managed server, so the gateway judges it, and journals the hand-off and the result", async () => {
    const sessions = await admitted({ server: "juno" });
    const asked = mcpCall("mcp__juno__message_send", { name: "juno", source: "enterprise" });
    expect(await sessions.preToolUse(asked)).toEqual({ decision: "none" });
    expect(await sessions.postToolUse({ ...asked, hook_event_name: "PostToolUse", tool_response: [{ type: "text", text: "parked by the gateway" }] })).toEqual({ recorded: true });
    const recorded = notes();
    expect(recorded).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "note", type: "gateway_call", tool: "mcp__juno__message_send", mcp_server: { name: "juno", source: "enterprise" }, judged_by: "gateway" })]));
    const result = recorded.find((item) => item["kind"] === "capability_result");
    expect(result).toMatchObject({ tool: "mcp__juno__message_send", judged_by: "gateway" });
    expect(result?.["without_authorized_call"]).toBeUndefined();
  });

  // proves D-190 item 4: an MCP tool from any other source, any other server, or without mcp_server, is denied
  it.each([
    ["a project server under the gateway's name", "mcp__juno__message_send", { name: "juno", source: "project" }],
    ["a user server under the gateway's name", "mcp__juno__message_send", { name: "juno", source: "user" }],
    ["a local server under the gateway's name", "mcp__juno__message_send", { name: "juno", source: "local" }],
    ["an in-process sdk server under the gateway's name", "mcp__juno__message_send", { name: "juno", source: "sdk" }],
    ["a server provided by managed settings", "mcp__juno__message_send", { name: "juno", source: "managed" }],
    ["a plugin server", "mcp__juno__message_send", { name: "juno", source: "plugin" }],
    ["no mcp_server at all", "mcp__juno__message_send", undefined],
    ["another enterprise server", "mcp__other__message_send", { name: "other", source: "enterprise" }],
    ["a server whose name extends the gateway's", "mcp__juno__x__send", { name: "juno__x", source: "enterprise" }],
    ["a tool name that does not match the server", "mcp__other__message_send", { name: "juno", source: "enterprise" }],
  ])("denies %s", async (_what, tool, server) => {
    const sessions = await admitted({ server: "juno" });
    expect(await sessions.preToolUse(mcpCall(tool, server))).toMatchObject({ decision: "deny", reason: expect.stringContaining("unknown_capability") });
  });

  // proves D-190 item 3 of the ruling: without a configured gateway, every MCP tool stays blocked, the gateway's included
  it("denies every MCP tool when the service has no gateway", async () => {
    const sessions = await admitted();
    expect(await sessions.preToolUse(mcpCall("mcp__juno__message_send", { name: "juno", source: "enterprise" }))).toMatchObject({ decision: "deny", reason: expect.stringContaining("unknown_capability") });
  });

  // proves D-190 item 4 with §4.3: a session JUNO did not admit is denied the gateway's tool too, and a passed call counts against the budget
  it("denies the gateway's tool to an unadmitted session, and counts passed calls against the budget", async () => {
    const sessions = await admitted({ server: "juno" }, 1);
    expect(await sessions.preToolUse(mcpCall("mcp__juno__message_send", { name: "juno", source: "enterprise" }, "not-admitted"))).toMatchObject({ decision: "deny", reason: expect.stringContaining("not admitted") });
    const first = mcpCall("mcp__juno__message_send", { name: "juno", source: "enterprise" });
    expect(await sessions.preToolUse(first)).toEqual({ decision: "none" });
    expect(await sessions.postToolUse({ ...first, hook_event_name: "PostToolUse", tool_response: "ok" })).toEqual({ recorded: true });
    expect(await sessions.preToolUse(mcpCall("mcp__juno__message_send", { name: "juno", source: "enterprise" }))).toMatchObject({ decision: "deny", reason: expect.stringContaining("budget_exceeded") });
  });

  // proves D-190 item 4 with plan item 8: a passed call whose result never arrived is recorded, and the next call is denied
  it("records a passed call whose result never arrived, and denies the next call", async () => {
    const sessions = await admitted({ server: "juno" });
    expect(await sessions.preToolUse(mcpCall("mcp__juno__message_send", { name: "juno", source: "enterprise" }))).toEqual({ decision: "none" });
    expect(await sessions.preToolUse(mcpCall("mcp__juno__message_send", { name: "juno", source: "enterprise" }))).toMatchObject({ decision: "deny" });
    expect(notes()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "result_missing" })]));
  });

  // proves §2.7.1 A4 with D-192: passing a call to the gateway does not clear the hook session's count of consecutive
  // rejections, because the hook does not know whether the gateway will reject it
  it("does not clear the rejection count when it passes a call to the gateway", async () => {
    const sessions = await admitted({ server: "juno" });
    for (let index = 0; index < 2; index += 1) expect(await sessions.preToolUse(mcpCall("mcp__other__x", { name: "other", source: "enterprise" }))).toMatchObject({ reason: expect.stringContaining("unknown_capability") });
    const passed = mcpCall("mcp__juno__message_send", { name: "juno", source: "enterprise" });
    expect(await sessions.preToolUse(passed)).toEqual({ decision: "none" });
    expect(await sessions.postToolUse({ ...passed, hook_event_name: "PostToolUse", tool_response: "parked by the gateway" })).toEqual({ recorded: true });
    expect(await sessions.preToolUse(mcpCall("mcp__other__x", { name: "other", source: "enterprise" }))).toMatchObject({ reason: expect.stringContaining("rejection_limit") });
  });

  // proves D-190 item 1: the service refuses a gateway name that could be read as another server's prefix
  it("refuses a gateway name with an underscore", () => {
    expect(() => sessionsWith({ server: "ju_no" })).toThrow(MediatedError);
  });
});
