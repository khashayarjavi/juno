import { connect } from "node:net";

/**
 * `juno-hook`: the client Claude Code runs for PreToolUse, PostToolUse and PostToolUseFailure (spec §4.3 fail-closed
 * ingress; DECISIONS.md D-142). Installed in exec form with `onFailure: "block"` (D-139), so a crash or timeout of this
 * client blocks the call too. It uses Node's built-in modules only.
 *
 *   node hook-client.js --socket <path> [--timeout-ms <ms>]     (the hook input JSON on standard input)
 *
 * PreToolUse: JUNO's `{ decision: "none" }` → exit 0 with no output (no decision; Claude Code's own rules apply);
 * `{ decision: "deny", reason }` → Claude Code's deny JSON on standard output, exit 0. **Any doubt** — the service is
 * unreachable, slow, or answers anything else; the input is unreadable — → exit 2 with the reason on standard error,
 * which blocks the call. It never prints `allow`, `ask`, `defer`, `updatedInput` or `updatedToolOutput`.
 * PostToolUse / PostToolUseFailure: `{ recorded: true }` → exit 0; anything else → exit 2.
 */

export type ClientResult = { readonly exitCode: 0 | 2; readonly stdout: string; readonly stderr: string };

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ANSWER_BYTES = 1024 * 1024;

function blocked(reason: string): ClientResult {
  return { exitCode: 2, stdout: "", stderr: `JUNO blocked this call: ${reason}\n` };
}

function ask(socketPath: string, request: string, timeoutMs: number): Promise<{ ok: true; answer: unknown } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (value: { ok: true; answer: unknown } | { ok: false; reason: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => settle({ ok: false, reason: `the JUNO service did not answer within ${String(timeoutMs)} ms` }), timeoutMs);
    socket.on("connect", () => socket.write(request));
    socket.on("error", (error: NodeJS.ErrnoException) => settle({ ok: false, reason: `the JUNO service is unreachable (${error.code ?? error.message})` }));
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ANSWER_BYTES) return settle({ ok: false, reason: "the JUNO service answered too much" });
      chunks.push(chunk);
    });
    socket.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const newline = text.indexOf("\n");
      if (newline === -1) return settle({ ok: false, reason: "the JUNO service gave no complete answer" });
      try {
        settle({ ok: true, answer: JSON.parse(text.slice(0, newline)) as unknown });
      } catch {
        settle({ ok: false, reason: "the JUNO service's answer is not JSON" });
      }
    });
  });
}

/** Asks the service about one hook input and turns the answer into what Claude Code reads. */
export async function runHookClient(stdin: string, socketPath: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<ClientResult> {
  let input: unknown;
  try {
    input = JSON.parse(stdin);
  } catch {
    return blocked("the hook input is not JSON");
  }
  const event = typeof input === "object" && input !== null && "hook_event_name" in input ? input.hook_event_name : undefined;
  if (event !== "PreToolUse" && event !== "PostToolUse" && event !== "PostToolUseFailure") return blocked("the hook event is not one JUNO handles");
  const asked = await ask(socketPath, `${JSON.stringify({ event, input })}\n`, timeoutMs);
  if (!asked.ok) return blocked(asked.reason);
  const answer = asked.answer;
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return blocked("the JUNO service's answer is not a decision");
  const keys = Object.keys(answer).sort().join(",");
  const record = answer as Record<string, unknown>;
  if (event === "PreToolUse") {
    if (keys === "decision" && record["decision"] === "none") return { exitCode: 0, stdout: "", stderr: "" };
    if (keys === "decision,reason" && record["decision"] === "deny" && typeof record["reason"] === "string") {
      const output = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: record["reason"] } };
      return { exitCode: 0, stdout: `${JSON.stringify(output)}\n`, stderr: "" };
    }
    return blocked("the JUNO service's answer is not a decision JUNO can give");
  }
  return keys === "recorded" && record["recorded"] === true ? { exitCode: 0, stdout: "", stderr: "" } : blocked("JUNO did not record the result");
}

/** Reads the arguments and standard input, runs the client, and exits; any failure here exits 2 (block). */
export async function main(argv: readonly string[]): Promise<number> {
  const socketAt = argv.indexOf("--socket");
  const socketPath = socketAt === -1 ? undefined : argv[socketAt + 1];
  const timeoutAt = argv.indexOf("--timeout-ms");
  const timeoutMs = timeoutAt === -1 ? DEFAULT_TIMEOUT_MS : Number(argv[timeoutAt + 1]);
  if (socketPath === undefined || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    process.stderr.write("JUNO blocked this call: juno-hook was installed without a valid --socket or --timeout-ms\n");
    return 2;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const result = await runHookClient(Buffer.concat(chunks).toString("utf8"), socketPath, timeoutMs);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.exitCode;
}
