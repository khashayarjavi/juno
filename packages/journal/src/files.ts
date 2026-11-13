import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Durable file operations for the journal. All synchronous: an append runs to
 * completion before anything else in the runner can touch the same files.
 */

/**
 * Reads a journal file, or null when there is none. The file itself is never reached through a symbolic link
 * (`O_NOFOLLOW`; D-213): a link where a journal file should be is an error, not a file.
 */
export function readOptional(path: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function fsyncDir(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.length) {
    offset += writeSync(fd, data, offset, data.length - offset);
  }
}

/** Appends to the end of a file (O_APPEND) and flushes it to disk. */
export function appendDurably(path: string, data: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    writeAll(fd, Buffer.from(data, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Replaces a file in one step: write a temporary file, flush it, rename it over the target, flush the directory. */
export function replaceDurably(path: string, data: Uint8Array | string): void {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    writeAll(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  fsyncDir(dirname(path));
}

/** Removes a file and flushes its folder, so the removal survives a power loss. A file that is not there is not an error. */
export function removeDurably(path: string): void {
  rmSync(path, { force: true });
  fsyncDir(dirname(path));
}
