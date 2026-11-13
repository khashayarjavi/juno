import { type Stats, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { knownHostsRefusals, parseAnchorPin } from "../../enforcement/src/anchor-pin.js";
import { type FilesystemIo, caseFoldingRefusals, systemFilesystemIo } from "./filesystem.js";
import { type GatewayInstall, MANAGED_MCP_NAME, MANAGED_SETTINGS, gatewayInputRefusals, gatewaySettingsRefusals, hookRefusals, managedMcpRefusals } from "./install.js";

/**
 * `juno hook check` (operator ruling 1 of 2026-11-08, second set; DECISIONS.md D-173). Before a governed session, it
 * proves the separation the ruling requires: Claude Code runs inside WSL2 as its own Linux user, which is not root and
 * not the runner, and which cannot write JUNO's journal, grants, socket permissions or hook configuration (the hooks
 * live in root-owned managed settings). Each path is judged with POSIX permission rules for the agent's uid and every
 * group it holds, read from /etc/passwd and /etc/group. ACLs are not read: the container test
 * (test/containers/hook-separation.test.ts) asks the kernel itself, and STATE.md Part E sets no ACL.
 */

export type Account = { readonly name: string; readonly uid: number; readonly gids: readonly number[] };

export type FileFacts = { readonly uid: number; readonly gid: number; readonly mode: number; readonly kind: "file" | "directory" | "symlink" | "socket" | "other" };

export type PreflightIo = {
  readonly lstat: (path: string) => FileFacts | null;
  readonly realpath: (path: string) => string | null;
  readonly readdir: (path: string) => readonly string[] | null;
  readonly readFile: (path: string) => string | null;
  readonly passwd: string;
  readonly group: string;
};

export type PreflightInput = {
  readonly agentUser: string;
  readonly runnerUser: string;
  readonly settings: string;
  readonly socket: string;
  readonly client: string;
  readonly node: string;
  /** JUNO's state: journal, grants, checkpoints. The agent may not read, write or search any of it. */
  readonly state: readonly string[];
  /** The trust anchor: public (D-116), so the agent may read it, but never write or replace it. */
  readonly anchor?: string;
  /**
   * The anchor pin (operator ruling D-206 item 2; D-208): root's own file naming the anchor repository, GitHub's SSH
   * host key and the journal folders that may anchor there. `juno hook check` always judges it.
   */
  readonly anchorPin?: string;
  /**
   * JUNO's gateway relay, when the hook is to let the gateway's calls through (D-190): its server name, the shim Claude
   * Code starts, and the runner's gateway socket. Node is `node` above.
   */
  readonly gateway?: { readonly name: string; readonly shim: string; readonly socket: string };
};

/** The account named `name`: its uid, its primary group and every group listing it as a member. */
export function account(name: string, passwd: string, group: string): Account | null {
  const line = passwd.split("\n").map((row) => row.split(":")).find((fields) => fields[0] === name);
  if (line === undefined || line.length < 4) return null;
  const uid = Number(line[2]);
  const primary = Number(line[3]);
  if (!Number.isInteger(uid) || !Number.isInteger(primary)) return null;
  const gids = new Set<number>([primary]);
  for (const fields of group.split("\n").map((row) => row.split(":"))) {
    if (fields.length < 4) continue;
    const members = (fields[3] ?? "").split(",").map((member) => member.trim());
    if (members.includes(name) && Number.isInteger(Number(fields[2]))) gids.add(Number(fields[2]));
  }
  return { name, uid, gids: [...gids] };
}

/** Whether `who` holds permission `bit` (4 read, 2 write, 1 search/execute) on a file with these facts (POSIX, no ACLs). */
export function holds(who: Account, facts: FileFacts, bit: 4 | 2 | 1): boolean {
  if (who.uid === 0) return true;
  if (facts.uid === who.uid) return ((facts.mode >> 6) & bit) !== 0;
  if (who.gids.includes(facts.gid)) return ((facts.mode >> 3) & bit) !== 0;
  return (facts.mode & bit) !== 0;
}

/** Every directory from `/` down to the parent of `path`. */
function ancestors(path: string): string[] {
  const out: string[] = [];
  for (let at = dirname(path); ; at = dirname(at)) {
    out.unshift(at);
    if (at === "/") break;
  }
  return out;
}

const describeMode = (facts: FileFacts): string => `owner ${String(facts.uid)}, group ${String(facts.gid)}, mode ${(facts.mode & 0o7777).toString(8).padStart(4, "0")}`;

/** Refusals for a path only root may change: it, its kernel-resolved form, and every ancestor of each, owned by root and not writable by group or others. */
function rootOnly(what: string, path: string, io: PreflightIo): string[] {
  if (!path.startsWith("/")) return [`${what} ${path} is not an absolute path`];
  const real = io.realpath(path);
  if (real === null) return [`${what} ${path} does not exist`];
  const refusals: string[] = [];
  for (const chain of new Set([path, real])) {
    for (const at of [...ancestors(chain), chain]) {
      const facts = io.lstat(at);
      if (facts === null) {
        refusals.push(`${what}: ${at} does not exist`);
        continue;
      }
      // A symlink's own mode is always 0777 and cannot be changed; who may replace it is decided by its folder, checked as an ancestor.
      if (facts.kind === "symlink") continue;
      if (facts.uid !== 0 || (facts.mode & 0o022) !== 0) refusals.push(`${what}: ${at} must be owned by root and writable by no one else (${describeMode(facts)}), or the Claude Code user could change it`);
    }
  }
  return refusals;
}

/** Whether `who` can replace or remove the entry `path` through its folder (write and search there, no sticky protection). */
function canReplace(who: Account, path: string, io: PreflightIo): boolean {
  const folder = io.lstat(dirname(path));
  const entry = io.lstat(path);
  if (folder === null) return false;
  if (!ancestors(path).every((at) => { const facts = io.lstat(at); return facts !== null && holds(who, facts, 1); })) return false;
  if (!holds(who, folder, 2) || !holds(who, folder, 1)) return false;
  const sticky = (folder.mode & 0o1000) !== 0;
  return !sticky || folder.uid === who.uid || entry === null || entry.uid === who.uid;
}

/** Refusals for a socket of the runner's that the agent must reach and must not replace (D-173; the gateway's too, D-190). */
function socketRefusals(what: string, path: string, agent: Account, runner: Account, io: PreflightIo): string[] {
  const refusals: string[] = [];
  const socket = io.lstat(path);
  const folder = io.lstat(dirname(path));
  if (socket === null || socket.kind !== "socket") refusals.push(`${what} ${path} is not a listening socket (start the runner's service first)`);
  else {
    if (socket.uid !== runner.uid) refusals.push(`${what} ${path} is not owned by the runner's user (${describeMode(socket)}); its owner can change its mode`);
    if (!holds(agent, socket, 2)) refusals.push(`the Claude Code user cannot connect to ${what} ${path} (${describeMode(socket)}); the hook would block every call`);
    if ((socket.mode & 0o007) !== 0) refusals.push(`${what} ${path} is open to every user (${describeMode(socket)}); only the runner and the Claude Code user's group may reach it`);
  }
  if (folder === null) refusals.push(`${what}'s folder ${dirname(path)} does not exist`);
  else {
    if (folder.uid !== runner.uid) refusals.push(`${what}'s folder ${dirname(path)} is not owned by the runner's user (${describeMode(folder)})`);
    if (!ancestors(path).every((at) => { const facts = io.lstat(at); return facts !== null && holds(agent, facts, 1); })) refusals.push(`the Claude Code user cannot reach ${what}'s folder ${dirname(path)}; the hook would block every call`);
    if (holds(agent, folder, 2)) refusals.push(`the Claude Code user can write ${what}'s folder ${dirname(path)} (${describeMode(folder)}), so it could replace ${what} (D-173)`);
    if ((folder.mode & 0o002) !== 0) refusals.push(`${what}'s folder ${dirname(path)} is writable by every user (${describeMode(folder)})`);
    if (canReplace(agent, dirname(path), io)) refusals.push(`the Claude Code user can replace ${what}'s folder ${dirname(path)} (D-173)`);
  }
  return refusals;
}

/** The refusals; empty when the separation D-173 requires holds. */
export function hookPreflight(input: PreflightInput, io: PreflightIo): string[] {
  const refusals: string[] = [];
  const agent = account(input.agentUser, io.passwd, io.group);
  const runner = account(input.runnerUser, io.passwd, io.group);
  if (agent === null) return [`the Claude Code user ${input.agentUser} is not in /etc/passwd`];
  if (runner === null) return [`the runner's user ${input.runnerUser} is not in /etc/passwd`];
  // 1. Identities.
  if (agent.uid === 0) refusals.push(`the Claude Code user ${agent.name} is root; it must be an ordinary user (D-173)`);
  if (runner.uid === 0) refusals.push(`the runner's user ${runner.name} is root (D-130)`);
  if (agent.uid === runner.uid) refusals.push(`the Claude Code user and the runner are the same user (uid ${String(agent.uid)}); they must differ (D-173)`);
  const shared = agent.gids.filter((gid) => runner.gids.includes(gid));
  if (shared.length > 0) refusals.push(`the Claude Code user holds the runner's group(s) ${shared.join(", ")}; it must hold none (D-173)`);

  // 2. The managed settings: root's alone, holding JUNO's fail-closed hook, with no drop-in beside it.
  if (input.settings !== MANAGED_SETTINGS) refusals.push(`the settings file must be ${MANAGED_SETTINGS} (D-173)`);
  refusals.push(...rootOnly("the managed settings", input.settings, io));
  const text = io.readFile(input.settings);
  let parsed: unknown;
  try {
    parsed = text === null ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) refusals.push(`${input.settings} is missing or is not a JSON object`);
  else {
    refusals.push(...hookRefusals(parsed as Record<string, unknown>, input.client));
    const hooks = (parsed as { hooks?: Record<string, unknown> }).hooks ?? {};
    for (const groups of Object.values(hooks)) {
      for (const hook of (Array.isArray(groups) ? groups : []).flatMap((group: { hooks?: unknown }) => (Array.isArray(group.hooks) ? (group.hooks as Record<string, unknown>[]) : []))) {
        const args = Array.isArray(hook["args"]) ? (hook["args"] as unknown[]) : [];
        if (args.includes(input.client) && (hook["command"] !== input.node || args[0] !== input.client || args[1] !== "--socket" || args[2] !== input.socket)) {
          refusals.push(`the managed hook does not run ${input.node} ${input.client} --socket ${input.socket}`);
        }
      }
    }
  }
  const dropIn = join(dirname(input.settings), "managed-settings.d");
  if (io.lstat(dropIn) !== null) {
    const entries = io.readdir(dropIn);
    if (entries === null || entries.length > 0) refusals.push(`${dropIn} holds files JUNO did not write; a drop-in could change or turn off JUNO's hook; empty it (D-173)`);
    refusals.push(...rootOnly("the managed drop-in folder", dropIn, io));
  }

  // 3. What the hook runs: node, the client, and everything beside the client (it imports its sibling).
  refusals.push(...rootOnly("node", input.node, io));
  refusals.push(...rootOnly("the hook client", input.client, io));
  for (const name of io.readdir(dirname(input.client)) ?? []) {
    const facts = io.lstat(join(dirname(input.client), name));
    if (facts !== null && facts.kind !== "symlink" && (facts.uid !== 0 || (facts.mode & 0o022) !== 0)) {
      refusals.push(`the hook client's folder holds ${name}, which must be owned by root and writable by no one else (${describeMode(facts)})`);
    }
  }

  // 4. JUNO's state: the runner's, closed to the agent.
  for (const path of input.state) {
    const facts = io.lstat(path);
    if (facts === null) {
      refusals.push(`JUNO's state ${path} does not exist`);
      continue;
    }
    if (facts.uid !== runner.uid) refusals.push(`JUNO's state ${path} is not owned by the runner's user (${describeMode(facts)})`);
    if (holds(agent, facts, 4) || holds(agent, facts, 2) || holds(agent, facts, 1)) refusals.push(`the Claude Code user holds a permission on JUNO's state ${path} (${describeMode(facts)}); it must hold none (D-173)`);
    if (canReplace(agent, path, io)) refusals.push(`the Claude Code user can replace or remove JUNO's state ${path} through its folder (D-173)`);
  }
  if (input.anchor !== undefined) {
    const facts = io.lstat(input.anchor);
    if (facts === null) refusals.push(`the trust anchor ${input.anchor} does not exist`);
    else if ((agent.uid !== 0 && holds(agent, facts, 2)) || canReplace(agent, input.anchor, io)) refusals.push(`the Claude Code user can change the trust anchor ${input.anchor} (D-116, D-173)`);
  }

  // 5. The socket: the runner's, which the agent can connect to but whose mode and folder it cannot change.
  refusals.push(...socketRefusals("the socket", input.socket, agent, runner, io));

  // 6. The gateway (D-190): Claude Code's exclusive managed MCP file names only JUNO's relay, nothing else can load,
  // and what the relay runs and where it connects are out of the agent's reach.
  if (input.gateway !== undefined) {
    const gateway: GatewayInstall = { name: input.gateway.name, node: input.node, shim: input.gateway.shim, socket: input.gateway.socket };
    refusals.push(...gatewayInputRefusals(gateway));
    const mcpFile = join(dirname(input.settings), MANAGED_MCP_NAME);
    refusals.push(...rootOnly("the managed MCP file", mcpFile, io));
    refusals.push(...managedMcpRefusals(io.readFile(mcpFile), gateway));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) refusals.push(...gatewaySettingsRefusals(parsed as Record<string, unknown>, gateway));
    refusals.push(...rootOnly("the gateway shim", input.gateway.shim, io));
    for (const name of io.readdir(dirname(input.gateway.shim)) ?? []) {
      const facts = io.lstat(join(dirname(input.gateway.shim), name));
      if (facts !== null && facts.kind !== "symlink" && (facts.uid !== 0 || (facts.mode & 0o022) !== 0)) {
        refusals.push(`the gateway shim's folder holds ${name}, which must be owned by root and writable by no one else (${describeMode(facts)})`);
      }
    }
    refusals.push(...socketRefusals("the gateway socket", input.gateway.socket, agent, runner, io));
  }

  // 7. The anchor pin (D-206, D-208): root's own, naming an SSH repository with exactly the pinned host key, the
  // runner's own push key, and journal folders that are among the state judged above.
  if (input.anchorPin !== undefined) refusals.push(...anchorPinRefusals(input.anchorPin, input.state, agent, runner, io));
  return refusals;
}

