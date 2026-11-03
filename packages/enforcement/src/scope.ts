import { type Grant, type ScalarFieldType, argvTokenKinds, pathWithin } from "../../contracts/src/index.js";
import type { CapabilityCall, RegistryEntry } from "../../registry/src/index.js";
import type { CanonicalPaths } from "./canonical.js";

/**
 * §2.7 step 4: a `data` field outside the grant's `resource_scope` parks
 * `scope_violation` (DECISIONS.md D-047, the operator's ruling on O-4).
 *
 *   - A `path`-typed data value must lie inside a path selector of the grant
 *     (prefix containment at a segment boundary, D-020).
 *   - Every argv element the D-037 reading classes as an operand is a path:
 *     a relative one is read against the call's `cwd`, and it is normalised
 *     (`.` and `..` resolved as written). Flags and subcommands are not
 *     resources. Plain text resolves under `cwd`, so it passes whenever `cwd`
 *     does; an absolute path or a `..` escape outside the scope does not.
 *   - A path value held in a `map` data field always fails (D-050).
 *
 * Since v0.6 (C4, D-113) scope is judged on the **canonical** path: the raw
 * path (absolute as given, or `cwd` + "/" + operand, with `..` not collapsed)
 * resolved, symlinks included, where the effect will run (§2.7.1). The caller
 * resolves the raw paths `scopePaths` lists and passes the answers; a path with
 * no canonical form, or one missing from the answers, is outside every scope.
 * This closes D-047's accepted residual (a symlink in the work content reaching
 * outside the scope).
 */

export type ScopeViolation = {
  readonly argument: string;
  /** The value as the call carries it. */
  readonly value: string;
  /** What was judged: the canonical path, or the raw path when it has none. */
  readonly path: string;
  /** Why the raw path has no canonical form, when it has none (it is then outside every scope). */
  readonly unresolved?: string;
};

/** One path a call names: the argument, its value, and the raw absolute path the resolver resolves (D-113). */
export type ScopePath = { readonly argument: string; readonly value: string; readonly raw: string };

/** Normalises `operand` as a path: absolute as given, or relative to `cwd`; `.` and `..` resolved; never above `/`. */
export function operandPath(cwd: string, operand: string): string {
  const segments: string[] = [];
  for (const segment of (operand.startsWith("/") ? operand : cwd + "/" + operand).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return "/" + segments.join("/");
}

function isPath(type: ScalarFieldType): boolean {
  return type.kind === "path";
}

function pathInScope(path: string, grant: Grant): boolean {
  return grant.resource_scope.some((selector) => selector.kind === "path" && pathWithin(path, selector.prefix));
}

/** The raw path an argv operand names: absolute as given, else joined to `cwd`; nothing collapsed (D-113). */
export function rawOperandPath(cwd: string, operand: string): string {
  return operand.startsWith("/") ? operand : `${cwd.endsWith("/") ? cwd.slice(0, -1) : cwd}/${operand}`;
}

/**
 * Every path `call` names, as step 4 judges them (D-047, D-113): each path-typed data value (outside `argv`), and each
 * argv operand by the D-037 reading. A path held in a map field is not listed: it fails closed regardless (D-050).
 * The one reading shared by the caller's resolution and step 4, so the two can never judge different paths.
 */
export function scopePaths(entry: RegistryEntry, call: CapabilityCall): ScopePath[] {
  const { capability, argv_field: argvField, cwd_field: cwdField, program_field: programField } = entry;
  const paths: ScopePath[] = [];
  for (const [name, field] of Object.entries(capability.interface)) {
    if (field.role !== "data" || name === argvField) continue;
    const value = call[name];
    if (field.type.kind === "list") {
      if (isPath(field.type.items) && Array.isArray(value)) {
        value.forEach((item, index) => {
          if (typeof item === "string") paths.push({ argument: `${name}[${String(index)}]`, value: item, raw: item });
        });
      }
    } else if (field.type.kind !== "map" && isPath(field.type) && typeof value === "string") {
      paths.push({ argument: name, value, raw: value });
    }
  }
  const program = String(call[programField]);
  const cwd = String(call[cwdField]);
  const argv = (call[argvField] as readonly unknown[]).map(String);
  const surface = entry.program_surfaces.find((candidate) => candidate.program === program);
  argvTokenKinds(program, surface, argv).forEach((kind, index) => {
    const element = argv[index] ?? "";
    if (kind === "operand") paths.push({ argument: `${argvField}[${String(index)}]`, value: element, raw: rawOperandPath(cwd, element) });
  });
  return paths;
}

/**
 * Every path of `call` that falls outside `grant`'s scope, judged on its canonical form (§2.7.1 C4, D-113): a path with
 * no canonical form in `canonical` is outside. A path held in a map field always fails (D-050).
 */
export function scopeViolations(entry: RegistryEntry, call: CapabilityCall, grant: Grant, canonical: CanonicalPaths): ScopeViolation[] {
  const violations: ScopeViolation[] = [];
  for (const { argument, value, raw } of scopePaths(entry, call)) {
    const answer = canonical.get(raw);
    if (answer === undefined || !answer.ok) violations.push({ argument, value, path: raw, unresolved: answer === undefined ? "not resolved" : answer.reason });
    else if (!pathInScope(answer.canonical, grant)) violations.push({ argument, value, path: answer.canonical });
  }
  for (const [name, field] of Object.entries(entry.capability.interface)) {
    const value = call[name];
    // D-050: no ruling says what a path held in a map names, so each one fails closed, in scope or not.
    if (field.role === "data" && field.type.kind === "map" && isPath(field.type.values) && typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [key, item] of Object.entries(value)) violations.push({ argument: `${name}[${JSON.stringify(key)}]`, value: String(item), path: String(item) });
    }
  }
  return violations;
}
