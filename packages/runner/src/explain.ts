import { type TrajectoryEntry } from "../../contracts/src/index.js";
import { readPayload, readTrajectory } from "../../journal/src/index.js";

/**
 * "Why did this happen?" answered from the journal alone (spec §3.4.5, §18
 * acceptance test 1). Reads one task's verified trajectory through the
 * journal's read interface (§3.4.1) and writes a plain account: what was
 * admitted, every turn and call, every verdict and the reason for it, every
 * park and resume, verification and closure. It consults nothing but the
 * journal root it is given.
 */

const decoder = new TextDecoder("utf-8", { fatal: true });

function payloadOf(root: string, entry: TrajectoryEntry): Record<string, unknown> {
  const blob = readPayload(root, entry.payload_ref);
  if (blob.status !== "present") return { unreadable: blob.status };
  try {
    const parsed: unknown = JSON.parse(decoder.decode(blob.bytes));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    return { unreadable: "not JSON" };
  }
}

const show = (value: unknown): string => JSON.stringify(value) ?? "null";

function describe(entry: TrajectoryEntry, body: Record<string, unknown>): string | null {
  const head = `#${String(entry.seq)} ${entry.timestamp}`;
  switch (entry.kind) {
    case "turn": {
      const response = body["response"] as { tool_calls?: { capability: string; arguments: unknown }[]; text?: string | null } | null;
      if (response === null) return `${head} turn ${show(body["turn"])} by ${entry.actor}: the runner could not read the answer (${show(body["malformed"])})`;
      const calls = response.tool_calls ?? [];
      return calls.length === 0
        ? `${head} turn ${show(body["turn"])} by ${entry.actor}: proposed no call; claims the task is done`
        : `${head} turn ${show(body["turn"])} by ${entry.actor}: proposed ${calls.map((call) => `${call.capability} ${show(call.arguments)}`).join("; ")}`;
    }
    case "binding_resolution":
      return body["outcome"] === "resolved"
        ? `${head} reference ${show(body["reference"])} for ${show(body["argument"])} bound to entry #${show(body["bound_to"])}: ${show(body["value"])}`
        : `${head} reference ${show(body["reference"])} for ${show(body["argument"])} rejected: ${show(body["code"])}`;
    case "capability_call": {
      const verdict = body["verdict"] as Record<string, unknown>;
      const provenance = (entry.argument_provenance ?? []).map((item) => `${item.argument}=${item.class}/${item.integrity}`).join(", ");
      const reason = verdict["outcome"] === "proceed" ? `under grant ${show(body["grant"])}` : `reason ${show(verdict["reason"])}`;
      return `${head} call to ${show(body["capability"])}: ${show(verdict["outcome"])}, ${reason}; arguments ${provenance}`;
    }
    case "capability_result":
      return `${head} result of call #${show(body["call_seq"])} from ${entry.actor}: exit ${show(body["exit_code"] ?? body["error"])}, output ${show(body["stdout"])}`;
    case "park": {
      const detail = body["detail"] === undefined ? "" : `; detail ${show(body["detail"])}`;
      return `${head} PARKED ${show(body["reason"])} (${body["overridable"] === false ? "not overridable" : "overridable"})${body["call_seq"] === undefined ? "" : ` at call #${show(body["call_seq"])}`}${detail}`;
    }
    case "resume":
      return `${head} RESUMED from park #${show(body["resumed_park_seq"])} (${show(body["parked_reason"])}); grants added ${show(body["added_grants"])}, removed ${show(body["removed_grants"] ?? [])}; grant status ${show(body["grants"])}`;
    case "note":
      switch (body["type"]) {
        case "admission":
          if (body["outcome"] !== "admitted") return `${head} admission REJECTED: ${show(body["failures"])}`;
          {
            const task = body["task"] as Record<string, unknown>;
            return `${head} admitted task ${show(task["id"])} for ${show(task["principal"])}: objective ${show(task["objective"])}; closure ${show(task["closure_mode"])}; criterion integrity ${show(task["criterion_integrity"])}; grants ${show(task["grants"])}; warnings ${show(body["warnings"])}`;
          }
        case "state":
          return `${head} state ${show(body["from"])} -> ${show(body["to"])} (${show(body["reason"])})`;
        case "verification":
          return body["phase"] === "start" ? `${head} verification started` : `${head} verification ${show(body["result"])}: exit ${show(body["exit_code"])} (expected ${show(body["expected_exit_code"])}), protected paths ${show(body["protected_paths"])}`;
        case "closure":
          return `${head} CLOSED ${show((body["closure"] as Record<string, unknown>)["closure_mode"])} by ${show((body["closure"] as Record<string, unknown>)["verifier_identity"])}`;
        case "sensitivity_floor":
          return `${head} sensitivity floor ${show(body["from"])} -> ${show(body["to"])} after entry #${show(body["cause_seq"])}`;
        case "protected_listing":
          return `${head} protected paths listed (${show(body["phase"])})`;
        default:
          return null;
      }
    default:
      return `${head} ${entry.kind} by ${entry.actor}`;
  }
}

/** The account of one task, one line per entry that says something, in order. Throws if the journal does not verify. */
export function explainTask(root: string, taskId: string): string {
  return readTrajectory(root, taskId)
    .map((entry) => describe(entry, payloadOf(root, entry)))
    .filter((line): line is string => line !== null)
    .join("\n");
}
