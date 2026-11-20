// The sealed workspace copy (operator ruling of 2026-11-20 on PR #60, item 1; DECISIONS.md D-228).
//
// This module is the only code that reads a hook workspace's files into a checkpoint, judges whether a checkpoint could
// be restored, or writes a checkpoint back. JUNO runs it in a fresh container (packages/enforcement/src/host-restore.ts,
// `dockerSealedLauncher`): rootless, as the runner's own host identity with every capability dropped and no new
// privileges, no network, a read-only image, and one mount: the workspace (read-only unless it restores). Its input
// (a checkpoint's manifest and bytes) arrives on standard input and its output leaves on standard output, so neither
// the checkpoint store nor anything else of the runner's is mounted. A link planted in the workspace, a name swapped
// while it is read, or a path handed to it can therefore reach only the workspace itself and the image's own public
// files: nothing the Claude Code user cannot reach already.
//
// What it accepts from a workspace (item 2): regular files (their names and their bytes) and folders. Never a symbolic
// link, a device, a FIFO or a socket; never a set-user-ID, set-group-ID or sticky bit; never a file with a second name
// (a hard link); never a folder on another file system or one the runner could not read, change and enter. Anything
// else refuses the checkpoint, so the workspace is not reversible (D-221). A restore writes fixed modes: every file it
// writes is FILE_MODE and every folder it owns DIR_MODE, whatever the workspace held.
//
// Even in the container every step is taken relative to an open folder handle and never follows a link (D-221, D-227):
// each folder is opened O_DIRECTORY | O_NOFOLLOW from the handle above it, every file O_NOFOLLOW, the entry opened
// must be the one listed, and files are created O_CREAT | O_EXCL | O_NOFOLLOW (never written in place). No shell.
//
// It imports only node's own modules, so its text runs as it is: `node --input-type=module -e <text>` plus SEALED_MAIN.

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import process from "node:process";

/** The mode every file a restore writes gets: read and write for the runner and, through the access list's mask, for juno-agent. */
export const FILE_MODE = 0o660;
/** The mode every folder a restore owns gets: read, write and enter for the runner and, through the mask, for juno-agent. */
export const DIR_MODE = 0o770;
/** The bounds of a checkpoint (as D-136's): a larger workspace is not checkpointed, so not reversible. */
export const MAX_ENTRIES = 2000;
export const MAX_BYTES = 8 * 1024 * 1024;
/** The most entries a restore walks in the folder as it stands; a larger one is refused before anything changes. */
export const MAX_SCAN = 200_000;

const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY;
// A name is a string when JUNO wrote it (a manifest's, always valid UTF-8) and a Buffer when it was read from a folder:
// folders are listed as bytes, so a name that is not valid UTF-8 is acted on as the bytes it is, never as a string node
// would have changed (review round 7 on PR #61, D-231).
const at = (fd, name) => (typeof name === "string" ? `/proc/self/fd/${String(fd)}/${name}` : Buffer.concat([Buffer.from(`/proc/self/fd/${String(fd)}/`), name]));
const self = (fd) => `/proc/self/fd/${String(fd)}`;
const namesIn = (fd) => readdirSync(self(fd), { encoding: "buffer" }).sort(Buffer.compare);
/** The name as a string when its bytes are valid UTF-8 (and so recorded exactly), else null. */
const utf8 = (bytes) => {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : null;
};
const nameOf = (bytes) => utf8(bytes) ?? `<bytes ${bytes.toString("hex")}>`;
const code = (error) => (error !== null && typeof error === "object" && typeof error.code === "string" ? error.code : "error");
const plain = (name) => name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0");
const shown = (rel) => (rel === "" ? "the workspace root" : JSON.stringify(rel));
const octal = (mode) => (mode & 0o7777).toString(8);
const kindOf = (stats) =>
  stats.isDirectory() ? "folder" : stats.isFile() ? "file" : stats.isSymbolicLink() ? "symbolic link" : stats.isFIFO() ? "FIFO" : stats.isSocket() ? "socket" : stats.isCharacterDevice() || stats.isBlockDevice() ? "device" : "entry of an unknown kind";

