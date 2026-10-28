import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  GRANT_DIMENSIONS,
  Grant,
  INTEGRITY_LEVELS,
  ResourceSelector,
  SENSITIVITY_LEVELS,
  WORK_NAMESPACE,
  attenuationViolations,
  compareGrantDimensions,
  isValidAttenuation,
  parseAtBoundary,
  pathWithin,
} from "../src/index.js";

const parent: Grant = parseAtBoundary("grant", Grant, {
  id: "grant-parent",
  principal: "alireza",
  capability_selector: { capabilities: ["shell.run", "fs.file.read"] },
  resource_scope: [
    { kind: "path", prefix: "/work/repo" },
    { kind: "host", host: "api.example.com", port: 443 },
  ],
  data_class_bounds: { max_sensitivity: "confidential", min_integrity: "derived" },
  issuance: "preissued",
  issued_by: "alireza",
  issued_at: "2026-10-28T09:00:00Z",
  expires_at: "2026-10-29T09:00:00Z",
  max_invocations: 10,
  attenuation_parent: null,
  revoked_at: null,
});

function child(overrides: Partial<Grant>): Grant {
  return parseAtBoundary("grant", Grant, { ...parent, id: "grant-child", attenuation_parent: parent.id, ...overrides });
}

describe("Grant schema (§3.2)", () => {
  // proves §3.2: expires_at is mandatory — there are no perpetual grants
  it.each([undefined, null, "never"])("rejects expires_at = %j", (expiresAt) => {
    expect(Grant.safeParse({ ...parent, expires_at: expiresAt }).success).toBe(false);
  });

  // proves §3.2 / §0.2 D8: a grant that expires before it is issued is refused rather than treated as expired
  it("rejects a grant that expires at or before its issue time", () => {
    expect(Grant.safeParse({ ...parent, expires_at: parent.issued_at }).success).toBe(false);
  });

  // proves §3.2 and §2.2.1: no wildcard or unbounded resource_scope can be written at all, so none can reach an external capability
  it.each([
    { kind: "host", host: "*", port: 443 },
    { kind: "host", host: "*.example.com", port: 443 },
    { kind: "host", host: "api.example.com" },
    { kind: "host", host: "api.example.com", port: "*" },
    { kind: "record", id: "*" },
    { kind: "repo", id: "org/*" },
    { kind: "any" },
  ])("rejects the unbounded selector %j", (selector) => {
    expect(ResourceSelector.safeParse(selector).success).toBe(false);
  });

  // proves §3.2: a path selector is a literal prefix; '*' in a path is a file name, not a pattern
  it("treats '*' in a path as a literal segment that reaches only itself", () => {
    const literal = child({ resource_scope: [{ kind: "path", prefix: "/work/*" }] });
    const sibling = child({ resource_scope: [{ kind: "path", prefix: "/work/other" }] });
    expect(attenuationViolations(literal, sibling)).toContain("resource_scope");
  });

  // proves §3.3 canonical form: path selectors must be absolute and normalised, so containment cannot be fooled by '..'
  it.each(["work/repo", "/work/../etc", "/work/./repo", "/work//repo", "/work/repo/"])("rejects the non-canonical path %j", (prefix) => {
    expect(ResourceSelector.safeParse({ kind: "path", prefix }).success).toBe(false);
  });

  // proves §3.2 / §3.4.1: a path selector cannot name anything outside the capability namespace, journal storage included
  it.each(["/", "/journal", "/journal/tasks", "/journal/blobs/sha256", "/etc", "/workspace", "/work-other", "/app", "/var/lib/docker"])(
    "rejects the out-of-namespace path %j at grant creation",
    (prefix) => {
      expect(ResourceSelector.safeParse({ kind: "path", prefix }).success).toBe(false);
      expect(Grant.safeParse({ ...parent, resource_scope: [{ kind: "path", prefix }] }).success).toBe(false);
    },
  );

  // proves §3.4.1 as a property: every path selector that parses lies inside the capability namespace
  it("accepts a path selector only when it lies inside the capability namespace", () => {
    const segment = fc.constantFrom("work", "journal", "repo", "src", "..", ".", "", "a", "work-x", "tasks");
    fc.assert(
      fc.property(fc.array(segment, { minLength: 0, maxLength: 5 }), (segments) => {
        const prefix = `/${segments.join("/")}`;
        const parsed = ResourceSelector.safeParse({ kind: "path", prefix });
        if (parsed.success && parsed.data.kind === "path") {
          expect(pathWithin(parsed.data.prefix, WORK_NAMESPACE)).toBe(true);
        }
      }),
      { numRuns: 3000 },
    );
    expect(ResourceSelector.safeParse({ kind: "path", prefix: WORK_NAMESPACE }).success).toBe(true);
  });

  // proves §3.2: the capability selector is a bounded set — at least one capability, each named once
  it("rejects an empty or duplicated capability set", () => {
    expect(Grant.safeParse({ ...parent, capability_selector: { capabilities: [] } }).success).toBe(false);
    expect(Grant.safeParse({ ...parent, capability_selector: { capabilities: ["shell.run", "shell.run"] } }).success).toBe(false);
  });
});

