import { chmodSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import type { McpGateway } from "./gateway.js";
import { SessionLayer } from "../../enforcement/src/index.js";
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
    // D-194: a service runs only on a session layer the shared start-up check opened for it.
    SessionLayer.require(gateway.layer, "gateway");
    this.#gateway = gateway;
    this.#socketMode = options.socketMode ?? 0o600;
    this.#server = createServer((socket) => {
      this.#serve(socket);
    });
  }

  listen(path: string): Promise<void> {
    const mode = this.#socketMode;
    // D-194: only a socket the shared start-up check judged, its folder still writable by no one else, and a mode of at
    // most 0660; an absolute path only, since Node reads a bare number as a TCP port (D-144, D-148, D-173).
    try {
      this.#gateway.layer.requireSocket(path, mode);
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    // D-243: a socket file left by a service killed without a stop is removed first, under the journal's lock.
    return this.#gateway.layer.clearStaleSocket(path).then(() => new Promise<void>((resolve, reject) => {
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
