import { describe, expect, it } from "vitest";
import { sshFingerprint } from "../../enforcement/src/anchor-pin.js";
import { HOOK_EVENTS, MANAGED_SETTINGS, hookEntry } from "../src/install.js";
import type { FilesystemIo } from "../src/filesystem.js";
import { type FileFacts, type PreflightInput, type PreflightIo, account, holds, hookPreflight, runHookCheckCli } from "../src/preflight.js";

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

const PIN = "/etc/juno/anchors.json";
const KNOWN_HOSTS = "/etc/juno/anchors_known_hosts";
/** A host key blob (any bytes do for the fingerprint rule; the real ssh-keygen comparison is in anchor-ssh.test.ts). */
const HOST_KEY = Buffer.from("a pinned host key, for the test").toString("base64");
const PINNED = {
  url: "git@github.com:operator/juno-anchors.git",
  branch: "main",
  host_key_fingerprint: sshFingerprint(HOST_KEY),
  known_hosts: KNOWN_HOSTS,
  push_key: "/var/lib/juno-runner/.ssh/juno_anchors",
  journals: [{ path: "/var/lib/juno-runner/journal", recovery_epoch: "2026-11-13T00:00:00Z" }],
};

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
    // D-208: the anchor pin, the pinned host key, and the runner's push key.
    [PIN, { ...file(0, 0o644), text: JSON.stringify(PINNED) }],
    [KNOWN_HOSTS, { ...file(0, 0o644), text: `github.com ssh-ed25519 ${HOST_KEY}\n` }],
    ["/var/lib/juno-runner/.ssh", dir(RUNNER, 0o700)],
    ["/var/lib/juno-runner/.ssh/juno_anchors", file(RUNNER, 0o600)],
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
  anchorPin: PIN,
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

  // proves D-206 item 2 (D-208): the anchor pin and its known-hosts file are root's own; the pin names an SSH address,
  // exactly the pinned host key, the runner's own push key, and journal folders this check judged
  it("refuses an anchor pin that is not root's own, or that pins less than the operator's set-up requires (D-208)", () => {
    const withPin = (pin: Record<string, unknown>): Layout => { const layout = good(); layout.set(PIN, { ...file(0, 0o644), text: JSON.stringify(pin) }); return layout; };
    expect(hookPreflight(INPUT, io(changed(PIN, { uid: RUNNER }))).join("\n")).toMatch(/the anchor pin: \/etc\/juno\/anchors\.json must be owned by root/);
    expect(hookPreflight(INPUT, io(changed(PIN, { mode: 0o666 }))).join("\n")).toMatch(/the anchor pin: .* must be owned by root and writable by no one else/);
    expect(hookPreflight(INPUT, io(changed("/etc/juno", { uid: RUNNER }))).join("\n")).toMatch(/the anchor pin: \/etc\/juno must be owned by root/);
    expect(hookPreflight(INPUT, io(changed(KNOWN_HOSTS, { uid: RUNNER }))).join("\n")).toMatch(/the pinned known-hosts file: .* must be owned by root/);
    const missing = good();
    missing.delete(PIN);
    expect(hookPreflight(INPUT, io(missing)).join("\n")).toMatch(/the anchor pin \/etc\/juno\/anchors\.json does not exist/);
    expect(hookPreflight(INPUT, io(withPin({ ...PINNED, url: "/srv/anchors.git", host_key_fingerprint: null, known_hosts: null, push_key: null }))).join("\n")).toMatch(/names a local path .* the operator's pin names the anchor repository's SSH address/);
    expect(hookPreflight(INPUT, io(withPin({ ...PINNED, url: "https://github.com/operator/juno-anchors.git" }))).join("\n")).toMatch(/cannot be used: the pinned url is neither an SSH address/);
    expect(hookPreflight(INPUT, io(withPin({ ...PINNED, host_key_fingerprint: sshFingerprint(Buffer.from("another key").toString("base64")) }))).join("\n")).toMatch(/holds a ssh-ed25519 key with fingerprint .* not the pinned/);
    expect(hookPreflight(INPUT, io(changed("/var/lib/juno-runner/.ssh/juno_anchors", { mode: 0o644 }))).join("\n")).toMatch(/the anchor push key .* must be the runner's own file, readable by no one else/);
    expect(hookPreflight(INPUT, io(changed("/var/lib/juno-runner/.ssh/juno_anchors", { uid: 0 }))).join("\n")).toMatch(/the anchor push key .* must be the runner's own file/);
    expect(hookPreflight(INPUT, io(withPin({ ...PINNED, journals: [{ path: "/tmp/journal", recovery_epoch: "2026-11-13T00:00:00Z" }] }))).join("\n")).toMatch(/names the journal folder \/tmp\/journal, which is not under any --state path/);
  });

  // proves D-178: `juno hook check` judges the workspace and every source it is given, requires a workspace, and
  // refuses one on a Windows-mounted file system or holding a case-folding folder, with a plain reason
  it("requires a workspace, and refuses one on a Windows mount or holding a case-folding folder (D-178)", async () => {
    const fsIo = (fsType: string, flags = "--------------e-------"): FilesystemIo => ({
      mountinfo: () => `20 1 0:20 / / rw - ${fsType} src rw`,
      realpath: (path) => path,
      list: () => [],
      identity: () => null,
      attributes: (dirs) => Promise.resolve({ ok: true, flags: dirs.map(() => flags) }),
    });
    const base = ["--agent-user", "juno-agent", "--runner-user", "juno-runner", "--socket", SOCKET, "--client", CLIENT, "--node", NODE, "--anchor", "/etc/juno/operator.pub", ...INPUT.state.flatMap((path) => ["--state", path])];
    const run = async (args: readonly string[], fs: FilesystemIo) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runHookCheckCli(args, (text) => out.push(text), (text) => err.push(text), io(good()), fs);
      return { code, out: out.join(""), err: err.join("") };
    };
    expect(await run(base, fsIo("ext4"))).toMatchObject({ code: 2, err: expect.stringContaining("--workspace <path>") });
    expect(await run([...base, "--workspace", "/srv/juno-work"], fsIo("ext4"))).toMatchObject({ code: 0, out: expect.stringContaining("case-sensitive") });
    const windows = await run([...base, "--workspace", "/srv/juno-work"], fsIo("drvfs"));
    expect(windows).toMatchObject({ code: 1, err: expect.stringContaining("how WSL mounts a Windows folder") });
    expect(await run([...base, "--workspace", "/srv/juno-work", "--source", "/srv/juno-work/project"], fsIo("ext4", "-----F"))).toMatchObject({ code: 1, err: expect.stringContaining("case-folding attribute") });
  });
});
