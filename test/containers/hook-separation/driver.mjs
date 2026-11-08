// The container test's driver (D-173), as root in a sealed container (no network; only CHOWN, SETUID, SETGID,
// FSETID and DAC_READ_SEARCH, for setup and for the check). It builds the layout STATE.md Part E describes (JUNO's
// code root-owned, as /opt/juno is there and /app is in this image), installs
// JUNO's hook with the real `juno hook install`, starts the real runner as uid 1000, runs the real `juno hook check`,
// then runs the Claude Code user's attempts as uid 1001, and the check's negative controls. Prints one JSON object.
// Every program is started with execFile and an argument array; there is no shell.
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { appendFileSync, chmodSync, chownSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import process from "node:process";
import { promisify } from "node:util";

const run = promisify(execFile);
const NODE = "/usr/local/bin/node";
const JUNO = "/app/dist/runner/src/juno.js";
const CLIENT = "/app/dist/mediated/src/juno-hook.js";
const SOCKET = "/var/lib/juno-hook/hook.sock";
const RUNNER = 1000;
const AGENT = 1001;
const HOOK_GROUP = 1500;

async function exit(args) {
  try {
    const { stdout, stderr } = await run(NODE, args, { timeout: 60_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : -1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

// Accounts: the runner is the image's `node` (1000, no supplementary group); the Claude Code user is new (1001), in
// group juno-hook only for the socket.
appendFileSync("/etc/passwd", `juno-agent:x:${String(AGENT)}:${String(AGENT)}::/home/juno-agent:/usr/sbin/nologin\n`);
appendFileSync("/etc/group", `juno-agent:x:${String(AGENT)}:\njuno-hook:x:${String(HOOK_GROUP)}:juno-agent\n`);
const groupFile = readFileSync("/etc/group", "utf8");

// A stand-in for `claude --version` (the install asks it); root's, like the real binary would be.
mkdirSync("/opt/fake-claude", { mode: 0o755 });
writeFileSync("/opt/fake-claude/claude", "#!/usr/local/bin/node\nprocess.stdout.write(\"2.1.319 (Claude Code)\\n\");\n", { mode: 0o755 });

// The trust anchor: public, root's.
mkdirSync("/etc/juno", { mode: 0o755 });
writeFileSync("/etc/juno/operator.pub", generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }), { mode: 0o444 });

// The runner's state folder and the socket folder (Part E: `install -d -o juno-runner -m 0700` and `-g juno-hook -m 2750`).
// The mode first, while root owns the folder; then the owner (changing a mode needs the owner, or CAP_FOWNER).
mkdirSync("/var/lib/juno-runner");
chmodSync("/var/lib/juno-runner", 0o700);
chownSync("/var/lib/juno-runner", RUNNER, RUNNER);
mkdirSync("/var/lib/juno-hook");
chmodSync("/var/lib/juno-hook", 0o2750);
chownSync("/var/lib/juno-hook", RUNNER, HOOK_GROUP);
// The workspace Claude Code works in: its own, on a tmpfs the test mounts there (a case-sensitive Linux file system,
// D-178; the container's own root is overlay, which the check refuses).
mkdirSync("/srv/work", { recursive: true, mode: 0o755 });
chmodSync("/srv/work", 0o755);
chownSync("/srv/work", AGENT, AGENT);
// A folder on the container's overlay root, for the D-178 negative control.
mkdirSync("/srv/overlay-work", { mode: 0o755 });

const results = {};
results.install = await exit([JUNO, "hook", "install", "--socket", SOCKET, "--client", CLIENT, "--node", NODE, "--claude", "/opt/fake-claude/claude"]);
results.settings = JSON.parse(readFileSync("/etc/claude-code/managed-settings.json", "utf8"));
results.modes = Object.fromEntries(["/var/lib/juno-runner", "/var/lib/juno-hook", "/etc/claude-code", "/etc/claude-code/managed-settings.json"].map((path) => { const stats = statSync(path); return [path, { uid: stats.uid, gid: stats.gid, mode: (stats.mode & 0o7777).toString(8) }]; }));

const check = (overrides = {}, states = ["/var/lib/juno-runner", "/var/lib/juno-runner/journal", "/var/lib/juno-runner/grants", "/var/lib/juno-runner/checkpoints"]) => {
  const options = { "--agent-user": "juno-agent", "--runner-user": "node", "--socket": SOCKET, "--client": CLIENT, "--node": NODE, "--anchor": "/etc/juno/operator.pub", "--workspace": "/srv/work", ...overrides };
  const args = [JUNO, "hook", "check", ...Object.entries(options).flat()];
  for (const state of states) args.push("--state", state);
  return exit(args);
};
// Part E step 14 today: before any service listens, the check refuses with exactly one line, the missing socket.
results.checkBeforeService = await check({}, ["/var/lib/juno-runner"]);

// The runner, as uid 1000 with no supplementary group.
const runner = execFile(NODE, ["/t/as-user.mjs", String(RUNNER), String(RUNNER), "", "/t/runner.mjs"], { timeout: 120_000 }, () => undefined);
const ready = await new Promise((resolve, reject) => {
  let text = "";
  runner.stdout.on("data", (chunk) => {
    text += String(chunk);
    if (text.includes("\n")) resolve(JSON.parse(text.slice(0, text.indexOf("\n"))));
  });
  runner.stderr.on("data", (chunk) => reject(new Error(String(chunk))));
  runner.on("exit", (code) => reject(new Error(`runner exited ${String(code)}`)));
});
results.runner = ready;

results.check = await check();

// The Claude Code user, as uid 1001 holding group juno-hook.
const agent = await exit(["/t/as-user.mjs", String(AGENT), String(AGENT), String(HOOK_GROUP), "/t/agent.mjs", String(ready.pid)]);
results.agent = agent.code === 0 ? JSON.parse(agent.stdout) : agent;

// The check's negative controls: each must refuse.
results.negative = {};
results.negative.agentIsRoot = await check({ "--agent-user": "root" });
results.negative.agentIsRunner = await check({ "--agent-user": "node" });
writeFileSync("/etc/group", groupFile.replace(/^node:x:1000:$/m, "node:x:1000:juno-agent"));
results.negative.agentInRunnersGroup = await check();
writeFileSync("/etc/group", groupFile);
chmodSync("/etc/claude-code/managed-settings.json", 0o666);
results.negative.settingsWritable = await check();
chmodSync("/etc/claude-code/managed-settings.json", 0o644);
// D-178: a workspace on a file system that is not a native case-sensitive Linux one (here the container's overlay root).
results.negative.workspaceOnOverlay = await check({ "--workspace": "/srv/overlay-work" });
results.recheck = await check();

runner.stdin.end();
process.stdout.write(`${JSON.stringify(results)}\n`);
