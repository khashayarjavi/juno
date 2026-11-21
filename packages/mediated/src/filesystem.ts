import { execFile } from "node:child_process";
import { type Dirent, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Case-sensitive Linux file systems only (operator ruling of 2026-11-08 on D-177, options (a) and (b); DECISIONS.md
 * D-178). JUNO classifies a read by the path's text after the kernel's own resolution (D-167, D-174). On a file system
 * that matches names without regard to case (a Windows folder mounted into WSL by drvfs or 9p, or a directory with the
 * case-folding attribute, `chattr +F`), the kernel opens `project/secrets/key.txt` for `project/SECRETS/key.txt` while
 * the text names no source of that class. So, fail-closed, before any session is admitted and in `juno hook check`, a
 * workspace root or a registered source is refused unless:
 *   1. it, and every mount inside it, is on a native Linux file system type JUNO knows to be case-sensitive by default
 *      (ext4, btrfs, tmpfs without its `casefold` option); drvfs, 9p, virtiofs, FUSE, overlay, NTFS, FAT and every other
 *      type are refused (autopilot ruling D-182: xfs is refused too, as its `version=ci` mode folds ASCII case for the
 *      whole file system and shows no attribute);
 *   2. no directory in its tree carries the case-folding attribute (`F` in `lsattr -d`), read by execFile with an argv
 *      array; a directory whose attributes cannot be read is refused;
 *   3. no directory in its tree answers a lookup of a listed name with its case swapped (the kernel's own answer: the
 *      swapped name opens the same entry while the listing does not hold it), which catches folding no attribute shows.
 * The tree is walked without following any symlink; one with more than MAX_DIRECTORIES directories is refused, never
 * partly checked. The check is a snapshot; the resolver also refuses, at every call, a path whose kernel lookup matched
 * a name not literally listed in its folder (D-182), so a folder that starts folding later is still caught.
 */

/** File-system types accepted for a workspace or a registered source (D-178, D-182). */
export const CASE_SENSITIVE_TYPES: ReadonlySet<string> = new Set(["ext4", "btrfs", "tmpfs"]);

/** The most directories a checked tree may hold; a larger one is refused, never partly checked. */
export const MAX_DIRECTORIES = 50_000;

/** Directories per `lsattr` call. */
const BATCH = 256;

export type Mount = { readonly mountPoint: string; readonly fsType: string; readonly superOptions: string };

export type FilesystemIo = {
  /** The text of /proc/self/mountinfo, or null when it cannot be read. */
  readonly mountinfo: () => string | null;
  /** The kernel's realpath(3) of `path`, or null when it does not resolve. */
  readonly realpath: (path: string) => string | null;
  /** The entries of a directory with their kinds, never following a symlink; null when it cannot be listed. */
  readonly list: (dir: string) => readonly { readonly name: string; readonly directory: boolean }[] | null;
  /** The identity (device and inode) of the entry `path`, never following a final symlink; null when absent. */
  readonly identity: (path: string) => string | null;
  /** `lsattr -d` flags of each directory, in order; an error when any cannot be read. */
  readonly attributes: (dirs: readonly string[]) => Promise<{ readonly ok: true; readonly flags: readonly string[] } | { readonly ok: false; readonly error: string }>;
};

const unescape = (field: string): string => field.replace(/\\([0-7]{3})/g, (_whole, octal: string) => String.fromCharCode(parseInt(octal, 8)));

/** The mounts of /proc/self/mountinfo, in order; null when a line cannot be read (fail-closed). */
export function parseMountinfo(text: string): Mount[] | null {
  const mounts: Mount[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.split(" ");
    const separator = fields.indexOf("-", 6);
    const mountPoint = fields[4];
    const fsType = fields[separator + 1];
    if (separator < 0 || mountPoint === undefined || fsType === undefined) return null;
    mounts.push({ mountPoint: unescape(mountPoint), fsType, superOptions: fields[separator + 3] ?? "" });
  }
  return mounts;
}

const within = (path: string, prefix: string): boolean => prefix === "/" || path === prefix || path.startsWith(`${prefix}/`);

/** The mount `path` lies on: the longest mount point above it, the last one listed when several share it. */
export function mountOf(path: string, mounts: readonly Mount[]): Mount | null {
  let best: Mount | null = null;
  for (const mount of mounts) {
    if (within(path, mount.mountPoint) && (best === null || mount.mountPoint.length >= best.mountPoint.length)) best = mount;
  }
  return best;
}

function typeRefusal(what: string, path: string, mount: Mount): string | null {
  const options = mount.superOptions.split(",");
  if (mount.fsType === "tmpfs" && options.some((option) => option === "casefold" || option.startsWith("casefold="))) {
    return `${what} ${path} is on a tmpfs mounted with case folding (${mount.mountPoint}); JUNO accepts only case-sensitive Linux file systems (D-178)`;
  }
  if (CASE_SENSITIVE_TYPES.has(mount.fsType)) return null;
  const windows = mount.fsType === "drvfs" || mount.fsType === "9p" || mount.fsType === "v9fs";
  return `${what} ${path} is on a file system of type ${mount.fsType} (mounted at ${mount.mountPoint})${windows ? ", which is how WSL mounts a Windows folder" : ""}; JUNO accepts only folders on the distribution's own case-sensitive Linux file system (ext4, btrfs, tmpfs), because elsewhere a name can open a file whose case differs (D-178)`;
}

/** A name with its letter case swapped, or null when swapping changes nothing. */
function swapped(name: string): string | null {
  let out = "";
  for (const char of name) {
    const upper = char.toUpperCase();
    out += upper === char ? char.toLowerCase() : upper;
  }
  return out === name ? null : out;
}

/**
 * The refusals for these paths (workspace roots and registered sources, as host paths); empty when every one lies on a
 * case-sensitive file system with no case-folding directory in its tree (D-178). `what` names each path's role.
 */
/**
 * `options.tree: false` (D-237): judges each path's own folder only (its file system, its attribute, its lookups), never
 * what lies below it and never the mounts inside it: for the undo, which makes one new folder in that folder and never
 * looks inside the folder it moves aside.
 */
export async function caseFoldingRefusals(paths: readonly { readonly what: string; readonly path: string }[], io: FilesystemIo, options: { readonly tree?: boolean } = {}): Promise<string[]> {
  const tree = options.tree !== false;
  const refusals: string[] = [];
  const text = io.mountinfo();
  const mounts = text === null ? null : parseMountinfo(text);
  if (mounts === null) return ["JUNO cannot read /proc/self/mountinfo, so it cannot tell whether the workspace is on a case-sensitive file system (D-178)"];
  const checked = new Set<string>();
  for (const { what, path } of paths) {
    if (!path.startsWith("/")) {
      refusals.push(`${what} ${path} is not an absolute path`);
      continue;
    }
    // A path that does not exist yet is judged by its nearest existing ancestor, where it will be created.
    let at = path;
    let real = io.realpath(at);
    while (real === null && at !== "/") {
      at = dirname(at);
      real = io.realpath(at);
    }
    if (real === null) {
      refusals.push(`${what} ${path} cannot be resolved`);
      continue;
    }
    const mount = mountOf(real, mounts);
    if (mount === null) {
      refusals.push(`${what} ${path} lies on no mount JUNO can find (D-178)`);
      continue;
    }
    const own = typeRefusal(what, path, mount);
    if (own !== null) refusals.push(own);
    for (const inner of tree ? mounts : []) {
      if (inner.mountPoint !== real && within(inner.mountPoint, real)) {
        const nested = typeRefusal(`a mount inside ${what}`, inner.mountPoint, inner);
        if (nested !== null) refusals.push(nested);
      }
    }
    if (checked.has(real)) continue;
    checked.add(real);
    // The tree, never following a symlink.
    const dirs: string[] = [];
    const pending = [real];
    let failed: string | null = null;
    for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
      dirs.push(dir);
      if (dirs.length > MAX_DIRECTORIES) {
        failed = `${what} ${path} holds more than ${String(MAX_DIRECTORIES)} folders, so JUNO cannot check that none folds case; it is refused, never partly checked (D-178)`;
        break;
      }
      if (dir.includes("\n")) {
        failed = `${what} ${path} holds a folder whose name contains a line break, which JUNO cannot check (D-178)`;
        break;
      }
      const entries = io.list(dir);
      if (entries === null) {
        failed = `JUNO cannot list ${dir} in ${what} ${path}, so it cannot check that it does not fold case (D-178)`;
        break;
      }
      const names = new Set(entries.map((entry) => entry.name));
      // The kernel's own answer: a listed name with its case swapped must not open the same entry (D-178 check 3).
      const probe = entries.find((entry) => swapped(entry.name) !== null && !names.has(swapped(entry.name) ?? ""));
      if (probe !== undefined) {
        const other = swapped(probe.name) ?? "";
        const original = io.identity(join(dir, probe.name));
        if (original !== null && io.identity(join(dir, other)) === original) {
          failed = `${dir} in ${what} ${path} matches names without regard to case: ${JSON.stringify(other)} opens ${JSON.stringify(probe.name)}; JUNO refuses a case-folding folder (D-178)`;
          break;
        }
      }
      if (tree) for (const entry of entries) if (entry.directory) pending.push(join(dir, entry.name));
    }
    if (failed !== null) {
      refusals.push(failed);
      continue;
    }
    for (let start = 0; start < dirs.length; start += BATCH) {
      const batch = dirs.slice(start, start + BATCH);
      const answer = await io.attributes(batch);
      if (!answer.ok) {
        refusals.push(`JUNO cannot read the attributes of the folders in ${what} ${path} (${answer.error}), so it cannot check that none folds case (D-178)`);
        break;
      }
      const folding = batch.find((_dir, index) => (answer.flags[index] ?? "F").includes("F"));
      if (folding !== undefined) {
        refusals.push(`${folding} in ${what} ${path} has the case-folding attribute (chattr +F), so names in it open files whatever their case; JUNO refuses a case-folding folder (D-178)`);
        break;
      }
    }
  }
  return refusals;
}

