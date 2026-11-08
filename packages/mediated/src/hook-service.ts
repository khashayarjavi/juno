import { chmodSync, statSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { dirname } from "node:path";
import type { MediatedSessions } from "./session.js";

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

  constructor(sessions: MediatedSessions) {
    this.#sessions = sessions;
    this.#server = createServer((socket) => {
      this.#serve(socket);
    });
  }

  /**
   * Listens on `path`, an absolute Unix socket path. Its folder must be writable by no one but its owner, or someone
   * else could replace the socket (D-173). After it listens, the socket's mode is set to `mode` (default 0600: the
   * runner alone). In real use it is 0660, and the folder (the runner's, group `juno-hook`, set-group-ID, 2750) gives
   * the socket the group through which the Claude Code user, and only it, connects (STATE.md Part E).
   */
  listen(path: string, options: { readonly mode?: number } = {}): Promise<void> {
    // An absolute path only: Node reads a bare number as a TCP port, which would listen on the network (D-144, D-148).
    if (!path.startsWith("/")) return Promise.reject(new Error("the hook service listens only on an absolute Unix socket path"));
    const folder = statSync(dirname(path));
    if ((folder.mode & 0o022) !== 0) return Promise.reject(new Error(`the socket's folder ${dirname(path)} is writable by group or others, so the socket could be replaced (D-173)`));
    const mode = options.mode ?? 0o600;
    if ((mode & 0o007) !== 0 || (mode & ~0o660) !== 0) return Promise.reject(new Error("the socket's mode may give at most read and write to its owner and group (D-173)"));
    return new Promise((resolve, reject) => {
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
    });
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
