import { instant } from "./common.js";
import { type Grant, scopeWithin } from "./grant.js";
import { compareIntegrity, compareSensitivity } from "./lattice.js";

/**
 * Grant attenuation (spec §3.2): "A derived grant is a strict subset of its
 * parent on every dimension."
 *
 * This module compares a child grant with its parent one dimension at a time.
 * A child that is wider on any dimension is not an attenuation under any
 * reading of §3.2, so `attenuationViolations` rejects it.
 *
 * What it deliberately does not decide: whether a child that is *equal* to its
 * parent on some or all dimensions is an attenuation. "Strict subset on every
 * dimension" can be read three ways, and the readings disagree exactly there.
 * That is open objection O-1 in STATE.md; until the operator rules, no
 * function here declares a grant a valid attenuation.
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
 * `child` is not an attenuation of `parent` under any reading of §3.2, and
 * must be refused. An empty result is necessary for attenuation; whether it
 * is sufficient is open objection O-1.
 */
export function attenuationViolations(parent: Grant, child: Grant): readonly GrantDimension[] {
  const relations = compareGrantDimensions(parent, child);
  return GRANT_DIMENSIONS.filter((dimension) => relations[dimension] === "wider");
}
