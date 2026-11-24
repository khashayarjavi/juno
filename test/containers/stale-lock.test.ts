import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// D-243 (operator's increment 1.5-ops, item 1): on Windows, WSL tears its instance down when nothing uses it, killing
// `juno hook serve` without a stop and leaving the journal's lock behind. A lock whose owner is provably dead (same host,
// boot and PID namespace, and the PID absent or now a different process by start time) is stale: the next start takes
// it over, records that in the journal and runs the normal start-up check; the restore refuses it, changing nothing, and
// says how to go on. Against the real hook service in sealed containers from the runner image (no network): first killed
// with SIGKILL in its namespace; then killed with its whole PID namespace (the container's first process killed, so the
// kernel kills every process in it and tears it down) and started again in a new container on the same state volume,
// with the same machine id and host name, as WSL's next instance has. No shell.

const run = promisify(execFile);
const fixtures = fileURLToPath(new URL("./stale-lock", import.meta.url));
const helpers = fileURLToPath(new URL("./hook-separation", import.meta.url));

type Exit = { code: number; stdout: string; stderr: string };
type First = {
  phase: "first"; namespace: string; firstStarted: boolean; firstPid: number; lockWhileServing: string | null; killedExit: number | string;
  lockAfterKill: string | null; restore: Exit; lockAfterRestore: string | null; againStarted: boolean; againText: string; againPid: number; lockHeld: string | null;
};
type Second = {
  phase: "second"; namespace: string; lockBefore: string | null; started: boolean; text: string; pid: number; stopped?: Exit; lockAfterStop: string | null;
  reclaims: { actor: string; type: string; reason: string; holder: { pid: number; pid_ns: string; pid_start: number } }[];
  cleanStarted: boolean; cleanText: string; restoreAfterStop: Exit; lockAtEnd: string | null;
};

const id = randomBytes(6).toString("hex");
const volume = `juno-stale-lock-${id}`;
const name = `juno-stale-lock-first-${id}`;
const identity = mkdtempSync(join(tmpdir(), "juno-stale-lock-"));
writeFileSync(join(identity, "machine-id"), `${randomBytes(16).toString("hex")}\n`, { mode: 0o644 });

const dockerArgs = (phase: string, extra: string[]): string[] => [
  "run", ...extra, "--user", "0", "--network", "none", "--hostname", "juno-host",
  "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "FSETID", "--cap-add", "DAC_READ_SEARCH",
  "--security-opt", "no-new-privileges:true",
  "--mount", ["type=bind", ["source", fixtures].join("="), "target=/r", "readonly"].join(","),
  "--mount", ["type=bind", ["source", helpers].join("="), "target=/h", "readonly"].join(","),
  "--mount", ["type=bind", ["source", join(identity, "machine-id")].join("="), "target=/etc/machine-id", "readonly"].join(","),
  "--mount", ["type=volume", ["source", volume].join("="), "target=/var/lib/juno-runner"].join(","),
  "--tmpfs", "/srv/work:mode=0755",
  "--entrypoint", "/usr/local/bin/node", "juno-runner:local", "/r/driver.mjs", phase,
];

let first: First;
let second: Second;

beforeAll(async () => {
  await run("docker", ["volume", "create", volume]);
  // Phase one runs until its service is serving again, then waits; its JSON line is the signal to kill it whole.
  first = await new Promise<First>((resolve, reject) => {
    let out = "";
    let err = "";
    const child = execFile("docker", dockerArgs("first", ["--name", name]), { maxBuffer: 16 * 1024 * 1024, timeout: 240_000 }, (error) => {
      if (!out.includes("\n")) reject(new Error(`phase one ended before it reported: ${String(error)}\n${out}\n${err}`));
    });
    child.stderr?.on("data", (chunk) => { err += String(chunk); });
    child.stdout?.on("data", (chunk) => {
      out += String(chunk);
      const line = out.split("\n").find((text) => text.startsWith("{"));
      if (line !== undefined && out.includes("\n")) resolve(JSON.parse(line) as First);
    });
  });
  // SIGKILL to the container's first process: the kernel kills every process in its PID namespace, the service with
  // them, and tears the namespace down. Nothing stops the service; its lock stays on the volume.
  await run("docker", ["kill", "--signal", "KILL", name]);
  await run("docker", ["wait", name]);
  await run("docker", ["rm", name]);
  const { stdout } = await run("docker", dockerArgs("second", ["--rm"]), { maxBuffer: 16 * 1024 * 1024, timeout: 240_000 });
  second = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Second;
}, 600_000);