describe("attenuation (§3.2): a derived grant never widens its parent", () => {
  // proves §3.2: every dimension of an identical copy compares equal, and none is widened
  it("finds no widening in an identical copy", () => {
    const relations = compareGrantDimensions(parent, child({}));
    for (const dimension of GRANT_DIMENSIONS) {
      expect(relations[dimension]).toBe("equal");
    }
    expect(attenuationViolations(parent, child({}))).toEqual([]);
  });

  // proves §3.2: extending the expiry is a widening (the build plan names this case)
  it("rejects expiry extension", () => {
    expect(attenuationViolations(parent, child({ expires_at: "2026-10-29T09:00:01Z" }))).toEqual(["expires_at"]);
  });

  // proves §3.2: widening on any one dimension is rejected, and only that dimension is named
  it.each<[string, Partial<Grant>, string]>([
    ["a different principal", { principal: "someone-else" }, "principal"],
    ["an added capability", { capability_selector: { capabilities: ["shell.run", "fs.file.read", "fs.file.write"] } }, "capability_selector"],
    ["a swapped capability", { capability_selector: { capabilities: ["fs.file.write"] } }, "capability_selector"],
    ["a parent path", { resource_scope: [{ kind: "path", prefix: "/work" }] }, "resource_scope"],
    ["a sibling path sharing a name prefix", { resource_scope: [{ kind: "path", prefix: "/work/repo-other" }] }, "resource_scope"],
    ["an added host", { resource_scope: [{ kind: "host", host: "evil.example.com", port: 443 }] }, "resource_scope"],
    ["another port on the same host", { resource_scope: [{ kind: "host", host: "api.example.com", port: 80 }] }, "resource_scope"],
    ["a higher sensitivity ceiling", { data_class_bounds: { max_sensitivity: "secret", min_integrity: "derived" } }, "max_sensitivity"],
    ["a lower integrity floor", { data_class_bounds: { max_sensitivity: "confidential", min_integrity: "untrusted" } }, "min_integrity"],
    ["a later expiry", { expires_at: "2026-11-28T09:00:00Z" }, "expires_at"],
    ["a higher invocation cap", { max_invocations: 11 }, "max_invocations"],
    ["a removed invocation cap", { max_invocations: null }, "max_invocations"],
  ])("rejects %s", (_name, overrides, dimension) => {
    expect(attenuationViolations(parent, child(overrides))).toEqual([dimension]);
  });

  // proves §3.2: narrowing every dimension is not a widening on any of them
  it("finds no widening when every dimension narrows", () => {
    const narrow = child({
      capability_selector: { capabilities: ["fs.file.read"] },
      resource_scope: [{ kind: "path", prefix: "/work/repo/src" }],
      data_class_bounds: { max_sensitivity: "internal", min_integrity: "attested" },
      expires_at: "2026-10-28T12:00:00Z",
      max_invocations: 3,
    });
    const relations = compareGrantDimensions(parent, narrow);
    expect(relations).toMatchObject({
      principal: "equal",
      capability_selector: "narrower",
      resource_scope: "narrower",
      max_sensitivity: "narrower",
      min_integrity: "narrower",
      expires_at: "narrower",
      max_invocations: "narrower",
    });
    expect(attenuationViolations(parent, narrow)).toEqual([]);
  });

  // proves §3.2: a capped child under an uncapped parent narrows the cap
  it("treats adding an invocation cap as narrowing", () => {
    const uncapped = child({ max_invocations: null });
    expect(compareGrantDimensions(uncapped, child({ max_invocations: 5 })).max_invocations).toBe("narrower");
  });

  // proves §3.2 as a property: any child built by widening at least one dimension is rejected on that dimension
  it("rejects every randomly widened child on each dimension it widened", () => {
    const later = (base: string, ms: number): string => new Date(Date.parse(base) + ms).toISOString();
    fc.assert(
      fc.property(
        fc.subarray([...GRANT_DIMENSIONS], { minLength: 1 }),
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.integer({ min: 11, max: 1000 }),
        (dimensions, extraMs, cap) => {
          let overrides: Partial<Grant> = {};
          let bounds = { ...parent.data_class_bounds };
          for (const dimension of dimensions) {
            if (dimension === "principal") {
              overrides = { ...overrides, principal: "intruder" };
            } else if (dimension === "capability_selector") {
              overrides = { ...overrides, capability_selector: { capabilities: ["shell.run", "fs.file.read", "net.http.post"] } };
            } else if (dimension === "max_sensitivity") {
              bounds = { ...bounds, max_sensitivity: "secret" };
            } else if (dimension === "min_integrity") {
              bounds = { ...bounds, min_integrity: "untrusted" };
            } else if (dimension === "expires_at") {
              overrides = { ...overrides, expires_at: later(parent.expires_at, extraMs) };
            } else if (dimension === "max_invocations") {
              overrides = { ...overrides, max_invocations: cap };
            } else {
              overrides = { ...overrides, resource_scope: [...parent.resource_scope, { kind: "record", id: "ticket-1" }] };
            }
          }
          const widened = child({ ...overrides, data_class_bounds: bounds });
          expect([...attenuationViolations(parent, widened)].sort()).toEqual([...dimensions].sort());
        },
      ),
    );
  });

  // proves §3.2 as a property: a child narrowed on any combination of dimensions is never reported as widening
  it("never reports widening for a randomly narrowed child", () => {
    fc.assert(
      fc.property(
        fc.subarray(["fs.file.read", "shell.run"] as const, { minLength: 1 }),
        fc.constantFrom(...SENSITIVITY_LEVELS.slice(0, 3)),
        fc.constantFrom(...INTEGRITY_LEVELS.slice(1)),
        fc.integer({ min: 0, max: 86_400_000 - 1 }),
        fc.integer({ min: 0, max: 10 }),
        fc.constantFrom("/work/repo", "/work/repo/src", "/work/repo/src/main.ts"),
        (capabilities, maxSensitivity, minIntegrity, earlierMs, cap, prefix) => {
          const narrowed = child({
            capability_selector: { capabilities: [...capabilities] },
            resource_scope: [{ kind: "path", prefix }],
            data_class_bounds: { max_sensitivity: maxSensitivity, min_integrity: minIntegrity },
            expires_at: new Date(Date.parse(parent.expires_at) - earlierMs).toISOString(),
            max_invocations: cap,
          });
          expect(attenuationViolations(parent, narrowed)).toEqual([]);
        },
      ),
    );
  });
});