/**
 * Why the anchor pin is not what the operator's set-up requires (operator ruling D-206 item 2; D-208). The pin and its
 * known-hosts file, and every folder above them, must be owned by root and writable by no one else, so neither the
 * runner nor the Claude Code user can change where the journal is anchored or which server is believed. The pin must
 * name an SSH address (a local path is for JUNO's own tests), the known-hosts file must hold exactly the key with the
 * pinned fingerprint, the push key must be the runner's own private file, and each journal folder must be state this
 * check was given, so that everything above has judged it.
 */
export function anchorPinRefusals(pin: string, state: readonly string[], agent: Account, runner: Account, io: PreflightIo): string[] {
  const refusals = rootOnly("the anchor pin", pin, io);
  const text = io.readFile(pin);
  if (text === null) return [...refusals, `the anchor pin ${pin} cannot be read`];
  let parsed: ReturnType<typeof parseAnchorPin>;
  try {
    parsed = parseAnchorPin(text);
  } catch (error: unknown) {
    return [...refusals, `the anchor pin ${pin} cannot be used: ${error instanceof Error ? error.message : String(error)} (D-208)`];
  }
  if (parsed.transport !== "ssh" || parsed.known_hosts === null || parsed.push_key === null || parsed.host_key_fingerprint === null || parsed.host === null) {
    return [...refusals, `the anchor pin ${pin} names a local path (${parsed.url}); the operator's pin names the anchor repository's SSH address, with its host key (D-208)`];
  }
  refusals.push(...rootOnly("the pinned known-hosts file", parsed.known_hosts, io));
  const known = io.readFile(parsed.known_hosts);
  if (known === null) refusals.push(`the pinned known-hosts file ${parsed.known_hosts} cannot be read`);
  else refusals.push(...knownHostsRefusals(known, parsed.host, parsed.host_key_fingerprint).map((line) => `${line} (${parsed.known_hosts ?? ""}, D-208)`));
  const key = io.lstat(parsed.push_key);
  if (key === null) refusals.push(`the anchor push key ${parsed.push_key} does not exist`);
  else {
    if (key.kind !== "file" || key.uid !== runner.uid || (key.mode & 0o077) !== 0) refusals.push(`the anchor push key ${parsed.push_key} must be the runner's own file, readable by no one else (${describeMode(key)})`);
    if (canReplace(agent, parsed.push_key, io)) refusals.push(`the Claude Code user can replace the anchor push key ${parsed.push_key} through its folder (D-173)`);
  }
  for (const journal of parsed.journals) {
    if (!state.some((path) => journal.path === path || journal.path.startsWith(`${path}/`))) refusals.push(`the anchor pin names the journal folder ${journal.path}, which is not under any --state path this check was given, so its separation was not judged (D-208)`);
  }
  return refusals;
}

