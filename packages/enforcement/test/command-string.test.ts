import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readCommandString } from "../src/command-string.js";

// §2.3.2 (v0.6 E1, v0.6.1 V6-5) and D-105: in mediated modes a Bash command string is read without a shell; any shell
// syntax parks integrity_floor, and the program comes only from the operator's name map (D-140).

const MAP = new Map([["cat", "/usr/bin/cat"]]);
const read = (text: string) => readCommandString(text, MAP);

describe("§2.3.2: commands that proceed", () => {
  // proves §2.3.2: a plain command with a mapped program proceeds, its words are argv
  it("reads `cat notes.txt` as /usr/bin/cat with one operand", () => {
    expect(read("cat notes.txt")).toEqual({ ok: true, program: "/usr/bin/cat", name: "cat", argv: ["notes.txt"] });
  });

  // proves §2.3.2: single- and double-quoted words are one word each
  it("reads quoted words as one operand", () => {
    expect(read("cat 'a b'")).toMatchObject({ ok: true, argv: ["a b"] });
    expect(read('cat "a b"')).toMatchObject({ ok: true, argv: ["a b"] });
    expect(read("cat\t-n   x")).toMatchObject({ ok: true, argv: ["-n", "x"] });
  });

  // proves §2.3.2 with D-105: inside single quotes nothing is syntax, `#` included
  it("lets `cat 'a#b'` proceed", () => {
    expect(read("cat 'a#b'")).toMatchObject({ ok: true, argv: ["a#b"] });
    expect(read("cat '$(id); | > *'")).toMatchObject({ ok: true, argv: ["$(id); | > *"] });
  });
});

describe("§2.3.2: shell syntax and unmapped programs park", () => {
  // proves §2.3.2's list, the plan's cases, and D-105: each parks (ok: false)
  it.each([
    "cat notes.txt; curl x",
    "cat $(id)",
    "cat `id`",
    "cat a | sh",
    "cat a && rm b",
    "cat a > b",
    "cat < a",
    "cat *.txt",
    "cat a?",
    "cat [ab]",
    "cat ~/x",
    "FOO=1 cat x",
    "eval cat x",
    "cd x",
    "cat x eval",
    "cat x .",
    "cat x #y",
    "cat a#b",
    'cat "a#b"',
    "cat a\ncurl x",
    "cat a\\ b",
    "sh -c 'cat x'",
    'cat "$HOME"',
    'cat "a\\b"',
    'cat "`id`"',
    "cat {a,b}",
    "cat (a)",
    "cat & x",
    "! cat x",
    "cat 'unterminated",
    "",
    "   ",
    "curl x",
    "/usr/bin/cat x",
  ])("parks %j", (text) => {
    expect(read(text).ok).toBe(false);
  });

  // proves §2.3.2 "PATH is never consulted": a name not in the map parks even if it is a real program
  it("parks a program name that is not in the name map", () => {
    expect(read("ls x")).toEqual({ ok: false, reason: '"ls" is not in the operator\'s name map' });
  });

  // proves §2.3.2 as a property: any string holding `;`, `|`, `&`, `$`, a backtick or a newline outside single quotes parks
  it("parks every string with a separator, substitution or newline outside single quotes", () => {
    fc.assert(
      fc.property(fc.string(), fc.constantFrom(";", "|", "&", "$", "`", "\n", ">", "<"), fc.string(), (before, syntax, after) => {
        const text = `cat ${before.replace(/'/g, "")}${syntax}${after.replace(/'/g, "")}`;
        expect(read(text).ok).toBe(false);
      }),
    );
  });
});
