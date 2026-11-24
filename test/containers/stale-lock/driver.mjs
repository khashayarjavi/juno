// The stale-lock test's driver (D-243), as root in a sealed container from the runner image (no network; only CHOWN,
// SETUID, SETGID, FSETID and DAC_READ_SEARCH). The runner's state (/var/lib/juno-runner: journal, journal key, anchors)
// is a named volume the test hands from one container to the next, so a service killed with its whole PID namespace can
// be followed by a start in a new one, as when WSL tears its instance down.
//   phase "first": the real `juno hook serve` as the runner; SIGKILL it (no stop, the lock is left); the real
//     `juno checkpoint restore` as the runner, which must refuse and change nothing; the real service started again,
//     which takes the lock over. That service is left running and this script waits: the test then kills the whole
//     container (SIGKILL to its first process, so the kernel kills every process in the namespace and tears it down).
//   phase "second", in a new container and so a new PID namespace: the real service started on the same journal, then
//     stopped cleanly, then started and stopped again; and what the journal's own record holds.
// Prints one JSON object per phase. No shell anywhere.
import { execFile } from "node:child_process";
import { setInterval, clearInterval } from "node:timers";
import { promisify } from "node:util";
import { generateKeyPairSync } from "node:crypto";
import { appendFileSync, chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import process from "node:process";
import { TextDecoder } from "node:util";

const phase = process.argv[2];
const NODE = "/usr/local/bin/node";
const JUNO = "/app/dist/runner/src/juno.js";
const RUNNER = 1000;
const AGENT = 1001;
const HOOK_GROUP = 1500;
const SOCKET = "/var/lib/juno-hook/hook.sock";
const CONTROL = "/var/lib/juno-runner/admit.sock";
const JOURNAL = "/var/lib/juno-runner/journal";
const LOCK = `${JOURNAL}/runner.lock`;
const CHECKPOINTS = "/var/lib/juno-runner/checkpoints";
const WORK = "/srv/work";

appendFileSync("/etc/passwd", `juno-agent:x:${String(AGENT)}:${String(AGENT)}::/home/juno-agent:/usr/sbin/nologin\n`);
appendFileSync("/etc/group", `juno-agent:x:${String(AGENT)}:\njuno-hook:x:${String(HOOK_GROUP)}:juno-agent\n`);
if (!existsSync("/usr/bin/ssh")) writeFileSync("/usr/bin/ssh", "#!/usr/local/bin/node\nprocess.exit(1);\n", { mode: 0o755 });
mkdirSync("/etc/juno", { recursive: true, mode: 0o755 });
writeFileSync("/etc/juno/operator.pub", generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }), { mode: 0o444 });
mkdirSync("/var/lib/juno-hook");
chmodSync("/var/lib/juno-hook", 0o2750);
chownSync("/var/lib/juno-hook", RUNNER, HOOK_GROUP);
mkdirSync("/opt/fake-docker", { mode: 0o755 });
// The test stack's stand-in for the runner's Docker (no container has a Docker socket, D-065): `docker info` reports a
// rootless runtime that enforces limits. No session is admitted here, so nothing is copied.
writeFileSync("/opt/fake-docker/docker", [
  "#!/usr/local/bin/node",
  "const args = process.argv.slice(2);",
  'if (args[0] === "info") { process.stdout.write(JSON.stringify({ CgroupDriver: "systemd", CgroupVersion: "2", SecurityOptions: ["name=rootless"] })); process.exit(0); }',
  "process.exit(125);",
  "",
].join("\n"), { mode: 0o755 });
const runnerEnv = { ...process.env, PATH: `/opt/fake-docker:${process.env.PATH ?? ""}` };

const asUser = (uid, groups, args, env = process.env) => new Promise((resolve) => {
  const child = execFile(NODE, ["/h/as-user.mjs", String(uid), String(uid), groups, ...args], { timeout: 90_000, env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : -1, stdout, stderr }));
  child.stdin.end();
});

