import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { runHookCheckCli } from "./preflight.js";
import { commandText, junoCommand, junoProgramText } from "../../journal/src/index.js";

/**
 * `juno hook install` (spec §4.3 "Fail-closed ingress": a configuration in which a hook failure lets a call proceed is
 * refused at setup; build plan Slice 1.5 Increment 4 item 2; DECISIONS.md D-139, D-143, D-173).
 *
 * It writes JUNO's hook for PreToolUse, PostToolUse and PostToolUseFailure, matcher `*`, in exec form (`command` plus
 * `args`, no shell), with `onFailure: "block"` and an explicit `timeout`, sets `CLAUDE_CODE_DISABLE_FILE_MENTIONS=1`
 * (D-139) and `allowManagedHooksOnly: true` (D-173), into Claude Code's root-owned managed settings file on Linux,
 * `/etc/claude-code/managed-settings.json` (read from the 2.1.319 binary, D-173). It refuses:
 *   - any other settings file: the user's, a project's or a local one (the Claude Code user could rewrite those, D-173);
 *   - to run as anyone but root (only root can write the managed settings, and so only root can change them, D-173);
 *   - Claude Code older than 2.1.299, asked by `execFile(claude, ["--version"])`;
 *   - any configuration the result would hold that lacks exec form, `onFailure: "block"` or a timeout, or that turns
 *     hooks off (`disableAllHooks`).
 * There is no Windows-to-WSL bridge: Claude Code is governed only when it runs inside WSL2, as its own Linux user, and
 * the hook runs as that user (D-173). It says, and does not hide, what it cannot control.
 */

/** Claude Code's managed settings file on Linux (and so in WSL2), as the 2.1.319 binary names it (D-173). */
export const MANAGED_SETTINGS = "/etc/claude-code/managed-settings.json";

export const MINIMUM_CLAUDE_CODE = "2.1.299";
export const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure"] as const;
export const HOOK_TIMEOUT_SECONDS = 30;

export const NOT_CONTROLLED = [
  "a Claude Code session that does not run inside WSL2 as the Claude Code user: a Windows-native session is not governed at all, because JUNO never sees it (D-173)",
  "how Claude Code is started: whoever starts it chooses its environment and flags, so a session started with CLAUDE_CODE_MANAGED_SETTINGS_PATH naming another folder, with --settings '{\"disableAllHooks\": true}' where Claude Code honours that over managed settings, or by another program, is not governed; start governed sessions only from the WSL terminal of STATE.md Part E (D-173)",
  "anything Claude Code does without a tool call: its own memory, and an @-mention Claude does not follow with a file tool",
  "a file or symlink changed between JUNO's check and Claude Code's use of it: Claude Code, not JUNO, performs the effect",
  "a shell function named with a program's absolute path (bash allows `function /usr/bin/cat { ...; }`): JUNO hands Claude Code the command rebuilt with the program's absolute path, so PATH and aliases no longer choose the program, but such a function in the shell's startup files still would; keep those files free of functions (D-150, D-152)",
  "a hook in a user's or a project's settings file, where Claude Code does not honour allowManagedHooksOnly (JUNO sets it, D-173)",
];

/** Claude Code's managed MCP file on Linux (and so in WSL2): while it exists, Claude Code loads only the servers it defines (D-190). */
export const MANAGED_MCP_NAME = "managed-mcp.json";

/**
 * JUNO's gateway relay as Claude Code's one managed MCP server (D-190): `<node> <shim> --socket <socket>`, the stdio shim
 * that only relays to the runner's gateway service (D-188). The name is letters, digits and hyphens only, so
 * `mcp__<name>__` cannot be read as another server's prefix.
 */
export type GatewayInstall = { readonly name: string; readonly node: string; readonly shim: string; readonly socket: string };

export const GATEWAY_NAME = /^[A-Za-z0-9-]{1,64}$/;

/** Every remote server, and the built-in servers by name: kept out by the denylist, which nothing overrides (D-190). */
export const GATEWAY_DENIED: readonly Record<string, string>[] = [{ serverUrl: "*" }, { serverUrl: "*://*:*/*" }, { serverName: "ide" }, { serverName: "claude-in-chrome" }];

/** Managed-settings keys that would let another server load beside the gateway; refused (D-190). */
export const REFUSED_MCP_KEYS = ["managedMcpServers", "allowAllClaudeAiMcps", "allowClaudeInChromeWithManagedMcp", "managedSourcesBehavior"] as const;

/** The one server entry of the managed MCP file. */
export function gatewayServerEntry(gateway: GatewayInstall): Record<string, unknown> {
  return { type: "stdio", command: gateway.node, args: [gateway.shim, "--socket", gateway.socket] };
}

