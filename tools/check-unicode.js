// CLAUDE.md rule 12: no invisible or bidirectional-control Unicode in source,
// tests or capability files (DECISIONS.md D-058).
//
// Such characters make text read differently from how it parses: a bidi
// override can reorder what a reviewer sees ("Trojan Source"), and a
// zero-width character can hide inside an identifier, a string or a
// capability definition. The operator accepts work without reading code, so
// what a reviewer would see must be what runs.
//
// Usage:
//   node tools/check-unicode.js              scan the repository, exit 1 on any finding
//   node tools/check-unicode.js --self-test  prove the scan rejects a planted character
//
// The scan reads files only; it runs no program.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

/** @typedef {{ line: number, column: number, codePoint: string }} Finding */

/**
 * Every character class refused, by name:
 * - Cf: format characters. Covers the bidi embeddings, overrides and isolates
 *   (U+202A..U+202E, U+2066..U+2069), the marks U+200E, U+200F and U+061C,
 *   zero-width space, joiners (U+200B..U+200D), word joiner and invisible
 *   operators (U+2060..U+2064), the byte-order mark U+FEFF, soft hyphen U+00AD,
 *   and the tag characters U+E0000..U+E007F.
 * - line and paragraph separators U+2028, U+2029;
 * - every space separator except the ASCII space (no-break and other wide spaces);
 * - variation selectors (U+FE00..U+FE0F, U+E0100..U+E01EF and the Mongolian ones);
 * - the Hangul fillers U+115F, U+1160, U+3164, U+FFA0 and combining grapheme joiner U+034F,
 *   which render as nothing.
 */
export const FORBIDDEN = /\p{Cf}|\p{Variation_Selector}|\u034F|[\u2028\u2029\u115F\u1160\u3164\uFFA0]|[^\S\n\r\t\v\f\x20]/gu;

/** Directories scanned, relative to the repository root. `spec/` and `docs/` are prose inputs, not source. */
export const SCANNED_DIRECTORIES = ["packages", "test", "tools", "containers", "scripts", ".github", ".claude"];
/** Files at the root that are source or configuration. */
export const SCANNED_ROOT_FILES = [
  "Makefile",
  "package.json",
  "package-lock.json",
  "eslint.config.js",
  "vitest.config.ts",
  "vitest.containers.config.ts",
  "tsconfig.json",
  "tsconfig.base.json",
  "tsconfig.build.json",
  ".dockerignore",
  ".gitattributes",
  ".gitignore",
];
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", ".git"]);

/**
 * Each forbidden character in `text`, with its line, column and code point.
 * @param {string} text
 * @returns {Finding[]}
 */
export function findForbidden(text) {
  /** @type {Finding[]} */
  const findings = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const match of line.matchAll(FORBIDDEN)) {
      const codePoint = match[0].codePointAt(0) ?? 0;
      findings.push({ line: index + 1, column: (match.index ?? 0) + 1, codePoint: `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}` });
    }
  });
  return findings;
}

/**
 * @param {string} path
 * @returns {string[]}
 */
function filesUnder(path) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return [];
  }
  if (stats.isFile()) return [path];
  if (!stats.isDirectory()) return [];
  return readdirSync(path)
    .filter((name) => !SKIPPED_DIRECTORIES.has(name))
    .sort()
    .flatMap((name) => filesUnder(join(path, name)));
}

/**
 * Scans the repository (or any root laid out like it) and returns every finding.
 * @param {string} root
 * @param {readonly string[]} [directories]
 * @param {readonly string[]} [rootFiles]
 * @returns {(Finding & { file: string })[]}
 */
export function scan(root, directories = SCANNED_DIRECTORIES, rootFiles = SCANNED_ROOT_FILES) {
  const paths = [...directories.flatMap((directory) => filesUnder(join(root, directory))), ...rootFiles.flatMap((file) => filesUnder(join(root, file)))];
  return paths.flatMap((path) => {
    const bytes = readFileSync(path);
    // Binary files cannot hide text from a reader; a NUL marks one.
    if (bytes.includes(0)) return [];
    return findForbidden(bytes.toString("utf8")).map((finding) => ({ file: relative(root, path), ...finding }));
  });
}

/** @param {readonly (Finding & { file: string })[]} findings */
function report(findings) {
  for (const { file, line, column, codePoint } of findings) {
    process.stderr.write(`${file}:${String(line)}:${String(column)}: forbidden invisible or bidirectional character ${codePoint} (CLAUDE.md rule 12)\n`);
  }
}

/**
 * Plants each kind of forbidden character in a scratch tree and requires the scan to find every one.
 * @returns {number}
 */
function selfTest() {
  const planted = ["\u202E", "\u2066", "\u200B", "\u200D", "\uFEFF", "\u00AD", "\u00A0", "\u2028", "\uFE0F", "\u{E0041}", "\u{E0100}", "\u3164"];
  const root = mkdtempSync(join(tmpdir(), "juno-unicode-self-test-"));
  try {
    writeFileSync(join(root, "Makefile"), "clean:\n\ttrue\n");
    const probes = join(root, "packages", "probe", "src");
    mkdirSync(probes, { recursive: true });
    planted.forEach((character, index) => {
      writeFileSync(join(probes, `probe-${String(index)}.ts`), `const ok = "visible";\nconst probe = "a${character}b";\n`);
    });
    // The real walker over the real directory list: every planted file must be found, and the clean file never.
    const found = new Set(scan(root).map((finding) => finding.file));
    const missed = planted.filter((_, index) => !found.has(join("packages", "probe", "src", `probe-${String(index)}.ts`)));
    const clean = [...found].filter((file) => file === "Makefile");
    if (missed.length > 0 || clean.length > 0) {
      process.stderr.write(`unicode self-test FAILED: missed ${missed.map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}`).join(", ") || "none"}; false positives ${clean.join(", ") || "none"}\n`);
      return 1;
    }
    process.stdout.write(`unicode self-test: all ${String(planted.length)} planted characters rejected, as required\n`);
    return 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--self-test")) {
    process.exitCode = selfTest();
  } else {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const findings = scan(root);
    report(findings);
    if (findings.length > 0) process.exitCode = 1;
    else process.stdout.write("unicode check: no invisible or bidirectional characters\n");
  }
}
