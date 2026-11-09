// The runner's side (D-173), as uid 1000 with no supplementary group: JUNO's real journal, grant store, sessions and
// hook service, with its state under /var/lib/juno-runner (0700) and its socket in /var/lib/juno-hook (2750, group
// juno-hook), mode 0660. Prints one JSON line when ready; exits when its stdin ends.
import { createPublicKey } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

process.umask(0o077);
const { GrantStore, HostPathResolver, SessionLayer, Workspace, execFileScript } = await import("/app/dist/enforcement/src/index.js");
const { MediatedSessions, PathMap } = await import("/app/dist/mediated/src/session.js");
const { HookService } = await import("/app/dist/mediated/src/hook-service.js");
const { systemFilesystemIo } = await import("/app/dist/mediated/src/filesystem.js");

const state = "/var/lib/juno-runner";
mkdirSync(`${state}/grants`, { mode: 0o700 });
mkdirSync(`${state}/checkpoints`, { mode: 0o700 });
writeFileSync(`${state}/grants/grant-cc.json`, "{\"id\":\"grant-cc\"}\n", { mode: 0o600 });
// The shared start-up check, on the real host as the runner (uid 1000), then the shared session layer (D-194).
const layer = SessionLayer.open({
  service: "hook",
  journal: `${state}/journal`,
  workspaces: ["/srv/work"],
  state: [{ what: "JUNO's state", path: state, kind: "path" }, { what: "the hook socket", path: "/var/lib/juno-hook/hook.sock", kind: "socket" }, { what: "Claude Code's managed settings", path: "/etc/claude-code", kind: "path" }],
  anchor: null,
});
const grants = new GrantStore(createPublicKey(readFileSync("/etc/juno/operator.pub", "utf8")));
const sessions = new MediatedSessions({
  layer,
  grants,
  paths: new PathMap(["/srv/work"]),
  resolver: new HostPathResolver("/srv/work"),
  view: new Workspace(execFileScript(process.execPath, []), "/work", "/srv/work"),
  filesystem: systemFilesystemIo(),
});
// Something in the journal to try to read: a refused admission (no such grant) is journalled.
await sessions.admit({ session_id: "probe", principal: "alireza", attendance: "gated", ttl: 60_000, grants: ["grant-missing"], budget: { tool_calls: 1, wall_clock_ms: 60_000 }, unmetered_accepted: true, provider_clearance: "internal", sources: [{ id: "w", selector: { kind: "path", prefix: "/work" }, data_class: { sensitivity: "internal", integrity: "untrusted" } }], name_map: [] });
const service = new HookService(sessions, { socketMode: 0o660 });
await service.listen("/var/lib/juno-hook/hook.sock");
process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid })}\n`);
process.stdin.resume();
process.stdin.on("end", () => {
  void service.close().then(() => process.exit(0));
});