/** Why a gateway configuration cannot be installed (empty: it can). */
export function gatewayInputRefusals(gateway: GatewayInstall): string[] {
  const refusals: string[] = [];
  if (!GATEWAY_NAME.test(gateway.name)) refusals.push(`the gateway's server name ${JSON.stringify(gateway.name)} must be letters, digits and hyphens only (D-190)`);
  for (const [what, path] of [["node", gateway.node], ["the gateway shim", gateway.shim], ["the gateway socket", gateway.socket]] as const) {
    if (!path.startsWith("/") || path.includes("${")) refusals.push(`${what} must be an absolute path with no \${...} expansion (D-190)`);
  }
  return refusals;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Why the managed MCP file does not make JUNO's relay the only server Claude Code loads (empty: it does). `text` is the
 * file's content, or null when it is missing. The file must hold exactly `{ "mcpServers": { <name>: <entry> } }`.
 */
export function managedMcpRefusals(text: string | null, gateway: GatewayInstall): string[] {
  if (text === null) return [`${MANAGED_MCP_NAME} is missing, so Claude Code's exclusive control of MCP servers is not in force (D-190)`];
  if (text.includes("${")) return [`${MANAGED_MCP_NAME} holds a \${...} expansion, which the Claude Code user's environment would decide (D-190)`];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [`${MANAGED_MCP_NAME} is not JSON`];
  }
  const record = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  const servers = record !== null && typeof record["mcpServers"] === "object" && record["mcpServers"] !== null && !Array.isArray(record["mcpServers"]) ? (record["mcpServers"] as Record<string, unknown>) : null;
  if (record === null || servers === null || Object.keys(record).length !== 1) return [`${MANAGED_MCP_NAME} must hold only "mcpServers" (D-190)`];
  const names = Object.keys(servers);
  if (names.length !== 1 || names[0] !== gateway.name) return [`${MANAGED_MCP_NAME} must define exactly one server, ${gateway.name}; it defines ${JSON.stringify(names)} (D-190)`];
  const entry = servers[gateway.name];
  const expected = gatewayServerEntry(gateway);
  const keys = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? Object.keys(entry).sort() : [];
  if (!sameJson(keys, Object.keys(expected).sort()) || !sameJson(Object.keys(expected).map((key) => (entry as Record<string, unknown>)[key]), Object.values(expected))) {
    return [`${MANAGED_MCP_NAME}'s ${gateway.name} must run exactly ${gateway.node} ${gateway.shim} --socket ${gateway.socket}, with nothing else in its entry (D-190)`];
  }
  return [];
}

/** Why the managed settings could let another MCP server load beside the gateway (empty: they cannot). */
export function gatewaySettingsRefusals(settings: Record<string, unknown>, gateway: GatewayInstall): string[] {
  const refusals: string[] = [];
  for (const key of REFUSED_MCP_KEYS) if (key in settings) refusals.push(`the managed settings set ${key}, which could let another MCP server load beside JUNO's gateway (D-190)`);
  if (settings["allowManagedMcpServersOnly"] !== true) refusals.push("allowManagedMcpServersOnly is not true: a user's own allowlist could widen which MCP servers load (D-190)");
  const allowed = settings["allowedMcpServers"];
  if (!sameJson(allowed, [{ serverCommand: [gateway.node, gateway.shim, "--socket", gateway.socket] }])) refusals.push(`allowedMcpServers must be exactly the gateway relay's command, so no other server matches it (D-190)`);
  const denied = Array.isArray(settings["deniedMcpServers"]) ? (settings["deniedMcpServers"] as unknown[]) : [];
  for (const entry of GATEWAY_DENIED) if (!denied.some((have) => sameJson(have, entry))) refusals.push(`deniedMcpServers lacks ${JSON.stringify(entry)}, so a remote or built-in server could load (D-190)`);
  return refusals;
}

/** The managed settings with the gateway's MCP keys added (D-190); entries already in the denylist are kept. */
function withGatewaySettings(settings: Record<string, unknown>, gateway: GatewayInstall): Record<string, unknown> {
  const denied = Array.isArray(settings["deniedMcpServers"]) ? [...(settings["deniedMcpServers"] as unknown[])] : [];
  for (const entry of GATEWAY_DENIED) if (!denied.some((have) => sameJson(have, entry))) denied.push(entry);
  return { ...settings, allowManagedMcpServersOnly: true, allowedMcpServers: [{ serverCommand: [gateway.node, gateway.shim, "--socket", gateway.socket] }], deniedMcpServers: denied };
}

