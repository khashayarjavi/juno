import { type Stats, lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { GrantStore, HostPathResolver, type TrustAnchor, Workspace, execFileScript } from "../../enforcement/src/index.js";
import { JournalWriter } from "../../journal/src/index.js";
import { type FilesystemIo, systemFilesystemIo } from "./filesystem.js";
import { GatewaySessionRequest, McpGateway } from "./gateway.js";
import { GatewayService } from "./gateway-service.js";
import { StdioUpstream } from "./gateway-stdio.js";

/**
 * `juno gateway serve` (build plan Slice 1.5 Increment 5 item 3; DECISIONS.md D-188, D-191): run as the runner, it
 * loads the gateway session file the operator wrote, admits the session as a Task, starts the operator's upstream MCP
 * server by `execFile(program, argv)`, and serves the gateway on its Unix socket until it is stopped. Claude Code (or
 * any MCP client) reaches it only through the stdio shim `juno-mcp.js` (D-188).
 *
 *   juno gateway serve --session <file> --socket <path> --journal <dir> --anchor <operator.pub> --workspace <dir>
 *                      --grant <signed grant file> [--grant <file> ...]
 *
 * It refuses, and starts nothing, when it runs as root (the gateway is the runner's, D-188), when the session file or
 * a grant file could be changed by anyone but its owner and root, when the anchor could be written by this process
 * (D-116), when a path is not absolute, or when admission refuses the session. Exit 0 after a clean stop, 1 refused,
 * 2 bad usage.
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
  readonly uid: number;
  readonly lstat: (path: string) => Stats | null;
  readonly readFile: (path: string) => string;
  readonly loadAnchor: (path: string) => TrustAnchor;
  readonly filesystem: FilesystemIo;
  /** Resolves when the gateway should stop (SIGINT or SIGTERM in real use). */
  readonly stopped: () => Promise<void>;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
};

const USAGE = "usage: juno gateway serve --session <file> --socket <path> --journal <dir> --anchor <operator.pub> --workspace <dir> --grant <file> [--grant <file> ...]\n";

/** Why a file the operator wrote could be changed by someone else (empty: it cannot). */
function ownedRefusals(what: string, path: string, io: GatewayCliIo): string[] {
  const facts = io.lstat(path);
  if (facts === null) return [`${what} ${path} does not exist`];
  if (facts.isSymbolicLink()) return [`${what} ${path} is a symbolic link; name the file itself`];
  if (!facts.isFile()) return [`${what} ${path} is not a file`];
  if (facts.uid !== 0 && facts.uid !== io.uid) return [`${what} ${path} is owned by uid ${String(facts.uid)}, neither root nor this process; its owner could change what is admitted (D-191)`];
  if ((facts.mode & 0o022) !== 0) return [`${what} ${path} is writable by group or others (mode ${(facts.mode & 0o7777).toString(8)}), who could change what is admitted (D-191)`];
  return [];
}

/** Admits the session and serves it; returns the exit code once stopped (or at once, when refused). */
export async function runGatewayCli(args: readonly string[], io: GatewayCliIo): Promise<number> {
  const [command, ...rest] = args;
  const single = ["--session", "--socket", "--journal", "--anchor", "--workspace"];
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
  const [session, socket, journalDir, anchor, workspace] = single.map((name) => options.get(name));
  if (command !== "serve" || session === undefined || socket === undefined || journalDir === undefined || anchor === undefined || workspace === undefined || grantFiles.length === 0) {
    io.err(USAGE);
    return 2;
  }
  const refusals: string[] = [];
  if (io.uid === 0) refusals.push("juno gateway serve must not run as root: the gateway is the runner's, and the runner is not root (D-130, D-188)");
  for (const [what, path] of [["the session file", session], ["the socket", socket], ["the journal", journalDir], ["the trust anchor", anchor], ["the workspace", workspace], ...grantFiles.map((file) => ["the grant file", file] as const)] as const) {
    if (!path.startsWith("/")) refusals.push(`${what} ${path} is not an absolute path`);
  }
  if (refusals.length === 0) for (const [what, path] of [["the session file", session], ...grantFiles.map((file) => ["the grant file", file] as const)] as const) refusals.push(...ownedRefusals(what, path, io));
  let file: z.output<typeof GatewaySessionFile> | null = null;
  let trust: TrustAnchor | null = null;
  const grants: unknown[] = [];
  if (refusals.length === 0) {
    try {
      const parsed = GatewaySessionFile.safeParse(JSON.parse(io.readFile(session)));
      if (parsed.success) file = parsed.data;
      else refusals.push(`the session file ${session} is not a gateway session: ${parsed.error.message}`);
    } catch (error: unknown) {
      refusals.push(`the session file ${session} cannot be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      trust = io.loadAnchor(anchor);
    } catch (error: unknown) {
      refusals.push(error instanceof Error ? error.message : String(error));
    }
    for (const grantFile of grantFiles) {
      try {
        grants.push(JSON.parse(io.readFile(grantFile)));
      } catch (error: unknown) {
        refusals.push(`the grant file ${grantFile} cannot be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (refusals.length > 0 || file === null || trust === null) {
    io.err(`juno gateway serve: refused:\n${refusals.map((line) => `  - ${line}`).join("\n")}\n`);
    return 1;
  }
  const store = new GrantStore(trust);
  for (const grant of grants) {
    try {
      store.add(grant);
    } catch (error: unknown) {
      io.err(`juno gateway serve: refused:\n  - a grant file holds no valid grant: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  const upstream = file.upstream;
  const journal = JournalWriter.open(journalDir);
  const gateway = new McpGateway({
    journal,
    grants: store,
    resolver: new HostPathResolver(workspace),
    view: new Workspace(execFileScript(process.execPath, []), "/work", workspace),
    filesystem: io.filesystem,
    upstream: (refused) => new StdioUpstream(upstream.program, upstream.argv, { env: { ...upstream.env }, refused }),
  });
  const admitted = await gateway.admit(file.session);
  if (!admitted.admitted) {
    io.err(`juno gateway serve: the session was not admitted (journalled):\n${admitted.failures.map((line) => `  - ${line}`).join("\n")}\n`);
    gateway.close();
    return 1;
  }
  // 0660: the runner and the socket folder's group, through which the Claude Code user's shim connects (D-173, D-188).
  const service = new GatewayService(gateway, { socketMode: 0o660 });
  try {
    await service.listen(socket);
  } catch (error: unknown) {
    io.err(`juno gateway serve: refused:\n  - ${error instanceof Error ? error.message : String(error)}\n`);
    await service.close();
    return 1;
  }
  io.out(`juno gateway: session ${admitted.task_id} admitted; serving ${socket}. Stop with Ctrl+C.\n`);
  await io.stopped();
  await service.close();
  io.out("juno gateway: stopped.\n");
  return 0;
}

/** The real process: its uid, the file system, and SIGINT or SIGTERM to stop. */
export function systemGatewayCliIo(loadAnchor: (path: string) => TrustAnchor): GatewayCliIo {
  return {
    uid: typeof process.geteuid === "function" ? process.geteuid() : -1,
    lstat: (path) => {
      try {
        return lstatSync(path);
      } catch {
        return null;
      }
    },
    readFile: (path) => readFileSync(path, "utf8"),
    loadAnchor,
    filesystem: systemFilesystemIo(),
    stopped: () => new Promise((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    }),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  };
}
