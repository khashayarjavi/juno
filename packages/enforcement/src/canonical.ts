import { z } from "zod";
import { type WorkloadTarget, WorkloadTarget as WorkloadTargetSchema, executeOutbound } from "../../registry/src/index.js";
import { parseAtBoundary } from "../../contracts/src/index.js";

/**
 * Canonical scope (spec §2.7.1 "Data fields and scope", v0.6 C4; "Paths that do not exist yet", v0.6.1 V6-2;
 * DECISIONS.md D-113).
 *
 * Step 4 judges every path on its canonical form: symlinks resolved against the volume the effect will touch. A path
 * that does not exist yet is resolved through its longest existing ancestor: the ancestor is canonicalized and must lie
 * in scope, and the missing remainder must hold no `..`, no symlink and no empty component. A path that cannot be
 * resolved (a symlink loop, a permission error, a remainder that fails those conditions) is outside scope.
 *
 * Resolution runs where the effect runs, by an operator-fixed program the model never names: the workload image's own
 * node with `RESOLVER_SCRIPT`. It is not in any capability's program enum; the boundary's caller runs it before the
 * boundary judges, and the boundary judges only what it returned.
 */

export type CanonicalPath = { readonly ok: true; readonly canonical: string } | { readonly ok: false; readonly reason: string };
/** Raw path (as the call carries it, joined to `cwd`) → its canonical form, or why it has none. */
export type CanonicalPaths = ReadonlyMap<string, CanonicalPath>;

export interface PathResolver {
  /** Resolves each raw absolute path. Every path asked for is answered; one the resolver cannot answer is `ok: false`. */
  resolve(paths: readonly string[]): Promise<CanonicalPaths>;
}

/**
 * The resolver, as one self-contained node program. Arguments: the path prefix the program's filesystem view maps
 * from and to (`/work` and `/work` in the workload; a host directory in unit tests), then the raw paths. It prints one
 * JSON array: per path, `{ path, canonical }` or `{ path, error }`.
 */
export const RESOLVER_SCRIPT = String.raw`
const fs = require("node:fs");
const [from, to, ...paths] = process.argv.slice(1);
const inside = (p) => p === from || p.startsWith(from + "/") ? to + p.slice(from.length) : null;
const outside = (p) => p === to || p.startsWith(to + "/") ? from + p.slice(to.length) : null;
const results = paths.map((path) => {
  if (!path.startsWith("/")) return { path, error: "not absolute" };
  const parts = path.split("/").slice(1);
  for (let keep = parts.length; keep >= 0; keep -= 1) {
    const ancestor = "/" + parts.slice(0, keep).join("/");
    const mapped = inside(ancestor);
    if (mapped === null) {
      if (keep === 0) return { path, error: "no part of the path lies in the resolver's view" };
      continue;
    }
    let real;
    // .native is libc realpath(3): physical resolution, as the kernel does it (the JS one collapses .. before symlinks).
    try { real = fs.realpathSync.native(mapped); } catch (error) {
      if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) continue;
      return { path, error: "cannot be resolved: " + (error && error.code ? error.code : "error") };
    }
    const canonicalAncestor = outside(real);
    if (canonicalAncestor === null) return { path, error: "resolves outside the resolver's view" };
    const rest = parts.slice(keep);
    if (rest.some((part) => part === ".." || part === "")) return { path, error: "the missing remainder holds .. or an empty component" };
    if (rest.length > 0) {
      try { fs.lstatSync(mapped + "/" + rest[0]); return { path, error: "a dangling symlink, or an entry that cannot be resolved" }; } catch (error) {
        if (!(error && (error.code === "ENOENT" || error.code === "ENOTDIR"))) return { path, error: "cannot be resolved: " + (error && error.code ? error.code : "error") };
      }
    }
    const tail = rest.filter((part) => part !== ".");
    return { path, canonical: tail.length === 0 ? canonicalAncestor : (canonicalAncestor === "/" ? "" : canonicalAncestor) + "/" + tail.join("/") };
  }
  return { path, error: "no ancestor exists" };
});
process.stdout.write(JSON.stringify(results));
`;

const ResolverOutput = z.array(z.union([z.strictObject({ path: z.string(), canonical: z.string() }), z.strictObject({ path: z.string(), error: z.string() })]));

/** Reads the resolver's output for `paths`. Anything unreadable, or a path it did not answer, is unresolved (fail-closed). */
export function readResolverOutput(paths: readonly string[], stdout: string): CanonicalPaths {
  const answered = new Map<string, CanonicalPath>();
  let parsed: z.infer<typeof ResolverOutput>;
  try {
    parsed = ResolverOutput.parse(JSON.parse(stdout));
  } catch {
    parsed = [];
  }
  for (const item of parsed) answered.set(item.path, "canonical" in item ? { ok: true, canonical: item.canonical } : { ok: false, reason: item.error });
  return new Map(paths.map((path) => [path, answered.get(path) ?? { ok: false, reason: "the resolver did not answer" }]));
}

/** The workload image's node: the resolver's program (D-113). Not in any capability's enum. */
export const WORKLOAD_NODE = "/nodejs/bin/node";

/** Resolves in a fresh workload container, with the same isolation as every capability call (D-113). */
export class WorkloadPathResolver implements PathResolver {
  readonly #target: WorkloadTarget;

  constructor(target: WorkloadTarget) {
    this.#target = parseAtBoundary("workload target", WorkloadTargetSchema, target);
  }

  async resolve(paths: readonly string[]): Promise<CanonicalPaths> {
    if (paths.length === 0) return new Map();
    const { composeFile, project, service } = this.#target;
    try {
      const result = await executeOutbound({
        file: "docker",
        args: ["compose", "-f", composeFile, "-p", project, "run", "--rm", "--no-deps", "-T", "--entrypoint", WORKLOAD_NODE, service, "-e", RESOLVER_SCRIPT, "/work", "/work", ...paths],
      });
      return readResolverOutput(paths, result.exitCode === 0 ? result.stdout.toString("utf8") : "");
    } catch (error: unknown) {
      const reason = `the resolver did not run: ${error instanceof Error ? error.message : String(error)}`;
      return new Map(paths.map((path) => [path, { ok: false, reason }]));
    }
  }
}
