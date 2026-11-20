// The end-to-end restore test's driver (D-221), as root in a sealed container from the runner image (no network; only
// CHOWN, SETUID, SETGID, FSETID and DAC_READ_SEARCH). It builds the guide's layout for a hook session's workspace:
// /srv/work belongs to the Claude Code user (1001), and carries the guide's access list, which gives the runner (1000)
// and the Claude Code user read, write and enter on everything in it and on everything made in it later (the guide
// runs `setfacl`; this image has none, so the same list is written with the kernel's own setxattr call, through perl,
// which the image has). Then: the real `juno hook serve` as the runner, the real `juno hook admit` of a session with a
// reversible workspace, the real hook client's calls as the Claude Code user, that user's own changes to the folder,
// and the real `juno checkpoint restore` and `juno checkpoint list`, as root, as the Claude Code user and as the
// runner; then the service started again on the same journal. Prints one JSON object. No shell anywhere.
import { execFile } from "node:child_process";
import { setInterval, clearInterval } from "node:timers";
import { promisify } from "node:util";
import { generateKeyPairSync } from "node:crypto";
import { appendFileSync, chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import process from "node:process";
import { TextDecoder } from "node:util";

const NODE = "/usr/local/bin/node";
const JUNO = "/app/dist/runner/src/juno.js";
const CLIENT = "/app/dist/mediated/src/juno-hook.js";
const RUNNER = 1000;
const AGENT = 1001;
const HOOK_GROUP = 1500;
const SESSION = "5e0d6c1b-2a3f-4b4c-8d5e-6f7081928374";
const SOCKET = "/var/lib/juno-hook/hook.sock";
const CONTROL = "/var/lib/juno-runner/admit.sock";
const JOURNAL = "/var/lib/juno-runner/journal";
const CHECKPOINTS = "/var/lib/juno-runner/checkpoints";
const WORK = "/srv/work";
const PROJECT = `${WORK}/project`;

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
writeFileSync("/opt/fake-docker/docker", "#!/usr/local/bin/node\nprocess.stdout.write(JSON.stringify({ CgroupDriver: \"systemd\", CgroupVersion: \"2\", SecurityOptions: [\"name=rootless\"] }));\n", { mode: 0o755 });
const runnerEnv = { ...process.env, PATH: `/opt/fake-docker:${process.env.PATH ?? ""}` };

/** Runs `node <args>` as uid with groups; resolves with its exit. */
const asUser = (uid, groups, args, env = process.env) => new Promise((resolve) => {
  const child = execFile(NODE, ["/h/as-user.mjs", String(uid), String(uid), groups, ...args], { timeout: 90_000, env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : -1, stdout, stderr }));
  child.stdin.end();
});
const asRoot = (args) => new Promise((resolve) => {
  execFile(NODE, args, { timeout: 90_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : -1, stdout, stderr }));
});
const agentDoes = async (ops, umask = "022") => JSON.parse((await asUser(AGENT, "", ["/r/act.mjs", umask, JSON.stringify(ops)])).stdout);
const runnerDoes = async (ops) => JSON.parse((await asUser(RUNNER, "", ["/r/act.mjs", "077", JSON.stringify(ops)])).stdout);

// The guide's access list (Part E, D-221): `setfacl -R -m u:juno-runner:rwX,u:juno-agent:rwX` and
// `setfacl -R -d -m u:juno-runner:rwx,u:juno-agent:rwx` on the workspace, as the kernel stores it (POSIX ACL xattr,
// version 2: owner, the two named users, group, mask, other).
const entry = (tag, perm, id) => { const b = Buffer.alloc(8); b.writeUInt16LE(tag, 0); b.writeUInt16LE(perm, 2); b.writeUInt32LE(id >>> 0, 4); return b; };
const acl = (owner, group, other) => Buffer.concat([Buffer.from([2, 0, 0, 0]), entry(0x01, owner, -1), entry(0x02, 7, RUNNER), entry(0x02, 7, AGENT), entry(0x04, group, -1), entry(0x10, 7, -1), entry(0x20, other, -1)]);
const run = promisify(execFile);
const setxattr = (path, name, value) => run("/usr/bin/perl", ["-e", "my ($p, $n, $h, $nr) = @ARGV; my $v = pack(\"H*\", $h); exit(syscall($nr, $p, $n, $v, length($v), 0) == 0 ? 0 : 1)", path, name, value.toString("hex"), process.arch === "arm64" ? "5" : "188"]);
const accessList = async (path) => {
  await setxattr(path, "system.posix_acl_access", acl(7, 5, 5));
  if (lstatSync(path).isDirectory()) await setxattr(path, "system.posix_acl_default", acl(7, 5, 5));
};

