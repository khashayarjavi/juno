import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type AbsolutePath, WorkPath, parseAtBoundary } from "../../contracts/src/index.js";
import { WORKLOAD_NODE } from "./canonical.js";
import { canonicalJson } from "../../journal/src/index.js";
import { type WorkloadTarget, WorkloadTarget as WorkloadTargetSchema } from "../../registry/src/index.js";

/**
 * Reversible workspaces (spec §2.2.2, v0.6 A1; DECISIONS.md D-136).
 *
 * "A scope is reversible when a checkpoint of its full content is taken before the task's first effect on it and
 * restoring that checkpoint is an operator action recorded in the journal."
 *
 *   - The operator names the task's reversible workspaces at admission. Before the task's first turn, so before any
 *     effect, the runner snapshots each one where the effects run: an operator-fixed node program (`SNAPSHOT_SCRIPT`)
 *     that never follows a symlink. It stores every file's bytes in the content-addressed checkpoint store (outside
 *     every mount and every selector), and journals the manifest (paths, types, modes, hashes, symlink targets). The
 *     checkpoint's id is the SHA-256 of the canonical manifest.
 *   - Restoring is the operator's action (`juno checkpoint restore`). `RESTORE_SCRIPT` writes the manifest back where
 *     the effects run, removing whatever the manifest lacks, then lists the result. The result is compared with the
 *     manifest, and the restore and its outcome are journalled.
 *
 * Bounds: at most `MAX_CHECKPOINT_ENTRIES` entries and `MAX_CHECKPOINT_BYTES` of file content. A larger workspace is
 * not checkpointed, and its task fails before its first turn: a scope is never treated as reversible on a partial copy.
 */

export const MAX_CHECKPOINT_ENTRIES = 2000;
export const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;

/**
 * Lists a workspace without following any symlink. Arguments: the view roots (`/work` and `/work` in the workload; a
 * host directory in unit tests), the workspace root, the bounds, and `content` or `listing`. Prints
 * `{ entries, hard_links }` (paths relative to the root, the root itself as ""; `hard_links` names the regular files
 * whose link count is above 1, D-157) or `{ error }`.
 */
export const SNAPSHOT_SCRIPT = String.raw`
const fs = require("node:fs"); const crypto = require("node:crypto");
const [from, to, root, maxEntries, maxBytes, mode] = process.argv.slice(1);
const out = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
if (root !== from && !root.startsWith(from + "/")) out({ error: "the workspace root is outside the view" });
const host = (rel) => to + root.slice(from.length) + (rel === "" ? "" : "/" + rel);
let top; try { top = fs.lstatSync(host("")); } catch (error) { out({ error: "cannot read the workspace root: " + (error.code || "error") }); }
if (!top.isDirectory()) out({ error: "the workspace root is not a directory (a symlink is refused)" });
const entries = [{ path: "", type: "directory", mode: top.mode & 0o7777 }]; const hardLinks = []; let bytes = 0;
const walk = (rel) => {
  for (const name of fs.readdirSync(host(rel)).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const path = rel === "" ? name : rel + "/" + name; const s = fs.lstatSync(host(path)); const m = s.mode & 0o7777;
    if (entries.length >= Number(maxEntries)) out({ error: "the workspace has more than " + maxEntries + " entries" });
    if (s.isDirectory()) { entries.push({ path, type: "directory", mode: m }); walk(path); }
    else if (s.isSymbolicLink()) entries.push({ path, type: "symlink", mode: m, target: fs.readlinkSync(host(path)) });
    else if (s.isFile()) {
      const data = fs.readFileSync(host(path)); bytes += data.length;
      if (bytes > Number(maxBytes)) out({ error: "the workspace holds more than " + maxBytes + " bytes" });
      const entry = { path, type: "file", mode: m, sha256: crypto.createHash("sha256").update(data).digest("hex") };
      if (mode === "content") entry.content = data.toString("base64");
      if (s.nlink > 1) hardLinks.push(path);
      entries.push(entry);
    } else out({ error: "the workspace holds an entry that is not a file, directory or symlink: " + path });
  }
};
try { walk(""); } catch (error) { out({ error: "cannot list the workspace: " + (error.code || "error") }); }
out({ entries, hard_links: hardLinks });
`;

/**
 * Writes a manifest back. Arguments: the view roots, the workspace root; the manifest with every file's content
 * (base64) arrives on standard input. Removes every entry the manifest lacks or whose type differs, recreates the rest
 * (directories first, in manifest order), sets every mode, then prints the listing `SNAPSHOT_SCRIPT` would print.
 * Operator-run only, while no task runs on the workspace; it never follows a symlink, because every entry whose type
 * differs from the manifest is removed before anything is written beneath it.
 */
