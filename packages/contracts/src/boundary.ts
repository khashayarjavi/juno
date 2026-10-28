import type { z } from "zod";

/**
 * Raised when input crossing a boundary does not match its schema.
 * Callers fail closed on it (spec §0.2 D8): nothing unparsed goes further.
 */
export class BoundaryError extends Error {
  readonly boundary: string;
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(boundary: string, issues: readonly z.core.$ZodIssue[]) {
    const detail = issues
      .map((issue) => `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    super(`${boundary}: input rejected (${detail})`);
    this.name = "BoundaryError";
    this.boundary = boundary;
    this.issues = issues;
  }
}

/**
 * Parse, don't validate: the only way untyped input becomes a typed value.
 * Returns the schema's output type, or throws BoundaryError.
 */
export function parseAtBoundary<S extends z.ZodType>(
  boundary: string,
  schema: S,
  input: unknown,
): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new BoundaryError(boundary, result.error.issues);
  }
  return result.data;
}
