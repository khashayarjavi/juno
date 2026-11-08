import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { runHookCheckCli } from "./preflight.js";

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

/** Installs JUNO's hook into `file`, or refuses and changes nothing. */
export async function installHook(file: string, hook: HookCommand, client: string, io: InstallIo): Promise<InstallResult> {
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
  if (refusals.length > 0) return { installed: false, refusals };
  const hooks = { ...(typeof settings["hooks"] === "object" && settings["hooks"] !== null ? (settings["hooks"] as Record<string, unknown>) : {}) };
  for (const event of HOOK_EVENTS) {
    const others = (Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []).filter((group) => !JSON.stringify(group).includes(JSON.stringify(client)));
    hooks[event] = [...others, hookEntry(hook)];
  }
  const env = { ...(typeof settings["env"] === "object" && settings["env"] !== null ? (settings["env"] as Record<string, unknown>) : {}), CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1" };
  const result = { ...settings, hooks, env, allowManagedHooksOnly: true };
  const check = hookRefusals(result, client);
  if (check.length > 0) return { installed: false, refusals: check };
  io.writeSettings(file, `${JSON.stringify(result, null, 2)}\n`);
  return { installed: true, settings: result, not_controlled: NOT_CONTROLLED };
}

const USAGE = "usage: juno hook install --socket <path> --client <juno-hook.js> [--node <node>] [--claude <claude>] [--settings /etc/claude-code/managed-settings.json]\n       juno hook check --agent-user <name> --runner-user <name> --socket <path> --client <juno-hook.js> --node <node> --state <path> [--state <path> ...] [--anchor <file>] [--settings <file>]\n";

/**
 * `juno hook install --socket <path> --client <juno-hook.js> [--node <node>] [--claude <claude>] [--settings <file>]`
 * (D-143, D-173): as root, into the managed settings file; the hook runs `<node> <client> --socket <path>` as the
 * Claude Code user, inside WSL2. `juno hook check` is preflight.ts. Exit 0 installed or checked, 1 refused, 2 bad usage.
 */
export async function runHookInstallCli(args: readonly string[], out: (text: string) => void, err: (text: string) => void, ioFor: (claude: string) => InstallIo = SYSTEM_INSTALL_IO): Promise<number> {
  const [command, ...rest] = args;
  if (command === "check") return runHookCheckCli(rest, out, err);
  const names = ["--settings", "--socket", "--client", "--node", "--claude"];
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
  const result = await installHook(settings, hook, client, io);
  if (!result.installed) {
    err(`juno hook install: refused:\n${result.refusals.map((line) => `  - ${line}`).join("\n")}\n`);
    return 1;
  }
  out(`JUNO's hook is installed in ${settings}.\nNext: juno hook check, as root, before the first governed session.\nWhat it cannot control:\n${result.not_controlled.map((line) => `  - ${line}`).join("\n")}\n`);
  return 0;
}
