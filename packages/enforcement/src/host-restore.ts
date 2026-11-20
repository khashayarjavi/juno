import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { type Stats, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { MAX_CHECKPOINT_ENTRIES, type ManifestEntry, type Snapshot, Workspace, sameManifest } from "./checkpoint.js";
import { WORKLOAD_NODE } from "./canonical.js";
import { DIR_MODE, FILE_MODE } from "./workspace-copy.mjs";

export { DIR_MODE, FILE_MODE, MAX_SCAN as MAX_RESTORE_SCAN, kernelMayChange, listTree, openRoot, openRootAt, restoreRefusals, restoreTree } from "./workspace-copy.mjs";

/**
 * Hook workspaces: their checkpoints and their restores (spec §2.2.2, "restoring that checkpoint is an operator action
 * recorded in the journal"; DECISIONS.md D-221, D-228).
 *
 * The workspace is a folder the Claude Code user controls. Rounds 1, 3, 4 and 5 of PR #60's review (D-223, D-225,
 * D-226, D-227) were one class: JUNO, with the runner's privileges, operating on that folder. The operator's ruling of
 * 2026-11-20 closes the class (D-228): every checkpoint copy, every judgement of whether a checkpoint could be restored,
 * and every restore runs in a context that can reach nothing the Claude Code user cannot reach:
 *
 *   - a fresh container (`dockerSealedLauncher`), on the runner's own rootless runtime: as the runner's host identity
 *     (container root, which rootless Docker maps to the runner) with every capability dropped and no new privileges;
 *     no network; a read-only image (the workload image, whose files are JUNO's public code); no IPC; no logs kept;
 *     the D-025 limits; and exactly one mount, the workspace: read-only for the copy, writable for the restore and for
 *     the judgement of whether the runner could restore (the kernel's write test needs a writable mount; that run
 *     reads no file and changes nothing);
 *   - the checkpoint's bytes cross on standard input and output, so neither the checkpoint store nor the journal, the
 *     journal key, the runner's home or anything else of the runner's is in the container at all;
 *   - the program it runs is `workspace-copy.mjs`, which takes only files and folders, fixed modes, and steps through
 *     folder handles that never follow a link (item 2).
 * A link planted in the workspace resolves inside that container, where the runner's state does not exist.
 *
 * On the host, JUNO only opens the workspace folder itself (never following a link) to learn its identity, which the
 * sealed program compares with the folder it was given before reading or changing anything, and refuses a workspace
 * whose path someone other than root and the runner could replace (`workspaceRefusals`). The read view (`HostReadView`)
 * lists names and kinds without ever opening a file. No root, no sudo, no new privilege for the runner.
 */

/** The image the sealed context runs: the workload image `make containers` builds (distroless node; D-013). */
export const SEALED_IMAGE = "juno-workload:local";

/** One run of the sealed program: the operation, the service's host folder, the workspace root, and its identity. */
export type SealedRequest = {
  readonly op: "checkpoint" | "check" | "restore";
  /** The service's `--workspace`, a real path, standing for /work. */
  readonly workspace: string;
  readonly root: string;
  /** What JUNO's own handle on `workspace` reads (decimal strings). */
  readonly dev: string;
  readonly ino: string;
  readonly input: string | null;
};
/** Runs the sealed program for a request; the production launcher is `dockerSealedLauncher`. */
export type SealedLauncher = (request: SealedRequest) => Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }>;

const PROGRAM_URL = new URL("./workspace-copy.mjs", import.meta.url);

/** The sealed program's text, as `node --input-type=module -e` runs it. */
export function sealedProgram(): string {
  return `${readFileSync(PROGRAM_URL, "utf8")}\nawait main(process.argv.slice(1), readStdin);\n`;
}

/** The workspace path in the one form a mount option may carry: absolute, with no character the option syntax would read. */
const SAFE_PATH = /^\/[A-Za-z0-9._@+/-]+$/;

/**
 * The `docker run` arguments of the sealed context for `request` (D-228). `rootless`: the runtime maps container root
 * to the runner (Docker's rootless mode), so the program runs as 0:0 there; on a root-run daemon it runs as the
 * runner's own uid and gid. `program`: the text node evaluates (the sealed program; tests probe with their own).
 */
