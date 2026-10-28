import { execFile } from "node:child_process";
import type { CapabilityCall } from "./call.js";

/**
 * Adapters (spec §2.1 `providers`, §2.4). An adapter turns a parsed call into
 * exactly one outbound invocation: a program and an argv array. It runs
 * nothing itself; `executeOutbound` runs the invocation it planned, so what
 * the conformance suite inspects is what is executed (DECISIONS.md D-033).
 */

/** One execFile call: the program and its argv array (§2.4 structural channel). */
export type OutboundInvocation = {
  readonly file: string;
  readonly args: readonly string[];
};

export interface Adapter {
  /** The provider id a capability lists in `providers`. */
  readonly id: string;
  /** Builds the outbound invocation for a call already parsed against the capability's interface. */
  plan(call: CapabilityCall): OutboundInvocation;
}

export type InvocationResult = {
  /** The program's exit code, or null when a signal ended it. */
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
};

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Runs an outbound invocation with execFile and an argv array; there is no
 * shell. A non-zero exit is a result, not an error. Failing to start the
 * program at all (for example, it does not exist) rejects.
 */
export function executeOutbound(invocation: OutboundInvocation): Promise<InvocationResult> {
  return new Promise((resolve, reject) => {
    execFile(
      invocation.file,
      [...invocation.args],
      { encoding: "buffer", maxBuffer: MAX_OUTPUT_BYTES, shell: false },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, signal: null, stdout, stderr });
        } else if (typeof error.code === "string") {
          // The program did not start, or its output overflowed: not a program result.
          reject(error);
        } else {
          resolve({ exitCode: error.code ?? null, signal: error.signal ?? null, stdout, stderr });
        }
      },
    );
  });
}
