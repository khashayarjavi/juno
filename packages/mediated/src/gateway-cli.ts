import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  type Anchoring,
  type AnchoringConfig,
  DEFAULT_ANCHOR_PIN,
  GrantStore,
  type HostIo,
  HostPathResolver,
  HostReadView,
  SessionLayer,
  StartupRefused,
  type StartupSpec,
  anchoringState,
  gitAnchoring,
  parseAnchorInterval,
  systemHostIo,
} from "../../enforcement/src/index.js";
import { type FilesystemIo, systemFilesystemIo } from "./filesystem.js";
import { GatewaySessionRequest, McpGateway } from "./gateway.js";
import { GatewayService } from "./gateway-service.js";
import { StdioUpstream } from "./gateway-stdio.js";

/**
 * `juno gateway serve` (build plan Slice 1.5 Increment 5 item 3; DECISIONS.md D-188, D-191, D-194): run as the runner,
 * it loads the gateway session file the operator wrote, admits the session as a Task, starts the operator's upstream MCP
 * server by `execFile(program, argv)`, and serves the gateway on its Unix socket until it is stopped. Claude Code (or
 * any MCP client) reaches it only through the stdio shim `juno-mcp.js` (D-188).
 *
 *   juno gateway serve --session <file> --socket <path> --journal <dir> --anchor <operator.pub> --workspace <dir>
 *                      --journal-key <dir> --anchors <juno-anchors clone> [--anchor-pin <file>] [--anchor-interval <seconds>]
 *                      --grant <signed grant file> [--grant <file> ...]
 *
 * Before it opens anything it runs THE shared start-up check (D-193, D-194) through `SessionLayer.open`: never root;
 * none of JUNO's state (journal, session and grant files, anchor, socket and its folder) inside or overlapping the
 * workspace; nothing anyone else could change; a verified trust anchor. Then the session file is parsed and the session
 * admitted through the shared session layer. Exit 0 after a clean stop, 1 refused, 2 bad usage.
 */

/** The session file: the gateway session (D-187) and the upstream it fronts. */
export const GatewaySessionFile = z.strictObject({
  session: GatewaySessionRequest,
  upstream: z.strictObject({
    /** An absolute program path, started with no shell (CLAUDE.md rule 8). */
    program: z.string().regex(/^\//),
    argv: z.array(z.string()).max(64).default([]),
    /** The upstream's environment, which may hold its credentials; never shown to the client (§3.2). Empty by default. */
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).default({}),
  }),
});

export type GatewayCliIo = {
  /** How the shared start-up check reads the host (D-194). */
  readonly host: HostIo;
  readonly readFile: (path: string) => string;
  readonly filesystem: FilesystemIo;
  /** Tests only: the anchoring to use in place of the journal key and clone the flags name (the flags are still judged). */
  readonly anchoring?: Anchoring;
  /** Resolves when the gateway should stop (SIGINT or SIGTERM in real use). */
  readonly stopped: () => Promise<void>;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
};

const USAGE = "usage: juno gateway serve --session <file> --socket <path> --journal <dir> --anchor <operator.pub> --workspace <dir> --journal-key <dir> --anchors <juno-anchors clone> [--anchor-pin <file>] [--anchor-interval <seconds>] --grant <file> [--grant <file> ...]\n";

/** What `juno gateway serve` asks the shared start-up check to judge (D-194). */
export function gatewayStartupSpec(options: { readonly session: string; readonly socket: string; readonly journal: string; readonly anchor: string; readonly workspace: string; readonly grants: readonly string[]; readonly anchoring: AnchoringConfig }): StartupSpec {
  return {
    service: "gateway",
    journal: options.journal,
    workspaces: [options.workspace],
    state: [
      { what: "the session file", path: options.session, kind: "file" },
      ...options.grants.map((path) => ({ what: "the grant file", path, kind: "file" as const })),
      { what: "the gateway socket", path: options.socket, kind: "socket" },
      ...anchoringState(options.anchoring),
    ],
    anchor: options.anchor,
  };
}

function refused(io: GatewayCliIo, refusals: readonly string[]): number {
  io.err(`juno gateway serve: refused:\n${refusals.map((line) => `  - ${line}`).join("\n")}\n`);
  return 1;
}