const KIND = (stats: Stats): FileFacts["kind"] =>
  stats.isSymbolicLink() ? "symlink" : stats.isDirectory() ? "directory" : stats.isSocket() ? "socket" : stats.isFile() ? "file" : "other";

/** The real file system and account files. */
export function systemPreflightIo(): PreflightIo {
  const read = (path: string): string | null => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };
  return {
    lstat: (path) => {
      try {
        const stats = lstatSync(path);
        return { uid: stats.uid, gid: stats.gid, mode: stats.mode, kind: KIND(stats) };
      } catch {
        return null;
      }
    },
    realpath: (path) => {
      try {
        return realpathSync(path);
      } catch {
        return null;
      }
    },
    readdir: (path) => {
      try {
        return readdirSync(path);
      } catch {
        return null;
      }
    },
    readFile: read,
    passwd: read("/etc/passwd") ?? "",
    group: read("/etc/group") ?? "",
  };
}

const CHECK_USAGE = "usage: juno hook check --agent-user <name> --runner-user <name> --socket <path> --client <juno-hook.js> --node <node> --state <path> [--state <path> ...] --workspace <path> [--workspace <path> ...] [--source <path> ...] [--anchor <file>] [--anchor-pin <file>] [--settings <file>] [--gateway <name> --shim <juno-mcp.js> --gateway-socket <path>]\n";