describe("attenuation (§3.2, D-024): a child no wider than its parent on every dimension is valid", () => {
  // proves §3.2 under D-024: equality is permitted on every dimension, so an identical copy is a valid attenuation
  it("accepts an identical copy", () => {
    expect(isValidAttenuation(parent, child({}))).toBe(true);
  });

  // proves §3.2 under D-024: a child narrowed on every dimension is valid
  it("accepts a child narrowed on every narrowable dimension", () => {
    const narrow = child({
      capability_selector: { capabilities: ["fs.file.read"] },
      resource_scope: [{ kind: "path", prefix: "/work/repo/src" }],
      data_class_bounds: { max_sensitivity: "internal", min_integrity: "attested" },
      expires_at: "2026-10-28T12:00:00Z",
      max_invocations: 3,
    });
    expect(isValidAttenuation(parent, narrow)).toBe(true);
  });

  // proves §3.2 under D-024: equality on some dimensions and narrowing on the rest is valid
  it.each<[string, Partial<Grant>]>([
    ["only the capability set narrowed", { capability_selector: { capabilities: ["shell.run"] } }],
    ["only the scope narrowed", { resource_scope: [{ kind: "host", host: "api.example.com", port: 443 }] }],
    ["only the expiry brought forward", { expires_at: "2026-10-29T08:59:59Z" }],
    ["only the invocation cap lowered", { max_invocations: 9 }],
  ])("accepts a child with %s", (_name, overrides) => {
    expect(isValidAttenuation(parent, child(overrides))).toBe(true);
  });

  // proves §3.2: a child that widens any single dimension is not a valid attenuation, whatever it narrows elsewhere
  it.each<[string, Partial<Grant>]>([
    ["a different principal", { principal: "someone-else", max_invocations: 1 }],
    ["an added capability", { capability_selector: { capabilities: ["shell.run", "fs.file.read", "fs.file.write"] }, max_invocations: 1 }],
    ["a wider scope", { resource_scope: [{ kind: "path", prefix: "/work" }], max_invocations: 1 }],
    ["a higher sensitivity ceiling", { data_class_bounds: { max_sensitivity: "secret", min_integrity: "operator" } }],
    ["a lower integrity floor", { data_class_bounds: { max_sensitivity: "public", min_integrity: "untrusted" } }],
    ["an extended expiry", { expires_at: "2026-10-29T09:00:01Z", max_invocations: 1 }],
    ["a higher invocation cap", { max_invocations: 11, expires_at: "2026-10-28T10:00:00Z" }],
  ])("refuses a child with %s", (_name, overrides) => {
    expect(isValidAttenuation(parent, child(overrides))).toBe(false);
  });

  describe("max_invocations (D-024)", () => {
    const uncappedParent = child({ id: "grant-uncapped", max_invocations: null });
    const derive = (from: Grant, cap: number | null): Grant =>
      parseAtBoundary("grant", Grant, { ...from, id: "grant-derived", attenuation_parent: from.id, max_invocations: cap });

    // proves D-024: a null parent cap is unbounded, so an uncapped child under it is equal, not wider
    it("accepts an uncapped child under an uncapped parent", () => {
      expect(isValidAttenuation(uncappedParent, derive(uncappedParent, null))).toBe(true);
    });

    // proves D-024: any cap under an unbounded parent is no wider
    it.each([0, 1, 10, 1_000_000])("accepts a cap of %i under an uncapped parent", (cap) => {
      expect(isValidAttenuation(uncappedParent, derive(uncappedParent, cap))).toBe(true);
    });

    // proves D-024: a null child cap under a bounded parent is a widening
    it("refuses an uncapped child under a capped parent", () => {
      expect(isValidAttenuation(parent, derive(parent, null))).toBe(false);
    });

    // proves D-024: a child cap may equal the parent's but must not exceed it
    it("accepts a cap equal to the parent's and refuses one above it", () => {
      expect(isValidAttenuation(parent, derive(parent, 10))).toBe(true);
      expect(isValidAttenuation(parent, derive(parent, 11))).toBe(false);
    });
  });

  // A small pool of grants, so random pairs and triples are often in the attenuation relation.
  const grantArbitrary = fc
    .record({
      principal: fc.constantFrom("alireza", "alireza", "alireza", "other"),
      capabilities: fc.subarray(["fs.file.read", "shell.run", "net.http.get"], { minLength: 1 }),
      prefixes: fc.subarray(["/work", "/work/repo", "/work/repo/src", "/work/data"], { minLength: 0 }),
      maxSensitivity: fc.constantFrom(...SENSITIVITY_LEVELS),
      minIntegrity: fc.constantFrom(...INTEGRITY_LEVELS),
      expiryHours: fc.integer({ min: 1, max: 4 }),
      cap: fc.constantFrom(null, 0, 1, 2),
    })
    .map((g) =>
      parseAtBoundary("grant", Grant, {
        ...parent,
        principal: g.principal,
        capability_selector: { capabilities: g.capabilities },
        resource_scope: g.prefixes.map((prefix) => ({ kind: "path", prefix })),
        data_class_bounds: { max_sensitivity: g.maxSensitivity, min_integrity: g.minIntegrity },
        expires_at: new Date(Date.parse(parent.issued_at) + g.expiryHours * 3_600_000).toISOString(),
        max_invocations: g.cap,
      }),
    );

  // proves §3.2 under D-024 as a property: every grant is a valid attenuation of itself
  it("is reflexive", () => {
    fc.assert(
      fc.property(grantArbitrary, (grant) => {
        expect(isValidAttenuation(grant, grant)).toBe(true);
      }),
    );
  });

  // proves §3.2 as a property: attenuating an attenuation never yields more than the original grant held
  it("is transitive", () => {
    fc.assert(
      fc.property(grantArbitrary, grantArbitrary, grantArbitrary, (a, b, c) => {
        if (isValidAttenuation(a, b) && isValidAttenuation(b, c)) {
          expect(isValidAttenuation(a, c)).toBe(true);
        }
      }),
      { numRuns: 2000 },
    );
  });

  // proves §3.2 as a property: a child is valid exactly when no dimension is wider than the parent's
  it("accepts exactly the children with no widened dimension", () => {
    fc.assert(
      fc.property(grantArbitrary, grantArbitrary, (a, b) => {
        const relations = compareGrantDimensions(a, b);
        const noneWider = GRANT_DIMENSIONS.every((dimension) => relations[dimension] !== "wider");
        expect(isValidAttenuation(a, b)).toBe(noneWider);
      }),
    );
  });
});