/** Admits the session and serves it; returns the exit code once stopped (or at once, when refused). */
export async function runGatewayCli(args: readonly string[], io: GatewayCliIo): Promise<number> {
  const [command, ...rest] = args;
  const single = ["--session", "--socket", "--journal", "--anchor", "--workspace", "--journal-key", "--anchors", "--anchor-interval", "--anchor-pin"];
  const options = new Map<string, string>();
  const grantFiles: string[] = [];
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index] ?? "";
    const value = rest[index + 1];
    if (value === undefined || (name !== "--grant" && (!single.includes(name) || options.has(name)))) {
      io.err(USAGE);
      return 2;
    }
    if (name === "--grant") grantFiles.push(value);
    else options.set(name, value);
  }
  const [session, socket, journalDir, anchor, workspace, journalKeyDir, anchorClone] = single.map((name) => options.get(name));
  const intervalMs = parseAnchorInterval(options.get("--anchor-interval"));
  if (command !== "serve" || session === undefined || socket === undefined || journalDir === undefined || anchor === undefined || workspace === undefined || journalKeyDir === undefined || anchorClone === undefined || intervalMs === null || grantFiles.length === 0) {
    io.err(USAGE);
    return 2;
  }
  const anchoring: AnchoringConfig = { journalKeyDir, anchorClone, intervalMs, pin: options.get("--anchor-pin") ?? DEFAULT_ANCHOR_PIN };
  // THE shared start-up check, before anything is opened (D-193, D-194).
  let layer: SessionLayer;
  try {
    layer = await SessionLayer.open(gatewayStartupSpec({ session, socket, journal: journalDir, anchor, workspace, grants: grantFiles, anchoring }), { host: io.host, lockJournal: true, anchoring: io.anchoring ?? ((root, pin) => gitAnchoring(anchoring, root, pin)) });
  } catch (error: unknown) {
    if (error instanceof StartupRefused) return refused(io, error.refusals);
    return refused(io, [error instanceof Error ? error.message : String(error)]);
  }
  const trust = layer.anchor;
  if (trust === null) { layer.releaseLock(); return refused(io, ["no verified trust anchor (D-194)"]); }
  const refusals: string[] = [];
  let file: z.output<typeof GatewaySessionFile> | null = null;
  const grants: unknown[] = [];
  try {
    const parsed = GatewaySessionFile.safeParse(JSON.parse(io.readFile(session)));
    if (parsed.success) file = parsed.data;
    else refusals.push(`the session file ${session} is not a gateway session: ${parsed.error.message}`);
  } catch (error: unknown) {
    refusals.push(`the session file ${session} cannot be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const grantFile of grantFiles) {
    try {
      grants.push(JSON.parse(io.readFile(grantFile)));
    } catch (error: unknown) {
      refusals.push(`the grant file ${grantFile} cannot be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (refusals.length > 0 || file === null) { layer.releaseLock(); return refused(io, refusals); }
  const store = new GrantStore(trust);
  for (const grant of grants) {
    try {
      store.add(grant);
    } catch (error: unknown) {
      { layer.releaseLock(); return refused(io, [`a grant file holds no valid grant: ${error instanceof Error ? error.message : String(error)}`]); }
    }
  }
  const upstream = file.upstream;
  const gateway = new McpGateway({
    layer,
    grants: store,
    resolver: new HostPathResolver(workspace),
    // D-228: names and kinds only; the read view never opens a file in the workspace.
    view: new HostReadView(workspace),
    filesystem: io.filesystem,
    upstream: (refusedRequest) => new StdioUpstream(upstream.program, upstream.argv, { env: { ...upstream.env }, refused: refusedRequest }),
  });
  const admitted = await gateway.admit(file.session);
  if (!admitted.admitted) {
    io.err(`juno gateway serve: the session was not admitted:\n${admitted.failures.map((line) => `  - ${line}`).join("\n")}\n`);
    gateway.close();
    await layer.close();
    return 1;
  }
  // 0660: the runner and the socket folder's group, through which the Claude Code user's shim connects (D-173, D-188).
  const service = new GatewayService(gateway, { socketMode: 0o660 });
  try {
    await service.listen(socket);
  } catch (error: unknown) {
    await service.close();
    layer.releaseLock();
    return refused(io, [error instanceof Error ? error.message : String(error)]);
  }
  // §3.4.1 (D-198): every record is anchored at most one interval after it is written, and once more when the gateway stops.
  layer.startAnchoring();
  // D-243: the lock of a service that was provably no longer running was taken over at this start, and recorded.
  const reclaimed = layer.reclaimedLock;
  if (reclaimed !== null) io.err(`juno gateway: the journal's lock was left by a JUNO process that is no longer running (${reclaimed.reason}, process ${String(reclaimed.holder["pid"])}), for example after WSL shut down under it. It was taken over and recorded in the journal (stale_lock_reclaimed), after the journal was checked (D-243).\n`);
  // D-206 item 1 (D-207): a torn final write was repaired at this start; say what it cost.
  const recovery = layer.recovery;
  if (recovery !== null) io.err(`juno gateway: the journal's last entry was left incomplete (a power loss or a crash in the middle of a write). It was dropped and recorded (recovered_truncation). Every grant used by a session open at that moment is now exhausted and needs a new, newly signed grant: ${recovery.exhausted_grants.length === 0 ? "(none)" : recovery.exhausted_grants.join(", ")} (D-206).\n`);
  io.out(admitted.resumed === true
    ? `juno gateway: session ${admitted.task_id} was admitted before this start; it goes on from its journal, with the budget and limits it had (D-201); serving ${socket}. Stop with Ctrl+C.\n`
    : `juno gateway: session ${admitted.task_id} admitted; serving ${socket}. Stop with Ctrl+C.\n`);
  await io.stopped();
  await service.close();
  const unanchored = await layer.close();
  if (unanchored.length > 0) {
    io.err(`juno gateway: stopped, but ${String(unanchored.length)} journal record(s) could not be anchored off the host (journalled as anchor_failed; §3.4.1).\n`);
    return 1;
  }
  io.out("juno gateway: stopped.\n");
  return 0;
}

/** The real process: the host as it is, the file system, and SIGINT or SIGTERM to stop. */
export function systemGatewayCliIo(): GatewayCliIo {
  return {
    host: systemHostIo(),
    readFile: (path) => readFileSync(path, "utf8"),
    filesystem: systemFilesystemIo(),
    stopped: () => new Promise((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    }),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  };
}
