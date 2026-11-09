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
import { TextDecoder } from "node:util";
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

// §3.4.1 (D-198): the service anchors its journal. This image has no git, so a root-owned stand-in (fake-git.mjs) pushes
// to a stand-in destination beside the clone; the start-up check judges it like the real /usr/bin/git.
mkdirSync("/opt/fake-git", { mode: 0o755 });
writeFileSync("/opt/fake-git/git", readFileSync("/t/fake-git.mjs", "utf8").replace(/^/, "#!/usr/local/bin/node\n"), { mode: 0o755 });
chmodSync("/opt/fake-git/git", 0o755);

// The trust anchor: public, root's.
mkdirSync("/etc/juno", { mode: 0o755 });
// The operator's key pair is made here for this run; the private key never leaves this process (it signs the grant below).
const operator = generateKeyPairSync("ed25519");
writeFileSync("/etc/juno/operator.pub", operator.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o444 });

// The runner's state folder and the socket folder (Part E: `install -d -o juno-runner -m 0700` and `-g juno-hook -m 2750`).
// The mode first, while root owns the folder; then the owner (changing a mode needs the owner, or CAP_FOWNER).
// The runner image already holds it, the runner's and 0700, as Part E makes it (D-198: the journal key and the anchor
// clone live there). Root here holds no CAP_FOWNER, so it is checked, not changed.
{
  const runnerState = statSync("/var/lib/juno-runner");
  if (runnerState.uid !== RUNNER || (runnerState.mode & 0o777) !== 0o700) throw new Error("/var/lib/juno-runner is not the runner's 0700 folder");
}
mkdirSync("/var/lib/juno-hook");
chmodSync("/var/lib/juno-hook", 0o2750);
chownSync("/var/lib/juno-hook", RUNNER, HOOK_GROUP);
// The workspace Claude Code works in: its own, on a tmpfs the test mounts there (a case-sensitive Linux file system,
// D-178; the container's own root is overlay, which the check refuses).
mkdirSync("/srv/work", { recursive: true, mode: 0o755 });
chmodSync("/srv/work", 0o755);
// Plan Increment 6's file to read, made before the workspace is handed to the Claude Code user.
mkdirSync("/srv/work/project", { mode: 0o755 });
writeFileSync("/srv/work/project/notes.txt", "notes\n");
chownSync("/srv/work/project", AGENT, AGENT);
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

// Plan Increment 6 (D-180, D-196): the real `juno hook serve`, as the runner, admits the operator's session with the real
// `juno hook admit`; the real hook client, as the Claude Code user, gets an allowed read and a denied write outside the
// grant; both are journalled. Then: it refuses to start on a workspace D-178 refuses.
const { signGrant } = await import("/app/dist/enforcement/src/index.js");
const { readPayload, readTrajectory } = await import("/app/dist/journal/src/index.js");
const SESSION = "7d2c4b1a-0e3f-4a5b-9c6d-112233445566";
const SERVE_SOCKET = "/var/lib/juno-hook/serve.sock";
const CONTROL = "/var/lib/juno-runner/admit.sock";
const SERVE_JOURNAL = "/var/lib/juno-runner/serve-journal";
// The machine's container runtime, as `docker info` reports it on Part E's rootless setup (cgroup v2, systemd): this
// container has no Docker (D-065), so a stand-in on the runner's PATH answers the probe; the probe itself is D-149's.
mkdirSync("/opt/fake-docker", { mode: 0o755 });
writeFileSync("/opt/fake-docker/docker", "#!/usr/local/bin/node\nprocess.stdout.write(JSON.stringify({ CgroupDriver: \"systemd\", CgroupVersion: \"2\", SecurityOptions: [\"name=rootless\"] }));\n", { mode: 0o755 });
const runnerEnv = { ...process.env, PATH: `/opt/fake-docker:${process.env.PATH ?? ""}` };
// The operator writes the session and grant files as the runner, into its 0700 state (root here cannot write there).
const asRunnerFile = (path, text) => run(NODE, ["/t/as-user.mjs", String(RUNNER), String(RUNNER), "", "/t/write-file.mjs", path, text]);
const now = Date.now();
await asRunnerFile("/var/lib/juno-runner/grants/grant-serve.json", JSON.stringify(signGrant({ id: "grant-serve", principal: "alireza", capability_selector: { capabilities: ["cc.read", "cc.write"] }, resource_scope: [{ kind: "path", prefix: "/work/project" }], data_class_bounds: { max_sensitivity: "internal", min_integrity: "untrusted" }, issuance: "preissued", issued_by: "alireza", issued_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 3_600_000).toISOString(), max_invocations: 10, attenuation_parent: null, revoked_at: null }, operator.privateKey)));
await asRunnerFile("/var/lib/juno-runner/session.json", JSON.stringify({ session: { session_id: SESSION, principal: "alireza", attendance: "gated", ttl: 3_600_000, grants: ["grant-serve"], budget: { tool_calls: 10, wall_clock_ms: 3_600_000 }, unmetered_accepted: true, provider_clearance: "internal", sources: [{ id: "project", selector: { kind: "path", prefix: "/work/project" }, data_class: { sensitivity: "internal", integrity: "untrusted" } }], name_map: [] }, grants: ["/var/lib/juno-runner/grants/grant-serve.json"] }));

