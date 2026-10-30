import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findForbidden, scan } from "../../tools/check-unicode.js";

// CLAUDE.md rule 12 (DECISIONS.md D-058): source, tests and capability files
// carry no invisible or bidirectional-control characters. Every character is
// built from its code point here, so this file itself stays clean.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const char = (codePoint: number): string => String.fromCodePoint(codePoint);

describe("check-unicode", () => {
  // proves rule 12: each class of hidden character is found, with its line and column
  it.each([
    ["right-to-left override", 0x202e],
    ["left-to-right isolate", 0x2066],
    ["pop directional isolate", 0x2069],
    ["right-to-left mark", 0x200f],
    ["arabic letter mark", 0x061c],
    ["zero-width space", 0x200b],
    ["zero-width joiner", 0x200d],
    ["word joiner", 0x2060],
    ["byte-order mark", 0xfeff],
    ["soft hyphen", 0x00ad],
    ["no-break space", 0x00a0],
    ["ideographic space", 0x3000],
    ["line separator", 0x2028],
    ["variation selector", 0xfe0f],
    ["supplementary variation selector", 0xe0100],
    ["tag character", 0xe0041],
    ["hangul filler", 0x3164],
    ["combining grapheme joiner", 0x034f],
  ])("finds a %s", (_name, codePoint) => {
    const text = `const a = 1;\nconst b = "x${char(codePoint)}y";\n`;
    expect(findForbidden(text)).toEqual([{ line: 2, column: 13, codePoint: `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}` }]);
  });

  // proves rule 12 leaves ordinary text alone: visible non-ASCII and ASCII whitespace are allowed
  it("allows visible characters and ordinary whitespace", () => {
    expect(findForbidden("// proves \u00a7 2.2 \u2192 park\n\tconst s = 'caf\u00e9 \u2264 \u03bb';\r\n")).toEqual([]);
  });

  // proves rule 12 over the repository as it stands: nothing hidden in any scanned file
  it("finds nothing in the repository", () => {
    expect(scan(repoRoot)).toEqual([]);
  });
});