/** D-208: the anchor pin's place unless the operator names another (the services' default too). */
const ANCHOR_PIN = "/etc/juno/anchors.json";

/**
 * `juno hook check …` (see USAGE in install.ts). Exit 0 when the separation holds and every workspace and source is on
 * a case-sensitive Linux file system with no case-folding folder (D-178), 1 refused, 2 bad usage.
 */
export async function runHookCheckCli(args: readonly string[], out: (text: string) => void, err: (text: string) => void, io: PreflightIo = systemPreflightIo(), fsIo: FilesystemIo = systemFilesystemIo()): Promise<number> {
  const single = ["--agent-user", "--runner-user", "--socket", "--client", "--node", "--settings", "--anchor", "--anchor-pin", "--gateway", "--shim", "--gateway-socket"];
  const repeated = ["--state", "--workspace", "--source"];
  const options = new Map<string, string>();
  const lists = new Map<string, string[]>(repeated.map((name) => [name, []]));
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index] ?? "";
    const value = args[index + 1];
    if (value === undefined || (!repeated.includes(name) && (!single.includes(name) || options.has(name)))) {
      err(CHECK_USAGE);
      return 2;
    }
    if (repeated.includes(name)) lists.get(name)?.push(value);
    else options.set(name, value);
  }
  const need = (name: string): string | undefined => options.get(name);
  const [agentUser, runnerUser, socket, client, node] = ["--agent-user", "--runner-user", "--socket", "--client", "--node"].map(need);
  const state = lists.get("--state") ?? [];
  const workspaces = lists.get("--workspace") ?? [];
  const sources = lists.get("--source") ?? [];
  // D-178: the workspace is required, so the check never passes without judging its file system.
  if (agentUser === undefined || runnerUser === undefined || socket === undefined || client === undefined || node === undefined || state.length === 0 || workspaces.length === 0) {
    err(CHECK_USAGE);
    return 2;
  }
  const anchor = options.get("--anchor");
  // D-190: the gateway is all three or none.
  const [gatewayName, shim, gatewaySocket] = ["--gateway", "--shim", "--gateway-socket"].map(need);
  const gatewayGiven = [gatewayName, shim, gatewaySocket].filter((part) => part !== undefined).length;
  if (gatewayGiven !== 0 && gatewayGiven !== 3) {
    err(CHECK_USAGE);
    return 2;
  }
  const gateway = gatewayName === undefined || shim === undefined || gatewaySocket === undefined ? undefined : { name: gatewayName, shim, socket: gatewaySocket };
  const refusals = hookPreflight({ agentUser, runnerUser, socket, client, node, state, settings: options.get("--settings") ?? MANAGED_SETTINGS, ...(anchor === undefined ? {} : { anchor }), anchorPin: options.get("--anchor-pin") ?? ANCHOR_PIN, ...(gateway === undefined ? {} : { gateway }) }, io);
  refusals.push(...(await caseFoldingRefusals([...workspaces.map((path) => ({ what: "the workspace", path })), ...sources.map((path) => ({ what: "the source", path }))], fsIo)));
  if (refusals.length > 0) {
    err(`juno hook check: refused:\n${refusals.map((line) => `  - ${line}`).join("\n")}\n`);
    return 1;
  }
  out(`juno hook check: the Claude Code user ${agentUser} is separated from the runner ${runnerUser} as D-173 requires, and the workspace is on a case-sensitive Linux file system with no case-folding folder (D-178).${gateway === undefined ? "" : ` JUNO's gateway relay ${gateway.name} is the only MCP server Claude Code can load, and the Claude Code user cannot change it (D-190).`} The anchor repository and its host key are pinned in root's own file (D-208).\n`);
  return 0;
}
