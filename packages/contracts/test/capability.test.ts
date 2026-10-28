import { describe, expect, it } from "vitest";
import { BoundaryError, Capability, InterfaceField, parseAtBoundary } from "../src/index.js";

/** `shell.run(program: enum, argv: list<string>, cwd: path)` as §2.2 illustrates it. */
const shellRun = {
  id: "shell.run",
  interface: {
    program: { type: { kind: "enum", values: ["ls", "cat"] } },
    argv: { type: { kind: "list", items: { kind: "string" } }, role: "data" },
    cwd: { type: { kind: "path" }, role: "data" },
  },
  providers: ["adapter.execfile"],
  side_effect: "read",
  isolation_tier: 2,
  max_input_sensitivity: "internal",
  min_argument_integrity: "attested",
  output_class: { sensitivity: "input", integrity: "untrusted" },
  cost_model: { expected_cost: 0, expected_latency_ms: 100, cost_of_failure: 0 },
};

describe("field roles (§2.2)", () => {
  // proves §2.2 rule 1: a field with no declared role parses as instruction
  it("parses a field with no declared role as instruction", () => {
    expect(InterfaceField.parse({ type: { kind: "string" } }).role).toBe("instruction");
    expect(InterfaceField.parse({ type: { kind: "path" } }).role).toBe("instruction");
  });

  // proves §2.2 rule 1: only an explicit declaration makes a field data
  it("parses a field as data only when data is declared", () => {
    expect(InterfaceField.parse({ type: { kind: "string" }, role: "data" }).role).toBe("data");
    expect(InterfaceField.parse({ type: { kind: "string" }, role: "instruction" }).role).toBe("instruction");
  });

  // proves §2.2 rule 1 (fail closed): a role that is present but not a valid role is rejected, not defaulted
  it.each([null, "", "Data", "operand", 1])("rejects an invalid role %j", (role) => {
    expect(InterfaceField.safeParse({ type: { kind: "string" }, role }).success).toBe(false);
  });

  // proves §2.2 rule 1 (fail closed): a misspelt role key cannot silently fall back to anything
  it("rejects unknown keys on a field, so a misspelt role key is an error", () => {
    expect(InterfaceField.safeParse({ type: { kind: "string" }, rol: "data" }).success).toBe(false);
  });

  // proves §2.2 rule 2: a list-typed instruction field fails to parse
  it("rejects a list-typed instruction field", () => {
    const declared = InterfaceField.safeParse({ type: { kind: "list", items: { kind: "string" } }, role: "instruction" });
    expect(declared.success).toBe(false);
  });

  // proves §2.2 rules 1 and 2 together: a list field with no role defaults to instruction and so fails to parse
  it("rejects a list-typed field with no declared role", () => {
    expect(InterfaceField.safeParse({ type: { kind: "list", items: { kind: "string" } } }).success).toBe(false);
  });

  // proves §2.2 rule 2: maps are complex types too
  it("rejects a map-typed instruction field, declared or defaulted", () => {
    expect(InterfaceField.safeParse({ type: { kind: "map", values: { kind: "string" } }, role: "instruction" }).success).toBe(false);
    expect(InterfaceField.safeParse({ type: { kind: "map", values: { kind: "string" } } }).success).toBe(false);
  });

  // proves §2.2 rule 2: nested structures are not expressible at all
  it("rejects nested complex types", () => {
    const nested = { type: { kind: "list", items: { kind: "list", items: { kind: "string" } } }, role: "data" };
    expect(InterfaceField.safeParse(nested).success).toBe(false);
  });

  // proves §2.2: complex types are fine when the field is data (argv[] is the §2.2 example)
  it("accepts list and map fields declared data", () => {
    expect(InterfaceField.parse({ type: { kind: "list", items: { kind: "string" } }, role: "data" }).role).toBe("data");
    expect(InterfaceField.parse({ type: { kind: "map", values: { kind: "integer" } }, role: "data" }).role).toBe("data");
  });

  // proves §2.2 rule 2: every scalar type may be an instruction field
  it.each([{ kind: "string" }, { kind: "path" }, { kind: "integer" }, { kind: "number" }, { kind: "boolean" }, { kind: "enum", values: ["a"] }])(
    "accepts a scalar %j as an instruction field",
    (type) => {
      expect(InterfaceField.parse({ type }).role).toBe("instruction");
    },
  );
});

describe("Capability (§2.1)", () => {
  // proves §2.1 and §2.2: shell.run parses with program as instruction and argv, cwd as data
  it("parses shell.run with the roles §2.2 assigns", () => {
    const capability = parseAtBoundary("capability", Capability, shellRun);
    expect(capability.interface["program"]?.role).toBe("instruction");
    expect(capability.interface["argv"]?.role).toBe("data");
    expect(capability.interface["cwd"]?.role).toBe("data");
  });

  // proves §2.2 rule 1 through the whole capability: forgetting to declare argv as data rejects the definition
  it("rejects shell.run when argv's data role is omitted", () => {
    const withoutRole = { ...shellRun, interface: { ...shellRun.interface, argv: { type: { kind: "list", items: { kind: "string" } } } } };
    expect(() => parseAtBoundary("capability", Capability, withoutRole)).toThrow(BoundaryError);
  });

  // proves §2.1: the enumerated fields have the enumerated values only
  it.each([
    ["side_effect", "delete"],
    ["isolation_tier", 0],
    ["isolation_tier", 6],
    ["max_input_sensitivity", "top-secret"],
    ["min_argument_integrity", "trusted"],
    ["id", "shellrun"],
    ["id", "Shell.Run"],
  ])("rejects %s = %j", (field, value) => {
    expect(Capability.safeParse({ ...shellRun, [field]: value }).success).toBe(false);
  });

  // proves §0.2 D8 (fail closed): an enum with no members or duplicate members is a definition error
  it("rejects an empty or duplicated program enum", () => {
    for (const values of [[], ["ls", "ls"]]) {
      const bad = { ...shellRun, interface: { ...shellRun.interface, program: { type: { kind: "enum", values } } } };
      expect(Capability.safeParse(bad).success).toBe(false);
    }
  });
});
