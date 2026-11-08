import { describe, expect, it } from "vitest";
import { HOOK_EVENTS, MANAGED_SETTINGS, hookEntry } from "../src/install.js";
import { type FileFacts, type PreflightInput, type PreflightIo, account, holds, hookPreflight } from "../src/preflight.js";

// D-173 (operator ruling 1 of 2026-11-08, second set): `juno hook check` refuses unless the Claude Code user is an
// ordinary user, distinct from the runner, unable to change the managed hook settings, the hook it runs, JUNO's state,
// or the socket's permissions. Here over a described file system; test/containers/hook-separation.test.ts asks the
// kernel itself.

const RUNNER = 1000;
const AGENT = 1001;
const HOOK_GROUP = 1500;
const NODE = "/opt/node22/bin/node";
const CLIENT = "/opt/juno/dist/mediated/src/juno-hook.js";
const SOCKET = "/var/lib/juno-hook/hook.sock";

const PASSWD = ["root:x:0:0::/root:/bin/bash", `juno-runner:x:${String(RUNNER)}:${String(RUNNER)}::/home/juno-runner:/bin/bash`, `juno-agent:x:${String(AGENT)}:${String(AGENT)}::/home/juno-agent:/bin/bash`].join("\n");
const GROUP = ["root:x:0:", `juno-runner:x:${String(RUNNER)}:`, `juno-agent:x:${String(AGENT)}:`, `juno-hook:x:${String(HOOK_GROUP)}:juno-agent`].join("\n");

