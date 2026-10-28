import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Durable file operations for the journal. All synchronous: an append runs to
 * completion before anything else in the runner can touch the same files.
 */

export function readOptional(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function fsyncDir(path: string): void {
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
  const fd = openSync(path, "a", 0o600);
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
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeAll(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  fsyncDir(dirname(path));
}
