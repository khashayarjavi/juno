import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SHELL_WORDS, readCommandString } from "../../enforcement/src/index.js";
import { quoteArgument, readRebuiltCommand, rebuildBashCommand } from "../src/rebuild.js";

// Operator ruling 2 of 2026-11-07 (DECISIONS.md D-152, D-153): what runs is what was judged. The command JUNO hands to
// Claude Code is rebuilt from the judged program and argv, and JUNO's own strict reader (§2.3.2) must parse it back to
// exactly that program and argv, for arbitrary arguments: quotes, spaces, newlines, leading dashes and the rest.

const PROGRAMS = ["/usr/bin/cat", "/usr/bin/rm", "/bin/ls", "/usr/local/bin/my-tool_2.1"];

/** Characters that matter to a shell or to the reader, mixed with ordinary ones. */
const tricky = fc.constantFrom("'", '"', " ", "\t", "\n", "\r", "-", "--", "\\", "$", "`", "!", "*", "?", "[", "]", "#", ";", "|", "&", "~", "=", "(", ")", "{", "}", "<", ">", "a", "Z", "0", "/", ".", "é", "✓", "'\\''");
const argument = fc.oneof(
  fc.string({ unit: tricky, maxLength: 12 }),
  fc.string({ unit: "binary", maxLength: 12 }),
  fc.string({ unit: "grapheme", maxLength: 12 }),
  fc.string({ maxLength: 12 }).map((text) => `-${text}`),
  fc.string({ maxLength: 12 }).map((text) => `--${text}`),
);
/** What the reader can hand to the rebuild: never a NUL (execve cannot carry one) and never a shell word (it parks those). */
const judgedArgument = argument.filter((text) => !text.includes("\0") && !SHELL_WORDS.has(text));

describe("operator ruling 2 (D-152): the rebuilt command reads back to exactly what was judged", () => {
  // proves D-152 with §2.3.2: for arbitrary judged arguments, the strict reader gives back exactly the program and argv
  it("round-trips every judged program and argv through the strict reader", () => {
    fc.assert(
      fc.property(fc.constantFrom(...PROGRAMS), fc.array(judgedArgument, { maxLength: 6 }), (program, argv) => {
        const command = rebuildBashCommand(program, argv);
        expect(command).not.toBeNull();
        expect(command?.startsWith(`${program} `) || command === program).toBe(true);
        expect(readRebuiltCommand(command ?? "", program)).toEqual({ ok: true, program, name: program, argv });
      }),
      { numRuns: 2_000, seed: 20261107 },
    );
  });

  // proves D-152: for ANY argv, the rebuild either refuses (null, so the call is denied) or gives a command that reads back
  // exactly; it never hands out a command that means something else
  it("never hands out a command that reads back differently", () => {
    fc.assert(
      fc.property(fc.constantFrom(...PROGRAMS), fc.array(argument, { maxLength: 6 }), (program, argv) => {
        const command = rebuildBashCommand(program, argv);
        if (command === null) {
          expect(argv.some((text) => text.includes("\0") || SHELL_WORDS.has(text))).toBe(true);
          return;
        }
        expect(readRebuiltCommand(command, program)).toEqual({ ok: true, program, name: program, argv });
      }),
      { numRuns: 2_000, seed: 20261107 },
    );
  });

  // proves D-152 end to end at the reader: whatever command the strict reader accepts from the model, the rebuilt command
  // reads back to the same program and argv the reader judged
  it("rebuilds every command the strict reader accepts to one that reads back the same", () => {
    const map = new Map([["cat", "/usr/bin/cat"], ["rm", "/usr/bin/rm"]]);
    const modelWord = fc.oneof(
      fc.string({ unit: tricky, maxLength: 8 }).filter((text) => !text.includes("'")).map((text) => `'${text}'`),
      fc.string({ unit: tricky, maxLength: 8 }).map((text) => `"${text}"`),
      fc.string({ unit: tricky, maxLength: 8 }),
    );
    fc.assert(
      fc.property(fc.constantFrom("cat", "rm"), fc.array(modelWord, { maxLength: 5 }), fc.constantFrom(" ", "\t", "  "), (name, words, separator) => {
        const reading = readCommandString([name, ...words].join(separator), map);
        fc.pre(reading.ok);
        if (!reading.ok) return;
        const command = rebuildBashCommand(reading.program, reading.argv);
        expect(readRebuiltCommand(command ?? "", reading.program)).toEqual({ ok: true, program: reading.program, name: reading.program, argv: reading.argv });
      }),
      { numRuns: 2_000, seed: 20261107 },
    );
  });

  // proves D-152 and D-153 on the cases the ruling names: quotes, spaces, newlines, leading dashes
  it.each([
    [["it's"], "/usr/bin/cat 'it'\"'\"'s'"],
    [["a b"], "/usr/bin/cat 'a b'"],
    [["line1\nline2"], "/usr/bin/cat 'line1\nline2'"],
    [["-n", "--", "-rf"], "/usr/bin/cat '-n' '--' '-rf'"],
    [[""], "/usr/bin/cat ''"],
    [["$(id)", "`id`", "\\", "!x"], "/usr/bin/cat '$(id)' '`id`' '\\' '!x'"],
    [[], "/usr/bin/cat"],
  ])("rebuilds %j as %j", (argv, expected) => {
    expect(rebuildBashCommand("/usr/bin/cat", argv)).toBe(expected);
    expect(readRebuiltCommand(expected, "/usr/bin/cat")).toEqual({ ok: true, program: "/usr/bin/cat", name: "/usr/bin/cat", argv });
  });

  // proves D-153: the operator's '\'' form contains a \ outside single quotes, which the strict reader parks (§2.3.2)
  it("uses '\"'\"' for a quote because the strict reader refuses '\\''", () => {
    expect(quoteArgument("it's")).toBe("'it'\"'\"'s'");
    expect(readCommandString("/usr/bin/cat 'it'\\''s'", new Map([["/usr/bin/cat", "/usr/bin/cat"]]))).toMatchObject({ ok: false });
  });

  // proves D-152: a program path that would need quoting, is relative, or climbs, and an argument holding NUL, are refused
  it.each([
    ["cat", []],
    ["/usr/bin/c t", []],
    ["/usr/bin/../../bin/sh", []],
    ["/usr/bin/cat;", []],
    ["/usr/bin/cat", ["a\0b"]],
    ["/usr/bin/cat", ["eval"]],
  ])("refuses to rebuild %j %j", (program, argv) => {
    expect(rebuildBashCommand(program, argv)).toBeNull();
  });
});
