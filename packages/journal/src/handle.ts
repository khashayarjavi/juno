import { closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, lstatSync } from "node:fs";
import { AbsolutePath, WORK_NAMESPACE, parseAtBoundary, pathsOverlap } from "../../contracts/src/index.js";
import { JournalLocationError } from "./layout.js";

/**
 * The journal folder, opened from a directory handle with no symbolic link followed in any component of its path
 * (operator ruling D-211 item 1; review round 7 finding F3; DECISIONS.md D-213).
 *
 * A check of the path followed by a second look-up of the same path can be raced: a folder above the journal is moved
 * aside and a symbolic link put in its place between the two. So the path is looked up exactly once, here. Starting at
 * `/`, each component is opened relative to the handle of the folder before it (through `/proc/self/fd/<handle>/<name>`,
 * which is how a process names "this entry of the folder I hold open"), with `O_NOFOLLOW | O_DIRECTORY`: the kernel
 * refuses a component that is a symbolic link, or not a folder, at the moment it is opened. A component that does not
 * exist yet is created (mode 0700) inside the held folder and then opened the same way.
 *
 * The handle of the last folder stays open for as long as the process lives, and the journal is read and written only
 * as `via`, the name of that handle. Whatever is done to the path afterwards (a folder above it renamed, replaced or
 * linked elsewhere), the journal this process uses is the folder it opened.
 */

export class JournalHandleError extends Error {
  override readonly name = "JournalHandleError";
}

export type JournalHandle = {
  /** The path the journal was asked for, exactly as written: what the anchor pin names. */
  readonly path: AbsolutePath;
  /** The held folder: every read and write of the journal goes through this name. */
  readonly via: AbsolutePath;
  readonly fd: number;
};

const OPEN_FOLDER = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function codeOf(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
}

function inside(fd: number, name: string): string {
  return `/proc/self/fd/${String(fd)}/${name}`;
}

/** Opens one folder without following a symbolic link at its last component. */
function openFolder(target: string, shown: string): number {
  try {
    return openSync(target, OPEN_FOLDER);
  } catch (error: unknown) {
    const code = codeOf(error);
    if (code === "ELOOP" || code === "ENOTDIR") throw new JournalHandleError(`${shown} is a symbolic link or not a folder; the journal's path may hold no symbolic link at all (D-209, D-213)`);
    throw error;
  }
}

/**
 * Opens (creating what does not exist yet) the journal folder at `path`. `owner` is the user the service runs as: the
 * folder that was opened must be that user's or root's and writable by no one else, judged on the handle itself, so it
 * is the opened folder that is judged and not whatever the path names a moment later.
 */
export function openJournalFolder(path: unknown, owner: number): JournalHandle {
  const checked = parseAtBoundary("journal root", AbsolutePath, path);
  if (pathsOverlap(checked, WORK_NAMESPACE)) throw new JournalLocationError(checked);
  const names = checked.split("/").filter((name) => name !== "");
  if (names.some((name) => name === "." || name === "..")) throw new JournalHandleError(`the journal path ${checked} is not a plain path`);
  let fd = openSync("/", OPEN_FOLDER);
  let shown = "";
  try {
    for (const name of names) {
      shown = `${shown}/${name}`;
      let next: number;
      try {
        next = openFolder(inside(fd, name), shown);
      } catch (error: unknown) {
        if (codeOf(error) !== "ENOENT") throw error;
        try {
          mkdirSync(inside(fd, name), { mode: 0o700 });
        } catch (made: unknown) {
          if (codeOf(made) !== "EEXIST") throw made;
        }
        next = openFolder(inside(fd, name), shown);
      }
      closeSync(fd);
      fd = next;
    }
    const facts = fstatSync(fd);
    if (!facts.isDirectory()) throw new JournalHandleError(`the journal ${checked} is not a folder`);
    if (facts.uid !== 0 && facts.uid !== owner) throw new JournalHandleError(`the journal folder that was opened at ${checked} is owned by uid ${String(facts.uid)}, neither root nor this service (D-194, D-213)`);
    if ((facts.mode & 0o022) !== 0) throw new JournalHandleError(`the journal folder that was opened at ${checked} is writable by group or others (D-194, D-213)`);
    const via = parseAtBoundary("journal handle", AbsolutePath, `/proc/self/fd/${String(fd)}`);
    // The held name must be the folder just judged (a process without /proc cannot hold the journal this way).
    const again = fstatSync(fd);
    const named = lstatSync(`${via}/.`);
    if (named.dev !== again.dev || named.ino !== again.ino) throw new JournalHandleError("the journal folder cannot be held open by a handle on this system (/proc is not available)");
    return { path: checked, via, fd };
  } catch (error: unknown) {
    closeSync(fd);
    throw error;
  }
}

/**
 * Why the journal's own folders are not plain folders (empty: they are). Inside the held folder, the folders the
 * journal's layout names (`tasks`, each record's folder, `blobs`, `blobs/sha256` and its two-letter folders) and the
 * files in a record's folder must not be symbolic links: a link there would send reads and writes outside the folder
 * that was opened. Only the service's own user can write in the journal folder; this is the same rule applied inside.
 */
export function journalLayoutRefusals(via: string): string[] {
  const refusals: string[] = [];
  const kind = (path: string): "none" | "dir" | "file" | "link" | "other" => {
    try {
      const facts = lstatSync(path);
      return facts.isSymbolicLink() ? "link" : facts.isDirectory() ? "dir" : facts.isFile() ? "file" : "other";
    } catch {
      return "none";
    }
  };
  const folder = (relative: string): boolean => {
    const found = kind(`${via}/${relative}`);
    if (found === "none") return false;
    if (found !== "dir") refusals.push(`the journal's ${relative} is not a plain folder (it is a ${found === "link" ? "symbolic link" : "file"}) (D-213)`);
    return found === "dir";
  };
  if (folder("tasks")) {
    for (const record of readdirSync(`${via}/tasks`)) {
      if (!folder(`tasks/${record}`)) continue;
      for (const name of readdirSync(`${via}/tasks/${record}`)) {
        if (kind(`${via}/tasks/${record}/${name}`) !== "file") refusals.push(`the journal's tasks/${record}/${name} is not a plain file (D-213)`);
      }
    }
  }
  if (folder("blobs") && folder("blobs/sha256")) {
    for (const prefix of readdirSync(`${via}/blobs/sha256`)) folder(`blobs/sha256/${prefix}`);
  }
  return refusals;
}