// The guide's access list on the workspace (Part E step 12), as the kernel stores it (POSIX ACL xattr, version 2).
const entry = (tag, perm, id) => { const b = Buffer.alloc(8); b.writeUInt16LE(tag, 0); b.writeUInt16LE(perm, 2); b.writeUInt32LE(id >>> 0, 4); return b; };
const acl = (owner, group, other) => Buffer.concat([Buffer.from([2, 0, 0, 0]), entry(0x01, owner, -1), entry(0x02, 7, RUNNER), entry(0x02, 7, AGENT), entry(0x04, group, -1), entry(0x10, 7, -1), entry(0x20, other, -1)]);
const run = promisify(execFile);
const setxattr = (path, name, value) => run("/usr/bin/perl", ["-e", "my ($p, $n, $h, $nr) = @ARGV; my $v = pack(\"H*\", $h); exit(syscall($nr, $p, $n, $v, length($v), 0) == 0 ? 0 : 1)", path, name, value.toString("hex"), process.arch === "arm64" ? "5" : "188"]);
await setxattr(WORK, "system.posix_acl_access", acl(7, 5, 5));
await setxattr(WORK, "system.posix_acl_default", acl(7, 5, 5));
chownSync(WORK, AGENT, AGENT);
if (!existsSync(CHECKPOINTS)) await asUser(RUNNER, "", ["/r/mkdir.mjs", CHECKPOINTS]);

const serveArgs = [JUNO, "hook", "serve", "--socket", SOCKET, "--control", CONTROL, "--journal", JOURNAL, "--anchor", "/etc/juno/operator.pub", "--journal-key", "/var/lib/juno-runner/journal-key", "--anchors", "/var/lib/juno-runner/juno-anchors", "--workspace", WORK, "--checkpoints", CHECKPOINTS, "--protect", "/etc/claude-code"];
/** Starts the real service as the runner; resolves once it serves (or exits), with its pid and a stop function. */
async function serve() {
  let out = "";
  let err = "";
  let child;
  const exited = new Promise((resolve) => {
    child = execFile(NODE, ["/h/as-user.mjs", String(RUNNER), String(RUNNER), "", ...serveArgs], { timeout: 120_000, env: runnerEnv }, (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : error.signal ?? -1, stdout, stderr }));
  });
  child.stdout.on("data", (chunk) => { out += String(chunk); });
  child.stderr.on("data", (chunk) => { err += String(chunk); });
  const started = await new Promise((resolve) => {
    const timer = setInterval(() => { if (out.includes("juno hook: serving")) { clearInterval(timer); resolve(true); } }, 50);
    void exited.then(() => { clearInterval(timer); resolve(false); });
  });
  return { started, pid: child.pid, text: () => `${out}${err}`, exited, stop: async () => { await asUser(RUNNER, "", ["/h/signal.mjs", String(child.pid)]); return exited; } };
}
const lock = () => (existsSync(LOCK) ? readFileSync(LOCK, "utf8") : null);
const restore = () => asUser(RUNNER, "", [JUNO, "checkpoint", "restore", "--journal", JOURNAL, "--checkpoints", CHECKPOINTS, "--workspace", WORK, "--principal", "alireza", "session-none", "0".repeat(64)], runnerEnv);

const results = { phase, namespace: readlinkSync("/proc/self/ns/pid") };
if (phase === "first") {
  const killed = await serve();
  results.firstStarted = killed.started;
  results.firstPid = killed.pid;
  results.lockWhileServing = lock();
  // As WSL's teardown does: no stop. The runner kills its own service.
  await asUser(RUNNER, "", ["/r/kill.mjs", String(killed.pid)]);
  results.killedExit = (await killed.exited).code;
  results.lockAfterKill = lock();
  results.restore = await restore();
  results.lockAfterRestore = lock();
  const again = await serve();
  results.againStarted = again.started;
  results.againText = again.text();
  results.againPid = again.pid;
  results.lockHeld = lock();
  // The test kills this whole container now; this line is its signal.
  process.stdout.write(`${JSON.stringify(results)}\n`);
  setInterval(() => undefined, 60_000);
} else {
  results.lockBefore = lock();
  const next = await serve();
  results.started = next.started;
  results.text = next.text();
  results.pid = next.pid;
  if (next.started) results.stopped = await next.stop();
  results.lockAfterStop = lock();
  const { listRecords, readPayload, readTrajectory } = await import("/app/dist/journal/src/index.js");
  results.reclaims = listRecords(JOURNAL).flatMap((record) => (record.taskId === null ? [] : readTrajectory(JOURNAL, record.taskId)).map((item) => {
    const blob = readPayload(JOURNAL, item.payload_ref);
    return blob.status === "present" ? { actor: item.actor, ...JSON.parse(new TextDecoder().decode(blob.bytes)) } : {};
  })).filter((payload) => payload.type === "stale_lock_reclaimed");
  const clean = await serve();
  results.cleanStarted = clean.started;
  results.cleanText = clean.text();
  if (clean.started) await clean.stop();
  results.restoreAfterStop = await restore();
  results.lockAtEnd = lock();
  results.lstat = lstatSync(JOURNAL).isDirectory();
  process.stdout.write(`${JSON.stringify(results)}\n`, () => process.exit(0));
}
