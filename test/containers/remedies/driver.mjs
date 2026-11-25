// The remedies test's driver (operator ruling D-247 item 1), as root in a sealed container from the runner image (no
// network; only CHOWN, SETUID, SETGID, FSETID and DAC_READ_SEARCH). It triggers, against the real `juno hook serve`,
// `juno hook admit` and `juno checkpoint restore` and real files, every refusal and remedy that names the journal's
// lock, its take-over file, a socket, the journal, a checkpoint store or the hook service, and every command a message
// gives. For each message it reports every absolute path it names and whether that path exists here, and every command
// it gives (the text between backticks, read back as an argument vector exactly as a POSIX shell reads it). Every
// command but `systemctl` and `pgrep` is then run here, as the runner, exactly as given: the runner image has neither
// (the test runs the `pgrep` command on the host, which sees this container's processes, while this script waits for
// it on standard input; `test/containers/remedies-systemd.test.ts` runs the `systemctl` commands against a real user
// manager). Prints one JSON line per step. No shell anywhere.
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { appendFileSync, chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { createInterface } from "node:readline";
import { clearInterval, setInterval } from "node:timers";
import { promisify } from "node:util";
import process from "node:process";

const marker = process.argv[2];
const NODE = "/usr/local/bin/node";
const JUNO = "/app/dist/runner/src/juno.js";
const RUNNER = 1000;
const AGENT = 1001;
const HOOK_GROUP = 1500;
const SESSION = "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f";
const SOCKET = "/var/lib/juno-hook/hook.sock";
const CONTROL = "/var/lib/juno-runner/admit.sock";
const JOURNAL = "/var/lib/juno-runner/journal";
const LOCK = `${JOURNAL}/runner.lock`;
const TAKEOVER = `${JOURNAL}/runner.lock.takeover`;
const CHECKPOINTS = "/var/lib/juno-runner/checkpoints";
const SESSION_FILE = "/var/lib/juno-runner/session.json";
const WORK = "/srv/work";
const PROJECT = `${WORK}/project`;

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const report = (step, body) => new Promise((resolve) => process.stdout.write(`${JSON.stringify({ step, ...body })}\n`, resolve));
/** Waits until the test has run the `pgrep` command on the host. */
const handOver = async (step, body) => {
  await report(step, { ...body, wait: true });
  await lines.next();
};

appendFileSync("/etc/passwd", `juno-agent:x:${String(AGENT)}:${String(AGENT)}::/home/juno-agent:/usr/sbin/nologin\n`);
appendFileSync("/etc/group", `juno-agent:x:${String(AGENT)}:\njuno-hook:x:${String(HOOK_GROUP)}:juno-agent\n`);
if (!existsSync("/usr/bin/ssh")) writeFileSync("/usr/bin/ssh", "#!/usr/local/bin/node\nprocess.exit(1);\n", { mode: 0o755 });
mkdirSync("/etc/juno", { recursive: true, mode: 0o755 });
const operator = generateKeyPairSync("ed25519");
writeFileSync("/etc/juno/operator.pub", operator.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o444 });
mkdirSync("/var/lib/juno-hook");
chmodSync("/var/lib/juno-hook", 0o2750);
chownSync("/var/lib/juno-hook", RUNNER, HOOK_GROUP);
mkdirSync("/opt/fake-docker", { mode: 0o755 });
// The test stack's stand-in for the runner's Docker (no container has a Docker socket, D-065): `docker info` reports a
// rootless runtime that enforces limits; `docker run` runs the sealed copy program as the caller, with the mount's
// source for /work (as test/containers/hook-restore/driver.mjs; the real runtime is proven by sealed-copy.test.ts).
writeFileSync("/opt/fake-docker/docker", [
  "#!/usr/local/bin/node",
  'const { execFile } = require("node:child_process");',
  "const args = process.argv.slice(2);",
  'if (args[0] === "info") { process.stdout.write(JSON.stringify({ CgroupDriver: "systemd", CgroupVersion: "2", SecurityOptions: ["name=rootless"] })); process.exit(0); }',
  'if (args[0] !== "run") process.exit(125);',
  'const mount = args[args.indexOf("--mount") + 1] ?? "";',
  'const source = /(?:^|,)source=([^,]+)/.exec(mount)?.[1];',
  'const program = args.indexOf("-e");',
  "const rest = args.slice(args.indexOf(\"--\", program) + 1);",
  'if (source === undefined || program < 0 || rest[1] !== "/work") process.exit(125);',
  "rest[1] = source;",
  'const child = execFile("/usr/local/bin/node", ["--input-type=module", "-e", args[program + 1], "--", ...rest], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => { process.stderr.write(stderr); process.stdout.write(stdout, () => process.exit(error === null ? 0 : typeof error.code === "number" ? error.code : 1)); });',
  "process.stdin.pipe(child.stdin);",
  "",
].join("\n"), { mode: 0o755 });
const runnerEnv = { ...process.env, PATH: `/opt/fake-docker:${process.env.PATH ?? ""}` };

