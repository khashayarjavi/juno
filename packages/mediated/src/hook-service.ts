import { chmodSync } from "node:fs";
import { type Server, type Socket, connect, createServer } from "node:net";
import type { MediatedSessions } from "./session.js";
import { SessionLayer } from "../../enforcement/src/index.js";

/**
 * Whether nothing answers on the Unix socket at `socketPath`: a connection to it is refused (D-243). Any other outcome
 * (it answers, or the attempt fails for another reason) is "something may": the file is then never removed.
 */
export function nothingAnswers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(false);
    });
    probe.once("error", (error: Error) => {
      probe.destroy();
      resolve("code" in error && error.code === "ECONNREFUSED");
    });
  });
}

/**
 * The boundary service for mode C (spec §4.3; DECISIONS.md D-142): a Unix-domain socket on the runner's host. Each
 * connection carries one request line, `{ "event": <hook event>, "input": <Claude Code's hook input> }`, and gets one
 * answer line:
 *   - PreToolUse: `{ "decision": "none" }`, `{ "decision": "deny", "reason": <text> }`, or, for a Bash call JUNO proceeded
 *     only, `{ "decision": "allow", "updatedInput": <the whole Bash input, its command rebuilt from what JUNO judged> }`
 *     (D-152);
 *   - PostToolUse / PostToolUseFailure: `{ "recorded": true | false }`.
 * Anything it cannot read gets a denial (for PreToolUse) or `recorded: false`. Requests are judged one at a time, in
 * arrival order, so a session's calls and results are journalled in order.
 */

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

export class HookService {
  readonly #sessions: MediatedSessions;
  readonly #server: Server;
  #queue: Promise<void> = Promise.resolve();
  readonly #socketMode: number;

  /**
   * `socketMode` is the mode the socket gets once it listens (default 0600: the runner alone). In real use it is 0660,
   * and the socket's folder (the runner's, group `juno-hook`, set-group-ID, 2750) gives the socket the group through
   * which the Claude Code user, and only it, connects (D-173; STATE.md Part E).
   */
  constructor(sessions: MediatedSessions, options: { readonly socketMode?: number } = {}) {
    // D-194: a service runs only on a session layer the shared start-up check opened for it.
    SessionLayer.require(sessions.layer, "hook");
    this.#sessions = sessions;
    this.#socketMode = options.socketMode ?? 0o600;
    this.#server = createServer((socket) => {
      this.#serve(socket);
    });
  }

  /**
   * Listens on `path`, an absolute Unix socket path. Its folder must be writable by no one but its owner, or someone
   * else could replace the socket (D-173). After it listens, the socket gets the service's socket mode.
   */
  listen(path: string): Promise<void> {
    const mode = this.#socketMode;
    // D-194: only a socket the shared start-up check judged, its folder still writable by no one else, and a mode of at
    // most 0660; an absolute path only, since Node reads a bare number as a TCP port (D-144, D-148, D-173).
    try {
      this.#sessions.layer.requireSocket(path, mode);
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    // D-243: a socket file left by a service killed without a stop is removed first, under the journal's lock.
    return this.#sessions.layer.clearStaleSocket(path, nothingAnswers).then(() => new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(path, () => {
        this.#server.off("error", reject);
        try {
          chmodSync(path, mode);
        } catch (error: unknown) {
          this.#server.close();
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        resolve();
      });
    }));
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  #serve(socket: Socket): void {
    const chunks: Buffer[] = [];
    let size = 0;
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
      const line = text.slice(0, newline);
      this.#queue = this.#queue.then(async () => {
        const answer = await this.#answer(line);
        socket.end(`${JSON.stringify(answer)}\n`);
      });
    });
    socket.on("error", () => socket.destroy());
  }

  async #answer(line: string): Promise<unknown> {
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      return { decision: "deny", reason: "JUNO could not read the request, so the call is blocked (§4.3 fail-closed)" };
    }
    const event = typeof request === "object" && request !== null && "event" in request ? request.event : undefined;
    const input = typeof request === "object" && request !== null && "input" in request ? request.input : undefined;
    try {
      if (event === "PreToolUse") return await this.#sessions.preToolUse(input);
      if (event === "PostToolUse" || event === "PostToolUseFailure") return await this.#sessions.postToolUse(input);
    } catch (error: unknown) {
      return { decision: "deny", reason: `JUNO failed while judging the call, so it is blocked: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { decision: "deny", reason: "JUNO does not handle this hook event, so the call is blocked" };
  }
}