// The workspace, on a tmpfs (case-sensitive, D-178): the project as the operator left it before the session.
mkdirSync(`${PROJECT}/sub`, { recursive: true, mode: 0o755 });
writeFileSync(`${PROJECT}/notes.txt`, "notes\n", { mode: 0o644 });
writeFileSync(`${PROJECT}/sub/keep.txt`, "keep\n", { mode: 0o644 });
for (const path of [WORK, PROJECT, `${PROJECT}/sub`, `${PROJECT}/notes.txt`, `${PROJECT}/sub/keep.txt`]) {
  await accessList(path);
  chownSync(path, AGENT, AGENT);
}

// The runner's state: grants, checkpoints (its 0700 folder already exists in the image).
await runnerDoes([{ op: "mkdir", path: "/var/lib/juno-runner/grants" }, { op: "mkdir", path: CHECKPOINTS }]);
const { signGrant } = await import("/app/dist/enforcement/src/index.js");
const { readPayload, readTrajectory } = await import("/app/dist/journal/src/index.js");
const now = Date.now();
const grantText = JSON.stringify(signGrant({ id: "grant-restore", principal: "alireza", capability_selector: { capabilities: ["cc.read", "cc.write"] }, resource_scope: [{ kind: "path", prefix: "/work/project" }], data_class_bounds: { max_sensitivity: "internal", min_integrity: "untrusted" }, issuance: "preissued", issued_by: "alireza", issued_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 3_600_000).toISOString(), max_invocations: 20, attenuation_parent: null, revoked_at: null }, operator.privateKey));
const sessionText = JSON.stringify({ session: { session_id: SESSION, principal: "alireza", attendance: "gated", ttl: 3_600_000, grants: ["grant-restore"], budget: { tool_calls: 20, wall_clock_ms: 3_600_000 }, unmetered_accepted: true, provider_clearance: "internal", sources: [{ id: "project", selector: { kind: "path", prefix: "/work/project" }, data_class: { sensitivity: "internal", integrity: "untrusted" } }], name_map: [], reversible_workspaces: ["/work/project"] }, grants: ["/var/lib/juno-runner/grants/grant-restore.json"] });
await asUser(RUNNER, "", ["/h/write-file.mjs", "/var/lib/juno-runner/grants/grant-restore.json", grantText]);
await asUser(RUNNER, "", ["/h/write-file.mjs", "/var/lib/juno-runner/session.json", sessionText]);

const serveArgs = [JUNO, "hook", "serve", "--socket", SOCKET, "--control", CONTROL, "--journal", JOURNAL, "--anchor", "/etc/juno/operator.pub", "--journal-key", "/var/lib/juno-runner/journal-key", "--anchors", "/var/lib/juno-runner/juno-anchors", "--workspace", WORK, "--checkpoints", CHECKPOINTS, "--protect", "/etc/claude-code"];
/** Starts the real service as the runner; resolves once it serves (or fails), with a stop function. */
async function serve() {
  let out = "";
  let child;
  const exited = new Promise((resolve) => {
    child = execFile(NODE, ["/h/as-user.mjs", String(RUNNER), String(RUNNER), "", ...serveArgs], { timeout: 120_000, env: runnerEnv }, (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : -1, stdout, stderr }));
  });
  child.stdout.on("data", (chunk) => { out += String(chunk); });
  const started = await new Promise((resolve) => {
    const timer = setInterval(() => { if (out.includes("serving")) { clearInterval(timer); resolve(true); } }, 50);
    void exited.then(() => { clearInterval(timer); resolve(false); });
  });
  return { started, text: () => out, exited, stop: async () => { await asUser(RUNNER, "", ["/h/signal.mjs", String(child.pid)]); return exited; } };
}

