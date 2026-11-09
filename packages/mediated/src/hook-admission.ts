import { chmodSync } from "node:fs";
import { type Server, type Socket, connect, createServer } from "node:net";
import { z } from "zod";
import { GrantStore, SessionLayer } from "../../enforcement/src/index.js";
import type { MediatedSessions } from "./session.js";
import { HookSessionFile } from "./hook-session-file.js";

/**
 * The hook service's admission socket (plan Increment 6; DECISIONS.md D-196): a Unix-domain socket only the runner can
 * reach (0600), local IPC like the hook's own socket (D-144). `askAdmission` is `juno hook admit`'s side of it.
 */

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
        // Restrictive (D-196): a grant enters the service's store only once its operator signature is verified, on a
        // store of its own first, so a forged grant can never take the place of the real one under its id.
        const trial = new GrantStore(this.#grants.trustAnchor);
        const id = trial.add(grant).id;
        if (trial.signed(id) === undefined) {
          failures.push(`the grant file ${grantFile} holds grant ${id} without a valid operator signature (§3.2)`);
          continue;
        }
        // A grant already held (verified by an earlier admission) is not added twice.
        if (this.#grants.signed(id) === undefined) this.#grants.add(grant);
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


/** `juno hook admit`'s request: asks the service on `socketPath` to admit the session file; resolves with its answer. */
export function askAdmission(socketPath: string, file: string): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const socket = connect(socketPath);
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
}
