/**
 * Verification-input pins (spec §3.4.4 "What is pinned", v0.6 B2, v0.6.1 V6-1; DECISIONS.md D-097, D-112).
 *
 * At admission (before the task's first turn) the verifier lists the verification scope and hashes every regular
 * file in it that is not a declared output; at closure it does both again and compares. Any difference, or a hash
 * that cannot be computed, makes `verified` impossible.
 *
 * Both readings here are pure: they parse what the workload's own programs printed.
 *   - The listing is GNU `ls -l -a -R -n --time-style=full-iso --quoting-style=escape -- <roots>` (coreutils 9.1 in
 *     the workload image, checked 2026-11-03). In escape style a name never holds a raw space or newline: spaces print
 *     as `\ `, newlines as `\n`, other bytes as octal, and `:` in a directory header as `\:`. So a raw space separates
 *     fields, a symlink's ` -> ` cannot be forged by a name, and a header is the line after a blank line.
 *   - The hashes are `sha256sum -z -- <files>`: one `HASH  NAME` record per readable file, NUL-terminated, the name
 *     raw. A file it cannot read prints no record.
 */

/** The listing program's flags, fixed by the verifier (D-112). Every one is declared on the ls surface. */
export const PIN_LISTING_FLAGS = ["-l", "-a", "-R", "-n", "--time-style=full-iso", "--quoting-style=escape", "--"] as const;
/** The hashing program and its flags, fixed by the verifier (D-112). */
export const PIN_HASH_PROGRAM = "/usr/bin/sha256sum";
export const PIN_HASH_FLAGS = ["-z", "--"] as const;
/** Bounds on one task's pin set (D-112): exceeding one fails the task; the check is never skipped. */
export const MAX_PIN_ENTRIES = 10_000;
export const MAX_PINNED_FILES = 2_000;
/** Files hashed per call. */
export const PIN_HASH_BATCH = 100;

export type PinEntryType = "file" | "directory" | "symlink" | "other";

export type PinEntry = {
  readonly type: PinEntryType;
  /** The mode string as `ls` prints it, e.g. `-rw-r--r--`. */
  readonly mode: string;
  readonly size: string;
  /** A symlink's target, as listed (escaped). */
  readonly target: string | null;
};

export type ParsedListing = { readonly ok: true; readonly entries: ReadonlyMap<string, PinEntry> } | { readonly ok: false; readonly reason: string };

const ENTRY = /^([-dlcbps])([-rwxsStT]{9})[.+@]? +\d+ +\d+ +\d+ +(\d+|\d+, *\d+) +\d{4}-\d{2}-\d{2} +\d{2}:\d{2}:\d{2}\.\d{9} +[+-]\d{4} (.+)$/;
const SIMPLE_ESCAPES: Readonly<Record<string, number>> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, "\\": 92, " ": 32, ":": 58, "'": 39, '"': 34, "?": 63 };

/**
 * Reads one escape-quoted name up to the first raw space (or the end). Returns the name decoded as UTF-8, or `null`
 * when it is not valid UTF-8 or uses an escape this reading does not know (fail-closed), and what follows the name.
 */
export function readEscaped(text: string): { readonly name: string | null; readonly rest: string } {
  const bytes: number[] = [];
  let valid = true;
  let index = 0;
  while (index < text.length && text[index] !== " ") {
    const char = text[index] ?? "";
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      index += 1;
      continue;
    }
    const next = text[index + 1] ?? "";
    const octal = /^[0-7]{3}/.exec(text.slice(index + 1, index + 4));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 4;
    } else if (SIMPLE_ESCAPES[next] !== undefined) {
      bytes.push(SIMPLE_ESCAPES[next]);
      index += 2;
    } else {
      valid = false;
      index += 2;
    }
  }
  let name: string | null = null;
  if (valid) {
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
    } catch {
      name = null;
    }
  }
  return { name, rest: text.slice(index) };
}

function typeOf(char: string): PinEntryType {
  if (char === "-") return "file";
  if (char === "d") return "directory";
  if (char === "l") return "symlink";
  return "other";
}

function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

/**
 * Parses the escape-quoted recursive long listing of `roots` into one entry per path: each root, and everything under
 * a directory root. `.` gives a directory's own entry; `..` is skipped. A listing that does not have this shape, a
 * name that cannot be decoded, a root missing from it, or more than `MAX_PIN_ENTRIES` entries is not a listing.
 */
