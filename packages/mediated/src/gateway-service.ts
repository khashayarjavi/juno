import { chmodSync, statSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { dirname } from "node:path";
import type { McpGateway } from "./gateway.js";
import { serveStdio } from "./gateway-stdio.js";

/**
 * The gateway's service side (D-188): the runner, which alone may write the journal (D-173), serves one gateway session
 * on a Unix-domain socket it owns. Claude Code starts the root-owned stdio shim (`juno-mcp.js`), running as the Claude
 * Code user, and the shim relays each line to this socket. One connection holds the session; a second is refused.
 */
export class GatewayService {
  readonly #gateway: McpGateway;
  readonly #server: Server;
  readonly #socketMode: number;
  #busy = false;

  /** `socketMode`: the socket's mode once it listens (default 0600; 0660 in real use, with the socket folder's group, as D-173). */
  constructor(gateway: McpGateway, options: { readonly socketMode?: number } = {}) {
    this.#gateway = gateway;
    this.#socketMode = options.socketMode ?? 0o600;
    this.#server = createServer((socket) => {
      this.#serve(socket);
    });
  }

  listen(path: string): Promise<void> {
    // An absolute path only: Node reads a bare number as a TCP port (D-144).
    if (!path.startsWith("/")) return Promise.reject(new Error("the gateway service listens only on an absolute Unix socket path"));
    const folder = statSync(dirname(path));
    if ((folder.mode & 0o022) !== 0) return Promise.reject(new Error(`the socket's folder ${dirname(path)} is writable by group or others, so the socket could be replaced (D-173)`));
    const mode = this.#socketMode;
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
    this.#gateway.close();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  #serve(socket: Socket): void {
    socket.on("error", () => undefined);
    if (this.#busy) {
      socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32002, message: "JUNO's gateway already serves a session; a second client is refused" } })}\n`);
      return;
    }
    this.#busy = true;
    void serveStdio(this.#gateway, socket, socket).finally(() => {
      socket.end();
    });
  }
}
