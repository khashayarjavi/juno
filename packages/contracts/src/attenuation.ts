import { instant } from "./common.js";
import { type Grant, scopeWithin } from "./grant.js";
import { compareIntegrity, compareSensitivity } from "./lattice.js";

/**
 * Grant attenuation (spec §3.2): "A derived grant is a strict subset of its
 * parent on every dimension."
 *
 * This module compares a child grant with its parent one dimension at a time.
 * The operator ruled on the reading (DECISIONS.md D-024): a child is a valid
 * attenuation when it is no wider than its parent on every dimension. Equality
 * on a dimension is permitted, so an identical copy is valid.
 *
 * Invocations of a derived grant are to be charged against the parent chain,
 * as budgets are (§3.1). That charge is runtime accounting, deferred with
 * delegation (D-006); this module only decides whether a child is valid.
 *
 * Dimensions that describe authority: principal, capability set, resource
 * scope, the two data-class bounds, expiry, and invocation cap. `issuance`,
 * `issued_by`, `issued_at`, `id`, `attenuation_parent` and `revoked_at` are
 * metadata or runtime state, not authority (DECISIONS.md D-020).
 */

export const GRANT_DIMENSIONS = [
  "principal",
  "capability_selector",
  "resource_scope",
  "max_sensitivity",
  "min_integrity",
  "expires_at",
  "max_invocations",
] as const;
export type GrantDimension = (typeof GRANT_DIMENSIONS)[number];

/**
 * `narrower`: the child permits strictly less than the parent on this dimension.
 * `equal`: the child permits exactly what the parent does.
 * `wider`: the child permits something the parent does not.
 */
export type DimensionRelation = "narrower" | "equal" | "wider";

function fromSubset(childWithinParent: boolean, parentWithinChild: boolean): DimensionRelation {
  if (!childWithinParent) {
    return "wider";
  }
  return parentWithinChild ? "equal" : "narrower";
}

/** Orders two numbers where a smaller child value permits less. */
function fromOrder(difference: number): DimensionRelation {
  if (difference > 0) {
    return "wider";
  }
  return difference === 0 ? "equal" : "narrower";
}

function capabilityRelation(parent: Grant, child: Grant): DimensionRelation {
  const parentIds = new Set(parent.capability_selector.capabilities);
  const childIds = new Set(child.capability_selector.capabilities);
  const childWithin = [...childIds].every((id) => parentIds.has(id));
  const parentWithin = [...parentIds].every((id) => childIds.has(id));
  return fromSubset(childWithin, parentWithin);
}

/** `null` means no cap. A capped child under an uncapped parent is narrower. */
function invocationRelation(parent: Grant, child: Grant): DimensionRelation {
  if (parent.max_invocations === null) {
    return child.max_invocations === null ? "equal" : "narrower";
  }
  if (child.max_invocations === null) {
    return "wider";
  }
  return fromOrder(child.max_invocations - parent.max_invocations);
}

/** The relation of `child` to `parent` on every authority dimension. */
export function compareGrantDimensions(parent: Grant, child: Grant): Readonly<Record<GrantDimension, DimensionRelation>> {
  return {
    // A different principal is not a narrowing of anything: it is authority the parent never held.
    principal: child.principal === parent.principal ? "equal" : "wider",
    capability_selector: capabilityRelation(parent, child),
    resource_scope: fromSubset(
      scopeWithin(child.resource_scope, parent.resource_scope),
      scopeWithin(parent.resource_scope, child.resource_scope),
    ),
    // Higher max sensitivity permits more.
    max_sensitivity: fromOrder(
      compareSensitivity(child.data_class_bounds.max_sensitivity, parent.data_class_bounds.max_sensitivity),
    ),
    // Lower min integrity permits more, so the order is reversed.
    min_integrity: fromOrder(compareIntegrity(parent.data_class_bounds.min_integrity, child.data_class_bounds.min_integrity)),
    // A later expiry permits more.
    expires_at: fromOrder(instant(child.expires_at) - instant(parent.expires_at)),
    max_invocations: invocationRelation(parent, child),
  };
}

/**
 * The dimensions on which `child` widens `parent`. A non-empty result means
 * `child` is not an attenuation of `parent` and must be refused.
 */
export function attenuationViolations(parent: Grant, child: Grant): readonly GrantDimension[] {
  const relations = compareGrantDimensions(parent, child);
  return GRANT_DIMENSIONS.filter((dimension) => relations[dimension] === "wider");
}

/**
 * Whether `child` is a valid attenuation of `parent` (§3.2, D-024): no wider
 * on any dimension. A child equal to its parent on some or every dimension is
 * valid.
 */
export function isValidAttenuation(parent: Grant, child: Grant): boolean {
  return attenuationViolations(parent, child).length === 0;
}