/** Reads `lsattr -d -- <dirs>` output: one `<flags> <path>` line per directory, in order; anything else is an error. */
export function readLsattr(dirs: readonly string[], stdout: string): { readonly ok: true; readonly flags: readonly string[] } | { readonly ok: false; readonly error: string } {
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== dirs.length) return { ok: false, error: `lsattr answered ${String(lines.length)} of ${String(dirs.length)} folders` };
  const flags: string[] = [];
  for (const [index, line] of lines.entries()) {
    const space = line.indexOf(" ");
    if (space <= 0 || line.slice(space + 1) !== dirs[index]) return { ok: false, error: `lsattr's answer for ${dirs[index] ?? ""} cannot be read` };
    flags.push(line.slice(0, space));
  }
  return { ok: true, flags };
}

/** The real file system: /proc/self/mountinfo, lstat, and `lsattr` (e2fsprogs) run by execFile with an argv array. */
export function systemFilesystemIo(lsattr = "lsattr"): FilesystemIo {
  return {
    mountinfo: () => {
      try {
        return readFileSync("/proc/self/mountinfo", "utf8");
      } catch {
        return null;
      }
    },
    realpath: (path) => {
      try {
        return realpathSync.native(path);
      } catch {
        return null;
      }
    },
    list: (dir) => {
      try {
        return readdirSync(dir, { withFileTypes: true }).map((entry: Dirent) => ({ name: entry.name, directory: entry.isDirectory() }));
      } catch {
        return null;
      }
    },
    identity: (path) => {
      try {
        const stats = lstatSync(path);
        return `${String(stats.dev)}:${String(stats.ino)}`;
      } catch {
        return null;
      }
    },
    attributes: (dirs) =>
      new Promise((resolve) => {
        execFile(lsattr, ["-d", "--", ...dirs], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60_000, shell: false }, (error, stdout, stderr) => {
          if (error !== null) {
            const first = stderr.trim().split("\n")[0] ?? "";
            resolve({ ok: false, error: `${lsattr}: ${first === "" ? error.message : first}` });
            return;
          }
          resolve(readLsattr(dirs, stdout));
        });
      }),
  };
}
