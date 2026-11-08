import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOOK_EVENTS, type InstallIo, MANAGED_SETTINGS, MINIMUM_CLAUDE_CODE, hookEntry, hookRefusals, installHook, runHookInstallCli, versionAtLeast } from "../src/install.js";

// §4.3 "refused at setup" (build plan Increment 4 item 2; D-139, D-143): JUNO's hook is installed only in exec form,
// with onFailure "block", an explicit timeout, matcher "*" on every hook event it needs, the file-mentions setting, on a
// Claude Code new enough, in Claude Code's root-owned managed settings file only (D-173: the user's settings are refused).

const HOME = "/home/operator";
const USER_SETTINGS = join(HOME, ".claude", "settings.json");
const MANAGED = MANAGED_SETTINGS;
const CLIENT = "/opt/juno/dist/mediated/src/juno-hook.js";
const HOOK = { command: "/usr/bin/node", args: [CLIENT, "--socket", "/run/juno/hook.sock"] };

function io(version: string, existing: string | null = null, uid = 0): InstallIo & { written: Map<string, string> } {
  const written = new Map<string, string>();
  return { claudeVersion: () => Promise.resolve(`${version} (Claude Code)\n`), readSettings: () => existing, writeSettings: (file, text) => written.set(file, text), managedSettings: MANAGED, uid, written };
}

