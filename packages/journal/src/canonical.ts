import { createHash } from "node:crypto";
import type { ContentHash } from "../../contracts/src/index.js";

/**
 * Canonical JSON (DECISIONS.md D-027): object keys sorted by code unit, no
 * whitespace, strings and numbers as `JSON.stringify` writes them. One value
 * has exactly one encoding, so a hash over the encoding is a hash over the
 * value, and a stored line that is not canonical has been altered.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON has no encoding for a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const members = keys.map((key) => {
      const member = record[key];
      if (member === undefined) {
        throw new TypeError(`canonical JSON has no encoding for undefined (key ${JSON.stringify(key)})`);
      }
      return `${JSON.stringify(key)}:${canonicalJson(member)}`;
    });
    return `{${members.join(",")}}`;
  }
  throw new TypeError(`canonical JSON has no encoding for ${typeof value}`);
}

/** The content address of some bytes: `sha256:` plus 64 lowercase hex digits (D-016). */
export function contentAddress(bytes: Uint8Array | string): ContentHash {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