class Refusal extends Error {}

/** The kernel's own answer (access(2), access lists included): may this process read, change and enter the folder? */
export function kernelMayChange(folder) {
  try {
    accessSync(folder, constants.R_OK | constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const bitsRefusal = (rel, mode) =>
  `${shown(rel)} has a set-user-ID, set-group-ID or sticky bit (mode ${octal(mode)}), which JUNO never takes from a workspace and never recreates; remove the bit as its owner (sudo -u juno-agent chmod u-s,g-s,o-t <folder or file>) and try again (D-223, D-225, D-228)`;

/** Why the folder at `fd` stops a checkpoint or a restore, or null. */
function folderRefusal(fd, rel, top, mayChange) {
  const stats = fstatSync(fd);
  if (stats.dev !== top.dev) return `${shown(rel)} is on another file system (a mount inside the workspace); it is refused, never partly copied or restored`;
  if ((stats.mode & 0o7000) !== 0) return bitsRefusal(rel, stats.mode);
  if (!mayChange(self(fd))) return `juno-runner cannot read, change and enter ${shown(rel)}: give it the guide's access list on the workspace (D-221)`;
  return null;
}

/**
 * Opens the workspace root `root` (a path under /work) below the open folder `baseFd` that stands for /work, one
 * component at a time, never following a link. The caller closes the handle it gets.
 */
export function openRootAt(baseFd, root) {
  if (root !== "/work" && !root.startsWith("/work/")) return { ok: false, reason: `${root} is not a path under /work` };
  const parts = root === "/work" ? [] : root.slice("/work/".length).split("/");
  if (!parts.every(plain)) return { ok: false, reason: `${root} is not a plain path` };
  let fd;
  try {
    fd = openSync(at(baseFd, "."), DIR_FLAGS);
  } catch (error) {
    return { ok: false, reason: `the workspace cannot be opened as a folder (${code(error)})` };
  }
  for (const part of parts) {
    let next;
    try {
      next = openSync(at(fd, part), DIR_FLAGS);
    } catch (error) {
      closeSync(fd);
      return { ok: false, reason: `${root} is not a folder reached without a symbolic link (${part}: ${code(error)})` };
    }
    closeSync(fd);
    fd = next;
  }
  return { ok: true, fd };
}

/** `openRootAt` from a path: the folder `base` stands for /work. */
export function openRoot(base, root) {
  let baseFd;
  try {
    baseFd = openSync(base, DIR_FLAGS);
  } catch (error) {
    return { ok: false, reason: `the workspace ${base} cannot be opened as a folder without following a link (${code(error)})` };
  }
  try {
    return openRootAt(baseFd, root);
  } finally {
    closeSync(baseFd);
  }
}

/**
 * Lists the folder at `rootFd` as a checkpoint takes it: only files and folders, each file read through its own handle.
 * Every mode in the manifest is the fixed one a restore writes (FILE_MODE, DIR_MODE): JUNO keeps names and bytes, not
 * modes. `strict` (the comparison after a restore) also requires every file to be this user's own with FILE_MODE and
 * one name, and every folder this user owns to have DIR_MODE. Returns `{ ok, manifest, contents }` or `{ ok: false, reason }`.
 */
export function listTree(rootFd, options = {}) {
  const mayChange = options.mayChange ?? kernelMayChange;
  const uid = options.uid ?? process.geteuid();
  const manifest = [];
  const contents = new Map();
  let bytes = 0;
  const fail = (reason) => {
    throw new Refusal(reason);
  };
  let top;
  const walk = (fd, rel) => {
    const why = folderRefusal(fd, rel, top, mayChange);
    if (why !== null) fail(why);
    if (options.strict === true) {
      const here = fstatSync(fd);
      if (here.uid === uid && (here.mode & 0o7777) !== DIR_MODE) fail(`${shown(rel)} is the runner's folder with mode ${octal(here.mode)}, not ${octal(DIR_MODE)}`);
    }
    let names;
    try {
      names = namesIn(fd);
    } catch (error) {
      return fail(`${shown(rel)} cannot be listed (${code(error)})`);
    }
    for (const raw of names) {
      const name = utf8(raw);
      if (name === null) fail(`${shown(rel)} holds a name that is not valid UTF-8 (${nameOf(raw)}): JUNO takes from a workspace only names it can record exactly; rename it (D-231)`);
      const path = rel === "" ? name : `${rel}/${name}`;
      if (manifest.length >= MAX_ENTRIES) fail(`the workspace has more than ${String(MAX_ENTRIES)} entries`);
      let seen;
      try {
        seen = lstatSync(at(fd, name));
      } catch (error) {
        return fail(`${JSON.stringify(path)} changed while it was listed (${code(error)})`);
      }
      if (!seen.isDirectory() && !seen.isFile()) fail(`${JSON.stringify(path)} is a ${kindOf(seen)}: JUNO takes only files and folders from a workspace, never a link, device, FIFO or socket, so it cannot checkpoint this workspace (D-228)`);
      if ((seen.mode & 0o7000) !== 0) fail(bitsRefusal(path, seen.mode));
      let child;
      try {
        child = openSync(at(fd, name), seen.isDirectory() ? DIR_FLAGS : FILE_FLAGS);
      } catch (error) {
        return fail(`${JSON.stringify(path)} changed while it was listed (${code(error)})`);
      }
      try {
        const held = fstatSync(child);
        if (held.dev !== seen.dev || held.ino !== seen.ino || held.isDirectory() !== seen.isDirectory() || held.isFile() !== seen.isFile()) fail(`${JSON.stringify(path)} changed while it was listed`);
        if ((held.mode & 0o7000) !== 0) fail(bitsRefusal(path, held.mode));
        if (held.isDirectory()) {
          manifest.push({ path, type: "directory", mode: DIR_MODE });
          walk(child, path);
          continue;
        }
        // A file with no name left was replaced while it was held (review round 6 on PR #61): changed, not a hard link.
        if (held.nlink === 0) fail(`${JSON.stringify(path)} changed while it was listed`);
        if (held.nlink !== 1) fail(`${JSON.stringify(path)} has ${String(held.nlink)} names (a hard link): JUNO takes a file from a workspace only when it has one name there and nowhere else; copy it so it has one (D-157, D-228)`);
        if (options.strict === true && (held.uid !== uid || (held.mode & 0o7777) !== FILE_MODE)) fail(`${JSON.stringify(path)} is not the runner's own file with mode ${octal(FILE_MODE)}`);
        if (held.size + bytes > MAX_BYTES) fail(`the workspace holds more than ${String(MAX_BYTES)} bytes`);
        const data = readFileSync(child);
        bytes += data.length;
        if (bytes > MAX_BYTES) fail(`the workspace holds more than ${String(MAX_BYTES)} bytes`);
        const sha256 = createHash("sha256").update(data).digest("hex");
        if (options.content === true) contents.set(sha256, data);
        manifest.push({ path, type: "file", mode: FILE_MODE, sha256 });
      } finally {
        closeSync(child);
      }
    }
    return undefined;
  };
  try {
    top = fstatSync(rootFd);
    manifest.push({ path: "", type: "directory", mode: DIR_MODE });
    walk(rootFd, "");
  } catch (error) {
    return { ok: false, reason: error instanceof Refusal ? error.message : `cannot list the workspace: ${code(error)}` };
  }
  return { ok: true, manifest, contents };
}

/**
 * The manifest by path, or why it is not one this module wrote: only files and folders, the fixed modes, plain paths
 * named once, every parent a folder named before it, the root a folder. A checkpoint holding anything else (a link,
 * a special bit) is refused before anything changes (D-223, D-228).
 */
export function wanted(manifest) {
  if (!Array.isArray(manifest)) return "the checkpoint's manifest is not a list";
  const map = new Map();
  for (const entry of manifest) {
    if (entry === null || typeof entry !== "object" || typeof entry.path !== "string") return "the checkpoint holds an entry that is not one";
    if (map.has(entry.path)) return `the checkpoint names ${JSON.stringify(entry.path)} twice`;
    if (!(entry.path === "" ? [] : entry.path.split("/")).every(plain)) return `the checkpoint names a path that is not plain: ${JSON.stringify(entry.path)}`;
    if (entry.type === "directory") {
      if (entry.mode !== DIR_MODE) return entry.mode & 0o7000 ? bitsRefusal(entry.path, entry.mode) : `the checkpoint gives ${shown(entry.path)} mode ${octal(entry.mode)}, not the fixed ${octal(DIR_MODE)} a sealed checkpoint records (D-228)`;
    } else if (entry.type === "file") {
      if (entry.mode !== FILE_MODE) return entry.mode & 0o7000 ? bitsRefusal(entry.path, entry.mode) : `the checkpoint gives ${shown(entry.path)} mode ${octal(entry.mode)}, not the fixed ${octal(FILE_MODE)} a sealed checkpoint records (D-228)`;
      if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) return `the checkpoint's ${JSON.stringify(entry.path)} has no content hash`;
    } else return `the checkpoint holds ${shown(entry.path)} as a ${String(entry.type)}: JUNO restores only files and folders (D-228)`;
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
 * Why the folder at `rootFd`, as it stands, could not be brought back to `manifest`; empty when it can. Reads only.
 * Every folder in it must be one the runner can read, change and enter, on the workspace's file system, with no special
 * bit (in a sticky folder the kernel lets the runner remove only its own files, D-225). Other entries are not judged:
 * the restore removes whatever the checkpoint does not hold, and removing never follows a link.
 */
export function restoreRefusals(rootFd, manifest, options = {}) {
  const want = wanted(manifest);
  if (typeof want === "string") return [want];
  const mayChange = options.mayChange ?? kernelMayChange;
  const refusals = [];
  const top = fstatSync(rootFd);
  let seen = 0;
  const walk = (fd, rel) => {
    const why = folderRefusal(fd, rel, top, mayChange);
    if (why !== null) {
      refusals.push(why);
      return;
    }
    let names;
    try {
      names = namesIn(fd);
    } catch (error) {
      refusals.push(`${shown(rel)} cannot be listed (${code(error)})`);
      return;
    }
    for (const name of names) {
      seen += 1;
      if (seen > MAX_SCAN) {
        refusals.push(`the workspace holds more than ${String(MAX_SCAN)} entries; it is refused, never partly restored`);
        return;
      }
      const path = rel === "" ? nameOf(name) : `${rel}/${nameOf(name)}`;
      let stats;
      try {
        stats = lstatSync(at(fd, name));
      } catch (error) {
        // A name gone between the listing and its look-up was changed while the folder was judged (still a refusal).
        refusals.push(code(error) === "ENOENT" ? `${JSON.stringify(path)} changed while it was listed (ENOENT)` : `${JSON.stringify(path)} cannot be read (${code(error)})`);
        return;
      }
      if (!stats.isDirectory()) continue;
      if (stats.dev !== top.dev) {
        refusals.push(`${JSON.stringify(path)} is on another file system (a mount inside the workspace); it is refused, never partly restored`);
        return;
      }
      let child;
      try {
        child = openSync(at(fd, name), DIR_FLAGS);
      } catch (error) {
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

/** Removes the entry `name` of the folder `dirFd`, whatever it is, never following a link. */
function remove(dirFd, name) {
  try {
    unlinkSync(at(dirFd, name));
    return;
  } catch (error) {
    if (code(error) === "ENOENT") return;
    if (code(error) !== "EISDIR" && code(error) !== "EPERM") throw error;
  }
  const fd = openSync(at(dirFd, name), DIR_FLAGS);
  try {
    for (const inner of namesIn(fd)) remove(fd, inner);
  } finally {
    closeSync(fd);
  }
  rmdirSync(at(dirFd, name));
}

function sameBytes(dirFd, name, sha256) {
  let fd;
  try {
    fd = openSync(at(dirFd, name), FILE_FLAGS);
  } catch {
    return false;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > MAX_BYTES) return false;
    return createHash("sha256").update(readFileSync(fd)).digest("hex") === sha256;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/** Whether an existing entry stays as it is: a folder the checkpoint holds, or the runner's own file with the checkpoint's bytes, FILE_MODE and one name. */
function keeps(dirFd, name, stats, want, uid) {
  if (want === undefined) return false;
  if (want.type === "directory") return stats.isDirectory();
  return stats.isFile() && stats.nlink === 1 && stats.uid === uid && (stats.mode & 0o7777) === FILE_MODE && sameBytes(dirFd, name, want.sha256);
}

/**
 * Brings the folder at `rootFd` back to `manifest`, with each file's bytes from `content` (each checked against its
 * hash before anything changes). Call `restoreRefusals` first; this throws on the first step that fails.
 */
export function restoreTree(rootFd, manifest, content, options = {}) {
  const want = wanted(manifest);
  if (typeof want === "string") throw new Error(want);
  const uid = options.uid ?? process.geteuid();
  const bytes = new Map();
  for (const entry of manifest) {
    if (entry.type !== "file" || bytes.has(entry.sha256)) continue;
    const data = content(entry.sha256);
    if (!Buffer.isBuffer(data) || createHash("sha256").update(data).digest("hex") !== entry.sha256) throw new Error(`the checkpoint's content for ${entry.path} does not match its hash`);
    bytes.set(entry.sha256, data);
  }
  // 1. Remove what the checkpoint lacks, or holds as another type, or (for a file) holds otherwise.
  const prune = (fd, rel) => {
    for (const name of namesIn(fd)) {
      // A name that is not valid UTF-8 is in no checkpoint (none records one), so it is removed as the bytes it is.
      const text = utf8(name);
      const path = text === null ? null : rel === "" ? text : `${rel}/${text}`;
      let stats;
      try {
        stats = lstatSync(at(fd, name));
      } catch (error) {
        if (code(error) === "ENOENT") continue;
        throw error;
      }
      const entry = path === null ? undefined : want.get(path);
      if (!keeps(fd, name, stats, entry, uid)) {
        remove(fd, name);
        continue;
      }
      if (entry.type !== "directory") continue;
      let child;
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
  const folders = new Map([["", rootFd]]);
  try {
    prune(rootFd, "");
    // 2. Create what is missing, in manifest order (every folder before what it holds).
    for (const entry of manifest) {
      if (entry.path === "") continue;
      const slash = entry.path.lastIndexOf("/");
      const parent = folders.get(slash < 0 ? "" : entry.path.slice(0, slash));
      const name = slash < 0 ? entry.path : entry.path.slice(slash + 1);
      if (parent === undefined) throw new Error(`the folder above ${entry.path} was not restored`);
      let exists = true;
      try {
        lstatSync(at(parent, name));
      } catch (error) {
        if (code(error) !== "ENOENT") throw error;
        exists = false;
      }
      if (entry.type === "directory") {
        if (!exists) mkdirSync(at(parent, name), 0o700);
        folders.set(entry.path, openSync(at(parent, name), DIR_FLAGS));
        continue;
      }
      if (exists) continue;
      const data = bytes.get(entry.sha256);
      if (data === undefined) throw new Error(`no content for ${entry.path}`);
      const fd = openSync(at(parent, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        for (let offset = 0; offset < data.length; ) offset += writeSync(fd, data, offset, data.length - offset);
        fchmodSync(fd, FILE_MODE);
      } finally {
        closeSync(fd);
      }
    }
    // 3. Every folder the runner owns gets DIR_MODE, the deepest first. A folder of another user's keeps its own mode,
    // which the runner may not change (it passed restoreRefusals, so the runner can read, change and enter it).
    for (const entry of [...manifest].reverse()) {
      if (entry.type !== "directory") continue;
      const fd = folders.get(entry.path);
      if (fd === undefined) continue;
      const stats = fstatSync(fd);
      if (stats.uid === uid && (stats.mode & 0o7777) !== DIR_MODE) fchmodSync(fd, DIR_MODE);
    }
  } finally {
    for (const [path, fd] of folders) if (path !== "") closeSync(fd);
  }
}

/**
 * The sealed program's entry. `argv`: `<checkpoint|check|restore> <base> <root> <dev> <ino>`, where `base` is the folder
 * standing for /work (the mount, in the sealed context) and `dev`/`ino` are what JUNO's own handle on the workspace
 * reads: a different folder (one put in its place before the mount) is refused before anything is read or changed.
 * `check` and `restore` read `{ manifest, contents? }` (contents: hash → base64) as JSON from `input`. Prints one JSON object.
 */
export async function main(argv, input) {
  const [op, base, root, dev, ino] = argv;
  const answer = (value) => process.stdout.write(JSON.stringify(value));
  // What is said before anything could have changed. For a restore that is `refused`: the one answer JUNO reads as
  // "nothing was changed"; any other end of a restore run (an error later, no answer at all) counts as changed (D-230).
  const early = (reason) => answer(op === "restore" ? { refused: [reason] } : { error: reason });
  let baseFd;
  try {
    baseFd = openSync(base, DIR_FLAGS);
  } catch (error) {
    return early(`the workspace cannot be opened as a folder (${code(error)}); nothing was read or changed`);
  }
  try {
    const identity = fstatSync(baseFd, { bigint: true });
    if (String(identity.dev) !== dev || String(identity.ino) !== ino) return early("the folder mounted for the workspace is not the one JUNO opened (it was replaced); nothing was read or changed");
    const opened = openRootAt(baseFd, root);
    if (!opened.ok) return early(opened.reason);
    try {
      if (op === "checkpoint") {
        // The copy's mount is read-only, where the kernel answers every write test "no": whether the runner could
        // restore the folder is judged by the `check` run, on a writable mount, which reads no file (D-228).
        const listed = listTree(opened.fd, { content: true, mayChange: () => true });
        if (!listed.ok) return answer({ error: listed.reason });
        return answer({ manifest: listed.manifest, contents: Object.fromEntries([...listed.contents].map(([hash, data]) => [hash, data.toString("base64")])) });
      }
      let request;
      try {
        request = JSON.parse(await input());
      } catch {
        return early("the request is not JSON; nothing was changed");
      }
      if (op === "check") return answer({ refusals: restoreRefusals(opened.fd, request.manifest) });
      if (op !== "restore") return answer({ error: `unknown operation ${String(op)}` });
      const refusals = restoreRefusals(opened.fd, request.manifest);
      if (refusals.length > 0) return answer({ refused: refusals });
      const contents = request.contents !== null && typeof request.contents === "object" ? request.contents : {};
      try {
        restoreTree(opened.fd, request.manifest, (hash) => (typeof contents[hash] === "string" ? Buffer.from(contents[hash], "base64") : Buffer.alloc(0)));
      } catch (error) {
        return answer({ failed: `the restore stopped part way: ${error instanceof Error ? error.message : String(error)}` });
      }
      const after = listTree(opened.fd, { strict: true });
      return answer(after.ok ? { restored: after.manifest } : { failed: `the folder after the restore is not the checkpoint: ${after.reason}` });
    } finally {
      closeSync(opened.fd);
    }
  } finally {
    closeSync(baseFd);
  }
}

/** Reads standard input to its end. */
export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
