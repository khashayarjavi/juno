import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commandText, noJunoProcessCommand, serviceCommand } from "../../packages/journal/src/index.js";

// Operator ruling D-247 item 1: every refusal or remedy that names a file, folder or command (the journal's lock, its
// take-over file, a socket, the journal, a checkpoint store, the hook service, a JUNO command) builds that name from the
// value the code uses, through one shared helper. This test triggers each such refusal against the real hook service,
// the real admission and the real restore, with real files, in a sealed container from the runner image (no network),
// and checks that every path a message names exists (or is exactly the file its command removes) and that every
// command it gives runs, exactly as given: `rm`, `juno hook admit` and `juno journal check` in the container as the
// runner; `pgrep` here on the host (the runner image has none), which sees the container's processes; `systemctl` is
// pinned to the helper here and run against a real user manager by remedies-systemd.test.ts. No shell.

const fixtures = fileURLToPath(new URL("./remedies", import.meta.url));
const helpers = fileURLToPath(new URL("./hook-separation", import.meta.url));

type Exit = { code: number | string; stdout: string; stderr: string };
type Command = { text: string; argv: string[] };
type Named = { paths: { path: string; exists: boolean }[]; commands: Command[]; descriptor: boolean };
type Step = Record<string, unknown> & { step: string; wait?: boolean };

const id = randomBytes(6).toString("hex");
const identity = mkdtempSync(join(tmpdir(), "juno-remedies-"));
writeFileSync(join(identity, "machine-id"), `${randomBytes(16).toString("hex")}\n`, { mode: 0o644 });
const pgrep = noJunoProcessCommand();
const steps = new Map<string, Step>();
const pgreps = new Map<string, Exit>();

/** Runs the pgrep command exactly as the refusals give it, here on the host. */
const runPgrep = (): Promise<Exit> => new Promise((resolve) => {
  execFile(pgrep[0] ?? "", pgrep.slice(1), (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : -1, stdout, stderr }));
});

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    let out = "";
    let err = "";
    const child = execFile("docker", [
      "run", "--rm", "-i", "--user", "0", "--network", "none", "--hostname", "juno-host",
      "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "FSETID", "--cap-add", "DAC_READ_SEARCH",
      "--security-opt", "no-new-privileges:true",
      "--mount", ["type=bind", ["source", fixtures].join("="), "target=/r", "readonly"].join(","),
      "--mount", ["type=bind", ["source", helpers].join("="), "target=/h", "readonly"].join(","),
      "--mount", ["type=bind", ["source", join(identity, "machine-id")].join("="), "target=/etc/machine-id", "readonly"].join(","),
      "--tmpfs", "/srv/work:mode=0755",
      "--entrypoint", "/usr/local/bin/node", "juno-runner:local", "/r/driver.mjs", id,
    ], { maxBuffer: 64 * 1024 * 1024, timeout: 420_000 }, (error) => {
      if (error !== null && steps.size < 6) reject(new Error(`the driver ended early: ${String(error)}\n${out}\n${err}`));
      else resolve();
    });
    child.stderr?.on("data", (chunk) => { err += String(chunk); });
    child.stdout?.on("data", (chunk) => {
      out += String(chunk);
      let newline = out.indexOf("\n");
      while (newline >= 0) {
        const line = out.slice(0, newline);
        out = out.slice(newline + 1);
        newline = out.indexOf("\n");
        if (!line.startsWith("{")) continue;
        const step = JSON.parse(line) as Step;
        steps.set(step.step, step);
        // The driver waits while the pgrep command runs here, then goes on.
        if (step.wait === true) void runPgrep().then((exit) => { pgreps.set(step.step, exit); child.stdin?.write("go\n"); });
      }
    });
  });
}, 480_000);

afterAll(() => {
  rmSync(identity, { recursive: true, force: true });
});

const step = (name: string): Step => {
  const found = steps.get(name);
  if (found === undefined) throw new Error(`no step ${name}`);
  return found;
};
const exit = (value: unknown): Exit => value as Exit;
const named = (value: unknown): Named => value as Named;

