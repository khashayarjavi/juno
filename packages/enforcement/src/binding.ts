import {
  type DataClass,
  type PathStep,
  type ReferenceErrorCode,
  type TrajectoryEntry,
  parseReference,
} from "../../contracts/src/index.js";
import type { CallScalar } from "../../registry/src/index.js";

/**
 * `bound` reference resolution (spec §2.6, §2.7 step 1, §17 O9; DECISIONS.md D-043).
 *
 * A reference `${<seq>.<path>}` resolves against the calling task's own
 * trajectory only: the caller passes that trajectory and nothing else, so a
 * reference cannot reach another task's entries. The value takes the data
 * class of the entry it came from; binding cannot forge integrity.
 *
 * The reference names one entry exactly. Its *shape*, the path, may also name
 * a value in other prior entries. Those entries are the candidate set: the
 * entries the same path could have bound. When there is more than one, the
 * set is recorded, so that post-hoc review can tell a hostile entry chosen
 * over a benign one from coincidence (§2.7 step 1).
 */

export type ResolutionFailureCode = ReferenceErrorCode;

export type Resolution =
  | {
      readonly ok: true;
      readonly seq: number;
      readonly value: CallScalar;
      readonly data_class: DataClass;
      /** Every prior entry whose payload holds a single value at the same path, in `seq` order. Includes `seq`. */
      readonly candidates: readonly number[];
    }
  | { readonly ok: false; readonly code: ResolutionFailureCode; readonly message: string };

/** An entry's payload as parsed JSON, or `undefined` when it is missing, corrupt, or not JSON. */
export type PayloadReader = (entry: TrajectoryEntry) => unknown;

/** The single value at `path` in `payload`, or `undefined` when the path names nothing or names a structure. */
export function valueAt(payload: unknown, path: readonly PathStep[]): CallScalar | undefined {
  let current: unknown = payload;
  for (const step of path) {
    if (step.kind === "index") {
      if (!Array.isArray(current) || step.index >= current.length) return undefined;
      current = current[step.index];
    } else {
      if (typeof current !== "object" || current === null || Array.isArray(current) || !Object.hasOwn(current, step.key)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[step.key];
    }
  }
  if (typeof current === "string" || typeof current === "boolean" || (typeof current === "number" && Number.isFinite(current))) {
    return current;
  }
  return undefined;
}

export function resolveReference(text: string, trajectory: readonly TrajectoryEntry[], payloadOf: PayloadReader): Resolution {
  const parsed = parseReference(text);
  if (!parsed.ok) return parsed;
  const { seq, path } = parsed.reference;

  const entry = trajectory.find((candidate) => candidate.seq === seq);
  if (entry === undefined) {
    return { ok: false, code: "unresolvable", message: `this task's trajectory has no entry ${String(seq)}` };
  }
  const value = valueAt(payloadOf(entry), path);
  if (value === undefined) {
    return {
      ok: false,
      code: "unresolvable",
      message: `entry ${String(seq)} has no single value at that path (its payload is missing, unreadable, or holds nothing or a structure there)`,
    };
  }
  const candidates = trajectory.filter((candidate) => valueAt(payloadOf(candidate), path) !== undefined).map((candidate) => candidate.seq);
  return { ok: true, seq, value, data_class: entry.data_class, candidates };
}
