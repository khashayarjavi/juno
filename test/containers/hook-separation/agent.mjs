// The Claude Code user's side (D-173), as uid 1001 holding group juno-hook (1500) only for the socket: every way it
// might change the hook's configuration or reach the runner's state, each answered by the kernel. Prints one JSON object.
import { execFile } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import process from "node:process";

const runnerPid = Number(process.argv[2]);
const results = {};
function attempt(name, action) {
  try {
    action();
    results[name] = { done: true };
  } catch (error) {
    results[name] = { done: false, code: error.code ?? String(error) };
  }
}

const status = readFileSync("/proc/self/status", "utf8");
results.identity = { uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(), capEff: /CapEff:\s*(\S+)/.exec(status)?.[1] ?? null };

// The hook configuration: root's managed settings, readable (Claude Code must read it), never writable.
attempt("read managed settings", () => readFileSync("/etc/claude-code/managed-settings.json", "utf8"));
attempt("write managed settings", () => writeFileSync("/etc/claude-code/managed-settings.json", "{}"));
attempt("append to managed settings", () => appendFileSync("/etc/claude-code/managed-settings.json", " "));
attempt("chmod managed settings", () => chmodSync("/etc/claude-code/managed-settings.json", 0o666));
attempt("remove managed settings", () => unlinkSync("/etc/claude-code/managed-settings.json"));
attempt("rename managed settings", () => renameSync("/etc/claude-code/managed-settings.json", "/tmp/stolen.json"));
attempt("create a managed drop-in", () => { mkdirSync("/etc/claude-code/managed-settings.d"); writeFileSync("/etc/claude-code/managed-settings.d/off.json", "{\"disableAllHooks\":true}"); });
attempt("create beside managed settings", () => writeFileSync("/etc/claude-code/other.json", "{}"));
attempt("replace the managed folder", () => renameSync("/etc/claude-code", "/tmp/claude-code"));
// What the hook runs.
attempt("replace the hook client", () => writeFileSync("/app/dist/mediated/src/juno-hook.js", "process.exit(0)"));
attempt("replace the hook client's import", () => writeFileSync("/app/dist/mediated/src/hook-client.js", "export {}"));
attempt("remove the hook client", () => unlinkSync("/app/dist/mediated/src/juno-hook.js"));
attempt("replace node", () => openSync("/usr/local/bin/node", "w"));
// JUNO's state.
attempt("list the runner's state", () => readdirSync("/var/lib/juno-runner"));
attempt("list the journal", () => readdirSync("/var/lib/juno-runner/journal"));
attempt("write the journal", () => writeFileSync("/var/lib/juno-runner/journal/forged", "x"));
attempt("list the grants", () => readdirSync("/var/lib/juno-runner/grants"));
attempt("read a grant", () => readFileSync("/var/lib/juno-runner/grants/grant-cc.json"));
attempt("write a grant", () => writeFileSync("/var/lib/juno-runner/grants/forged.json", "{}"));
attempt("write a checkpoint", () => writeFileSync("/var/lib/juno-runner/checkpoints/forged", "x"));
attempt("remove the runner's state", () => rmSync("/var/lib/juno-runner", { recursive: true }));
attempt("read the trust anchor", () => readFileSync("/etc/juno/operator.pub", "utf8"));
attempt("write the trust anchor", () => writeFileSync("/etc/juno/operator.pub", "forged"));
attempt("replace the trust anchor", () => renameSync("/etc/juno/operator.pub", "/tmp/anchor"));
// The socket and its permissions.
attempt("chmod the socket", () => chmodSync("/var/lib/juno-hook/hook.sock", 0o666));
attempt("remove the socket", () => unlinkSync("/var/lib/juno-hook/hook.sock"));
attempt("create in the socket folder", () => writeFileSync("/var/lib/juno-hook/fake.sock", "x"));
attempt("chmod the socket folder", () => chmodSync("/var/lib/juno-hook", 0o777));
attempt("replace the socket folder", () => renameSync("/var/lib/juno-hook", "/tmp/juno-hook"));
// The runner's process.
attempt("signal the runner", () => process.kill(runnerPid, "SIGTERM"));
attempt("read the runner's environment", () => readFileSync(`/proc/${String(runnerPid)}/environ`));
attempt("read the runner's memory map", () => readFileSync(`/proc/${String(runnerPid)}/maps`));

// Positive control: the real hook client, as Claude Code would run it, reaches JUNO and gets JUNO's answer.
const input = JSON.stringify({ session_id: "not-admitted", hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/srv/work/x" }, tool_use_id: "t1", cwd: "/srv/work" });
results.hook = await new Promise((resolve) => {
  const child = execFile("/usr/local/bin/node", ["/app/dist/mediated/src/juno-hook.js", "--socket", "/var/lib/juno-hook/hook.sock"], { timeout: 20_000 }, (error, stdout, stderr) => {
    resolve({ code: error === null ? 0 : (error.code ?? -1), stdout, stderr });
  });
  child.stdin.end(input);
});
process.stdout.write(`${JSON.stringify(results)}\n`);
