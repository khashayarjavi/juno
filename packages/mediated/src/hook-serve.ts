import { chmodSync } from "node:fs";
import { type Server, type Socket, createConnection, createServer } from "node:net";
import { z } from "zod";
import {
  CheckpointStore,
  type ContainerRuntime,
  GrantStore,
  type HostIo,
  HostPathResolver,
  SessionLayer,
  StartupRefused,
  type StartupSpec,
  Workspace,
  execFileScript,
  probeContainerRuntime,
  runtimeRefusal,
  systemHostIo,
} from "../../enforcement/src/index.js";
import { type FilesystemIo, systemFilesystemIo } from "./filesystem.js";
import { HookService } from "./hook-service.js";
import { MediatedSessions, PathMap, SessionRequest } from "./session.js";

/**
 * `juno hook serve` and `juno hook admit` (build plan Increment 6; operator ruling D-180; DECISIONS.md D-196).
 *
 *   juno hook serve --socket <hook.sock> --control <admit.sock> --journal <dir> --anchor <operator.pub>
 *                   --workspace <dir> --checkpoints <dir> [--protect <path> ...] [--gateway <name>]
 *   juno hook admit --control <admit.sock> <session file>
 *
 * `serve`, run as the runner, runs THE shared start-up check through `SessionLayer.open` (never root; no state in or
 * overlapping the workspace; nothing anyone else could change; a verified trust anchor; D-194), then refuses a container
 * runtime that would ignore the workloads' limits (D-131), then serves the hook on its socket (0660, D-173) and an
 * admission socket that only the runner can reach (0600). No session is admitted until the operator asks.
 *
 * `admit`, run as the runner, names one session file. The service reads it itself, refusing it, and every grant file it
 * names, under the shared check's rules (D-196): outside every workspace, changeable by no one but root and the runner.
 * Each grant must carry the operator's signature; then the session is admitted through the shared session layer, or
 * every refusal is printed. Exit 0 admitted / served and stopped, 1 refused, 2 bad usage.
 */

