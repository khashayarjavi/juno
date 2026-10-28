import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type ArgvRoles, type FlagSurface, argvRoles } from "../src/index.js";

/** A program not on the §2.3 list, so only its declared surface decides. */
const TOOL = "/opt/tools/bin/runner-tool";

const toolSurface: FlagSurface = {
  program: TOOL,
  positions: [
    { position: { kind: "flag", flag: "-q" }, executes_code: false },
    { position: { kind: "flag", flag: "--verbose" }, executes_code: false },
    { position: { kind: "flag", flag: "--hook" }, executes_code: true },
    { position: { kind: "flag", flag: "--" }, executes_code: false },
    { position: { kind: "subcommand", name: "show" }, executes_code: false },
    { position: { kind: "subcommand", name: "run" }, executes_code: true },
    { position: { kind: "operand" }, executes_code: false },
  ],
};

const instructionIndices = (roles: ArgvRoles): number[] =>
  roles.elements.filter((element) => element.role === "instruction").map((element) => element.index);

describe("argv positions are read per call against the declared surface (§2.3 rule 2, D-036, D-037)", () => {
  // proves §2.3 rule 2: an argv with only declared non-code positions stays data
  it("keeps every element data when no declared position executes code", () => {
    const roles = argvRoles(TOOL, toolSurface, ["-q", "show", "--verbose", "file.txt"]);
    expect(roles).toEqual({ elements: [0, 1, 2, 3].map((index) => ({ index, role: "data" })), failClosed: false });
  });

  // proves §2.3 rule 2: a code-bearing flag and everything after it are promoted, wherever the flag sits
  it.each([
    [["--hook", "CODE"], 0],
    [["-q", "--hook", "CODE"], 1],
    [["-q", "show", "--verbose", "--hook", "CODE", "more"], 3],
  ])("promotes from the code-bearing flag in %j", (argv, at) => {
    const roles = argvRoles(TOOL, toolSurface, argv);
    expect(roles.failClosed).toBe(false);
    expect(instructionIndices(roles)).toEqual(argv.map((_e, index) => index).filter((index) => index >= at));
    for (const element of roles.elements) {
      if (element.index >= at) expect(element).toMatchObject({ role: "instruction", reason: "code_bearing_position", at });
    }
  });

  // proves §2.3 rule 2: a code-bearing subcommand or operand is promoted the same way as a flag
  it("promotes from a code-bearing subcommand and from a code-bearing operand", () => {
    expect(instructionIndices(argvRoles(TOOL, toolSurface, ["-q", "run", "SCRIPT"]))).toEqual([1, 2]);
    const codeOperand: FlagSurface = { program: TOOL, positions: [{ position: { kind: "operand" }, executes_code: true }] };
    expect(instructionIndices(argvRoles(TOOL, codeOperand, ["script.file", "arg"]))).toEqual([0, 1]);
  });

  // proves D-036 fail-closed: a flag the surface does not cover promotes every element, before or after any code flag
  it.each([
    ["an undeclared flag", ["-q", "-Z", "file"], 1],
    ["a short-flag cluster", ["-qZ", "file"], 0],
    ["a value attached to a flag", ["--verbose=2", "file"], 0],
    ["an undeclared flag after the code flag", ["-q", "--hook", "CODE", "-Z"], 3],
  ])("promotes every element on %s", (_name, argv, at) => {
    const roles = argvRoles(TOOL, toolSurface, argv);
    expect(roles.failClosed).toBe(true);
    expect(roles.elements).toEqual(argv.map((_e, index) => ({ index, role: "instruction", reason: "uncovered_flag", at })));
  });

  // proves D-036 fail-closed: an operand where the surface declares none promotes every element
  it("promotes every element on an operand the surface does not declare", () => {
    const flagsOnly: FlagSurface = { program: TOOL, positions: [{ position: { kind: "flag", flag: "-q" }, executes_code: false }] };
    expect(argvRoles(TOOL, flagsOnly, ["-q", "file"])).toMatchObject({ failClosed: true, elements: [{ reason: "uncovered_operand", at: 1 }, {}] });
  });

  // proves D-036 fail-closed (D-018 basis): no surface, or a surface for another program, covers nothing
  it("promotes every element when the program has no surface or the surface names another program", () => {
    expect(argvRoles(TOOL, undefined, ["file"])).toEqual({
      elements: [{ index: 0, role: "instruction", reason: "no_declared_surface", at: null }],
      failClosed: true,
    });
    expect(argvRoles("/usr/bin/other", toolSurface, ["file"])).toMatchObject({ failClosed: true, elements: [{ reason: "surface_names_another_program" }] });
  });

  // proves D-037 with D-018: a listed interpreter whose surface claims no code position is not believed
  it("promotes every element of a listed interpreter whose surface declares no code-bearing position", () => {
    const lyingSh: FlagSurface = {
      program: "/bin/sh",
      positions: [
        { position: { kind: "flag", flag: "-c" }, executes_code: false },
        { position: { kind: "operand" }, executes_code: false },
      ],
    };
    expect(argvRoles("/bin/sh", lyingSh, ["-c", "CODE"])).toMatchObject({
      failClosed: true,
      elements: [{ reason: "known_interpreter_without_code_position" }, { reason: "known_interpreter_without_code_position" }],
    });
  });

  // proves D-037: a declared `--` ends option parsing, so later tokens are operands; an undeclared `--` is an uncovered flag
  it("reads tokens after a declared -- as operands", () => {
    expect(instructionIndices(argvRoles(TOOL, toolSurface, ["--", "--hook", "run", "-Z"]))).toEqual([]);
    const noEnd: FlagSurface = { program: TOOL, positions: [{ position: { kind: "operand" }, executes_code: false }] };
    expect(argvRoles(TOOL, noEnd, ["--", "file"]).failClosed).toBe(true);
  });

  // proves D-037: `-` alone is an operand, and an empty argv has no elements to promote
  it("treats - alone as an operand and an empty argv as nothing", () => {
    expect(argvRoles(TOOL, toolSurface, ["-"])).toEqual({ elements: [{ index: 0, role: "data" }], failClosed: false });
    expect(argvRoles(TOOL, toolSurface, [])).toEqual({ elements: [], failClosed: false });
  });

  // proves §2.3 rule 2 and D-036 for any argv (property): every element gets a role; promotion is all or a suffix;
  // a declared code flag before `--` is never data; an uncovered flag before `--` promotes all
  it("never leaves a declared code flag as data, and fails closed on any uncovered flag (property)", () => {
    const token = fc.oneof(
      fc.constantFrom("-q", "--verbose", "--hook", "--", "show", "run", "-", "-Z", "-qZ", "--hook=x"),
      fc.stringMatching(/^[a-z./]{1,8}$/),
    );
    let checked = 0;
    fc.assert(
      fc.property(fc.array(token, { maxLength: 10 }), (argv) => {
        const roles = argvRoles(TOOL, toolSurface, argv);
        expect(roles.elements.map((element) => element.index)).toEqual(argv.map((_e, index) => index));
        const promoted = instructionIndices(roles);
        const end = argv.indexOf("--");
        const beforeEnd = end === -1 ? argv : argv.slice(0, end);
        const uncovered = beforeEnd.some((element) => ["-Z", "-qZ", "--hook=x"].includes(element));
        if (uncovered) {
          expect(roles.failClosed).toBe(true);
          expect(promoted.length).toBe(argv.length);
          return;
        }
        if (promoted.length > 0) expect(promoted).toEqual(argv.map((_e, index) => index).slice(promoted[0]));
        beforeEnd.forEach((element, index) => {
          if (element === "--hook" || element === "run") expect(promoted).toContain(index);
        });
        if (beforeEnd.some((element) => element === "--hook" || element === "run")) checked += 1;
      }),
      { numRuns: 500 },
    );
    expect(checked).toBeGreaterThan(50);
  });
});