const results = {};
const first = await serve();
results.started = first.started;
results.startText = first.text();
if (first.started) {
  results.admit = await asUser(RUNNER, "", [JUNO, "hook", "admit", "--control", CONTROL, "/var/lib/juno-runner/session.json"], runnerEnv);
  const hook = (tool, input, id, extra = {}) => new Promise((resolve) => {
    const child = execFile(NODE, ["/h/as-user.mjs", String(AGENT), String(AGENT), String(HOOK_GROUP), CLIENT, "--socket", SOCKET], { timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : -1, stdout, stderr }));
    child.stdin.end(JSON.stringify({ session_id: SESSION, hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: id, cwd: PROJECT, ...extra }));
  });
  // The Claude Code user's session: JUNO judges each call; the user itself writes (umask 022, as an ordinary shell).
  results.writeNew = await hook("Write", { file_path: `${PROJECT}/new/made.txt`, content: "made\n" }, "toolu_1");
  results.agentChanges = await agentDoes([
    { op: "mkdir", path: `${PROJECT}/new` },
    { op: "write", path: `${PROJECT}/new/made.txt`, text: "made\n" },
    { op: "write", path: `${PROJECT}/notes.txt`, text: "changed by Claude\n" },
    { op: "rm", path: `${PROJECT}/sub/keep.txt` },
  ]);
  // Claude Code reports the write's result, as it does after every call it ran.
  results.writeNewResult = await hook("Write", { file_path: `${PROJECT}/new/made.txt`, content: "made\n" }, "toolu_1", { hook_event_name: "PostToolUse", tool_response: { success: true } });
  results.newFolderMode = (statSync(`${PROJECT}/new`).mode & 0o7777).toString(8);
  // The Claude Code user takes the runner's access off one folder (as its owner may): JUNO's next write there parks,
  // because the restore could not undo it (D-221).
  results.lockOut = await agentDoes([{ op: "mkdir", path: `${PROJECT}/locked` }, { op: "chmod", path: `${PROJECT}/locked`, mode: "755" }]);
  results.writeLocked = await hook("Write", { file_path: `${PROJECT}/locked/x.txt`, content: "x" }, "toolu_2");
  // D-223 (F2): only the runner's read is taken off (mode 333: the mask leaves it write and enter); the restore needs
  // read too, so the write parks as well.
  results.lockRead = await agentDoes([{ op: "mkdir", path: `${PROJECT}/unreadable` }, { op: "chmod", path: `${PROJECT}/unreadable`, mode: "333" }]);
  results.writeUnreadable = await hook("Write", { file_path: `${PROJECT}/unreadable/x.txt`, content: "x" }, "toolu_3");
  // D-225: a sticky folder of the Claude Code user's own, with a file of its own in it (the kernel then lets the runner
  // remove only its own files there): the next write below it parks.
  results.stickyMade = await agentDoes([{ op: "mkdir", path: `${PROJECT}/sticky` }, { op: "write", path: `${PROJECT}/sticky/own.txt`, text: "own\n" }, { op: "chmod", path: `${PROJECT}/sticky`, mode: "1775" }]);
  results.writeSticky = await hook("Write", { file_path: `${PROJECT}/sticky/x.txt`, content: "x" }, "toolu_4");
  results.unlockRead = await agentDoes([{ op: "chmod", path: `${PROJECT}/unreadable`, mode: "775" }, { op: "rm", path: `${PROJECT}/unreadable` }]);
  // While the service runs, the restore is refused.
  results.restoreWhileServing = await asUser(RUNNER, "", [JUNO, "checkpoint", "restore", "--journal", JOURNAL, "--checkpoints", CHECKPOINTS, "--workspace", WORK, "--principal", "alireza", `session-${SESSION}`, "0".repeat(64)]);
  results.stopped = await first.stop();
}
results.list = await asUser(RUNNER, "", [JUNO, "checkpoint", "list", "--journal", JOURNAL, `session-${SESSION}`]);
const checkpoint = results.list.code === 0 ? JSON.parse(results.list.stdout).checkpoints[0]?.checkpoint ?? "" : "";
const restoreArgs = [JUNO, "checkpoint", "restore", "--journal", JOURNAL, "--checkpoints", CHECKPOINTS, "--workspace", WORK, "--principal", "alireza", `session-${SESSION}`, checkpoint];
const listing = () => {
  const walk = (dir, rel) => readdirSync(dir).sort().flatMap((name) => {
    const path = `${dir}/${name}`;
    const s = lstatSync(path);
    const here = `${rel}${name}${s.isDirectory() ? "/" : ""}`;
    return s.isDirectory() ? [here, ...walk(path, here)] : [`${here}=${readFileSync(path, "utf8").trim()}`];
  });
  return walk(PROJECT, "");
};
results.before = listing();
results.asRoot = await asRoot(restoreArgs);
results.asAgent = await asUser(AGENT, String(HOOK_GROUP), restoreArgs);
// The folder the runner cannot change: refused, nothing changed.
results.locked = await asUser(RUNNER, "", restoreArgs);
results.afterLocked = listing();
// The locked folder given back, the sticky one not yet: refused again, before anything changes (D-225).
results.unlock = await agentDoes([{ op: "chmod", path: `${PROJECT}/locked`, mode: "775" }]);
results.sticky = await asUser(RUNNER, "", restoreArgs);
results.afterSticky = listing();
results.unstick = await agentDoes([{ op: "chmod", path: `${PROJECT}/sticky`, mode: "775" }]);
// With both given back, the restore brings the whole folder back.
results.restored = await asUser(RUNNER, "", restoreArgs);
results.after = listing();
results.journal = readTrajectory(JOURNAL, `session-${SESSION}`).map((item) => {
  const blob = readPayload(JOURNAL, item.payload_ref);
  const body = blob.status === "present" ? JSON.parse(new TextDecoder().decode(blob.bytes)) : {};
  return { kind: item.kind, actor: item.actor, type: body.type ?? null, outcome: body.outcome ?? null, reason: body.reason ?? null };
});
// The service starts again on the journal the restore wrote to; the session goes on from it (D-201).
const second = await serve();
results.restarted = second.started;
results.restartText = second.text();
if (second.started) results.restartStopped = await second.stop();
process.stdout.write(`${JSON.stringify(results)}\n`, () => process.exit(0));
