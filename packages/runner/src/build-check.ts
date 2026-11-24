import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Whether this copy of JUNO is complete (operator's increment 1.5-ops, item 2; DECISIONS.md D-244). `make build` writes,
 * as its very last step, `dist/build-manifest.json`: every file JUNO runs from (`dist`, `package.json`, and each runtime
 * dependency's folder in `node_modules`) with its SHA-256. A copy being built, or one being removed or replaced, lacks
 * the manifest or some file it names, or holds a file other than as built. The hook service's unit runs this check
 * before it starts JUNO itself, so a start on such a copy is refused, in plain words, before any of JUNO's modules is
 * loaded, instead of crashing part way. It uses Node's own modules only, so a missing dependency cannot stop it.
 */

export const MANIFEST = "dist/build-manifest.json";
type Manifest = { readonly version: 1; readonly files: Readonly<Record<string, string>> };

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const codeOf = (error: unknown): unknown => (error instanceof Error && "code" in error ? error.code : undefined);

/** Every regular file below `dir` (relative to `root`, with `/`); anything but a file or a folder stops the build. */
function filesBelow(root: string, dir: string): string[] {
  const found: string[] = [];
  const pending = [dir];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const name of readdirSync(join(root, next)).sort()) {
      const path = `${next}/${name}`;
      const facts = lstatSync(join(root, path));
      if (facts.isDirectory()) pending.push(path);
      else if (facts.isFile()) found.push(path);
      else throw new Error(`${path} is neither a file nor a folder; a build JUNO runs from holds only those`);
    }
  }
  return found;
}

/** The folders of the runtime dependencies, from the lockfile: every package not marked as needed for development only. */
function runtimePackages(root: string): string[] {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as { packages?: Record<string, { dev?: boolean }> };
  return Object.entries(lock.packages ?? {})
    .filter(([path, entry]) => path.startsWith("node_modules/") && entry.dev !== true)
    .map(([path]) => path)
    .sort();
}

/** Writes the manifest of the build at `root`; `make build` runs it last. Answers how many files it names. */
export function writeBuildManifest(root: string): number {
  const paths = ["package.json", ...filesBelow(root, "dist").filter((path) => path !== MANIFEST), ...runtimePackages(root).flatMap((dir) => filesBelow(root, dir))].sort();
  const files: Record<string, string> = {};
  for (const path of paths) files[path] = sha256(readFileSync(join(root, path)));
  const manifest: Manifest = { version: 1, files };
  writeFileSync(join(root, MANIFEST), `${JSON.stringify(manifest, null, 1)}\n`, { mode: 0o644 });
  return paths.length;
}

/** Why the copy of JUNO at `root` must not run: empty when every file the manifest names is there, as built. */
export function buildRefusals(root: string): string[] {
  const at = join(root, MANIFEST);
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(at, "utf8"));
  } catch (error: unknown) {
    return [codeOf(error) === "ENOENT" ? `${at} is missing, so this copy of JUNO is not a finished build (one still being built, or one being removed or replaced)` : `${at} cannot be read: ${error instanceof Error ? error.message : String(error)}`];
  }
  const files = typeof manifest === "object" && manifest !== null && (manifest as { version?: unknown }).version === 1 ? (manifest as { files?: unknown }).files : undefined;
  if (typeof files !== "object" || files === null || Array.isArray(files) || Object.keys(files).length === 0) return [`${at} is not a build manifest JUNO wrote`];
  const missing: string[] = [];
  const changed: string[] = [];
  for (const [path, digest] of Object.entries(files as Record<string, unknown>)) {
    if (typeof digest !== "string" || isAbsolute(path) || normalize(path) !== path || path.split(sep).includes("..")) return [`${at} is not a build manifest JUNO wrote (it names ${JSON.stringify(path)})`];
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(root, path));
    } catch {
      missing.push(path);
      continue;
    }
    if (sha256(bytes) !== digest) changed.push(path);
  }
  const listed = (paths: string[]): string => `${paths.slice(0, 5).join(", ")}${paths.length > 5 ? `, and ${String(paths.length - 5)} more` : ""}`;
  return [
    ...(missing.length === 0 ? [] : [`${String(missing.length)} of the files JUNO was built with are missing from ${root}: ${listed(missing)}`]),
    ...(changed.length === 0 ? [] : [`${String(changed.length)} of the files in ${root} are not as JUNO built them: ${listed(changed)}`]),
  ];
}

/** `juno-build-check`: checks the copy it is part of (`dist/runner/src` is three folders below its root). */
export function main(io: { readonly out: (text: string) => void; readonly err: (text: string) => void } = { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) }, root: string = fileURLToPath(new URL("../../../", import.meta.url))): number {
  const refusals = buildRefusals(root);
  if (refusals.length === 0) {
    io.out(`juno-build-check: this copy of JUNO at ${root} is complete: every file matches ${MANIFEST}\n`);
    return 0;
  }
  io.err(`juno-build-check: refused: JUNO will not start from an incomplete copy (D-244):\n${refusals.map((line) => `  - ${line}`).join("\n")}\nFinish the upgrade's steps (docs/operator-setup.md, "Upgrading JUNO to a new commit"), then start again.\n`);
  return 1;
}