export const RESTORE_SCRIPT = String.raw`
const fs = require("node:fs"); const crypto = require("node:crypto");
const [from, to, root] = process.argv.slice(1);
const out = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
if (root !== from && !root.startsWith(from + "/")) out({ error: "the workspace root is outside the view" });
const host = (rel) => to + root.slice(from.length) + (rel === "" ? "" : "/" + rel);
const chunks = []; process.stdin.on("data", (c) => chunks.push(c)); process.stdin.on("end", () => {
  let manifest; try { manifest = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { out({ error: "the manifest is not JSON" }); }
  const want = new Map(manifest.entries.map((e) => [e.path, e]));
  try {
    const top = fs.lstatSync(host(""));
    if (!top.isDirectory()) out({ error: "the workspace root is not a directory (a symlink is refused)" });
    const prune = (rel) => { for (const name of fs.readdirSync(host(rel))) {
      const path = rel === "" ? name : rel + "/" + name; const s = fs.lstatSync(host(path)); const w = want.get(path);
      const type = s.isDirectory() ? "directory" : s.isSymbolicLink() ? "symlink" : s.isFile() ? "file" : "other";
      if (w === undefined || w.type !== type) fs.rmSync(host(path), { recursive: true, force: true });
      else if (type === "directory") { fs.chmodSync(host(path), 0o700); prune(path); } } };
    fs.chmodSync(host(""), 0o700); prune("");
    for (const e of manifest.entries) { if (e.path === "") continue; const p = host(e.path);
      if (e.type === "directory") { try { fs.mkdirSync(p, 0o700); } catch (error) { if (error.code !== "EEXIST") throw error; } }
      else if (e.type === "symlink") { fs.rmSync(p, { force: true }); fs.symlinkSync(e.target, p); }
      else { const data = Buffer.from(e.content, "base64");
        if (crypto.createHash("sha256").update(data).digest("hex") !== e.sha256) out({ error: "content does not match its hash: " + e.path });
        fs.rmSync(p, { force: true }); const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeSync(fd, data); fs.closeSync(fd); fs.chmodSync(p, e.mode); } }
    for (const e of [...manifest.entries].reverse()) if (e.type === "directory") fs.chmodSync(host(e.path), e.mode);
  } catch (error) { out({ error: "cannot restore: " + (error.code || error.message || "error") }); }
  out({ restored: true });
});
`;

