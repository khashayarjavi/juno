import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * `juno hook install` (spec §4.3 "Fail-closed ingress": a configuration in which a hook failure lets a call proceed is
 * refused at setup; build plan Slice 1.5 Increment 4 item 2; DECISIONS.md D-139, D-143).
 *
 * It writes JUNO's hook for PreToolUse, PostToolUse and PostToolUseFailure, matcher `*`, in exec form (`command` plus
 * `args`, no shell), with `onFailure: "block"` and an explicit `timeout`, and sets `CLAUDE_CODE_DISABLE_FILE_MENTIONS=1`
 * (D-139), into the user's (or a managed) settings file. It refuses:
 *   - a project or local settings file (Claude Code ignores the file-mentions variable there, and a project can change it);
 *   - Claude Code older than 2.1.299, asked by `execFile(claude, ["--version"])`;
 *   - any configuration the result would hold that lacks exec form, `onFailure: "block"` or a timeout, or that turns
 *     hooks off (`disableAllHooks`).
 * It says, and does not hide, what it cannot control.
 */

export const MINIMUM_CLAUDE_CODE = "2.1.299";
export const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure"] as const;
export const HOOK_TIMEOUT_SECONDS = 30;

export const NOT_CONTROLLED = [
  "a run started with --settings '{\"disableAllHooks\": true}', or settings with higher precedence that turn hooks off",
  "anything Claude Code does without a tool call: its own memory, and an @-mention Claude does not follow with a file tool",
  "a file or symlink changed between JUNO's check and Claude Code's use of it: Claude Code, not JUNO, performs the effect",
  "managed settings that allow only managed hooks, if JUNO's hook is not among them",
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

/** A user or managed settings file; never a project's or a local one (D-143). */
export function settingsFileRefusal(file: string, home: string = homedir()): string | null {
  const absolute = resolve(file);
  if (basename(absolute) === "managed-settings.json") return null;
  if (absolute === join(home, ".claude", "settings.json")) return null;
  return `${file} is not the user's settings file (${join(home, ".claude", "settings.json")}) or a managed-settings.json; project and local settings are refused (D-143)`;
}

export type InstallIo = {
  readonly claudeVersion: () => Promise<string>;
  readonly readSettings: (file: string) => string | null;
  readonly writeSettings: (file: string, text: string) => void;
  readonly home: string;
};

export const SYSTEM_INSTALL_IO = (claude: string): InstallIo => ({
  claudeVersion: () =>
    new Promise((resolveVersion, reject) => {
      execFile(claude, ["--version"], { timeout: 30_000 }, (error, stdout) => (error === null ? resolveVersion(stdout) : reject(error)));
    }),
  readSettings: (file) => (existsSync(file) ? readFileSync(file, "utf8") : null),
  writeSettings: (file, text) => {
    const temporary = join(dirname(file), `.${basename(file)}.juno-${String(process.pid)}`);
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  },
  home: homedir(),
});

export type InstallResult = { readonly installed: true; readonly settings: Record<string, unknown>; readonly not_controlled: readonly string[] } | { readonly installed: false; readonly refusals: readonly string[] };

/** Installs JUNO's hook into `file`, or refuses and changes nothing. */
export async function installHook(file: string, hook: HookCommand, client: string, io: InstallIo): Promise<InstallResult> {
  const refusals: string[] = [];
  const where = settingsFileRefusal(file, io.home);
  if (where !== null) refusals.push(where);
  let version = "";
  try {
    version = await io.claudeVersion();
  } catch (error: unknown) {
    refusals.push(`claude --version did not run: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (version !== "" && !versionAtLeast(version)) refusals.push(`Claude Code ${version.trim()} is older than ${MINIMUM_CLAUDE_CODE}, which onFailure "block" and the file-mentions setting need (D-139)`);
  if (hook.args.length === 0 || !hook.args.includes(client)) refusals.push("the hook command must name JUNO's client in its args");
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
  if (refusals.length > 0) return { installed: false, refusals };
  const hooks = { ...(typeof settings["hooks"] === "object" && settings["hooks"] !== null ? (settings["hooks"] as Record<string, unknown>) : {}) };
  for (const event of HOOK_EVENTS) {
    const others = (Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []).filter((group) => !JSON.stringify(group).includes(JSON.stringify(client)));
    hooks[event] = [...others, hookEntry(hook)];
  }
  const env = { ...(typeof settings["env"] === "object" && settings["env"] !== null ? (settings["env"] as Record<string, unknown>) : {}), CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1" };
  const result = { ...settings, hooks, env };
  const check = hookRefusals(result, client);
  if (check.length > 0) return { installed: false, refusals: check };
  io.writeSettings(file, `${JSON.stringify(result, null, 2)}\n`);
  return { installed: true, settings: result, not_controlled: NOT_CONTROLLED };
}

/**
 * `juno hook install --settings <file> --socket <path> --client <juno-hook.js> [--node <node>] [--claude <claude>]
 *  [--wsl-distro <name> --wsl-user <user>]` (D-143). With `--wsl-distro`, the hook runs from Windows into WSL2 as
 * `wsl.exe -d <distro> --user <user> --exec <node> <client> --socket <path>` (D-130, D-131). Exit 0 installed, 1 refused, 2 bad usage.
 */
export async function runHookInstallCli(args: readonly string[], out: (text: string) => void, err: (text: string) => void, ioFor: (claude: string) => InstallIo = SYSTEM_INSTALL_IO): Promise<number> {
  const [command, ...rest] = args;
  const names = ["--settings", "--socket", "--client", "--node", "--claude", "--wsl-distro", "--wsl-user"];
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index] ?? "";
    const value = rest[index + 1];
    if (!names.includes(name) || value === undefined || options.has(name)) {
      err("usage: juno hook install --settings <file> --socket <path> --client <juno-hook.js> [--node <node>] [--claude <claude>] [--wsl-distro <name> --wsl-user <user>]\n");
      return 2;
    }
    options.set(name, value);
  }
  const settings = options.get("--settings");
  const socket = options.get("--socket");
  const client = options.get("--client");
  const distro = options.get("--wsl-distro");
  const user = options.get("--wsl-user");
  if (command !== "install" || settings === undefined || socket === undefined || client === undefined || (distro === undefined) !== (user === undefined)) {
    err("usage: juno hook install --settings <file> --socket <path> --client <juno-hook.js> [--node <node>] [--claude <claude>] [--wsl-distro <name> --wsl-user <user>]\n");
    return 2;
  }
  const node = options.get("--node") ?? process.execPath;
  const hook: HookCommand =
    distro !== undefined && user !== undefined
      ? { command: "wsl.exe", args: ["-d", distro, "--user", user, "--exec", node, client, "--socket", socket] }
      : { command: node, args: [client, "--socket", socket] };
  const result = await installHook(settings, hook, client, ioFor(options.get("--claude") ?? "claude"));
  if (!result.installed) {
    err(`juno hook install: refused:\n${result.refusals.map((line) => `  - ${line}`).join("\n")}\n`);
    return 1;
  }
  out(`JUNO's hook is installed in ${settings}.\nWhat it cannot control:\n${result.not_controlled.map((line) => `  - ${line}`).join("\n")}\n`);
  return 0;
}
