import { execFile } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { McpGateway, Upstream } from "./gateway.js";

/**
 * The gateway's two stdio sides (MCP stdio transport: one JSON-RPC message per line). The upstream server is started by
 * `execFile(program, argv)` with an argv array and no shell (CLAUDE.md rule 8); its credentials stay in its own
 * environment, which the gateway passes and the client never sees (§3.2). Fail-closed throughout: an upstream that exits,
 * says something unreadable or does not answer in time rejects every call waiting on it.
 */

const MAX_LINE = 4 * 1024 * 1024;
const MAX_OUTPUT = 64 * 1024 * 1024;

/** Splits a stream into lines; a line above MAX_LINE ends the stream with an error. */
export function lines(stream: Readable, onLine: (line: string) => void, onEnd: (error: Error | null) => void): void {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffered += chunk;
    for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      if (line.trim() !== "") onLine(line);
    }
    if (buffered.length > MAX_LINE) {
      stream.destroy();
      onEnd(new Error("a message longer than 4 MiB"));
    }
  });
  stream.on("end", () => onEnd(null));
  stream.on("error", (error: Error) => onEnd(error));
}

/** An upstream MCP server over stdio. */
export class StdioUpstream implements Upstream {
  readonly #child: ReturnType<typeof execFile>;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly #timeoutMs: number;
  #next = 1;
  #ended: Error | null = null;

  constructor(program: string, argv: readonly string[], options: { readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number; readonly refused: (method: string) => void }) {
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#child = execFile(program, [...argv], { env: options.env ?? {}, maxBuffer: MAX_OUTPUT, encoding: "utf8", shell: false }, (error) => {
      this.#end(error ?? new Error("the upstream server exited"));
    });
    const stdout = this.#child.stdout;
    if (stdout === null) throw new Error("the upstream server has no stdout");
    lines(stdout, (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.#end(new Error("the upstream server sent a line that is not JSON"));
        return;
      }
      this.#receive(message, options.refused);
    }, (error) => {
      this.#end(error ?? new Error("the upstream server closed its output"));
    });
    this.#child.stdin?.on("error", () => undefined);
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#ended !== null) return Promise.reject(this.#ended);
    const id = this.#next;
    this.#next += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`the upstream server did not answer ${method} in time`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#ended === null) this.#send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  close(): void {
    this.#end(new Error("the gateway closed the upstream"));
    this.#child.kill();
  }

  #send(message: unknown): void {
    this.#child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  #receive(message: unknown, refused: (method: string) => void): void {
    if (typeof message !== "object" || message === null) return;
    const { id, method, result, error } = message as { id?: unknown; method?: unknown; result?: unknown; error?: unknown };
    if (typeof method === "string") {
      // A request from the server to the client (elicitation, sampling, roots): never forwarded (D-186).
      if (id !== undefined) {
        refused(method);
        this.#send({ jsonrpc: "2.0", id, error: { code: -32601, message: "JUNO's gateway forwards no request from the server to the client" } });
      }
      return;
    }
    if (typeof id !== "number") return;
    const waiting = this.#pending.get(id);
    if (waiting === undefined) return;
    this.#pending.delete(id);
    clearTimeout(waiting.timer);
    if (error !== undefined) waiting.reject(new Error(`the upstream server answered with an error: ${JSON.stringify(error).slice(0, 500)}`));
    else waiting.resolve(result);
  }

  #end(error: Error): void {
    if (this.#ended !== null) return;
    this.#ended = error;
    for (const waiting of this.#pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.#pending.clear();
  }
}

/** Serves one client over stdio: each line is one message, answered in order. Returns when the client's input ends. */
export function serveStdio(gateway: McpGateway, input: Readable, output: Writable): Promise<void> {
  let queue: Promise<void> = Promise.resolve();
  return new Promise((resolve) => {
    lines(input, (line) => {
      queue = queue.then(async () => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JUNO could not read this message (§4.3 fail-closed)" } })}\n`);
          return;
        }
        const reply = await gateway.handle(message);
        if (reply !== null) output.write(`${JSON.stringify(reply)}\n`);
      });
    }, () => {
      void queue.then(() => {
        gateway.close();
        resolve();
      });
    });
  });
}