export function sealedDockerArgs(request: SealedRequest, options: { readonly rootless: boolean; readonly image?: string; readonly uid?: number; readonly gid?: number }, program: string = sealedProgram()): string[] {
  if (!SAFE_PATH.test(request.workspace)) throw new Error(`the workspace ${request.workspace} holds a character a mount cannot carry`);
  const user = options.rootless ? "0:0" : `${String(options.uid ?? process.getuid?.() ?? -1)}:${String(options.gid ?? process.getgid?.() ?? -1)}`;
  return [
    "run", "--rm", "-i", "--pull", "never",
    "--network", "none", "--ipc", "none", "--log-driver", "none",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only",
    "--user", user,
    "--cpus", "1", "--memory", "512m", "--memory-swap", "512m", "--pids-limit", "64",
    "--mount", ["type=bind", `source=${request.workspace}`, "target=/work", ...(request.op === "checkpoint" ? ["readonly"] : [])].join(","),
    "--entrypoint", WORKLOAD_NODE,
    options.image ?? SEALED_IMAGE,
    "--input-type=module", "-e", program, "--",
    request.op, "/work", request.root, request.dev, request.ino,
  ];
}

/** Runs `file` with `args` by execFile (no shell), `input` on standard input. */
export function runProgram(file: string, args: readonly string[], input: string | null, timeoutMs = 180_000): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, [...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, shell: false }, (error, stdout, stderr) => {
      if (error === null) resolve({ exitCode: 0, stdout, stderr });
      else if (typeof error.code === "number") resolve({ exitCode: error.code, stdout, stderr });
      else if (error.killed === true) resolve({ exitCode: null, stdout, stderr: `${stderr}\n(timed out)` });
      else reject(error);
    });
    child.stdin?.end(input ?? undefined);
  });
}

/** The sealed context on the runner's own container runtime (D-228). */
export function dockerSealedLauncher(options: { readonly rootless: boolean; readonly image?: string; readonly docker?: string }): SealedLauncher {
  return (request) => runProgram(options.docker ?? "docker", sealedDockerArgs(request, options), request.input);
}

/**
 * Why `workspace` cannot be handed to the sealed context: it must be an absolute real path (no link on the way) that
 * only root and the runner could replace: every folder above it owned by one of them, and writable by no one else
 * unless sticky (where no one may replace another's entry). Reads only.
 */
export function workspaceRefusals(workspace: string, uid: number = process.geteuid?.() ?? -1): string[] {
  if (!SAFE_PATH.test(workspace)) return [`the workspace ${workspace} must be an absolute path of letters, digits and . _ @ + - only`];
  let real: string;
  try {
    real = realpathSync.native(workspace);
  } catch (error: unknown) {
    return [`the workspace ${workspace} cannot be resolved (${error instanceof Error && "code" in error ? String(error.code) : "error"})`];
  }
  if (real !== workspace) return [`the workspace ${workspace} is reached through a symbolic link (it resolves to ${real}); give its real path`];
  const refusals: string[] = [];
  for (let folder = dirname(workspace); ; folder = dirname(folder)) {
    const stats = lstatSync(folder);
    if (stats.uid !== 0 && stats.uid !== uid) refusals.push(`${folder}, above the workspace, belongs to uid ${String(stats.uid)}, who could put another folder in the workspace's place (D-228)`);
    else if ((stats.mode & 0o022) !== 0 && (stats.mode & 0o1000) === 0) refusals.push(`${folder}, above the workspace, is writable by group or others without the sticky bit, so they could put another folder in the workspace's place (D-228)`);
    if (folder === "/") break;
  }
  return refusals;
}

