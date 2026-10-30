import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AbsolutePath } from "../../contracts/src/index.js";

/**
 * One runner per journal (DECISIONS.md D-025 Increment 5, D-064). The lock is
 * a file in the journal root created exclusively: a second runner finds it and
 * refuses to start. A lock left by a runner that crashed is not taken over;
 * the operator removes it (§0.2 D8: when unsure, stop and ask).
 */

export const LOCK_FILE = "runner.lock";

export class RunnerLockError extends Error {
  override readonly name = "RunnerLockError";
}

export type RunnerLock = { readonly path: string; release(): void };

export function acquireRunnerLock(root: AbsolutePath, clock: () => Date = () => new Date()): RunnerLock {
  const path = join(root, LOCK_FILE);
  const token = JSON.stringify({ pid: process.pid, started_at: clock().toISOString(), nonce: Math.random().toString(36).slice(2) });
  try {
    writeFileSync(path, token, { flag: "wx", mode: 0o600 });
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      let holder = "unknown";
      try {
        holder = readFileSync(path, "utf8");
      } catch {
        // The holder could not be read; the lock still stands.
      }
      throw new RunnerLockError(`another runner holds the journal at ${root} (${LOCK_FILE}: ${holder}); one runner per journal. If no runner is running, remove ${path}`);
    }
    throw error;
  }
  let held = true;
  return {
    path,
    release(): void {
      if (!held) return;
      held = false;
      // Only our own lock is removed.
      if (readFileSync(path, "utf8") === token) unlinkSync(path);
    },
  };
}
