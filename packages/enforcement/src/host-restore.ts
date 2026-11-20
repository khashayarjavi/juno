import { createHash } from "node:crypto";
import { type Stats, accessSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeSync } from "node:fs";
import { MAX_CHECKPOINT_BYTES, type ManifestEntry } from "./checkpoint.js";

/**
 * Restoring a host-folder workspace (spec §2.2.2: "restoring that checkpoint is an operator action recorded in the
 * journal"; DECISIONS.md D-221). Hook mode checkpoints the operator's host folder at admission (D-136); this writes such
 * a checkpoint back, on the host, as the runner.
 *
 * The folder is one the Claude Code user also writes, so every step is taken relative to an open directory handle and
 * never follows a symbolic link: each folder is opened with `O_DIRECTORY | O_NOFOLLOW` from the handle of the folder
 * above it (`/proc/self/fd/<fd>/<name>` resolves from the open directory, not from the path, as D-137's writer does),
 * and every name is created, removed or opened there, never as a path. A folder swapped for a link while the restore
 * runs is removed as the link it is; nothing outside the workspace is ever written.
 *
 *   1. `hostRestoreRefusals` walks the folder as it stands and changes nothing. It refuses, before anything is touched,
 *      whenever the restore could not finish: a folder the runner cannot read, write and enter (the guide's access list
 *      gives it all three, D-221), a folder on another file system, a root whose mode differs and that the runner does
 *      not own, more than `MAX_RESTORE_SCAN` entries.
 *   2. `restoreHostTree` removes every entry the checkpoint lacks or whose type differs; keeps a file only when it is
 *      the checkpoint's bytes and mode with one link, a link only with the checkpoint's target; recreates the rest
 *      (a file is never written in place: it is created anew with `O_CREAT | O_EXCL | O_NOFOLLOW`, so a hard link to a
 *      file elsewhere is never written through, D-158); and sets every mode, folders last.
 * The caller then lists the workspace again and compares it with the manifest; only an identical listing is `restored`.
 */

/** The most entries the restore walks in the folder as it stands; a larger one is refused before anything changes. */
export const MAX_RESTORE_SCAN = 200_000;

const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const at = (fd: number, name: string): string => `/proc/self/fd/${String(fd)}/${name}`;
const self = (fd: number): string => `/proc/self/fd/${String(fd)}`;
const code = (error: unknown): string => (error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "error");