/** The session file the operator writes (plan Increment 6): the session request and the signed grant files it uses. */
export const HookSessionFile = z.strictObject({
  /** Plain-language notes for the operator; ignored. */
  comments: z.array(z.string()).optional(),
  session: SessionRequest,
  grants: z.array(z.string().regex(/^\//)).max(64).default([]),
});

const MAX_REQUEST_BYTES = 64 * 1024;

/**
 * The admission socket's service: one request line `{ "admit": "<absolute session file path>" }`, one answer line
 * `{ "admitted": true, "task_id": … }` or `{ "admitted": false, "failures": [ … ] }`. It reads the file itself, through the
 * hook layer's own rules, and admits through the hook sessions, which admit through the shared session layer.
 */
export class HookAdmissionService {
  readonly #sessions: MediatedSessions;
  readonly #grants: GrantStore;
  readonly #layer: SessionLayer;
  readonly #server: Server;
  #queue: Promise<void> = Promise.resolve();

  constructor(sessions: MediatedSessions, grants: GrantStore) {
    // D-194: only on a hook layer the shared start-up check opened, whose verified anchor checks these grants.
    this.#layer = SessionLayer.require(sessions.layer, "hook");
    this.#layer.requireGrants(grants);
    this.#sessions = sessions;
    this.#grants = grants;
    this.#server = createServer((socket) => {
      this.#serve(socket);
    });
  }

  /** Listens on a socket the start-up check judged, with mode 0600: the runner alone may ask for an admission. */
  listen(path: string): Promise<void> {
    try {
      this.#layer.requireSocket(path, 0o600);
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(path, () => {
        this.#server.off("error", reject);
        try {
          chmodSync(path, 0o600);
        } catch (error: unknown) {
          this.#server.close();
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  /** Admits the session the file names, or says every reason why not. */
  async admitFile(path: string): Promise<{ readonly admitted: true; readonly task_id: string } | { readonly admitted: false; readonly failures: readonly string[] }> {
    const refusals = this.#layer.fileRefusals("the session file", path);
    if (refusals.length > 0) return { admitted: false, failures: refusals };
    let file: z.output<typeof HookSessionFile>;
    try {
      const parsed = HookSessionFile.safeParse(JSON.parse(this.#layer.readFile(path)));
      if (!parsed.success) return { admitted: false, failures: [`the session file ${path} is not a hook session file: ${parsed.error.message}`] };
      file = parsed.data;
    } catch (error: unknown) {
      return { admitted: false, failures: [`the session file ${path} cannot be read as JSON: ${error instanceof Error ? error.message : String(error)}`] };
    }
    const failures: string[] = [];
    for (const grantFile of file.grants) {
      const grantRefusals = this.#layer.fileRefusals("the grant file", grantFile);
      if (grantRefusals.length > 0) {
        failures.push(...grantRefusals);
        continue;
      }
      try {
        const grant: unknown = JSON.parse(this.#layer.readFile(grantFile));
        const id = typeof grant === "object" && grant !== null && "id" in grant ? grant.id : undefined;
        // A grant already held (by an earlier admission) is not added twice; its signature was checked then.
        if (typeof id !== "string" || this.#grants.signed(id) === undefined) this.#grants.add(grant);
      } catch (error: unknown) {
        failures.push(`the grant file ${grantFile} holds no valid grant: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) return { admitted: false, failures };
    return this.#sessions.admit(file.session);
  }

  #serve(socket: Socket): void {
    const chunks: Buffer[] = [];
    let size = 0;
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      const newline = text.indexOf("\n");
      if (newline === -1) return;
      socket.pause();
      this.#queue = this.#queue.then(async () => {
        let answer: unknown;
        try {
          const request = z.strictObject({ admit: z.string() }).safeParse(JSON.parse(text.slice(0, newline)));
          answer = request.success ? await this.admitFile(request.data.admit) : { admitted: false, failures: ["JUNO could not read the admission request"] };
        } catch (error: unknown) {
          answer = { admitted: false, failures: [`JUNO could not admit the session: ${error instanceof Error ? error.message : String(error)}`] };
        }
        socket.end(`${JSON.stringify(answer)}\n`);
      });
    });
  }
}

export type HookServeIo = {
  readonly host: HostIo;
  readonly filesystem: FilesystemIo;
  /** The container runtime the runner's workloads would use (D-131); in real use `docker info`. */
  readonly runtime: () => Promise<ContainerRuntime>;
  /** Resolves when the service should stop (SIGINT or SIGTERM in real use). */
  readonly stopped: () => Promise<void>;
  /** Called once the service listens; tests use it to drive it. */
  readonly ready?: (service: { readonly layer: SessionLayer }) => void;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
};

const SERVE_USAGE = "usage: juno hook serve --socket <hook.sock> --control <admit.sock> --journal <dir> --anchor <operator.pub> --workspace <dir> --checkpoints <dir> [--protect <path> ...] [--gateway <name>]\n";
const ADMIT_USAGE = "usage: juno hook admit --control <admit.sock> <session file>\n";

/** What `juno hook serve` asks the shared start-up check to judge (D-194, D-196). */
export function hookStartupSpec(options: { readonly socket: string; readonly control: string; readonly journal: string; readonly anchor: string; readonly workspace: string; readonly checkpoints: string; readonly protect: readonly string[] }): StartupSpec {
  return {
    service: "hook",
    journal: options.journal,
    workspaces: [options.workspace],
    state: [
      { what: "the hook socket", path: options.socket, kind: "socket" },
      { what: "the admission socket", path: options.control, kind: "socket" },
      { what: "the checkpoint store", path: options.checkpoints, kind: "dir" },
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
  const single = ["--socket", "--control", "--journal", "--anchor", "--workspace", "--checkpoints", "--gateway"];
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
  const [socket, control, journal, anchor, workspace, checkpoints] = single.slice(0, 6).map((name) => options.get(name));
  if (socket === undefined || control === undefined || journal === undefined || anchor === undefined || workspace === undefined || checkpoints === undefined) {
    io.err(SERVE_USAGE);
    return 2;
  }
  // THE shared start-up check, before anything is opened (D-193, D-194).
  let layer: SessionLayer;
  try {
    layer = SessionLayer.open(hookStartupSpec({ socket, control, journal, anchor, workspace, checkpoints, protect }), { host: io.host });
  } catch (error: unknown) {
    return refused(io, "serve", error instanceof StartupRefused ? error.refusals : [error instanceof Error ? error.message : String(error)]);
  }
  // D-131 (plan Increment 6): a runtime that would ignore the workloads' limits stops the service from starting.
  try {
    const why = runtimeRefusal(await io.runtime());
    if (why !== null) return refused(io, "serve", [why]);
  } catch (error: unknown) {
    return refused(io, "serve", [`the container runtime could not be checked: ${error instanceof Error ? error.message : String(error)} (D-131)`]);
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
  io.out(`juno hook: serving ${socket}; admit a session with: juno hook admit --control ${control} <session file>. Stop with Ctrl+C.\n`);
  io.ready?.({ layer });
  await io.stopped();
  await Promise.all([hook.close(), admission.close()]);
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
    answer = await new Promise<unknown>((resolve, reject) => {
      const socket = createConnection(control);
      let text = "";
      socket.setTimeout(30_000, () => socket.destroy(new Error("the hook service did not answer")));
      socket.on("connect", () => socket.write(`${JSON.stringify({ admit: file })}\n`));
      socket.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
      socket.on("error", reject);
      socket.on("end", () => {
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error("the hook service's answer could not be read"));
        }
      });
    });
  } catch (error: unknown) {
    return refused(io, "admit", [`the hook service at ${control} is not reachable: ${error instanceof Error ? error.message : String(error)}`]);
  }
  const parsed = z.union([z.object({ admitted: z.literal(true), task_id: z.string() }), z.object({ admitted: z.literal(false), failures: z.array(z.string()) })]).safeParse(answer);
  if (!parsed.success) return refused(io, "admit", ["the hook service's answer could not be read"]);
  if (!parsed.data.admitted) return refused(io, "admit", parsed.data.failures);
  const sessionId = parsed.data.task_id.replace(/^session-/, "");
  io.out(`admitted ${parsed.data.task_id}\nStart Claude Code for it with: claude --session-id ${sessionId}\n`);
  return 0;
}
