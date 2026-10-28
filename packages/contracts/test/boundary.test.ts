import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BoundaryError, parseAtBoundary } from "../src/index.js";

const Sample = z.object({ name: z.string().min(1), count: z.number().int() });

describe("parseAtBoundary", () => {
  // proves build plan Increment 0: runtime schemas at boundaries (parse, don't validate)
  it("returns the parsed value when the input matches the schema", () => {
    expect(parseAtBoundary("sample", Sample, { name: "a", count: 2 })).toEqual({ name: "a", count: 2 });
  });

  // proves §0.2 D8 (fail closed): non-matching input is rejected, never passed through
  it("throws BoundaryError naming the boundary and the failing field", () => {
    let caught: unknown;
    try {
      parseAtBoundary("sample", Sample, { name: "", count: 1.5 });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BoundaryError);
    const error = caught as BoundaryError;
    expect(error.boundary).toBe("sample");
    expect(error.issues.map((issue) => issue.path.join("."))).toEqual(["name", "count"]);
    expect(error.message).toContain("sample: input rejected");
  });

  // proves §0.2 D8 (fail closed): absent input is not treated as empty-but-valid
  it.each([undefined, null, "text", 42, []])("rejects non-object input %j", (input) => {
    expect(() => parseAtBoundary("sample", Sample, input)).toThrow(BoundaryError);
  });
});