const ANCHOR_CLONE = "/var/lib/juno-runner/juno-anchors";
const JOURNAL_KEY = "/var/lib/juno-runner/journal-key";
const serveArgs = (workspace, journal) => [JUNO, "hook", "serve", "--socket", SERVE_SOCKET, "--control", CONTROL, "--journal", journal, "--anchor", "/etc/juno/operator.pub", "--journal-key", JOURNAL_KEY, "--anchors", ANCHOR_CLONE, "--git", "/opt/fake-git/git", "--workspace", workspace, "--checkpoints", "/var/lib/juno-runner/serve-checkpoints", "--protect", "/etc/claude-code"];
/** Runs `node <args>` as uid:gid with groups, feeding `input` on stdin; resolves with its exit. */
const asUser = (uid, groups, args, input = "", env = process.env) => new Promise((resolve) => {
  const child = execFile(NODE, ["/t/as-user.mjs", String(uid), String(uid), groups, ...args], { timeout: 60_000, env }, (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : -1, stdout, stderr }));
  child.stdin.end(input);
});
results.serve = {};
// D-178: on the container's overlay root the command refuses to start, and nothing listens.
results.serve.overlay = await asUser(RUNNER, "", serveArgs("/srv/overlay-work", "/var/lib/juno-runner/overlay-journal"), "", runnerEnv);
results.serve.overlayJournalCreated = (() => { try { statSync("/var/lib/juno-runner/overlay-journal"); return true; } catch { return false; } })();
// The real service, as the runner.
let served;
let servedOut = "";
const servedExit = new Promise((resolve) => {
  served = execFile(NODE, ["/t/as-user.mjs", String(RUNNER), String(RUNNER), "", ...serveArgs("/srv/work", SERVE_JOURNAL)], { timeout: 120_000, env: runnerEnv }, (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : -1, stdout, stderr }));
});
served.stdout.on("data", (chunk) => {
  servedOut += String(chunk);
});
results.serve.started = await new Promise((resolve) => {
  let text = "";
  served.stdout.on("data", (chunk) => {
    text += String(chunk);
    if (text.includes("serving")) resolve({ ok: true, text });
  });
  served.stderr.on("data", (chunk) => resolve({ ok: false, text: String(chunk) }));
  served.on("exit", (code) => resolve({ ok: false, text: `exited ${String(code)}` }));
});
const hookCall = (tool, input, extra = {}) => JSON.stringify({ session_id: SESSION, hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd: "/srv/work/project", ...extra });
const client = (stdin) => asUser(AGENT, String(HOOK_GROUP), [CLIENT, "--socket", SERVE_SOCKET], stdin);
if (results.serve.started.ok) {
  results.serve.beforeAdmission = await client(hookCall("Read", { file_path: "/srv/work/project/notes.txt" }, { tool_use_id: "toolu_0" }));
  // The Claude Code user cannot reach the admission socket (the runner's alone, 0600, in a 0700 folder).
  results.serve.agentAdmit = await asUser(AGENT, String(HOOK_GROUP), [JUNO, "hook", "admit", "--control", CONTROL, "/var/lib/juno-runner/session.json"]);
  results.serve.admit = await asUser(RUNNER, "", [JUNO, "hook", "admit", "--control", CONTROL, "/var/lib/juno-runner/session.json"], "", runnerEnv);
  results.serve.read = await client(hookCall("Read", { file_path: "/srv/work/project/notes.txt" }, { tool_use_id: "toolu_1" }));
  results.serve.readResult = await client(JSON.stringify({ session_id: SESSION, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/srv/work/project/notes.txt" }, tool_use_id: "toolu_1", tool_response: { content: "notes" }, cwd: "/srv/work/project" }));
  results.serve.write = await client(hookCall("Write", { file_path: "/srv/work/outside.txt", content: "x" }, { tool_use_id: "toolu_2" }));
  results.serve.journal = readTrajectory(SERVE_JOURNAL, `session-${SESSION}`).map((entry) => {
    const blob = readPayload(SERVE_JOURNAL, entry.payload_ref);
    const body = blob.status === "present" ? JSON.parse(new TextDecoder().decode(blob.bytes)) : {};
    return { kind: entry.kind, type: body.type ?? null, outcome: body.outcome ?? null, reason: body.reason ?? null, tool: body.tool ?? null };
  });
  results.serve.socketMode = (statSync(SERVE_SOCKET).mode & 0o777).toString(8);
  results.serve.controlMode = (statSync(CONTROL).mode & 0o777).toString(8);
  // §3.4.1 (D-198): the runner stops its service; the service anchors what is pending as it stops. Then the operator's
  // check (`juno journal check`, run as the runner) reads the chain back against the anchors at the destination.
  await asUser(RUNNER, "", ["/t/signal.mjs", String(served.pid)]);
  results.serve.stopped = await servedExit;
  results.serve.stoppedText = servedOut;
  results.serve.journalCheck = await asUser(RUNNER, "", [JUNO, "journal", "check", "--journal", SERVE_JOURNAL, "--anchors", `${ANCHOR_CLONE}.remote`, "--key", `${JOURNAL_KEY}/journal-key.pub.pem`, `session-${SESSION}`]);
  results.serve.anchoringNote = results.serve.journal.some((entry) => entry.type === "anchoring");
}
// The service runs until the container stops; this driver is the container's first process, so leaving ends it.
process.stdout.write(`${JSON.stringify(results)}\n`, () => process.exit(0));