const exitOf = (error) => (error === null ? 0 : typeof error.code === "number" ? error.code : -1);
const asUser = (uid, groups, args, env = process.env) => new Promise((resolve) => {
  const child = execFile(NODE, ["/h/as-user.mjs", String(uid), String(uid), groups, ...args], { timeout: 90_000, env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ code: exitOf(error), stdout, stderr }));
  child.stdin.end();
});
const asRoot = (args) => new Promise((resolve) => {
  execFile(NODE, args, { timeout: 90_000, env: runnerEnv, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ code: exitOf(error), stdout, stderr }));
});

// The guide's access list on the workspace (Part E step 12), as the kernel stores it (POSIX ACL xattr, version 2).
const entry = (tag, perm, id) => { const b = Buffer.alloc(8); b.writeUInt16LE(tag, 0); b.writeUInt16LE(perm, 2); b.writeUInt32LE(id >>> 0, 4); return b; };
const acl = (owner, group, other) => Buffer.concat([Buffer.from([2, 0, 0, 0]), entry(0x01, owner, -1), entry(0x02, 7, RUNNER), entry(0x02, 7, AGENT), entry(0x04, group, -1), entry(0x10, 7, -1), entry(0x20, other, -1)]);
const run = promisify(execFile);
const setxattr = (path, name, value) => run("/usr/bin/perl", ["-e", "my ($p, $n, $h, $nr) = @ARGV; my $v = pack(\"H*\", $h); exit(syscall($nr, $p, $n, $v, length($v), 0) == 0 ? 0 : 1)", path, name, value.toString("hex"), process.arch === "arm64" ? "5" : "188"]);
mkdirSync(PROJECT, { recursive: true, mode: 0o755 });
writeFileSync(`${PROJECT}/notes.txt`, "notes\n", { mode: 0o644 });
for (const path of [WORK, PROJECT, `${PROJECT}/notes.txt`]) {
  await setxattr(path, "system.posix_acl_access", acl(7, 5, 5));
  if (lstatSync(path).isDirectory()) await setxattr(path, "system.posix_acl_default", acl(7, 5, 5));
  chownSync(path, AGENT, AGENT);
}
await asUser(RUNNER, "", ["/r/exec.mjs", "/bin/mkdir", "-m", "0700", "/var/lib/juno-runner/grants", CHECKPOINTS]);
const { signGrant } = await import("/app/dist/enforcement/src/index.js");
const now = Date.now();
const grant = JSON.stringify(signGrant({ id: "grant-remedies", principal: "alireza", capability_selector: { capabilities: ["cc.read", "cc.write"] }, resource_scope: [{ kind: "path", prefix: "/work/project" }], data_class_bounds: { max_sensitivity: "internal", min_integrity: "untrusted" }, issuance: "preissued", issued_by: "alireza", issued_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 3_600_000).toISOString(), max_invocations: 20, attenuation_parent: null, revoked_at: null }, operator.privateKey));
const session = JSON.stringify({ session: { session_id: SESSION, principal: "alireza", attendance: "gated", ttl: 3_600_000, grants: ["grant-remedies"], budget: { tool_calls: 20, wall_clock_ms: 3_600_000 }, unmetered_accepted: true, provider_clearance: "internal", sources: [{ id: "project", selector: { kind: "path", prefix: "/work/project" }, data_class: { sensitivity: "internal", integrity: "untrusted" } }], name_map: [], reversible_workspaces: ["/work/project"] }, grants: ["/var/lib/juno-runner/grants/grant-remedies.json"] });
await asUser(RUNNER, "", ["/h/write-file.mjs", "/var/lib/juno-runner/grants/grant-remedies.json", grant]);
await asUser(RUNNER, "", ["/h/write-file.mjs", SESSION_FILE, session]);

