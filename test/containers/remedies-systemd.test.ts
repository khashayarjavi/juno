import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { HOOK_SERVICE_UNIT, serviceCommand } from "../../packages/journal/src/index.js";

// Operator ruling D-247 item 1: every command a refusal gives runs, exactly as given. The `systemctl` commands the
// restore gives (stop the service while it runs; after a kill: start it once, check its status, stop it) run here
// against a real systemd user manager: the runner's, in CI's rootless jobs, where scripts/rootless/run-verify.sh sets
// JUNO_SYSTEMD_USER_REQUIRED=1. A unit is linked under the very name the helper gives (`HOOK_SERVICE_UNIT`, the name the
// guide installs the hook service under; test/evidence/operator-setup.test.ts pins the two together), whose program
// holds a real journal's lock with this build's own lock code, as the service does (the real service's refusals and
// take-overs are proven in a sealed container by remedies.test.ts and stale-lock.test.ts). The real `juno checkpoint
// restore` of this build is run against that journal. A machine whose user manager already has a unit of that name
// (the operator's, during an upgrade) is never touched: there only the read-only status command is run. No shell.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const JUNO = join(ROOT, "dist", "runner", "src", "juno.js");
const HOLDER = fileURLToPath(new URL("./remedies-systemd/holder.mjs", import.meta.url));
const REQUIRED = process.env["JUNO_SYSTEMD_USER_REQUIRED"] === "1";

type Exit = { code: number; stdout: string; stderr: string };
const exec = (argv: readonly string[]): Promise<Exit> => new Promise((resolve) => {
  execFile(argv[0] ?? "", argv.slice(1), { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : -1, stdout, stderr }));
});
/** Every command a message gives (between backticks), as a POSIX shell reads its words, each once, in order. */
function commands(text: string): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const [, command] of text.matchAll(/`([^`]+)`/g)) {
    if (command === undefined || seen.has(command)) continue;
    seen.add(command);
    out.push([...command.matchAll(/'((?:[^'])*)'|(\S+)/g)].map((word) => word[1] ?? word[2] ?? ""));
  }
  return out;
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>): Promise<boolean> {
  for (let tries = 0; tries < 100; tries += 1) {
    if (await check()) return true;
    await sleep(100);
  }
  return false;
}
const state = async (): Promise<string> => (await exec(["systemctl", "--user", "is-active", HOOK_SERVICE_UNIT])).stdout.trim();

const dir = mkdtempSync(join(homedir(), ".juno-remedies-systemd-"));
const journal = join(dir, "journal");
const store = join(dir, "checkpoints");
const work = join(dir, "work");
const lock = join(journal, "runner.lock");
let linked = false;

afterAll(async () => {
  if (linked) {
    await exec(["systemctl", "--user", "stop", HOOK_SERVICE_UNIT]);
    // `disable` removes the link `link` made; then the manager forgets the unit.
    await exec(["systemctl", "--user", "disable", HOOK_SERVICE_UNIT]);
    await exec(["systemctl", "--user", "reset-failed", HOOK_SERVICE_UNIT]);
    await exec(["systemctl", "--user", "daemon-reload"]);
  }
  rmSync(dir, { recursive: true, force: true });
});

const restore = (): Promise<Exit> => exec([process.execPath, JUNO, "checkpoint", "restore", "--journal", journal, "--checkpoints", store, "--workspace", work, "--principal", "alireza", "session-remedies", "0".repeat(64)]);

describe("the service commands a refusal gives run against a real systemd user manager (D-247)", () => {
  // proves D-247 item 1 for `systemctl --user stop|start|status juno-hook.service`: run exactly as given, each does
  // what the refusal says it does, and the restore then passes the journal's lock
  it("stops the service holding the lock, and after a kill starts it once, shows it running and stops it", async () => {
    const manager = await exec(["systemctl", "--user", "show-environment"]);
    if (REQUIRED) expect(manager.code, `JUNO_SYSTEMD_USER_REQUIRED=1 but no user manager: ${manager.stderr}`).toBe(0);
    if (manager.code !== 0) {
      // No user manager here (CI's plain verify job, a cloud session): nothing to run the commands against.
      expect(REQUIRED).toBe(false);
      return;
    }
    const known = (await exec(["systemctl", "--user", "show", "--property=LoadState", "--value", HOOK_SERVICE_UNIT])).stdout.trim();
    if (known !== "not-found") {
      // The operator's own unit: never started or stopped by a test. The read-only status command runs (0 running, 3 not).
      expect(REQUIRED, `a ${HOOK_SERVICE_UNIT} is already installed on a machine that requires this test`).toBe(false);
      expect([0, 3]).toContain((await exec(serviceCommand("status"))).code);
      return;
    }
    for (const path of [journal, store]) mkdirSync(path, { mode: 0o700 });
    mkdirSync(work);
    const unit = join(dir, HOOK_SERVICE_UNIT);
    writeFileSync(unit, ["[Unit]", "Description=JUNO test: holds a journal's lock as the hook service does (D-247)", "", "[Service]", "Type=simple", `ExecStart=${process.execPath} ${HOLDER} ${ROOT} ${journal}`, ""].join("\n"));
    expect(await exec(["systemctl", "--user", "link", unit])).toMatchObject({ code: 0 });
    linked = true;
    expect(await exec(["systemctl", "--user", "daemon-reload"])).toMatchObject({ code: 0 });

    // The service runs and holds the lock: the restore refuses and gives the stop command.
    expect(await exec(serviceCommand("start"))).toMatchObject({ code: 0 });
    expect(await until(() => Promise.resolve(existsSync(lock)))).toBe(true);
    const running = await restore();
    expect(running.stderr).toContain("(owner_running)");
    expect(commands(running.stderr)).toEqual([[...serviceCommand("stop")]]);
    // Run exactly as given: the service stops cleanly and its lock is gone.
    for (const argv of commands(running.stderr)) expect(await exec(argv)).toMatchObject({ code: 0 });
    expect(await until(async () => (await state()) !== "active" && !existsSync(lock))).toBe(true);
    expect((await restore()).stderr).not.toContain("the journal's lock");

    // Killed without a stop, as WSL's teardown kills it: the lock is left, its owner dead.
    expect(await exec(serviceCommand("start"))).toMatchObject({ code: 0 });
    expect(await until(() => Promise.resolve(existsSync(lock)))).toBe(true);
    expect(await exec(["systemctl", "--user", "kill", "--signal=SIGKILL", HOOK_SERVICE_UNIT])).toMatchObject({ code: 0 });
    expect(await until(async () => (await state()) !== "active")).toBe(true);
    expect(existsSync(lock)).toBe(true);
    const dead = await restore();
    expect(dead.stderr).toContain("(owner_dead)");
    const [start, status, stop, ...more] = commands(dead.stderr);
    expect([start, status, stop, ...more]).toEqual([[...serviceCommand("start")], [...serviceCommand("status")], [...serviceCommand("stop")]]);
    // Run exactly as given, in order: started once it takes the dead owner's lock over; its status shows it running;
    // stopped, it releases the lock; and the restore then passes it.
    expect(await exec(start ?? [])).toMatchObject({ code: 0 });
    expect(await until(async () => (await state()) === "active")).toBe(true);
    await sleep(500);
    const shown = await exec(status ?? []);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("active (running)");
    expect(await exec(stop ?? [])).toMatchObject({ code: 0 });
    expect(await until(async () => (await state()) !== "active" && !existsSync(lock))).toBe(true);
    expect((await restore()).stderr).not.toContain("the journal's lock");
  }, 120_000);
});
