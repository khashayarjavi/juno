import { type Capability, type Grant, type ScalarFieldType, pathWithin } from "../../contracts/src/index.js";
import type { CallValue, CapabilityCall } from "../../registry/src/index.js";

/**
 * §2.7 step 4: a `data` field outside the grant's `resource_scope` parks
 * `scope_violation`. A `path`-typed value is within scope when a path selector
 * of the grant contains it (prefix containment at a segment boundary, D-020).
 * Call paths are already absolute and normalised (D-032), so `..` cannot
 * leave a selector.
 *
 * How scope governs a `string`-typed data field such as `argv` is not settled
 * by the spec (objection O-4 in STATE.md). Until the ruling, only `path`-typed
 * fields are checked here.
 */

export type ScopeViolation = { readonly argument: string; readonly value: string };

function isPath(type: ScalarFieldType): boolean {
  return type.kind === "path";
}

function pathInScope(path: string, grant: Grant): boolean {
  return grant.resource_scope.some((selector) => selector.kind === "path" && pathWithin(path, selector.prefix));
}

/** Every path-typed data value of `call` that falls outside `grant`'s scope. */
export function scopeViolations(capability: Capability, call: CapabilityCall, grant: Grant): ScopeViolation[] {
  const violations: ScopeViolation[] = [];
  const check = (argument: string, value: CallValue | undefined): void => {
    if (typeof value === "string" && !pathInScope(value, grant)) violations.push({ argument, value });
  };
  for (const [name, field] of Object.entries(capability.interface)) {
    if (field.role !== "data") continue;
    const value = call[name];
    if (field.type.kind === "list") {
      if (isPath(field.type.items) && Array.isArray(value)) value.forEach((item, index) => check(`${name}[${String(index)}]`, item));
    } else if (field.type.kind !== "map" && isPath(field.type)) {
      check(name, value);
    }
  }
  return violations;
}