export function parseListing(stdout: string, roots: readonly string[]): ParsedListing {
  const entries = new Map<string, PinEntry>();
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let dir: string | null = null;
  let headerExpected = false;
  for (const [index, line] of lines.entries()) {
    if (line === "") {
      headerExpected = true;
      continue;
    }
    if (headerExpected || (index === 0 && !ENTRY.test(line))) {
      if (!line.endsWith(":")) return { ok: false, reason: `line ${String(index + 1)} is not a directory header` };
      const { name, rest } = readEscaped(line.slice(0, -1));
      if (name === null || rest !== "" || !name.startsWith("/")) return { ok: false, reason: `line ${String(index + 1)} names a directory that cannot be read` };
      dir = name;
      headerExpected = false;
      continue;
    }
    if (dir !== null && /^total \d+$/.test(line)) continue;
    const match = ENTRY.exec(line);
    if (match === null) return { ok: false, reason: `line ${String(index + 1)} is not a listing entry` };
    const [, kind = "", perms = "", size = "", tail = ""] = match;
    const { name, rest } = readEscaped(tail);
    if (name === null) return { ok: false, reason: `line ${String(index + 1)} holds a name that cannot be decoded` };
    const type = typeOf(kind);
    let target: string | null = null;
    if (type === "symlink") {
      if (!rest.startsWith(" -> ")) return { ok: false, reason: `line ${String(index + 1)} is a symlink without a target` };
      target = rest.slice(4);
    } else if (rest !== "") return { ok: false, reason: `line ${String(index + 1)} has text after its name` };
    if (name === "..") continue;
    // Outside a directory block, a name is an operand as given: an absolute path.
    const path = dir === null ? name : name === "." ? dir : joinPath(dir, name);
    if (!path.startsWith("/")) return { ok: false, reason: `line ${String(index + 1)} names a relative path outside a directory block` };
    entries.set(path, { type, mode: `${kind}${perms}`, size, target });
    if (entries.size > MAX_PIN_ENTRIES) return { ok: false, reason: `the verification scope has more than ${String(MAX_PIN_ENTRIES)} entries` };
  }
  for (const root of roots) if (!entries.has(root)) return { ok: false, reason: `the listing does not show ${root}` };
  return { ok: true, entries };
}

/** Parses `sha256sum -z` output into path → hash. A record that does not have the shape is ignored: that file then has no hash. */
export function parseHashes(stdout: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const record of stdout.split("\0")) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/s.exec(record);
    if (match?.[1] !== undefined && match[2] !== undefined) hashes.set(match[2], match[1]);
  }
  return hashes;
}

/** Whether `path` is `prefix` or lies under it. */
export function within(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

/** The roots to list: each given path once, dropping one that lies within another. */
export function pinRoots(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)].sort();
  return unique.filter((path) => !unique.some((other) => other !== path && within(path, other)));
}

/** One pinned path: its entry, and for a regular file its content hash (`null` when it could not be computed). */
export type Pin = PinEntry & { readonly sha256: string | null };

/** The regular files of a listing that are pinned by content: every one not within a declared output. */
export function filesToHash(entries: ReadonlyMap<string, PinEntry>, outputs: readonly string[]): string[] {
  return [...entries.entries()]
    .filter(([path, entry]) => entry.type === "file" && !outputs.some((output) => within(path, output)))
    .map(([path]) => path)
    .sort();
}

/** The pins of a listing and its hashes, outputs left out (§3.4.4: outputs are never pinned). */
export function pinsOf(entries: ReadonlyMap<string, PinEntry>, hashes: ReadonlyMap<string, string>, outputs: readonly string[]): Record<string, Pin> {
  const pins: Record<string, Pin> = {};
  for (const [path, entry] of [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (outputs.some((output) => within(path, output))) continue;
    pins[path] = { ...entry, sha256: entry.type === "file" ? (hashes.get(path) ?? null) : null };
  }
  return pins;
}

/**
 * The pinned paths that changed between admission and closure (§3.4.4, D-097, D-112): a path added, removed, or of a
 * different type or mode; a file whose hash differs or could not be computed on either side; a symlink whose target
 * differs. A directory's size is not compared: it changes when an output is created inside it, and its contents are
 * compared entry by entry. Outputs are never pinned.
 */
export function changedPins(baseline: Readonly<Record<string, Pin>>, check: Readonly<Record<string, Pin>>): string[] {
  const changed: string[] = [];
  for (const path of [...new Set([...Object.keys(baseline), ...Object.keys(check)])].sort()) {
    const before = baseline[path];
    const after = check[path];
    if (before === undefined || after === undefined || before.type !== after.type || before.mode !== after.mode) {
      changed.push(path);
      continue;
    }
    if (before.type === "file" && (before.sha256 === null || after.sha256 === null || before.sha256 !== after.sha256)) changed.push(path);
    else if (before.type === "symlink" && before.target !== after.target) changed.push(path);
    else if (before.type === "other" && before.size !== after.size) changed.push(path);
  }
  return changed;
}