afterAll(async () => {
  await run("docker", ["rm", "-f", name]).catch(() => undefined);
  await run("docker", ["volume", "rm", volume]).catch(() => undefined);
  rmSync(identity, { recursive: true, force: true });
});

const parse = (text: string | null): Record<string, unknown> => JSON.parse(text ?? "null") as Record<string, unknown>;

describe("D-243: the real hook service killed without a stop leaves a lock the next start takes over", () => {
  // proves D-243: the lock records its owner's start time, and a SIGKILL leaves it behind
  it("leaves the lock behind when the service is killed with SIGKILL", () => {
    expect(first.firstStarted).toBe(true);
    expect(first.killedExit).toBe("SIGKILL");
    expect(parse(first.lockWhileServing)).toMatchObject({ pid: first.firstPid, pid_ns: first.namespace, pid_start: expect.any(Number) });
    expect(first.lockAfterKill).toBe(first.lockWhileServing);
  });

  // proves D-243: the restore never takes a stale lock over; it changes nothing, names the lock's real path and says to
  // start the service once, never to stop a service that is not running
  it("refuses the restore on the dead service's lock, changing nothing, with a working remedy", () => {
    expect(first.restore.code).toBe(1);
    expect(first.restore.stderr).toContain("refused, nothing was changed: JUNO's service stopped without releasing the journal's lock");
    expect(first.restore.stderr).toContain("systemctl --user start juno-hook.service");
    expect(first.restore.stderr).toContain("/var/lib/juno-runner/journal/runner.lock");
    expect(first.restore.stderr).not.toContain("/proc/self/fd");
    expect(first.restore.stderr).not.toContain("so its service is running");
    expect(first.lockAfterRestore).toBe(first.lockAfterKill);
  });

  // proves D-243 in the same PID namespace: the next start takes the lock over, says so, and holds a lock of its own
  it("takes the lock over at the next start in the same namespace", () => {
    expect(first.againStarted, first.againText).toBe(true);
    expect(first.againText).toContain(`the journal's lock was left by a JUNO process that is no longer running (owner_not_running, process ${String(first.firstPid)})`);
    expect(parse(first.lockHeld)).toMatchObject({ pid: first.againPid, pid_ns: first.namespace });
    // The killed service's socket files are still there; nothing answers on them, so the start removes them and listens.
    expect(first.againText).toContain("juno hook: removed /var/lib/juno-hook/hook.sock, a socket file left by a JUNO process that is no longer running");
    expect(first.againText).toContain("juno hook: removed /var/lib/juno-runner/admit.sock, a socket file left by a JUNO process that is no longer running");
  });

  // proves D-243 across a torn-down PID namespace: the new namespace carries the dead one's name (Linux reuses the number,
  // as WSL's next instance shows), so the start takes the lock over, records it after checking the journal (D-201, D-206),
  // and starts; once stopped cleanly no lock is left, the next start takes nothing over, and the restore gets the journal
  it("takes the lock over after the whole PID namespace was torn down, and records both take-overs", () => {
    const left = parse(second.lockBefore);
    expect(left).toMatchObject({ pid: first.againPid, pid_ns: first.namespace });
    // Linux gives a torn-down namespace's number to the next one made: the field report's "all seen as pid:[N]".
    expect(second.namespace).toBe(first.namespace);
    expect(second.started, second.text).toBe(true);
    expect(second.text).toMatch(new RegExp(`the journal's lock was left by a JUNO process that is no longer running \\((owner_not_running|owner_pid_reused), process ${String(first.againPid)}\\)`));
    // The admission socket was on the runner's state volume, so it outlived the namespace too.
    expect(second.text).toContain("juno hook: removed /var/lib/juno-runner/admit.sock");
    expect(second.stopped?.code).toBe(0);
    expect(second.lockAfterStop).toBeNull();
    expect(second.reclaims).toEqual([
      expect.objectContaining({ actor: "juno.session-layer", type: "stale_lock_reclaimed", reason: "owner_not_running", holder: expect.objectContaining({ pid: first.firstPid }) }),
      expect.objectContaining({ actor: "juno.session-layer", type: "stale_lock_reclaimed", reason: expect.stringMatching(/^(owner_not_running|owner_pid_reused)$/), holder: expect.objectContaining({ pid: first.againPid }) }),
    ]);
    expect(second.cleanStarted, second.cleanText).toBe(true);
    expect(second.cleanText).not.toContain("no longer running");
    // The restore now gets past the lock (its own refusal is about the task, which does not exist here).
    expect(second.restoreAfterStop.stderr).not.toContain("lock");
    expect(second.lockAtEnd).toBeNull();
  });
});