const SETTINGS = JSON.stringify({
  hooks: Object.fromEntries(HOOK_EVENTS.map((event) => [event, [hookEntry({ command: NODE, args: [CLIENT, "--socket", SOCKET] })]])),
  env: { CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1" },
  allowManagedHooksOnly: true,
});

type Layout = Map<string, FileFacts & { readonly text?: string }>;

const dir = (uid: number, mode: number, gid = uid): FileFacts => ({ uid, gid, mode, kind: "directory" });
const file = (uid: number, mode: number, gid = uid): FileFacts => ({ uid, gid, mode, kind: "file" });

function good(): Layout {
  return new Map<string, FileFacts & { text?: string }>([
    ["/", dir(0, 0o755)],
    ["/etc", dir(0, 0o755)],
    ["/etc/claude-code", dir(0, 0o755)],
    [MANAGED_SETTINGS, { ...file(0, 0o644), text: SETTINGS }],
    ["/opt", dir(0, 0o755)],
    ["/opt/node22", dir(0, 0o755)],
    ["/opt/node22/bin", dir(0, 0o755)],
    [NODE, file(0, 0o755)],
    ["/opt/juno", dir(0, 0o755)],
    ["/opt/juno/dist", dir(0, 0o755)],
    ["/opt/juno/dist/mediated", dir(0, 0o755)],
    ["/opt/juno/dist/mediated/src", dir(0, 0o755)],
    [CLIENT, file(0, 0o644)],
    ["/opt/juno/dist/mediated/src/hook-client.js", file(0, 0o644)],
    ["/var", dir(0, 0o755)],
    ["/var/lib", dir(0, 0o755)],
    ["/var/lib/juno-runner", dir(RUNNER, 0o700)],
    ["/var/lib/juno-runner/journal", dir(RUNNER, 0o700)],
    ["/var/lib/juno-runner/grants", dir(RUNNER, 0o700)],
    ["/var/lib/juno-runner/checkpoints", dir(RUNNER, 0o700)],
    ["/etc/juno", dir(0, 0o755)],
    ["/etc/juno/operator.pub", file(0, 0o444)],
    ["/var/lib/juno-hook", dir(RUNNER, 0o2750, HOOK_GROUP)],
    [SOCKET, { uid: RUNNER, gid: HOOK_GROUP, mode: 0o660, kind: "socket" }],
  ]);
}

function io(layout: Layout, passwd = PASSWD, group = GROUP): PreflightIo {
  return {
    lstat: (path) => layout.get(path) ?? null,
    realpath: (path) => (layout.has(path) ? path : null),
    readdir: (path) => (layout.has(path) ? [...layout.keys()].filter((key) => key !== path && key.startsWith(path === "/" ? "/" : `${path}/`) && !key.slice(path.length + 1).includes("/")).map((key) => key.slice(path.length + 1)) : null),
    readFile: (path) => layout.get(path)?.text ?? null,
    passwd,
    group,
  };
}

const INPUT: PreflightInput = {
  agentUser: "juno-agent",
  runnerUser: "juno-runner",
  settings: MANAGED_SETTINGS,
  socket: SOCKET,
  client: CLIENT,
  node: NODE,
  state: ["/var/lib/juno-runner", "/var/lib/juno-runner/journal", "/var/lib/juno-runner/grants", "/var/lib/juno-runner/checkpoints"],
  anchor: "/etc/juno/operator.pub",
};

const changed = (path: string, facts: Partial<FileFacts>): Layout => {
  const layout = good();
  const before = layout.get(path);
  if (before === undefined) throw new Error(path);
  layout.set(path, { ...before, ...facts });
  return layout;
};

describe("juno hook check (D-173): the Claude Code user is separated from the runner and from the hook's configuration", () => {
  // proves D-173 (positive control): the layout STATE.md Part E builds passes
  it("passes the layout Part E builds", () => {
    expect(hookPreflight(INPUT, io(good()))).toEqual([]);
  });

  // proves D-173: the agent is not root, not the runner, and holds none of the runner's groups
  it("refuses an agent that is root, is the runner, or holds the runner's group", () => {
    expect(hookPreflight({ ...INPUT, agentUser: "root" }, io(good())).join(" ")).toMatch(/is root/);
    expect(hookPreflight({ ...INPUT, agentUser: "juno-runner" }, io(good())).join(" ")).toMatch(/same user/);
    expect(hookPreflight(INPUT, io(good(), PASSWD, GROUP.replace(`juno-runner:x:${String(RUNNER)}:`, `juno-runner:x:${String(RUNNER)}:juno-agent`))).join(" ")).toMatch(/runner's group/);
    expect(hookPreflight({ ...INPUT, runnerUser: "root" }, io(good())).join(" ")).toMatch(/runner's user root is root/);
  });

  // proves D-173: hooks live in root-owned managed settings; any write path for the agent is refused
  it("refuses managed settings the agent could change, or that do not hold JUNO's fail-closed hook", () => {
    expect(hookPreflight(INPUT, io(changed(MANAGED_SETTINGS, { uid: AGENT }))).join(" ")).toMatch(/managed settings/);
    expect(hookPreflight(INPUT, io(changed(MANAGED_SETTINGS, { mode: 0o666 }))).join(" ")).toMatch(/managed settings/);
    expect(hookPreflight(INPUT, io(changed("/etc/claude-code", { mode: 0o777 }))).join(" ")).toMatch(/managed settings/);
    expect(hookPreflight(INPUT, io(changed("/etc", { gid: AGENT, mode: 0o775 }))).join(" ")).toMatch(/managed settings/);
    const noAllow = good();
    noAllow.set(MANAGED_SETTINGS, { ...file(0, 0o644), text: JSON.stringify({ ...JSON.parse(SETTINGS), allowManagedHooksOnly: false }) });
    expect(hookPreflight(INPUT, io(noAllow)).join(" ")).toMatch(/allowManagedHooksOnly/);
    const disabled = good();
    disabled.set(MANAGED_SETTINGS, { ...file(0, 0o644), text: JSON.stringify({ ...JSON.parse(SETTINGS), disableAllHooks: true }) });
    expect(hookPreflight(INPUT, io(disabled)).join(" ")).toMatch(/disableAllHooks/);
    expect(hookPreflight({ ...INPUT, settings: "/home/juno-agent/.claude/settings.json" }, io(good())).join(" ")).toMatch(/must be \/etc\/claude-code\/managed-settings.json/);
    const otherSocket = good();
    otherSocket.set(MANAGED_SETTINGS, { ...file(0, 0o644), text: SETTINGS.replaceAll(SOCKET, "/tmp/agent.sock") });
    expect(hookPreflight(INPUT, io(otherSocket)).join(" ")).toMatch(/does not run/);
    const dropIn = good();
    dropIn.set("/etc/claude-code/managed-settings.d", dir(0, 0o755));
    dropIn.set("/etc/claude-code/managed-settings.d/other.json", { ...file(0, 0o644), text: "{}" });
    expect(hookPreflight(INPUT, io(dropIn)).join(" ")).toMatch(/drop-in/);
  });

  // proves D-173: the agent cannot replace what the hook runs
  it("refuses a hook client or node the agent could replace", () => {
    expect(hookPreflight(INPUT, io(changed(CLIENT, { uid: AGENT })))).not.toEqual([]);
    expect(hookPreflight(INPUT, io(changed("/opt/juno/dist/mediated/src/hook-client.js", { mode: 0o666 }))).join(" ")).toMatch(/hook-client.js/);
    expect(hookPreflight(INPUT, io(changed("/opt/juno", { uid: AGENT })))).not.toEqual([]);
    expect(hookPreflight(INPUT, io(changed(NODE, { mode: 0o777 })))).not.toEqual([]);
  });

  // proves D-173: the agent can neither read, write, search nor replace JUNO's journal, grants and checkpoints, nor change the trust anchor
  it("refuses state the agent can reach", () => {
    expect(hookPreflight(INPUT, io(changed("/var/lib/juno-runner/journal", { mode: 0o755 }))).join(" ")).toMatch(/permission on JUNO's state/);
    expect(hookPreflight(INPUT, io(changed("/var/lib/juno-runner/grants", { gid: HOOK_GROUP, mode: 0o750 }))).join(" ")).toMatch(/permission on JUNO's state/);
    expect(hookPreflight(INPUT, io(changed("/var/lib/juno-runner/checkpoints", { uid: AGENT }))).join(" ")).toMatch(/not owned by the runner/);
    expect(hookPreflight(INPUT, io(changed("/var/lib", { mode: 0o777 }))).join(" ")).toMatch(/replace or remove JUNO's state/);
    expect(hookPreflight(INPUT, io(changed("/etc/juno/operator.pub", { uid: AGENT, mode: 0o644 }))).join(" ")).toMatch(/trust anchor/);
    expect(hookPreflight(INPUT, io(changed("/etc/juno", { mode: 0o777 }))).join(" ")).toMatch(/trust anchor/);
  });

  // proves D-173: the agent connects to the socket but cannot change its mode or replace it
  it("refuses a socket the agent owns, cannot reach, or whose folder it can write", () => {
    expect(hookPreflight(INPUT, io(changed(SOCKET, { uid: AGENT }))).join(" ")).toMatch(/can change its mode/);
    expect(hookPreflight(INPUT, io(changed(SOCKET, { mode: 0o600 }))).join(" ")).toMatch(/cannot connect/);
    expect(hookPreflight(INPUT, io(changed(SOCKET, { mode: 0o666 }))).join(" ")).toMatch(/open to every user/);
    expect(hookPreflight(INPUT, io(changed("/var/lib/juno-hook", { mode: 0o2770 }))).join(" ")).toMatch(/write the socket's folder/);
    expect(hookPreflight(INPUT, io(changed("/var/lib/juno-hook", { mode: 0o2700 }))).join(" ")).toMatch(/cannot reach the socket's folder/);
    expect(hookPreflight(INPUT, io(changed(SOCKET, { kind: "file" }))).join(" ")).toMatch(/not a listening socket/);
  });

  // proves the permission model used: owner, then group, then others; root holds everything
  it("reads accounts and permissions as POSIX does", () => {
    const agent = account("juno-agent", PASSWD, GROUP);
    expect(agent).toEqual({ name: "juno-agent", uid: AGENT, gids: [AGENT, HOOK_GROUP] });
    if (agent === null) return;
    expect(holds(agent, file(AGENT, 0o044), 4)).toBe(false);
    expect(holds(agent, file(0, 0o640, HOOK_GROUP), 4)).toBe(true);
    expect(holds(agent, file(0, 0o604, HOOK_GROUP), 4)).toBe(false);
    expect(holds(agent, file(0, 0o004), 4)).toBe(true);
    expect(holds({ name: "root", uid: 0, gids: [0] }, file(5, 0o000), 2)).toBe(true);
  });
});