/** What the gateway install cannot control (D-190), added to NOT_CONTROLLED when a gateway is installed. */
export const GATEWAY_NOT_CONTROLLED = [
  "an in-process MCP server (type \"sdk\") that an app or the Agent SDK registers when it starts Claude Code: Claude Code applies no list to it; its calls arrive with source \"sdk\", so JUNO's hook denies them, and a governed session is started from the WSL terminal, where no app registers one (D-190)",
  "what an MCP tool's description says: the gateway passes descriptions unchanged, and the model reads them (mode B)",
];

export type HookCommand = { readonly command: string; readonly args: readonly string[] };

/** The hook entry JUNO installs for one event. */
export function hookEntry(hook: HookCommand): Record<string, unknown> {
  return { matcher: "*", hooks: [{ type: "command", command: hook.command, args: [...hook.args], onFailure: "block", timeout: HOOK_TIMEOUT_SECONDS }] };
}

/** Whether `version` (as `claude --version` prints it, e.g. "2.1.318 (Claude Code)") is at least the minimum. */
export function versionAtLeast(version: string, minimum: string = MINIMUM_CLAUDE_CODE): boolean {
  const parse = (text: string): number[] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
    return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const have = parse(version);
  const need = parse(minimum);
  if (have === null || need === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if ((have[index] ?? 0) !== (need[index] ?? 0)) return (have[index] ?? 0) > (need[index] ?? 0);
  }
  return true;
}

/** Why a settings object does not hold JUNO's fail-closed hook (empty: it does). `client` is the args element naming JUNO's client. */
export function hookRefusals(settings: Record<string, unknown>, client: string): string[] {
  const refusals: string[] = [];
  if (settings["disableAllHooks"] === true) refusals.push("disableAllHooks is true: no hook would run");
  if (settings["allowManagedHooksOnly"] !== true) refusals.push("allowManagedHooksOnly is not true: a hook in a user's or a project's settings could change a call after JUNO judged it (D-173)");
  const env = settings["env"];
  if (typeof env !== "object" || env === null || (env as Record<string, unknown>)["CLAUDE_CODE_DISABLE_FILE_MENTIONS"] !== "1") {
    refusals.push("CLAUDE_CODE_DISABLE_FILE_MENTIONS is not 1: @-mentioned files would reach the model with no tool call (D-139)");
  }
  const hooks = typeof settings["hooks"] === "object" && settings["hooks"] !== null ? (settings["hooks"] as Record<string, unknown>) : {};
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const ours = groups.flatMap((group) => {
      const record = typeof group === "object" && group !== null ? (group as Record<string, unknown>) : {};
      const list = Array.isArray(record["hooks"]) ? (record["hooks"] as unknown[]) : [];
      return list
        .filter((hook): hook is Record<string, unknown> => typeof hook === "object" && hook !== null)
        .filter((hook) => (Array.isArray(hook["args"]) && (hook["args"] as unknown[]).includes(client)) || (typeof hook["command"] === "string" && hook["command"].includes(client)))
        .map((hook) => ({ hook, matcher: record["matcher"] }));
    });
    if (ours.length === 0) refusals.push(`${event}: JUNO's hook is not installed`);
    for (const { hook, matcher } of ours) {
      if (matcher !== "*") refusals.push(`${event}: JUNO's hook must match every tool ("*")`);
      if (!Array.isArray(hook["args"])) refusals.push(`${event}: JUNO's hook is in shell form; it must be exec form (command plus args, no shell)`);
      if (hook["onFailure"] !== "block") refusals.push(`${event}: JUNO's hook lacks onFailure "block", so its failure would let the call proceed (§4.3)`);
      if (typeof hook["timeout"] !== "number" || hook["timeout"] <= 0) refusals.push(`${event}: JUNO's hook has no explicit timeout`);
    }
  }
  return refusals;
}

/** Only the managed settings file; never the user's, a project's or a local one (D-143, narrowed by D-173). */
export function settingsFileRefusal(file: string, managed: string = MANAGED_SETTINGS): string | null {
  if (resolve(file) === managed) return null;
  return `${file} is not Claude Code's managed settings file (${managed}); the user's, project and local settings are refused, because the Claude Code user could change them (D-173)`;
}

export type InstallIo = {
  readonly claudeVersion: () => Promise<string>;
  readonly readSettings: (file: string) => string | null;
  readonly writeSettings: (file: string, text: string) => void;
  /** The managed settings file this install may write: MANAGED_SETTINGS, except in tests. */
  readonly managedSettings: string;
  /** The effective uid the install runs as: it refuses anything but root (D-173). */
  readonly uid: number;
};

