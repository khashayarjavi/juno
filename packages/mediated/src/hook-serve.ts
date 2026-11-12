import { z } from "zod";
import {
  type Anchoring,
  type AnchoringConfig,
  DEFAULT_GIT,
  CheckpointStore,
  type ContainerRuntime,
  GrantStore,
  type HostIo,
  HostPathResolver,
  SessionLayer,
  StartupRefused,
  type StartupSpec,
  Workspace,
  anchoringState,
  execFileScript,
  gitAnchoring,
  parseAnchorInterval,
  probeContainerRuntime,
  runtimeRefusal,
  systemHostIo,
} from "../../enforcement/src/index.js";
import { type FilesystemIo, caseFoldingRefusals, systemFilesystemIo } from "./filesystem.js";
import { HookAdmissionService, askAdmission } from "./hook-admission.js";
import { HookService } from "./hook-service.js";
import { MediatedSessions, PathMap } from "./session.js";

/**
 * `juno hook serve` and `juno hook admit` (build plan Increment 6; operator ruling D-180; DECISIONS.md D-196).
 *
 *   juno hook serve --socket <hook.sock> --control <admit.sock> --journal <dir> --anchor <operator.pub>
 *                   --journal-key <dir> --anchors <juno-anchors clone> [--anchor-interval <seconds>] [--git <program>]
 *                   --workspace <dir> --checkpoints <dir> [--protect <path> ...] [--gateway <name>]
 *   juno hook admit --control <admit.sock> <session file>
 *
 * `serve`, run as the runner, runs THE shared start-up check through `SessionLayer.open` (never root; no state in or
 * overlapping the workspace; nothing anyone else could change; a verified trust anchor; D-194), then refuses a container
 * runtime that would ignore the workloads' limits (D-131) and a workspace D-178 refuses, then serves the hook on its socket (0660, D-173) and an
 * admission socket that only the runner can reach (0600). No session is admitted until the operator asks.
 *
 * `admit`, run as the runner, names one session file. The service reads it itself, refusing it, and every grant file it
 * names, under the shared check's rules (D-196): outside every workspace, changeable by no one but root and the runner.
 * Each grant must carry the operator's signature; then the session is admitted through the shared session layer, or
 * every refusal is printed. Exit 0 admitted / served and stopped, 1 refused, 2 bad usage.
 */


export type HookServeIo = {
  readonly host: HostIo;
  readonly filesystem: FilesystemIo;
  /** The container runtime the runner's workloads would use (D-131); in real use `docker info`. */
  readonly runtime: () => Promise<ContainerRuntime>;
  /** Resolves when the service should stop (SIGINT or SIGTERM in real use). */
  readonly stopped: () => Promise<void>;
  /** Tests only: the anchoring to use in place of the journal key and clone the flags name (the flags are still judged). */
  readonly anchoring?: Anchoring;
  /** Called once the service listens; tests use it to drive it. */
  readonly ready?: (service: { readonly layer: SessionLayer }) => void;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
};

const SERVE_USAGE = "usage: juno hook serve --socket <hook.sock> --control <admit.sock> --journal <dir> --anchor <operator.pub> --journal-key <dir> --anchors <juno-anchors clone> [--anchor-interval <seconds>] [--git <program>] --workspace <dir> --checkpoints <dir> [--protect <path> ...] [--gateway <name>]\n";
const ADMIT_USAGE = "usage: juno hook admit --control <admit.sock> <session file>\n";

/** What `juno hook serve` asks the shared start-up check to judge (D-194, D-196). */
export function hookStartupSpec(options: { readonly socket: string; readonly control: string; readonly journal: string; readonly anchor: string; readonly workspace: string; readonly checkpoints: string; readonly protect: readonly string[]; readonly anchoring: AnchoringConfig }): StartupSpec {
  return {
    service: "hook",
    journal: options.journal,
    workspaces: [options.workspace],
    state: [
      { what: "the hook socket", path: options.socket, kind: "socket" },
      { what: "the admission socket", path: options.control, kind: "socket" },
      { what: "the checkpoint store", path: options.checkpoints, kind: "dir" },
      ...anchoringState(options.anchoring),
      ...options.protect.map((path) => ({ what: "protected state", path, kind: "path" as const })),
    ],
    anchor: options.anchor,
  };
}

