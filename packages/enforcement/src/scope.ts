import { type Grant, type ScalarFieldType, argvTokenKinds, pathWithin } from "../../contracts/src/index.js";
import type { CallValue, CapabilityCall, RegistryEntry } from "../../registry/src/index.js";

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
 * Scope is judged on the normalised path as written; symlinks are not
 * resolved. Accepted residual (§0.5 corollary): a symlink already present in
 * the work content can reach outside the scope. Resolving symlinks (§3.3's
 * canonical form) is a gate before JUNO operates on any content it did not
 * create (Slice 1.5), not only when a link-creating program is admitted.
 */

export type ScopeViolation = {
  readonly argument: string;
  /** The value as the call carries it. */
  readonly value: string;
  /** The normalised absolute path the value names, which is what was judged. */
  readonly path: string;
};

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

/** Every path-typed data value, and every argv operand, of `call` that falls outside `grant`'s scope. */
export function scopeViolations(entry: RegistryEntry, call: CapabilityCall, grant: Grant): ScopeViolation[] {
  const { capability, argv_field: argvField, cwd_field: cwdField, program_field: programField } = entry;
  const violations: ScopeViolation[] = [];
  const check = (argument: string, value: CallValue | undefined, path: string | undefined = typeof value === "string" ? value : undefined): void => {
    if (typeof value === "string" && path !== undefined && !pathInScope(path, grant)) violations.push({ argument, value, path });
  };

  for (const [name, field] of Object.entries(capability.interface)) {
    if (field.role !== "data" || name === argvField) continue;
    const value = call[name];
    if (field.type.kind === "list") {
      if (isPath(field.type.items) && Array.isArray(value)) value.forEach((item, index) => check(`${name}[${String(index)}]`, item));
    } else if (field.type.kind === "map") {
      // D-050: no ruling says what a path held in a map names, so each one fails closed, in scope or not.
      if (isPath(field.type.values) && typeof value === "object" && !Array.isArray(value)) {
        for (const [key, item] of Object.entries(value)) {
          violations.push({ argument: `${name}[${JSON.stringify(key)}]`, value: String(item), path: String(item) });
        }
      }
    } else if (isPath(field.type)) {
      check(name, value);
    }
  }

  const program = String(call[programField]);
  const cwd = String(call[cwdField]);
  const argv = (call[argvField] as readonly unknown[]).map(String);
  const surface = entry.program_surfaces.find((candidate) => candidate.program === program);
  argvTokenKinds(program, surface, argv).forEach((kind, index) => {
    const element = argv[index] ?? "";
    if (kind === "operand") check(`${argvField}[${String(index)}]`, element, operandPath(cwd, element));
  });
  return violations;
}