describe("juno hook install (§4.3 refused at setup)", () => {
  // proves §4.3: the installed hook is exec form, fail-closed, timed, on every event, with file mentions routed through tools
  it("installs exec form with onFailure block and a timeout on all three events, and the file-mentions setting", async () => {
    const target = io("2.1.318", JSON.stringify({ model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "/bin/true" }] }] } }));
    const result = await installHook(MANAGED, HOOK, CLIENT, target);
    expect(result).toMatchObject({ installed: true });
    const written = JSON.parse(target.written.get(MANAGED) ?? "{}") as Record<string, Record<string, unknown>>;
    for (const event of HOOK_EVENTS) expect(written["hooks"]?.[event]).toEqual([hookEntry(HOOK)]);
    expect(written["env"]).toEqual({ CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1" });
    expect(written["model"]).toBe("x");
    // D-173: a hook in a user's or a project's settings does not run beside JUNO's.
    expect(written["allowManagedHooksOnly"]).toBe(true);
    expect(written["hooks"]?.["Stop"]).toBeDefined();
    expect(hookRefusals(written, CLIENT)).toEqual([]);
    if (result.installed) expect(result.not_controlled.join(" ")).toMatch(/Windows-native session is not governed/);
  });

  // proves §4.3: a Claude Code older than the minimum (2.1.299 since D-139) is refused, and nothing is written
  it("refuses a Claude Code older than the minimum", async () => {
    const target = io("2.1.298");
    expect(await installHook(MANAGED, HOOK, CLIENT, target)).toMatchObject({ installed: false, refusals: [expect.stringContaining(MINIMUM_CLAUDE_CODE)] });
    expect(target.written.size).toBe(0);
    expect(versionAtLeast("2.1.299")).toBe(true);
    expect(versionAtLeast("2.2.0")).toBe(true);
    expect(versionAtLeast("2.1.295")).toBe(false);
    expect(versionAtLeast("not a version")).toBe(false);
  });

  // proves D-143, narrowed by D-173: a project, local or user settings file is refused; only the managed file is written
  it.each(["/repo/.claude/settings.json", "/repo/.claude/settings.local.json", join(HOME, ".claude", "settings.local.json"), USER_SETTINGS, "/tmp/managed-settings.json", "/etc/claude-code/managed-settings.d/juno.json"])("refuses the settings file %s", async (file) => {
    const target = io("2.1.318");
    expect(await installHook(file, HOOK, CLIENT, target)).toMatchObject({ installed: false });
    expect(target.written.size).toBe(0);
  });

  // proves §4.3: a configuration without onFailure block, in shell form, without a timeout, or with hooks disabled is refused
  it("refuses configurations in which a hook failure lets a call proceed", () => {
    const good = { hooks: Object.fromEntries(HOOK_EVENTS.map((event) => [event, [hookEntry(HOOK)]])), env: { CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1" }, allowManagedHooksOnly: true };
    expect(hookRefusals(good, CLIENT)).toEqual([]);
    const variant = (change: (hook: Record<string, unknown>) => void): Record<string, unknown> => {
      const copy = JSON.parse(JSON.stringify(good)) as { hooks: Record<string, { hooks: Record<string, unknown>[] }[]> };
      for (const event of HOOK_EVENTS) for (const group of copy.hooks[event] ?? []) for (const hook of group.hooks) change(hook);
      return copy;
    };
    expect(hookRefusals(variant((hook) => delete hook["onFailure"]), CLIENT).join(" ")).toMatch(/onFailure "block"/);
    expect(hookRefusals(variant((hook) => (hook["onFailure"] = "continue")), CLIENT).join(" ")).toMatch(/onFailure "block"/);
    expect(hookRefusals(variant((hook) => { delete hook["args"]; hook["command"] = `/usr/bin/node ${CLIENT}`; }), CLIENT).join(" ")).toMatch(/shell form/);
    expect(hookRefusals(variant((hook) => delete hook["timeout"]), CLIENT).join(" ")).toMatch(/timeout/);
    expect(hookRefusals({ ...good, disableAllHooks: true }, CLIENT).join(" ")).toMatch(/disableAllHooks/);
    expect(hookRefusals({ ...good, env: {} }, CLIENT).join(" ")).toMatch(/CLAUDE_CODE_DISABLE_FILE_MENTIONS/);
    expect(hookRefusals({ env: good.env, allowManagedHooksOnly: true }, CLIENT)).toHaveLength(HOOK_EVENTS.length);
    expect(hookRefusals({ ...good, allowManagedHooksOnly: false }, CLIENT).join(" ")).toMatch(/allowManagedHooksOnly/);
  });

  // proves D-148: the socket must be an absolute path (a bare number would be a TCP port), and no other PreToolUse hook may share the file
  it("refuses a relative socket, and another PreToolUse hook in the same file", async () => {
    expect(await installHook(MANAGED, { command: "/usr/bin/node", args: [CLIENT, "--socket", "8080"] }, CLIENT, io("2.1.318"))).toMatchObject({ installed: false, refusals: [expect.stringContaining("absolute")] });
    const other = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "/usr/local/bin/rewrite", args: [] }] }] } });
    expect(await installHook(MANAGED, HOOK, CLIENT, io("2.1.318", other))).toMatchObject({ installed: false, refusals: [expect.stringContaining("another PreToolUse hook")] });
  });

  // proves D-173: only root may write the managed settings, so the install refuses to run as anyone else
  it("refuses to run as anyone but root", async () => {
    const target = io("2.1.318", null, 1001);
    expect(await installHook(MANAGED, HOOK, CLIENT, target)).toMatchObject({ installed: false, refusals: [expect.stringContaining("must run as root")] });
    expect(target.written.size).toBe(0);
  });

  // proves D-173: the Windows-to-WSL bridge is gone; the hook runs node and the client directly, as the Claude Code user
  it("writes no wsl.exe bridge and refuses the old bridge options", async () => {
    const target = io("2.1.318");
    const out: string[] = [];
    const err: string[] = [];
    expect(await runHookInstallCli(["install", "--socket", "/var/lib/juno-hook/hook.sock", "--client", CLIENT, "--node", "/usr/bin/node"], (text) => out.push(text), (text) => err.push(text), () => target)).toBe(0);
    const written = target.written.get(MANAGED) ?? "";
    expect(written).not.toMatch(/wsl/i);
    expect(JSON.parse(written)).toMatchObject({ hooks: { PreToolUse: [hookEntry({ command: "/usr/bin/node", args: [CLIENT, "--socket", "/var/lib/juno-hook/hook.sock"] })] } });
    expect(await runHookInstallCli(["install", "--socket", "/s", "--client", CLIENT, "--wsl-distro", "Ubuntu-24.04", "--wsl-user", "juno-runner"], () => undefined, (text) => err.push(text), () => io("2.1.318"))).toBe(2);
  });
});