export const SYSTEM_INSTALL_IO = (claude: string): InstallIo => ({
  claudeVersion: () =>
    new Promise((resolveVersion, reject) => {
      execFile(claude, ["--version"], { timeout: 30_000 }, (error, stdout) => (error === null ? resolveVersion(stdout) : reject(error)));
    }),
  readSettings: (file) => (existsSync(file) ? readFileSync(file, "utf8") : null),
  // Root writes it, so root owns it; readable by everyone (the Claude Code user must read it), writable by no one else.
  writeSettings: (file, text) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
    const temporary = join(dirname(file), `.${basename(file)}.juno-${String(process.pid)}`);
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o644 });
    chmodSync(temporary, 0o644);
    renameSync(temporary, file);
  },
  managedSettings: MANAGED_SETTINGS,
  uid: typeof process.geteuid === "function" ? process.geteuid() : -1,
});

export type InstallResult = { readonly installed: true; readonly settings: Record<string, unknown>; readonly not_controlled: readonly string[] } | { readonly installed: false; readonly refusals: readonly string[] };

/**
 * Installs JUNO's hook into `file`, or refuses and changes nothing. With `gateway`, it also makes JUNO's relay the only
 * MCP server Claude Code loads: the managed MCP file beside `file`, and the MCP keys of D-190 in the managed settings.
 */