function refused(io: { readonly err: (text: string) => void }, command: string, refusals: readonly string[]): number {
  io.err(`juno hook ${command}: refused:\n${refusals.map((line) => `  - ${line}`).join("\n")}\n`);
  return 1;
}

/** `juno hook serve`: returns the exit code once stopped, or at once when refused. */
export async function runHookServeCli(args: readonly string[], io: HookServeIo): Promise<number> {
  const single = ["--socket", "--control", "--journal", "--anchor", "--workspace", "--checkpoints", "--journal-key", "--anchors", "--anchor-interval", "--git", "--gateway"];
  const options = new Map<string, string>();
  const protect: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index] ?? "";
    const value = args[index + 1];
    if (value === undefined || (name !== "--protect" && (!single.includes(name) || options.has(name)))) {
      io.err(SERVE_USAGE);
      return 2;
    }
    if (name === "--protect") protect.push(value);
    else options.set(name, value);
  }
  const [socket, control, journal, anchor, workspace, checkpoints, journalKeyDir, anchorClone] = single.slice(0, 8).map((name) => options.get(name));
  const intervalMs = parseAnchorInterval(options.get("--anchor-interval"));
  if (socket === undefined || control === undefined || journal === undefined || anchor === undefined || workspace === undefined || checkpoints === undefined || journalKeyDir === undefined || anchorClone === undefined || intervalMs === null) {
    io.err(SERVE_USAGE);
    return 2;
  }
  const anchoring: AnchoringConfig = { journalKeyDir, anchorClone, intervalMs, git: options.get("--git") ?? DEFAULT_GIT };
  // D-131 (plan Increment 6): a runtime that would ignore the workloads' limits stops the service from starting.
  try {
    const why = runtimeRefusal(await io.runtime());
    if (why !== null) return refused(io, "serve", [why]);
  } catch (error: unknown) {
    return refused(io, "serve", [`the container runtime could not be checked: ${error instanceof Error ? error.message : String(error)} (D-131)`]);
  }
  // D-178 (plan Increment 6): the workspace must be a case-sensitive Linux file system with no folding folder, checked at
  // start as well as at every admission; a workspace JUNO cannot check is refused.
  const folding = await caseFoldingRefusals([{ what: "the workspace", path: workspace }], io.filesystem);
  if (folding.length > 0) return refused(io, "serve", folding);
  // THE shared start-up check, before anything is opened; the two checks above open nothing either (D-193, D-194).
  let layer: SessionLayer;
  try {
    layer = await SessionLayer.open(hookStartupSpec({ socket, control, journal, anchor, workspace, checkpoints, protect, anchoring }), { host: io.host, anchoring: io.anchoring ?? ((root) => gitAnchoring(anchoring, root)) });
  } catch (error: unknown) {
    return refused(io, "serve", error instanceof StartupRefused ? error.refusals : [error instanceof Error ? error.message : String(error)]);
  }
  const trust = layer.anchor;
  if (trust === null) return refused(io, "serve", ["no verified trust anchor (D-194)"]);
  const grants = new GrantStore(trust);
  const view = new Workspace(execFileScript(process.execPath, []), "/work", workspace);
  const gateway = options.get("--gateway");
  let sessions: MediatedSessions;
  try {
    sessions = new MediatedSessions({
      layer,
      grants,
      paths: new PathMap([workspace]),
      resolver: new HostPathResolver(workspace),
      view,
      filesystem: io.filesystem,
      checkpoints: { workspace: view, store: new CheckpointStore(checkpoints) },
      ...(gateway === undefined ? {} : { gateway: { server: gateway } }),
    });
  } catch (error: unknown) {
    return refused(io, "serve", [error instanceof Error ? error.message : String(error)]);
  }
  // 0660: the runner and the socket folder's group, through which the Claude Code user's hook connects (D-173).
  const hook = new HookService(sessions, { socketMode: 0o660 });
  const admission = new HookAdmissionService(sessions, grants);
  try {
    await hook.listen(socket);
    await admission.listen(control);
  } catch (error: unknown) {
    await Promise.all([hook.close(), admission.close()]);
    return refused(io, "serve", [error instanceof Error ? error.message : String(error)]);
  }
  // §3.4.1 (D-198): every record is anchored at most one interval after it is written, and once more when the service stops.
  layer.startAnchoring();
  // D-201: sessions admitted before this start go on from the journal; they are never admitted again.
  const rebuilt = sessions.rebuilt;
  if (rebuilt.sessions.length > 0) io.out(`juno hook: ${String(rebuilt.sessions.length)} session(s) admitted before this start go on from the journal, with the budget and limits they had (D-201).\n`);
  for (const why of rebuilt.grants) io.err(`juno hook: a grant file could not be read again, so its grant is absent until the service is restarted with the file in place: ${why}\n`);
  for (const [id, why] of rebuilt.failed) io.err(`juno hook: ${id} could not be rebuilt from the journal and stays closed: ${why}\n`);
  io.out(`juno hook: serving ${socket}; admit a session with: juno hook admit --control ${control} <session file>. Stop with Ctrl+C.\n`);
  io.ready?.({ layer });
  await io.stopped();
  await Promise.all([hook.close(), admission.close()]);
  const unanchored = await layer.close();
  if (unanchored.length > 0) {
    io.err(`juno hook: stopped, but ${String(unanchored.length)} journal record(s) could not be anchored off the host (journalled as anchor_failed; §3.4.1).\n`);
    return 1;
  }
  io.out("juno hook: stopped.\n");
  return 0;
}