const SealedEntrySchema = z.discriminatedUnion("type", [
  z.strictObject({ path: z.string(), type: z.literal("directory"), mode: z.literal(DIR_MODE) }),
  z.strictObject({ path: z.string(), type: z.literal("file"), mode: z.literal(FILE_MODE), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
]);
const SealedAnswer = z.union([
  z.strictObject({ error: z.string() }),
  z.strictObject({ manifest: z.array(SealedEntrySchema), contents: z.record(z.string(), z.string()) }),
  z.strictObject({ refusals: z.array(z.string()) }),
  z.strictObject({ refused: z.array(z.string()) }),
  z.strictObject({ failed: z.string() }),
  z.strictObject({ restored: z.array(SealedEntrySchema) }),
]);
type SealedAnswer = z.infer<typeof SealedAnswer>;

/** A hook workspace's restore outcome: `changed` says whether the folder may differ from what it was before. */
export type SealedRestore = { readonly ok: true } | { readonly ok: false; readonly changed: boolean; readonly reason: string };

/**
 * A hook session's host workspace, reached only through the sealed context (D-228). `workspace` is the service's
 * `--workspace`; every root is a path under /work.
 */
export class SealedWorkspace {
  readonly workspace: string;
  readonly #launch: SealedLauncher;

  constructor(workspace: string, launch: SealedLauncher) {
    this.workspace = workspace;
    this.#launch = launch;
  }

  async #run(op: SealedRequest["op"], root: string, input: string | null): Promise<SealedAnswer> {
    const refusals = workspaceRefusals(this.workspace);
    if (refusals.length > 0) return { error: `${refusals.join("; ")}; nothing was read or changed` };
    let fd: number;
    try {
      fd = openSync(this.workspace, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch (error: unknown) {
      return { error: `the workspace ${this.workspace} cannot be opened as a folder (${error instanceof Error && "code" in error ? String(error.code) : "error"}); nothing was read or changed` };
    }
    // The handle stays open while the sealed program runs, so the identity it compares names this very folder.
    try {
      const identity = fstatSync(fd, { bigint: true });
      const result = await this.#launch({ op, workspace: this.workspace, root, dev: String(identity.dev), ino: String(identity.ino), input });
      const parsed = SealedAnswer.safeParse((() => {
        try {
          return JSON.parse(result.stdout) as unknown;
        } catch {
          return null;
        }
      })());
      if (!parsed.success) return { error: `the sealed copy context did not answer (exit ${String(result.exitCode)}${result.stderr.trim() === "" ? "" : `: ${result.stderr.trim().slice(0, 500)}`})` };
      return parsed.data;
    } catch (error: unknown) {
      return { error: `the sealed copy context did not run: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Takes the checkpoint of `root` (on a read-only mount), then judges that the runner could restore it as the folder
   * stands (on a writable mount, reading no file and changing nothing): refused unless it holds only files and folders
   * and the runner could restore them (D-221, D-228).
   */
  async checkpoint(root: string): Promise<{ ok: true; snapshot: Snapshot } | { ok: false; reason: string; restorable?: false }> {
    const taken = await this.#copy(root);
    if (!taken.ok) return taken;
    const refusals = await this.check(root, taken.snapshot.manifest);
    return refusals.length === 0 ? taken : { ok: false, reason: refusals.join("; "), restorable: false };
  }

  async #copy(root: string): Promise<{ ok: true; snapshot: Snapshot } | { ok: false; reason: string }> {
    const answer = await this.#run("checkpoint", root, null);
    if ("error" in answer) return { ok: false, reason: answer.error };
    if (!("manifest" in answer)) return { ok: false, reason: "the sealed copy context gave no checkpoint" };
    const contents = new Map<string, Buffer>();
    for (const [hash, encoded] of Object.entries(answer.contents)) {
      const bytes = Buffer.from(encoded, "base64");
      if (createHash("sha256").update(bytes).digest("hex") !== hash) return { ok: false, reason: "a file's content does not match its hash" };
      contents.set(hash, bytes);
    }
    for (const entry of answer.manifest) if (entry.type === "file" && !contents.has(entry.sha256)) return { ok: false, reason: `no content for ${entry.path}` };
    return { ok: true, snapshot: { manifest: answer.manifest, contents, hardLinks: [] } };
  }

  /** Why `manifest` could not be restored to `root` as the folder now stands; empty when it could. Changes nothing. */
  async check(root: string, manifest: readonly ManifestEntry[]): Promise<readonly string[]> {
    const answer = await this.#run("check", root, JSON.stringify({ manifest }));
    if ("refusals" in answer) return answer.refusals;
    return ["error" in answer ? answer.error : "the sealed copy context gave no answer"];
  }

  /** Writes `manifest` back to `root`, with each file's bytes from `content`, then compares the folder with it. */
  async restore(root: string, manifest: readonly ManifestEntry[], content: (hash: string) => Buffer): Promise<SealedRestore> {
    const contents: Record<string, string> = {};
    try {
      for (const entry of manifest) if (entry.type === "file") contents[entry.sha256] = content(entry.sha256).toString("base64");
    } catch (error: unknown) {
      return { ok: false, changed: false, reason: `${error instanceof Error ? error.message : String(error)}; nothing was changed` };
    }
    const answer = await this.#run("restore", root, JSON.stringify({ manifest, contents }));
    if ("refused" in answer) return { ok: false, changed: false, reason: `${answer.refused.join("; ")}; nothing was changed` };
    if ("error" in answer) return { ok: false, changed: false, reason: answer.error };
    if ("failed" in answer) return { ok: false, changed: true, reason: answer.failed };
    if (!("restored" in answer)) return { ok: false, changed: true, reason: "the sealed copy context gave no answer" };
    return sameManifest(answer.restored, manifest) ? { ok: true } : { ok: false, changed: true, reason: "the folder after the restore differs from the checkpoint" };
  }
}

/**
 * The hook and gateway services' read view of the host folder (D-136, D-156, D-228): what a tree holds, for classifying
 * a read, listed through folder handles that never follow a link. It never opens a file: a file's bytes are never read,
 * so a file entry's `sha256` is the placeholder `NOT_READ` and a listing with content is refused.
 */
export const NOT_READ = "0".repeat(64);

export class HostReadView extends Workspace {
  readonly #workspace: string;

  /** `workspace`: the service's host folder, standing for `/work`. */
  constructor(workspace: string) {
    super(() => Promise.reject(new Error("the read view runs no script")), "/work", workspace as never);
    this.#workspace = workspace;
  }

  override list(root: string, content: boolean): Promise<{ ok: true; snapshot: Snapshot } | { ok: false; reason: string }> {
    if (content) return Promise.resolve({ ok: false, reason: "the read view never reads a file's bytes (D-228)" });
    return Promise.resolve(listNames(this.#workspace, root));
  }

  override restore(): Promise<{ ok: false; reason: string }> {
    return Promise.resolve({ ok: false, reason: "a host workspace is restored by juno checkpoint restore --workspace, in the sealed context (D-228)" });
  }
}

const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const at = (fd: number, name: string): string => `/proc/self/fd/${String(fd)}/${name}`;
const errorCode = (error: unknown): string => (error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "error");

/** Names, kinds, modes and link targets under `root`, never opening a file and never following a link; reasons as SNAPSHOT_SCRIPT's. */
function listNames(workspace: string, root: string): { ok: true; snapshot: Snapshot } | { ok: false; reason: string } {
  if (root !== "/work" && !root.startsWith("/work/")) return { ok: false, reason: "the workspace root is outside the view" };
  const parts = root === "/work" ? [] : root.slice("/work/".length).split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return { ok: false, reason: "the workspace root is not a plain path" };
  let fd: number;
  try {
    fd = openSync(workspace, DIR_FLAGS);
  } catch (error: unknown) {
    return { ok: false, reason: `cannot read the workspace root: ${errorCode(error)}` };
  }
  try {
    for (const [index, part] of parts.entries()) {
      let kind: Stats;
      try {
        kind = lstatSync(at(fd, part));
      } catch (error: unknown) {
        return { ok: false, reason: `cannot read the workspace root: ${errorCode(error)}` };
      }
      if (!kind.isDirectory()) return { ok: false, reason: index === parts.length - 1 ? "the workspace root is not a directory (a symlink is refused)" : `cannot read the workspace root: ${kind.isSymbolicLink() ? "ELOOP" : "ENOTDIR"}` };
      let next: number;
      try {
        next = openSync(at(fd, part), DIR_FLAGS);
      } catch (error: unknown) {
        return { ok: false, reason: `cannot read the workspace root: ${errorCode(error)}` };
      }
      closeSync(fd);
      fd = next;
    }
    const top = fstatSync(fd);
    const manifest: ManifestEntry[] = [{ path: "", type: "directory", mode: top.mode & 0o7777 }];
    const hardLinks: string[] = [];
    const walk = (dirFd: number, rel: string): string | null => {
      const names = readdirSync(`/proc/self/fd/${String(dirFd)}`).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      for (const name of names) {
        const path = rel === "" ? name : `${rel}/${name}`;
        if (manifest.length >= MAX_CHECKPOINT_ENTRIES) return `the workspace has more than ${String(MAX_CHECKPOINT_ENTRIES)} entries`;
        const seen = lstatSync(at(dirFd, name));
        const mode = seen.mode & 0o7777;
        if (seen.isSymbolicLink()) manifest.push({ path, type: "symlink", mode, target: readlinkSync(at(dirFd, name)) });
        else if (seen.isFile()) {
          if (seen.nlink > 1) hardLinks.push(path);
          manifest.push({ path, type: "file", mode, sha256: NOT_READ });
        } else if (seen.isDirectory()) {
          manifest.push({ path, type: "directory", mode });
          let child: number;
          try {
            child = openSync(at(dirFd, name), DIR_FLAGS);
          } catch (error: unknown) {
            return `cannot list the workspace: ${errorCode(error)}`;
          }
          try {
            const inner = walk(child, path);
            if (inner !== null) return inner;
          } finally {
            closeSync(child);
          }
        } else return `the workspace holds an entry that is not a file, directory or symlink: ${path}`;
      }
      return null;
    };
    let failed: string | null;
    try {
      failed = walk(fd, "");
    } catch (error: unknown) {
      failed = `cannot list the workspace: ${errorCode(error)}`;
    }
    return failed === null ? { ok: true, snapshot: { manifest, contents: new Map(), hardLinks } } : { ok: false, reason: failed };
  } finally {
    closeSync(fd);
  }
}
