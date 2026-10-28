import { z } from "zod";

/**
 * The data-class lattice (spec §1.1–1.2).
 *
 * Both axes are ordered enums. The arrays below list each axis from the
 * lowest to the highest level; the index is the rank, and nothing else in
 * the codebase may compare levels by any other means.
 */

/** Who may ever see this. Ascending: `public < internal < confidential < secret` (§1.1). */
export const SENSITIVITY_LEVELS = ["public", "internal", "confidential", "secret"] as const;

/** How far this may influence action. Ascending trust: `untrusted < derived < attested < operator` (§1.1). */
export const INTEGRITY_LEVELS = ["untrusted", "derived", "attested", "operator"] as const;

export const Sensitivity = z.enum(SENSITIVITY_LEVELS);
export type Sensitivity = z.infer<typeof Sensitivity>;

export const Integrity = z.enum(INTEGRITY_LEVELS);
export type Integrity = z.infer<typeof Integrity>;

/** `data_class = (sensitivity, integrity)` (§1.1). */
export const DataClass = z.strictObject({
  sensitivity: Sensitivity,
  integrity: Integrity,
});
export type DataClass = z.infer<typeof DataClass>;

export function sensitivityRank(level: Sensitivity): number {
  return SENSITIVITY_LEVELS.indexOf(level);
}

export function integrityRank(level: Integrity): number {
  return INTEGRITY_LEVELS.indexOf(level);
}

/** Negative when `a` is below `b`, zero when equal, positive when above. */
export function compareSensitivity(a: Sensitivity, b: Sensitivity): number {
  return sensitivityRank(a) - sensitivityRank(b);
}

/** Negative when `a` is less trusted than `b`, zero when equal, positive when more trusted. */
export function compareIntegrity(a: Integrity, b: Integrity): number {
  return integrityRank(a) - integrityRank(b);
}

export function maxSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return compareSensitivity(a, b) >= 0 ? a : b;
}

export function minIntegrity(a: Integrity, b: Integrity): Integrity {
  return compareIntegrity(a, b) <= 0 ? a : b;
}

/** At least one input. The model defines join over inputs, not over nothing (DECISIONS.md D-015). */
export type NonEmpty<T> = readonly [T, ...T[]];

/**
 * The join rule (§1.2): `sensitivity = max(inputs)`, `integrity = min(inputs)`.
 * Combining material can only make it more sensitive and less trusted.
 */
export function join(inputs: NonEmpty<DataClass>): DataClass {
  const [first, ...rest] = inputs;
  let sensitivity = first.sensitivity;
  let integrity = first.integrity;
  for (const input of rest) {
    sensitivity = maxSensitivity(sensitivity, input.sensitivity);
    integrity = minIntegrity(integrity, input.integrity);
  }
  return { sensitivity, integrity };
}

/**
 * The next value of a task's `sensitivity_floor` after it is exposed to
 * material of sensitivity `exposure` (§1.2, §3.1): monotonic non-decreasing.
 * Exposure is cumulative, so the floor never goes down.
 */
export function raiseSensitivityFloor(current: Sensitivity, exposure: Sensitivity): Sensitivity {
  return maxSensitivity(current, exposure);
}

/** Thrown when a recorded `sensitivity_floor` change would lower the floor. */
export class SensitivityFloorDecreaseError extends Error {
  readonly from: Sensitivity;
  readonly to: Sensitivity;

  constructor(from: Sensitivity, to: Sensitivity) {
    super(`sensitivity_floor cannot decrease (from ${from} to ${to}); it is monotonic non-decreasing (spec §3.1)`);
    this.name = "SensitivityFloorDecreaseError";
    this.from = from;
    this.to = to;
  }
}

/**
 * Guard for any write that replaces a task's `sensitivity_floor` (§3.1 invariant).
 * Returns the new floor when it is at or above the old one; throws otherwise.
 */
export function assertSensitivityFloorTransition(from: Sensitivity, to: Sensitivity): Sensitivity {
  if (compareSensitivity(to, from) < 0) {
    throw new SensitivityFloorDecreaseError(from, to);
  }
  return to;
}