export async function installHook(file: string, hook: HookCommand, client: string, io: InstallIo, gateway?: GatewayInstall): Promise<InstallResult> {
  const refusals: string[] = [];
  const where = settingsFileRefusal(file, io.managedSettings);
  if (where !== null) refusals.push(where);
  if (io.uid !== 0) refusals.push("juno hook install must run as root: only root may write the managed settings, so that the Claude Code user cannot change them (D-173)");
  let version = "";
  try {
    version = await io.claudeVersion();
  } catch (error: unknown) {
    refusals.push(`claude --version did not run: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (version !== "" && !versionAtLeast(version)) refusals.push(`Claude Code ${version.trim()} is older than ${MINIMUM_CLAUDE_CODE}, which onFailure "block" and the file-mentions setting need (D-139)`);
  if (hook.args.length === 0 || !hook.args.includes(client)) refusals.push("the hook command must name JUNO's client in its args");
  const socket = hook.args[hook.args.indexOf("--socket") + 1];
  if (!hook.args.includes("--socket") || socket === undefined || !socket.startsWith("/")) refusals.push("--socket must be an absolute Unix socket path (D-148)");
  let settings: Record<string, unknown> = {};
  const existing = io.readSettings(file);
  if (existing !== null) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      settings = parsed as Record<string, unknown>;
    } catch {
      refusals.push(`${file} is not a JSON object; it is left unchanged`);
    }
  }
  // Restrictive (D-148): another PreToolUse hook in the same file could change a call (updatedInput) after JUNO judged it.
  const existingHooks = typeof settings["hooks"] === "object" && settings["hooks"] !== null ? (settings["hooks"] as Record<string, unknown>) : {};
  const otherPre = (Array.isArray(existingHooks["PreToolUse"]) ? (existingHooks["PreToolUse"] as unknown[]) : []).filter((group) => !JSON.stringify(group).includes(JSON.stringify(client)));
  if (otherPre.length > 0) refusals.push(`${file} already has another PreToolUse hook, which could change a call after JUNO judged it; remove it first (D-148)`);
  const mcpFile = join(dirname(file), MANAGED_MCP_NAME);
  if (gateway !== undefined) {
    refusals.push(...gatewayInputRefusals(gateway));
    for (const key of REFUSED_MCP_KEYS) if (key in settings) refusals.push(`${file} sets ${key}, which could let another MCP server load beside JUNO's gateway; remove it first (D-190)`);
    // Never silently drop the operator's servers: an existing managed MCP file must already be exactly JUNO's.
    const existingMcp = io.readSettings(mcpFile);
    if (existingMcp !== null && gatewayInputRefusals(gateway).length === 0 && managedMcpRefusals(existingMcp, gateway).length > 0) refusals.push(`${mcpFile} already defines MCP servers other than JUNO's gateway; remove them first (D-190)`);
  }
  if (refusals.length > 0) return { installed: false, refusals };
  const hooks = { ...(typeof settings["hooks"] === "object" && settings["hooks"] !== null ? (settings["hooks"] as Record<string, unknown>) : {}) };
  for (const event of HOOK_EVENTS) {
    const others = (Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []).filter((group) => !JSON.stringify(group).includes(JSON.stringify(client)));
    hooks[event] = [...others, hookEntry(hook)];
  }
  const env = { ...(typeof settings["env"] === "object" && settings["env"] !== null ? (settings["env"] as Record<string, unknown>) : {}), CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1" };
  const hooked = { ...settings, hooks, env, allowManagedHooksOnly: true };
  const result = gateway === undefined ? hooked : withGatewaySettings(hooked, gateway);
  const check = [...hookRefusals(result, client), ...(gateway === undefined ? [] : gatewaySettingsRefusals(result, gateway))];
  if (check.length > 0) return { installed: false, refusals: check };
  // The exclusive MCP file first: should the settings write then fail, Claude Code loads only the relay, and the hook
  // service still passes nothing until `juno hook check --gateway` holds (fail-closed).
  if (gateway !== undefined) io.writeSettings(mcpFile, `${JSON.stringify({ mcpServers: { [gateway.name]: gatewayServerEntry(gateway) } }, null, 2)}\n`);
  io.writeSettings(file, `${JSON.stringify(result, null, 2)}\n`);
  return { installed: true, settings: result, not_controlled: gateway === undefined ? NOT_CONTROLLED : [...NOT_CONTROLLED, ...GATEWAY_NOT_CONTROLLED] };
}

const USAGE = `usage: ${junoProgramText()} hook install --socket <path> --client <juno-hook.js> [--node <node>] [--claude <claude>] [--settings /etc/claude-code/managed-settings.json] [--gateway <name> --shim <juno-mcp.js> --gateway-socket <path>]\n       ${junoProgramText()} hook check --agent-user <name> --runner-user <name> --socket <path> --client <juno-hook.js> --node <node> --state <path> [--state <path> ...] --workspace <path> [--workspace <path> ...] [--source <path> ...] [--anchor <file>] [--anchor-pin <file>] [--settings <file>] [--gateway <name> --shim <juno-mcp.js> --gateway-socket <path>]\n`;

/**
 * `juno hook install --socket <path> --client <juno-hook.js> [--node <node>] [--claude <claude>] [--settings <file>]`
 * (D-143, D-173): as root, into the managed settings file; the hook runs `<node> <client> --socket <path>` as the
 * Claude Code user, inside WSL2. `juno hook check` is preflight.ts. Exit 0 installed or checked, 1 refused, 2 bad usage.
 */
export async function runHookInstallCli(args: readonly string[], out: (text: string) => void, err: (text: string) => void, ioFor: (claude: string) => InstallIo = SYSTEM_INSTALL_IO): Promise<number> {
  const [command, ...rest] = args;
  if (command === "check") return runHookCheckCli(rest, out, err);
  const names = ["--settings", "--socket", "--client", "--node", "--claude", "--gateway", "--shim", "--gateway-socket"];
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index] ?? "";
    const value = rest[index + 1];
    if (!names.includes(name) || value === undefined || options.has(name)) {
      err(USAGE);
      return 2;
    }
    options.set(name, value);
  }
  const socket = options.get("--socket");
  const client = options.get("--client");
  if (command !== "install" || socket === undefined || client === undefined) {
    err(USAGE);
    return 2;
  }
  const io = ioFor(options.get("--claude") ?? "claude");
  const settings = options.get("--settings") ?? io.managedSettings;
  const node = options.get("--node") ?? process.execPath;
  const hook: HookCommand = { command: node, args: [client, "--socket", socket] };
  const gatewayParts = ["--gateway", "--shim", "--gateway-socket"].map((name) => options.get(name));
  // All three or none: a gateway named without its relay, or a relay without its name, is bad usage.
  if (gatewayParts.some((part) => part !== undefined) && gatewayParts.some((part) => part === undefined)) {
    err(USAGE);
    return 2;
  }
  const [name, shim, gatewaySocket] = gatewayParts;
  const gateway = name === undefined || shim === undefined || gatewaySocket === undefined ? undefined : { name, node, shim, socket: gatewaySocket };
  const result = await installHook(settings, hook, client, io, gateway);
  if (!result.installed) {
    err(`juno hook install: refused:\n${result.refusals.map((line) => `  - ${line}`).join("\n")}\n`);
    return 1;
  }
  out(`JUNO's hook is installed in ${settings}.${gateway === undefined ? "" : `\nJUNO's gateway relay ${gateway.name} is the only MCP server Claude Code loads (${join(dirname(settings), MANAGED_MCP_NAME)}).`}\nNext: JUNO's hook check, as root, before the first governed session: ${commandText(["sudo", ...junoCommand(["hook", "check"])])} with the arguments of the guide's Part E step 12.\nWhat it cannot control:\n${result.not_controlled.map((line) => `  - ${line}`).join("\n")}\n`);
  return 0;
}
