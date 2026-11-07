import { type Server, type Socket, createServer } from "node:net";
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

  /** Listens on `path`, a Unix socket only the runner's user can reach (its directory is the runner's, mode 0700). */
  listen(path: string): Promise<void> {
    // An absolute path only: Node reads a bare number as a TCP port, which would listen on the network (D-144, D-148).
    if (!path.startsWith("/")) return Promise.reject(new Error("the hook service listens only on an absolute Unix socket path"));
    return new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(path, () => {
        this.#server.off("error", reject);
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
      if (event === "PostToolUse" || event === "PostToolUseFailure") return this.#sessions.postToolUse(input);
    } catch (error: unknown) {
      return { decision: "deny", reason: `JUNO failed while judging the call, so it is blocked: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { decision: "deny", reason: "JUNO does not handle this hook event, so the call is blocked" };
  }
}
