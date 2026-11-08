import { connect } from "node:net";
import type { Readable, Writable } from "node:stream";

/**
 * `juno-mcp`: the stdio MCP server Claude Code starts for a governed upstream (D-188). It holds nothing and decides
 * nothing: it relays each line between Claude Code and JUNO's gateway socket, which the runner serves. It uses Node's
 * built-in modules only, so it can be root-owned beside the hook client. Fail-closed: if the socket cannot be reached, or
 * closes, every request gets an error answer and nothing else is ever reached.
 *
 *   node juno-mcp.js --socket <path>
 */

const unreachable = (id: unknown, why: string): string => `${JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code: -32603, message: `JUNO's gateway is not reachable (${why}), so no call is allowed (§4.3 fail-closed)` } })}\n`;

/** Relays `input` to the socket and its answers to `output`; resolves when the input ends. */
export function relay(socketPath: string, input: Readable, output: Writable): Promise<void> {
  return new Promise((resolve) => {
    let down: string | null = null;
    let connected = false;
    const waiting: string[] = [];
    const socket = connect(socketPath);
    const fail = (why: string): void => {
      if (down !== null) return;
      down = why;
      for (const line of waiting.splice(0)) answerDown(line);
    };
    const answerDown = (line: string): void => {
      let id: unknown;
      try {
        const message = JSON.parse(line) as { id?: unknown; method?: unknown };
        if (message.id === undefined) return; // a notification gets no answer
        id = message.id;
      } catch {
        id = null;
      }
      output.write(unreachable(id, down ?? "unknown"));
    };
    socket.on("connect", () => {
      connected = true;
      for (const line of waiting.splice(0)) socket.write(`${line}\n`);
    });
    socket.on("data", (chunk: Buffer) => output.write(chunk));
    socket.on("error", (error: Error) => fail(error.message));
    socket.on("close", () => fail("the gateway closed the connection"));
    let buffered = "";
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      buffered += chunk;
      for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        if (line.trim() === "") continue;
        if (down !== null) answerDown(line);
        else if (!connected) waiting.push(line);
        else socket.write(`${line}\n`);
      }
    });
    input.on("end", () => {
      socket.end();
      resolve();
    });
  });
}

/** The entry point: `--socket <absolute path>`; anything else answers every request with an error. */
export function main(args: readonly string[], input: Readable, output: Writable): Promise<void> {
  const socketPath = args[0] === "--socket" && args.length === 2 && args[1]?.startsWith("/") === true ? args[1] : null;
  return relay(socketPath ?? "/nonexistent/juno-mcp-was-installed-without-a-socket", input, output);
}