/** The real process for `juno hook serve`. */
export function systemHookServeIo(): HookServeIo {
  return {
    host: systemHostIo(),
    filesystem: systemFilesystemIo(),
    runtime: probeContainerRuntime,
    stopped: () => new Promise((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    }),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  };
}

/** `juno hook admit`: asks the running service to admit the session file; prints `admitted` or every refusal. */
export async function runHookAdmitCli(args: readonly string[], io: { readonly out: (text: string) => void; readonly err: (text: string) => void }): Promise<number> {
  const [flag, control, file, ...extra] = args;
  if (flag !== "--control" || control === undefined || file === undefined || extra.length > 0 || !control.startsWith("/") || !file.startsWith("/")) {
    io.err(ADMIT_USAGE);
    return 2;
  }
  let answer: unknown;
  try {
    answer = await askAdmission(control, file);
  } catch (error: unknown) {
    return refused(io, "admit", [`the hook service at ${control} is not reachable: ${error instanceof Error ? error.message : String(error)}`]);
  }
  const parsed = z.union([z.object({ admitted: z.literal(true), task_id: z.string(), check: z.object({ journal: z.string(), anchors: z.string(), key: z.string() }).optional() }), z.object({ admitted: z.literal(false), failures: z.array(z.string()) })]).safeParse(answer);
  if (!parsed.success) return refused(io, "admit", ["the hook service's answer could not be read"]);
  if (!parsed.data.admitted) return refused(io, "admit", parsed.data.failures);
  const sessionId = parsed.data.task_id.replace(/^session-/, "");
  io.out(`admitted ${parsed.data.task_id}\nStart Claude Code for it with: claude --session-id ${sessionId}\n`);
  const check = parsed.data.check;
  // §3.4.1 (D-198): the line that checks this session's journal against the anchors pushed to juno-anchors.
  if (check !== undefined) io.out(`Check its journal with: node /opt/juno/dist/runner/src/juno.js journal check --journal ${check.journal} --anchors ${check.anchors} --key ${check.key} ${parsed.data.task_id}\n`);
  return 0;
}