/** Every path a message names exists; no descriptor path; every command is exactly the helper's rendering of its words. */
function wellNamed(what: Named, exempt: readonly string[] = []): void {
  expect(what.descriptor).toBe(false);
  for (const { path, exists } of what.paths) if (!exempt.includes(path)) expect(exists, path).toBe(true);
  // A command with the admission's placeholder is read with the session file in its place, its last word.
  for (const command of what.commands) {
    const placeholder = command.text.endsWith(" <session file>");
    expect(commandText(placeholder ? command.argv.slice(0, -1) : command.argv, placeholder ? "<session file>" : undefined)).toBe(`\`${command.text}\``);
  }
}
const commandsOf = (what: Named): string[][] => what.commands.map((command) => command.argv);

describe("every refusal and remedy names real files and gives commands that run (D-247)", () => {
  // proves D-247 item 1 for the service's start line and the admission: the admit command and the journal check run
  it("gives an admit command and a journal check that run exactly as given", () => {
    const serving = step("serving");
    expect(serving["started"]).toBe(true);
    wellNamed(named(serving["serving"]));
    const admit = commandsOf(named(serving["serving"])).find((argv) => argv.includes("admit"));
    expect(admit?.slice(0, 2)).toEqual(["/usr/local/bin/node", "/app/dist/runner/src/juno.js"]);
    expect(exit(serving["admitted"])).toMatchObject({ code: 0, stdout: expect.stringContaining("admitted session-") });
    wellNamed(named(serving["admission"]));
    // The check as given runs; its one failure here is the history read, for the runner image has no git (D-001).
    const check = exit(step("root")["checked"]);
    expect(check.code, check.stdout).toBe(1);
    expect(JSON.parse(check.stdout)).toEqual({ ok: false, history: "refused", failure: { code: "anchor_history", reason: "the anchor clone's history could not be read: spawn /usr/bin/git ENOENT" } });
    // The same command with only --no-history added passes in full: the journal, the anchors and the key it names are right.
    const whole = exit(step("root")["checkedNoHistory"]);
    expect(whole.code, whole.stdout).toBe(0);
    expect(JSON.parse(whole.stdout)).toMatchObject({ ok: true, unanchored: 0, history: "not_checked" });
  });

  // proves D-247 item 1 for the restore's refusal while the service runs: the lock it names exists; stop the service
  it("names the held lock and the command that stops the service, while it runs", () => {
    const serving = step("serving");
    const refusal = named(serving["restoreNamed"]);
    expect(exit(serving["restore"]).code).toBe(1);
    expect(exit(serving["restore"]).stderr).toContain("(owner_running)");
    wellNamed(refusal);
    expect(refusal.paths.map((item) => item.path)).toContain("/var/lib/juno-runner/journal/runner.lock");
    expect(commandsOf(refusal)).toContainEqual([...serviceCommand("stop")]);
    // The pgrep the other refusals give, run on the host while this service runs: it lists this very service.
    const listed = pgreps.get("serving");
    expect(listed?.code).toBe(0);
    expect(listed?.stdout.split("\n").some((line) => line.includes(`/etc/claude-code-${id}`) && line.includes("juno.js hook serve"))).toBe(true);
  });

  // proves D-247 item 1 for the restore's refusal after a kill: start, check the status, stop; pgrep shows none of it
  it("names the dead lock and the start, status and stop commands after the service is killed", () => {
    const killed = step("killed");
    const refusal = named(killed["restoreNamed"]);
    expect(exit(killed["restore"]).stderr).toContain("(owner_dead)");
    wellNamed(refusal);
    expect(refusal.paths.map((item) => item.path)).toContain("/var/lib/juno-runner/journal/runner.lock");
    expect(commandsOf(refusal)).toEqual([[...serviceCommand("start")], [...serviceCommand("status")], [...serviceCommand("stop")]]);
    const listed = pgreps.get("killed");
    expect(listed === undefined ? -1 : [0, 1].includes(Number(listed.code))).toBe(true);
    expect(listed?.stdout).not.toContain(`/etc/claude-code-${id}`);
  });

  // proves D-247 item 1 (and D-243) for a lock JUNO cannot prove dead: its path exists, rm removes exactly it, then a start serves
  it("names a lock it cannot prove dead, and its rm command removes exactly that lock", () => {
    const unprovable = step("unprovable");
    expect(unprovable["started"]).toBe(false);
    const refusal = named(unprovable["named"]);
    expect(String(unprovable["text"])).toContain("(pid_namespace_differs)");
    wellNamed(refusal);
    expect(commandsOf(refusal)).toEqual([[...pgrep], ["rm", "/var/lib/juno-runner/journal/runner.lock"]]);
    expect(unprovable["rmPaths"]).toEqual([{ path: "/var/lib/juno-runner/journal/runner.lock", exists: true }]);
    wellNamed(named(unprovable["restoreNamed"]));
    expect(commandsOf(named(unprovable["restoreNamed"]))).toEqual([[...pgrep], ["rm", "/var/lib/juno-runner/journal/runner.lock"]]);
    expect(exit(unprovable["ran"]).code).toBe(0);
    expect(unprovable["lockAfterRm"]).toBeNull();
    expect((unprovable["next"] as { started: boolean }).started).toBe(true);
    expect(unprovable["lockAfterStop"]).toBeNull();
  });

  // proves D-247 item 1 (round 2's finding) for a take-over file left by a crash: both named, both removed, then a start serves
  it("names a leftover take-over file and the lock, and its rm command removes exactly both", () => {
    const takeover = step("takeover");
    expect(takeover["started"]).toBe(false);
    const refusal = named(takeover["named"]);
    expect(String(takeover["text"])).toContain("(takeover_in_progress)");
    wellNamed(refusal);
    expect(commandsOf(refusal)).toEqual([[...pgrep], ["rm", "/var/lib/juno-runner/journal/runner.lock.takeover", "/var/lib/juno-runner/journal/runner.lock"]]);
    expect(takeover["rmPaths"]).toEqual([{ path: "/var/lib/juno-runner/journal/runner.lock.takeover", exists: true }, { path: "/var/lib/juno-runner/journal/runner.lock", exists: true }]);
    expect(exit(takeover["ran"]).code).toBe(0);
    expect(takeover["afterRm"]).toEqual([null, null]);
    expect((takeover["next"] as { started: boolean }).started).toBe(true);
  });

  // proves D-247 item 1 for a socket path held by something JUNO did not leave: named, removed by its rm, then a start serves
  it("names a socket path that cannot be listened on, and its rm command removes exactly it", () => {
    const socket = step("socket");
    expect(socket["started"]).toBe(false);
    const refusal = named(socket["named"]);
    expect(String(socket["text"])).toContain("the socket /var/lib/juno-hook/hook.sock cannot be listened on (EADDRINUSE)");
    wellNamed(refusal);
    expect(commandsOf(refusal)).toEqual([[...pgrep], ["rm", "/var/lib/juno-hook/hook.sock"]]);
    expect(socket["rmPaths"]).toEqual([{ path: "/var/lib/juno-hook/hook.sock", exists: true }]);
    expect(exit(socket["ran"]).code).toBe(0);
    expect(socket["afterRm"]).toBe(false);
    expect((socket["next"] as { started: boolean }).started).toBe(true);
  });

  // proves D-247 item 1 for the restore run as root: it names the journal's owner by name, and the journal
  it("names the journal's owner, by name, when the restore runs as root", () => {
    const root = step("root");
    expect(exit(root["restore"]).stderr).toContain("never as root");
    // uid 1000 is `node` in the runner image: the name of the journal's real owner, not a literal.
    expect(root["owner"]).toBe(1000);
    expect(exit(root["restore"]).stderr).toContain("run it as node, the user that owns the journal /var/lib/juno-runner/journal");
    wellNamed(named(root["named"]));
  });
});