type Kind = ManifestEntry["type"] | "other";
const kindOf = (stats: Stats): Kind => (stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symlink" : stats.isFile() ? "file" : "other");

/** A name of one component: never empty, `.`, `..`, or holding a slash or a NUL. */
const plainName = (name: string): boolean => name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0");

function split(path: string): string[] {
  return path === "" ? [] : path.split("/");
}

/** The manifest by path, refusing one whose paths are not plain, are repeated, or name a parent that is not a folder. */
function wanted(manifest: readonly ManifestEntry[]): Map<string, ManifestEntry> | string {
  const map = new Map<string, ManifestEntry>();
  for (const entry of manifest) {
    if (map.has(entry.path)) return `the checkpoint names ${JSON.stringify(entry.path)} twice`;
    if (!split(entry.path).every(plainName)) return `the checkpoint names a path that is not plain: ${JSON.stringify(entry.path)}`;
    // D-223 (review round 1 of PR #60, F1): the runner recreates what it restores as its own, so a set-user-ID,
    // set-group-ID or sticky bit kept from the checkpoint would hand the Claude Code user a program that runs as the
    // runner. Any such bit refuses the checkpoint, at admission and at the restore; it is never stripped silently.
    if (entry.type !== "symlink" && (entry.mode & 0o7000) !== 0) return `${entry.path === "" ? "the workspace root" : JSON.stringify(entry.path)} has a set-user-ID, set-group-ID or sticky bit (mode ${entry.mode.toString(8)}), which the runner will never recreate as its own; remove the bit (chmod u-s,g-s,o-t) and admit the session again (D-223)`;
    if (entry.path !== "") {
      const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
      if (map.get(parent)?.type !== "directory") return `the checkpoint names ${JSON.stringify(entry.path)} before a folder above it`;
    }
    map.set(entry.path, entry);
  }
  if (map.get("")?.type !== "directory") return "the checkpoint's root is not a folder";
  return map;
}

/**
 * Opens the workspace root `root` (a path under `/work`) below the service's host folder `workspace`, one component at a
 * time and never following a link. `workspace` itself must be its own canonical form.
 */
export function openWorkspaceRoot(workspace: string, root: string): { ok: true; fd: number } | { ok: false; reason: string } {
  if (root !== "/work" && !root.startsWith("/work/")) return { ok: false, reason: `${root} is not a path under /work` };
  let real: string;
  try {
    real = realpathSync.native(workspace);
  } catch (error: unknown) {
    return { ok: false, reason: `the workspace ${workspace} cannot be resolved (${code(error)})` };
  }
  if (real !== workspace) return { ok: false, reason: `the workspace ${workspace} is reached through a symbolic link (it resolves to ${real}); give its real path` };
  const parts = split(root.slice("/work".length).replace(/^\//, ""));
  if (!parts.every(plainName)) return { ok: false, reason: `${root} is not a plain path` };
  let fd: number;
  try {
    fd = openSync(workspace, DIR_FLAGS);
  } catch (error: unknown) {
    return { ok: false, reason: `the workspace ${workspace} cannot be opened as a folder (${code(error)})` };
  }
  for (const part of parts) {
    let next: number;
    try {
      next = openSync(at(fd, part), DIR_FLAGS);
    } catch (error: unknown) {
      closeSync(fd);
      return { ok: false, reason: `${root} is not a folder reached without a symbolic link (${part}: ${code(error)})` };
    }
    closeSync(fd);
    fd = next;
  }
  return { ok: true, fd };
}

function sameBytes(dirFd: number, name: string, sha256: string): boolean {
  let fd: number;
  try {
    fd = openSync(at(dirFd, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return false;
  }
  try {
    const stats = fstatSync(fd);
    // A file larger than any checkpoint can hold is not the checkpoint's, and is never read whole.
    if (!stats.isFile() || stats.size > MAX_CHECKPOINT_BYTES) return false;
    return createHash("sha256").update(readFileSync(fd)).digest("hex") === sha256;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/** Whether an existing entry can stay as it is: the checkpoint's own file, link or folder. */
function keeps(dirFd: number, name: string, stats: Stats, want: ManifestEntry | undefined, uid: number): boolean {
  if (want === undefined || kindOf(stats) !== want.type) return false;
  if (want.type === "directory") return (stats.mode & 0o7777) === want.mode || stats.uid === uid;
  if (want.type === "symlink") {
    try {
      return readlinkSync(at(dirFd, name)) === want.target;
    } catch {
      return false;
    }
  }
  return stats.nlink === 1 && (stats.mode & 0o7777) === want.mode && sameBytes(dirFd, name, want.sha256);
}

/**
 * Why the folder at `rootFd`, as it stands, could not be brought back to `manifest` by the runner; empty when it can.
 * Reads only; changes nothing.
 */
export function hostRestoreRefusals(rootFd: number, manifest: readonly ManifestEntry[], uid: number = process.geteuid?.() ?? -1, mayChange: (folder: string) => boolean = kernelMayChange): string[] {
  const want = wanted(manifest);
  if (typeof want === "string") return [want];
  const refusals: string[] = [];
  const top = fstatSync(rootFd);
  const rootWant = want.get("");
  if (rootWant !== undefined && (top.mode & 0o7777) !== rootWant.mode && top.uid !== uid) refusals.push(`the workspace root's mode is ${(top.mode & 0o7777).toString(8)}, not the checkpoint's ${rootWant.mode.toString(8)}, and only its owner can change it`);
  let seen = 0;
  const walk = (fd: number, rel: string): void => {
    if (refusals.length > 0) return;
    if (!mayChange(self(fd))) {
      refusals.push(`juno-runner cannot read, change and enter ${rel === "" ? "the workspace root" : JSON.stringify(rel)}: give it the guide's access list on the workspace (D-221)`);
      return;
    }
    let names: string[];
    try {
      names = readdirSync(self(fd));
    } catch (error: unknown) {
      refusals.push(`${rel === "" ? "the workspace root" : JSON.stringify(rel)} cannot be listed (${code(error)})`);
      return;
    }
    for (const name of names) {
      seen += 1;
      if (seen > MAX_RESTORE_SCAN) {
        refusals.push(`the workspace holds more than ${String(MAX_RESTORE_SCAN)} entries; it is refused, never partly restored`);
        return;
      }
      const path = rel === "" ? name : `${rel}/${name}`;
      let stats: Stats;
      try {
        stats = lstatSync(at(fd, name));
      } catch (error: unknown) {
        refusals.push(`${JSON.stringify(path)} cannot be read (${code(error)})`);
        return;
      }
      if (!stats.isDirectory()) continue;
      if (stats.dev !== top.dev) {
        refusals.push(`${JSON.stringify(path)} is on another file system (a mount inside the workspace); it is refused, never partly restored`);
        return;
      }
      let child: number;
      try {
        child = openSync(at(fd, name), DIR_FLAGS);
      } catch (error: unknown) {
        refusals.push(`${JSON.stringify(path)} cannot be opened as a folder (${code(error)})`);
        return;
      }
      try {
        walk(child, path);
      } finally {
        closeSync(child);
      }
      if (refusals.length > 0) return;
    }
  };
  walk(rootFd, "");
  return refusals;
}

/** The kernel's own answer (access(2), access lists included): may this process read, change and enter the folder? */
export function kernelMayChange(folder: string): boolean {
  try {
    accessSync(folder, constants.R_OK | constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Removes the entry `name` of the folder `dirFd`, whatever it is, never following a link. */
function remove(dirFd: number, name: string): void {
  try {
    unlinkSync(at(dirFd, name));
    return;
  } catch (error: unknown) {
    if (code(error) === "ENOENT") return;
    if (code(error) !== "EISDIR" && code(error) !== "EPERM") throw error;
  }
  const fd = openSync(at(dirFd, name), DIR_FLAGS);
  try {
    for (const inner of readdirSync(self(fd))) remove(fd, inner);
  } finally {
    closeSync(fd);
  }
  rmdirSync(at(dirFd, name));
}

/**
 * Brings the folder at `rootFd` back to `manifest`, with each file's bytes from `content` (checked against its hash
 * before anything is changed). Call `hostRestoreRefusals` first; this throws on the first step that fails.
 */
export function restoreHostTree(rootFd: number, manifest: readonly ManifestEntry[], content: (hash: string) => Buffer, uid: number = process.geteuid?.() ?? -1): void {
  const want = wanted(manifest);
  if (typeof want === "string") throw new Error(want);
  // Every file's bytes, each checked, before the first change (the store checks each read against its name).
  const bytes = new Map<string, Buffer>();
  for (const entry of manifest) {
    if (entry.type !== "file" || bytes.has(entry.sha256)) continue;
    const data = content(entry.sha256);
    if (createHash("sha256").update(data).digest("hex") !== entry.sha256) throw new Error(`the checkpoint's content for ${entry.path} does not match its hash`);
    bytes.set(entry.sha256, data);
  }
  // 1. Remove what the checkpoint lacks, or holds as another type, or (for a file or link) holds otherwise.
  const prune = (fd: number, rel: string): void => {
    for (const name of readdirSync(self(fd))) {
      const path = rel === "" ? name : `${rel}/${name}`;
      let stats: Stats;
      try {
        stats = lstatSync(at(fd, name));
      } catch (error: unknown) {
        if (code(error) === "ENOENT") continue;
        throw error;
      }
      const entry = want.get(path);
      if (!keeps(fd, name, stats, entry, uid)) {
        remove(fd, name);
        continue;
      }
      if (entry?.type !== "directory") continue;
      let child: number;
      try {
        child = openSync(at(fd, name), DIR_FLAGS);
      } catch {
        // Swapped for something else since it was read: removed as what it now is.
        remove(fd, name);
        continue;
      }
      try {
        prune(child, path);
      } finally {
        closeSync(child);
      }
    }
  };
  // 2. Create what is missing, in manifest order (every folder before what it holds).
  const folders = new Map<string, number>([["", rootFd]]);
  try {
    prune(rootFd, "");
    for (const entry of manifest) {
      if (entry.path === "") continue;
      const slash = entry.path.lastIndexOf("/");
      const parent = folders.get(slash < 0 ? "" : entry.path.slice(0, slash));
      const name = slash < 0 ? entry.path : entry.path.slice(slash + 1);
      if (parent === undefined) throw new Error(`the folder above ${entry.path} was not restored`);
      let exists = true;
      try {
        lstatSync(at(parent, name));
      } catch (error: unknown) {
        if (code(error) !== "ENOENT") throw error;
        exists = false;
      }
      if (entry.type === "directory") {
        if (!exists) mkdirSync(at(parent, name), 0o700);
        folders.set(entry.path, openSync(at(parent, name), DIR_FLAGS));
      } else if (exists) {
        continue;
      } else if (entry.type === "symlink") {
        symlinkSync(entry.target, at(parent, name));
      } else {
        const data = bytes.get(entry.sha256);
        if (data === undefined) throw new Error(`no content for ${entry.path}`);
        const fd = openSync(at(parent, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          for (let offset = 0; offset < data.length; ) offset += writeSync(fd, data, offset, data.length - offset);
          fchmodSync(fd, entry.mode & 0o777);
        } finally {
          closeSync(fd);
        }
      }
    }
    // 3. Every folder's mode, the deepest first, so a folder that may not be written is set after what it holds.
    for (const entry of [...manifest].reverse()) {
      if (entry.type !== "directory") continue;
      const fd = folders.get(entry.path);
      if (fd !== undefined && (fstatSync(fd).mode & 0o7777) !== entry.mode) fchmodSync(fd, entry.mode & 0o777);
    }
  } finally {
    for (const [path, fd] of folders) if (path !== "") closeSync(fd);
  }
}