export const ManifestEntry = z.discriminatedUnion("type", [
  z.strictObject({ path: z.string(), type: z.literal("directory"), mode: z.int().min(0).max(0o7777) }),
  z.strictObject({ path: z.string(), type: z.literal("symlink"), mode: z.int().min(0).max(0o7777), target: z.string() }),
  z.strictObject({ path: z.string(), type: z.literal("file"), mode: z.int().min(0).max(0o7777), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
]);
export type ManifestEntry = z.infer<typeof ManifestEntry>;

const SnapshotEntry = z.union([
  ManifestEntry.options[0],
  ManifestEntry.options[1],
  z.strictObject({ path: z.string(), type: z.literal("file"), mode: z.int().min(0).max(0o7777), sha256: z.string().regex(/^[0-9a-f]{64}$/), content: z.string().optional() }),
]);
const SnapshotOutput = z.union([z.strictObject({ entries: z.array(SnapshotEntry), hard_links: z.array(z.string()) }), z.strictObject({ error: z.string() })]);
const RestoreOutput = z.union([z.strictObject({ restored: z.literal(true) }), z.strictObject({ error: z.string() })]);

/**
 * A workspace's full content: the manifest, and the bytes of every file by hash. `hardLinks`: the files (paths relative
 * to the root) whose link count is above 1 (D-157); not part of the manifest, so checkpoint ids are unchanged.
 */
export type Snapshot = { readonly manifest: readonly ManifestEntry[]; readonly contents: ReadonlyMap<string, Buffer>; readonly hardLinks: readonly string[] };

/** The checkpoint's id: the SHA-256 of its canonical manifest. */
export function checkpointId(root: string, manifest: readonly ManifestEntry[]): string {
  return createHash("sha256").update(canonicalJson({ root, manifest })).digest("hex");
}

/** Runs one of the scripts where the effects run: `args` after the program, `input` on standard input. */
export type ScriptRunner = (args: readonly string[], input: string | null) => Promise<{ readonly exitCode: number | null; readonly stdout: string }>;

/** Takes and restores workspace snapshots where effects run, by the operator-fixed scripts above. */
export class Workspace {
  readonly #run: ScriptRunner;
  readonly #from: string;
  readonly #to: string;

  /** `from`/`to`: the view the scripts map (`/work` → `/work` in the workload; `/work` → a host directory in tests). */
  constructor(run: ScriptRunner, from: AbsolutePath = "/work", to: AbsolutePath = "/work") {
    this.#run = run;
    this.#from = from;
    this.#to = to;
  }

  /** The directory this view reads for `/work` (a host directory in hook mode, `/work` in the workload). */
  get viewRoot(): string {
    return this.#to;
  }

  /** Every entry under `root`, with content when asked; or why it could not be taken. */
  async list(root: string, content: boolean): Promise<{ ok: true; snapshot: Snapshot } | { ok: false; reason: string }> {
    const parsedRoot = WorkPath.safeParse(root);
    if (!parsedRoot.success) return { ok: false, reason: "the workspace root is not a path in the capability namespace" };
    const args = ["-e", SNAPSHOT_SCRIPT, "--", this.#from, this.#to, parsedRoot.data, String(MAX_CHECKPOINT_ENTRIES), String(MAX_CHECKPOINT_BYTES), content ? "content" : "listing"];
    let output: z.infer<typeof SnapshotOutput>;
    try {
      const result = await this.#run(args, null);
      output = SnapshotOutput.parse(JSON.parse(result.exitCode === 0 ? result.stdout : "null"));
    } catch (error: unknown) {
      return { ok: false, reason: `the snapshot did not run: ${error instanceof Error ? error.message : String(error)}` };
    }
    if ("error" in output) return { ok: false, reason: output.error };
    const contents = new Map<string, Buffer>();
    const manifest = output.entries.map((entry): ManifestEntry => {
      if (entry.type !== "file") return entry;
      const { content: encoded, ...rest } = entry as typeof entry & { content?: string };
      if (encoded !== undefined) contents.set(entry.sha256, Buffer.from(encoded, "base64"));
      return rest;
    });
    for (const [hash, bytes] of contents) {
      if (createHash("sha256").update(bytes).digest("hex") !== hash) return { ok: false, reason: "a file's content does not match its hash" };
    }
    return { ok: true, snapshot: { manifest, contents, hardLinks: output.hard_links } };
  }

  /** Writes `manifest` back under `root`, with each file's bytes from `content`. */
  async restore(root: string, manifest: readonly ManifestEntry[], content: (hash: string) => Buffer): Promise<{ ok: true } | { ok: false; reason: string }> {
    const entries = manifest.map((entry) => (entry.type === "file" ? { ...entry, content: content(entry.sha256).toString("base64") } : entry));
    try {
      const result = await this.#run(["-e", RESTORE_SCRIPT, "--", this.#from, this.#to, root], JSON.stringify({ entries }));
      const output = RestoreOutput.parse(JSON.parse(result.exitCode === 0 ? result.stdout : "null"));
      return "error" in output ? { ok: false, reason: output.error } : { ok: true };
    } catch (error: unknown) {
      return { ok: false, reason: `the restore did not run: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

/** Runs a program by execFile with an argv array (no shell) and, when given, writes `input` to its standard input. */
export function execFileScript(file: string, prefix: readonly string[]): ScriptRunner {
  return (args, input) =>
    new Promise((resolve, reject) => {
      const child = execFile(file, [...prefix, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: false }, (error, stdout) => {
        if (error === null) resolve({ exitCode: 0, stdout });
        else if (typeof error.code === "number") resolve({ exitCode: error.code, stdout });
        else reject(error);
      });
      child.stdin?.end(input ?? undefined);
    });
}

/** The scripts in a fresh workload container, with the same isolation as every capability call (D-136). */
export function workloadWorkspace(target: WorkloadTarget): Workspace {
  const { composeFile, project, service } = parseAtBoundary("workload target", WorkloadTargetSchema, target);
  return new Workspace(execFileScript("docker", ["compose", "-f", composeFile, "-p", project, "run", "--rm", "--no-deps", "-T", "--entrypoint", WORKLOAD_NODE, service]));
}

/**
 * The content-addressed checkpoint store (§2.2.2, D-136): a directory outside every mount and every selector. Each
 * file's bytes are kept under their SHA-256, written once; a read is checked against its name.
 */
export class CheckpointStore {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  put(bytes: Buffer): string {
    const hash = createHash("sha256").update(bytes).digest("hex");
    try {
      writeFileSync(join(this.#dir, hash), bytes, { flag: "wx", mode: 0o400 });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return hash;
  }

  get(hash: string): Buffer {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("not a content hash");
    const bytes = readFileSync(join(this.#dir, hash));
    if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error(`checkpoint content ${hash} does not match its hash`);
    return bytes;
  }
}

/** Whether a listing is exactly the manifest: same paths, types, modes, hashes and targets. */
export function sameManifest(a: readonly ManifestEntry[], b: readonly ManifestEntry[]): boolean {
  return canonicalJson([...a]) === canonicalJson([...b]);
}
