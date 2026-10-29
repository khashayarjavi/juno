import { lstatSync, unlinkSync } from "node:fs";
import { type Server, connect, createServer } from "node:net";
import { join } from "node:path";

/**
 * One runner per journal volume (DECISIONS.md D-025 Increment 5, D-064).
 *
 * The runner listens on a Unix socket in the journal root while it runs. A
 * second runner finds the socket answering and refuses to start. The kernel
 * closes the socket when the holder exits, however it exits, so a runner that
 * crashed leaves a socket file nobody answers: that one is stale, and the next
 * runner replaces it. Only a socket file is ever replaced; any other file at
 * the path refuses the start (fail closed).
 *
 * Accepted residual (§0.5 corollary): two runners that both find the same
 * stale socket in the same instant can both replace it. The window is the time
 * between one failed connect and one bind, after a crash.
 */

export const RUNNER_LOCK_FILE = "runner.lock";

export class RunnerLockError extends Error {
  override readonly name = "RunnerLockError";
}

export type RunnerLock = {
  readonly path: string;
  release(): Promise<void>;
};

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function listen(path: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      // The lock never keeps the process alive on its own.
      server.unref();
      resolve(server);
    });
  });
}

/** Whether a runner answers on the socket at `path`. */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      const code = errorCode(error);
      if (code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
}

/** Takes the journal volume's runner lock, or throws RunnerLockError when another runner holds it. */
export async function acquireRunnerLock(journalRoot: string): Promise<RunnerLock> {
  const path = join(journalRoot, RUNNER_LOCK_FILE);
  let server: Server;
  try {
    server = await listen(path);
  } catch (error: unknown) {
    if (errorCode(error) !== "EADDRINUSE") throw error;
    if (!lstatSync(path).isSocket()) throw new RunnerLockError(`${path} exists and is not a runner socket; refusing to start`);
    if (await answers(path)) throw new RunnerLockError(`another runner holds the journal at ${journalRoot} (${path}); one runner per journal volume`);
    // Stale: its holder is gone.
    unlinkSync(path);
    server = await listen(path);
  }
  let released = false;
  return {
    path,
    release: () =>
      new Promise((resolve, reject) => {
        if (released) {
          resolve();
          return;
        }
        released = true;
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
