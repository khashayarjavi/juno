import { z } from "zod";
import { CapabilityId } from "./capability.js";
import { Count, Ref, Timestamp, instant } from "./common.js";
import { Integrity, Sensitivity } from "./lattice.js";

/**
 * Grant (spec §3.2). Selector shapes are fixed in DECISIONS.md D-020.
 *
 * `resource_scope` has no wildcard form. Paths are prefixes (a selector
 * reaches everything under it); hosts, repositories and records match
 * exactly, and a host always names its port. So an egress destination is
 * always enumerated, and §3.2's prohibition on wildcard scope for `external`
 * capabilities holds by construction: the unbounded scope cannot be written.
 */

/** An absolute, normalised path: no empty, `.` or `..` segments, no trailing slash except the root itself. */
export const AbsolutePath = z
  .string()
  .max(4096)
  .refine((path) => path.startsWith("/"), "must be absolute")
  .refine((path) => !path.includes("\0"), "must not contain NUL")
  .refine(
    (path) => path === "/" || path.slice(1).split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "must be normalised (no empty, '.' or '..' segments, no trailing slash)",
  );
export type AbsolutePath = z.infer<typeof AbsolutePath>;

/** An exact identifier inside a scope. Pattern characters are refused so nothing reads as a wildcard. */
const ScopeId = Ref.refine((id) => !/[*?]/.test(id), "must not contain '*' or '?'; scopes enumerate, they do not match patterns");

/** A lower-case DNS host name or IPv4 address. No wildcard labels. */
const HostName = z
  .string()
  .max(253)
  .regex(
    /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/,
    "must be a lower-case host name; wildcards are not expressible",
  );

export const ResourceSelector = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("path"), prefix: AbsolutePath }),
  z.strictObject({ kind: z.literal("repo"), id: ScopeId }),
  z.strictObject({ kind: z.literal("host"), host: HostName, port: z.int().min(1).max(65535) }),
  z.strictObject({ kind: z.literal("record"), id: ScopeId }),
]);
export type ResourceSelector = z.infer<typeof ResourceSelector>;

export const ResourceScope = z.array(ResourceSelector);
export type ResourceScope = z.infer<typeof ResourceScope>;

/** "One capability or a bounded set" (§3.2): an enumerated, non-empty set of capability ids. */
export const CapabilitySelector = z.strictObject({
  capabilities: z
    .array(CapabilityId)
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, "capability ids must be unique"),
});
export type CapabilitySelector = z.infer<typeof CapabilitySelector>;

/** Max sensitivity and min integrity permitted (§3.2). */
export const DataClassBounds = z.strictObject({
  max_sensitivity: Sensitivity,
  min_integrity: Integrity,
});
export type DataClassBounds = z.infer<typeof DataClassBounds>;

export const ISSUANCES = ["interactive", "preissued"] as const;
export const Issuance = z.enum(ISSUANCES);
export type Issuance = z.infer<typeof Issuance>;

export const Grant = z
  .strictObject({
    id: Ref,
    principal: Ref,
    capability_selector: CapabilitySelector,
    resource_scope: ResourceScope,
    data_class_bounds: DataClassBounds,
    /** When the grant was created, not what it permits (§3.2). */
    issuance: Issuance,
    issued_by: Ref,
    issued_at: Timestamp,
    /** Mandatory. No perpetual grants (§3.2). */
    expires_at: Timestamp,
    max_invocations: Count.nullable(),
    attenuation_parent: Ref.nullable(),
    revoked_at: Timestamp.nullable(),
  })
  .refine((grant) => instant(grant.expires_at) > instant(grant.issued_at), {
    path: ["expires_at"],
    message: "a grant must expire after it is issued",
  });
export type Grant = z.infer<typeof Grant>;

/** Whether `inner` reaches only resources that `outer` also reaches. */
export function selectorWithin(inner: ResourceSelector, outer: ResourceSelector): boolean {
  switch (inner.kind) {
    case "path":
      return outer.kind === "path" && pathWithin(inner.prefix, outer.prefix);
    case "host":
      return outer.kind === "host" && inner.host === outer.host && inner.port === outer.port;
    case "repo":
      return outer.kind === "repo" && inner.id === outer.id;
    case "record":
      return outer.kind === "record" && inner.id === outer.id;
  }
}

/** Path containment on normalised absolute paths: equal, or under `outer` at a segment boundary. */
export function pathWithin(inner: AbsolutePath, outer: AbsolutePath): boolean {
  if (outer === "/") {
    return true;
  }
  return inner === outer || inner.startsWith(`${outer}/`);
}

/** Whether every selector of `inner` is within some selector of `outer`. */
export function scopeWithin(inner: ResourceScope, outer: ResourceScope): boolean {
  return inner.every((selector) => outer.some((candidate) => selectorWithin(selector, candidate)));
}