/** The words of a command as a POSIX shell reads them: plain characters, '…' quoted runs, and \x escapes. */
function words(text) {
  const out = [];
  let word = null;
  for (let at = 0; at < text.length; at += 1) {
    const c = text[at];
    if (c === " ") {
      if (word !== null) out.push(word);
      word = null;
    } else if (c === "'") {
      const end = text.indexOf("'", at + 1);
      if (end < 0) throw new Error(`an unterminated quote in ${text}`);
      word = (word ?? "") + text.slice(at + 1, end);
      at = end;
    } else if (c === "\\") {
      word = (word ?? "") + (text[at + 1] ?? "");
      at += 1;
    } else word = (word ?? "") + c;
  }
  if (word !== null) out.push(word);
  return out;
}
/** What a message names: every absolute path, whether it exists here, and every command it gives. */
function named(text) {
  const commands = [...text.matchAll(/`([^`]+)`/g)].map((match) => ({ text: match[1], argv: words(match[1].replace("<session file>", SESSION_FILE)) }));
  const outside = text.replace(/`[^`]*`/g, " ");
  const paths = [...new Set([...outside.matchAll(/(?<![\w.[\]])\/[^\s`'"(),;]+/g)].map((match) => match[0].replace(/[.:]+$/, "")))];
  return { paths: paths.map((path) => ({ path, exists: existsSync(path) })), commands, descriptor: /\/proc\/(?:self|thread-self|\d+)\/fd|\/dev\/fd\//.test(text) };
}
/** Runs a command a message gives, exactly as given, as the runner. */
const runGiven = (argv) => asUser(RUNNER, "", ["/r/exec.mjs", ...argv], runnerEnv);
/** The argument paths of a command, and whether each exists. */
const argPaths = (argv) => argv.filter((word) => word.startsWith("/")).map((path) => ({ path, exists: existsSync(path) }));

const serveArgs = [JUNO, "hook", "serve", "--socket", SOCKET, "--control", CONTROL, "--journal", JOURNAL, "--anchor", "/etc/juno/operator.pub", "--journal-key", "/var/lib/juno-runner/journal-key", "--anchors", "/var/lib/juno-runner/juno-anchors", "--workspace", WORK, "--checkpoints", CHECKPOINTS, "--protect", `/etc/claude-code-${marker}`];
/** Starts the real service as the runner; resolves once it serves or has exited. */
async function serve() {
  let text = "";
  let child;
  const exited = new Promise((resolve) => {
    child = execFile(NODE, ["/h/as-user.mjs", String(RUNNER), String(RUNNER), "", ...serveArgs], { timeout: 120_000, env: runnerEnv }, (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : error.signal ?? -1, stdout, stderr }));
  });
  child.stdout.on("data", (chunk) => { text += String(chunk); });
  child.stderr.on("data", (chunk) => { text += String(chunk); });
  const started = await new Promise((resolve) => {
    const timer = setInterval(() => { if (text.includes("juno hook: serving")) { clearInterval(timer); resolve(true); } }, 50);
    void exited.then(() => { clearInterval(timer); resolve(false); });
  });
  return { started, pid: child.pid, text: () => text, exited, stop: async () => { await asUser(RUNNER, "", ["/h/signal.mjs", String(child.pid)]); return exited; } };
}
const restoreArgs = [JUNO, "checkpoint", "restore", "--journal", JOURNAL, "--checkpoints", CHECKPOINTS, "--workspace", WORK, "--principal", "alireza", `session-${SESSION}`, "0".repeat(64)];
const restore = () => asUser(RUNNER, "", restoreArgs, runnerEnv);
const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);

// 1. The service serving: the admit command its start line gives, the journal check the admission gives, and the
// restore's refusal while it serves (owner_running: stop the service). The test runs the pgrep command now.
const first = await serve();
const serving = named(first.text());
const admitCommand = serving.commands.find((command) => command.text.includes(" hook admit "));
const admitted = admitCommand === undefined ? null : await runGiven(admitCommand.argv);
const admission = admitted === null ? null : named(admitted.stdout);
const checkCommand = admission?.commands.find((command) => command.text.includes(" journal check "));
const whileServing = await restore();
await handOver("serving", { started: first.started, text: first.text(), serving, admitted, admission, restore: whileServing, restoreNamed: named(whileServing.stderr), lock: read(LOCK) });

// 2. The service killed with SIGKILL (no stop: the lock and both sockets are left). The restore refuses (owner_dead:
// start the service once, check its status, stop it). The test runs the pgrep command again: nothing of this
// container's JUNO runs.
const killedLock = read(LOCK);
await asUser(RUNNER, "", ["/r/kill.mjs", String(first.pid)]);
const killed = await first.exited;
const afterKill = await restore();
const afterKillNamed = named(afterKill.stderr);
await handOver("killed", { killed, restore: afterKill, restoreNamed: afterKillNamed, lock: read(LOCK), sockets: [existsSync(SOCKET), existsSync(CONTROL)] });

// 3. A lock JUNO cannot prove dead (taken in another PID namespace, as one left in WSL's own init namespace): the
// start refuses, naming the lock and the commands; the pgrep command (the test ran it in step 2) prints nothing; the
// lock is removed with the rm command exactly as given; the next start serves.
const foreign = JSON.stringify({ ...JSON.parse(killedLock ?? "{}"), pid_ns: "pid:[1]" });
await asUser(RUNNER, "", ["/r/exec.mjs", "/bin/rm", LOCK]);
await asUser(RUNNER, "", ["/h/write-file.mjs", LOCK, foreign]);
const unprovable = await serve();
const unprovableNamed = named(unprovable.text());
const unprovableRestore = await restore();
const unprovableRestoreNamed = named(unprovableRestore.stderr);
const unprovableRm = unprovableNamed.commands.find((command) => command.argv[0] === "rm");
const unprovableRmPaths = unprovableRm === undefined ? [] : argPaths(unprovableRm.argv);
const unprovableRan = unprovableRm === undefined ? null : await runGiven(unprovableRm.argv);
const afterUnprovable = await serve();
const afterUnprovableText = afterUnprovable.text();
const afterUnprovableStop = afterUnprovable.started ? await afterUnprovable.stop() : null;
await report("unprovable", { started: unprovable.started, text: unprovable.text(), named: unprovableNamed, restore: unprovableRestore, restoreNamed: unprovableRestoreNamed, rmPaths: unprovableRmPaths, ran: unprovableRan, lockAfterRm: read(LOCK), next: { started: afterUnprovable.started, text: afterUnprovableText, stop: afterUnprovableStop }, lockAfterStop: read(LOCK) });

// 4. A take-over file left by a crash in the middle of taking a dead owner's lock over: the start refuses, naming both
// files; the rm command removes exactly both; the next start serves.
await asUser(RUNNER, "", ["/h/write-file.mjs", LOCK, killedLock ?? ""]);
await asUser(RUNNER, "", ["/h/write-file.mjs", TAKEOVER, killedLock ?? ""]);
const takeover = await serve();
const takeoverNamed = named(takeover.text());
const takeoverRm = takeoverNamed.commands.find((command) => command.argv[0] === "rm");
const takeoverRmPaths = takeoverRm === undefined ? [] : argPaths(takeoverRm.argv);
const takeoverRan = takeoverRm === undefined ? null : await runGiven(takeoverRm.argv);
const afterTakeoverFiles = [read(LOCK), read(TAKEOVER)];
const afterTakeover = await serve();
const afterTakeoverText = afterTakeover.text();
const afterTakeoverStop = afterTakeover.started ? await afterTakeover.stop() : null;
await report("takeover", { started: takeover.started, text: takeover.text(), named: takeoverNamed, rmPaths: takeoverRmPaths, ran: takeoverRan, afterRm: afterTakeoverFiles, next: { started: afterTakeover.started, text: afterTakeoverText, stop: afterTakeoverStop } });

// 5. A file at the hook socket's path that is not a socket (nothing a killed service leaves, so the start does not
// remove it): the start refuses, naming the socket and the commands; the rm command removes it; the next start serves.
await asUser(RUNNER, "", ["/h/write-file.mjs", SOCKET, "not a socket"]);
const socket = await serve();
const socketNamed = named(socket.text());
const socketRm = socketNamed.commands.find((command) => command.argv[0] === "rm");
const socketRmPaths = socketRm === undefined ? [] : argPaths(socketRm.argv);
const socketRan = socketRm === undefined ? null : await runGiven(socketRm.argv);
const afterSocketFile = existsSync(SOCKET);
const afterSocket = await serve();
const afterSocketText = afterSocket.text();
const afterSocketStop = afterSocket.started ? await afterSocket.stop() : null;
await report("socket", { started: socket.started, text: socket.text(), named: socketNamed, rmPaths: socketRmPaths, ran: socketRan, afterRm: afterSocketFile, next: { started: afterSocket.started, text: afterSocketText, stop: afterSocketStop } });

// 6. The restore run as root: it names the user to run it as, by the journal's owner, and the journal. Then the journal
// check the admission gave, exactly as given, now that the service has stopped cleanly and anchored its journal.
const asRootRestore = await asRoot(restoreArgs);
const checked = checkCommand === undefined ? null : await runGiven(checkCommand.argv);
// The runner image has no git (D-001), so the check's history read cannot run here; the same command with only
// `--no-history` added must pass in full. (The history read with the real git: packages/journal/test/git-sink.test.ts.)
const checkedNoHistory = checkCommand === undefined ? null : await runGiven([...checkCommand.argv.slice(0, -1), "--no-history", ...checkCommand.argv.slice(-1)]);
await report("root", { restore: asRootRestore, named: named(asRootRestore.stderr), owner: lstatSync(JOURNAL).uid, checked, checkedNoHistory });
process.exit(0);
