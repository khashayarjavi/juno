import { z } from "zod";

/**
 * Shared scalar shapes for the contracts. Encodings the model leaves open are
 * fixed in DECISIONS.md D-016.
 */

/** An identifier or reference to another object: printable, no whitespace, bounded length. */
export const Ref = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\x21-\x7e]+$/, "must be printable ASCII with no whitespace");
export type Ref = z.infer<typeof Ref>;

/** A UTC instant in ISO 8601 form with a `Z` suffix, e.g. `2026-10-28T09:00:00Z`. */
export const Timestamp = z.iso.datetime();
export type Timestamp = z.infer<typeof Timestamp>;

/** A content address: `sha256:` followed by 64 lowercase hex digits. */
export const ContentHash = z.string().regex(/^sha256:[0-9a-f]{64}$/, "must be sha256:<64 lowercase hex digits>");
export type ContentHash = z.infer<typeof ContentHash>;

/** A duration in whole milliseconds. */
export const DurationMs = z.int().nonnegative();
export type DurationMs = z.infer<typeof DurationMs>;

/** A count of tokens, turns or invocations. */
export const Count = z.int().nonnegative();
export type Count = z.infer<typeof Count>;

/** An amount of currency in the operator's billing currency. */
export const Currency = z.number().nonnegative().finite();
export type Currency = z.infer<typeof Currency>;

/** Milliseconds since the Unix epoch for a parsed `Timestamp`. */
export function instant(timestamp: Timestamp): number {
  return Date.parse(timestamp);
}
