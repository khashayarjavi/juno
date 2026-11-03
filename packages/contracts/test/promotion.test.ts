import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type ArgvRoles, type FlagSurface, argvRoles, argvTokenKinds } from "../src/index.js";

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
    expect(roles).toEqual({ elements: [0, 1, 2, 3].map((index) => ({ index, role: "data" })), failClosed: false, undeclaredFlag: null });
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
      undeclaredFlag: null,
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

  // proves D-037 and §2.3.1 rules 1, 5 and 6: a declared `--` ends option parsing, so later tokens are operands; an
  // undeclared `--` is an undeclared flag: on a surface with a code-bearing position it promotes every element (rule 5),
  // and on a surface that is code-free everywhere it makes the call a rejection instead (rule 6, v0.6 A5)
  it("reads tokens after a declared -- as operands", () => {
    expect(instructionIndices(argvRoles(TOOL, toolSurface, ["--", "--hook", "run", "-Z"]))).toEqual([]);
    const noEndWithCode: FlagSurface = {
      program: TOOL,
      positions: [
        { position: { kind: "flag", flag: "--hook" }, executes_code: true },
        { position: { kind: "operand" }, executes_code: false },
      ],
    };
    expect(argvRoles(TOOL, noEndWithCode, ["--", "file"])).toMatchObject({ failClosed: true, undeclaredFlag: null, elements: [{ reason: "uncovered_flag", at: 0 }, {}] });
    const noEnd: FlagSurface = { program: TOOL, positions: [{ position: { kind: "operand" }, executes_code: false }] };
    expect(argvRoles(TOOL, noEnd, ["--", "file"])).toEqual({ elements: [{ index: 0, role: "data" }, { index: 1, role: "data" }], failClosed: false, undeclaredFlag: 0 });
  });

  // proves D-037: `-` alone is an operand, and an empty argv has no elements to promote
  it("treats - alone as an operand and an empty argv as nothing", () => {
    expect(argvRoles(TOOL, toolSurface, ["-"])).toEqual({ elements: [{ index: 0, role: "data" }], failClosed: false, undeclaredFlag: null });
    expect(argvRoles(TOOL, toolSurface, [])).toEqual({ elements: [], failClosed: false, undeclaredFlag: null });
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

describe("the same argv reading classes elements for the scope check (D-047)", () => {
  // records D-047: flags, subcommands and operands are classed by the one D-037 reading, and `--` ends options
  it("classes each element as promotion reads it", () => {
    expect(argvTokenKinds(TOOL, toolSurface, ["-q", "show", "file.txt", "--", "-q", "show", "-"])).toEqual([
      "flag",
      "subcommand",
      "operand",
      "flag",
      "operand",
      "operand",
      "operand",
    ]);
    // An undeclared flag is still a flag token; an undeclared `--` does not end options.
    const noEnd: FlagSurface = { program: TOOL, positions: toolSurface.positions.filter((entry) => !(entry.position.kind === "flag" && entry.position.flag === "--")) };
    expect(argvTokenKinds(TOOL, noEnd, ["-Z", "--", "-q", "x"])).toEqual(["flag", "flag", "flag", "operand"]);
  });

  // records D-047: with no usable surface nothing is known, so every element is read as an operand (the reading the scope check checks most)
  it("reads every element as an operand when the surface is missing or names another program", () => {
    expect(argvTokenKinds(TOOL, undefined, ["-q", "x"])).toEqual(["operand", "operand"]);
    expect(argvTokenKinds("/usr/bin/other", toolSurface, ["-q", "x"])).toEqual(["operand", "operand"]);
  });

  // records D-047: the kinds and the D-037 promotion reading agree; an element is code-bearing only where it sits in a declared code position
  it("agrees with promotion on every argv", () => {
    const token = fc.constantFrom("-q", "--verbose", "--hook", "--", "show", "run", "file.txt", "-", "-Z");
    fc.assert(
      fc.property(fc.array(token, { maxLength: 8 }), (argv) => {
        const kinds = argvTokenKinds(TOOL, toolSurface, argv);
        const roles = argvRoles(TOOL, toolSurface, argv);
        expect(kinds).toHaveLength(argv.length);
        // Fail-closed happens exactly when the reading finds an undeclared flag token (this surface declares an operand).
        expect(roles.failClosed).toBe(argv.some((element, index) => kinds[index] === "flag" && element === "-Z"));
      }),
    );
  });
});

describe("§2.3.1 rule 6 (v0.6, A5): an undeclared flag on a code-free program is a rejection, not a promotion", () => {
  /** A program not on the §2.3 list whose declared surface marks every position code-free. */
  const codeFree: FlagSurface = {
    program: TOOL,
    positions: [
      { position: { kind: "flag", flag: "-q" }, executes_code: false },
      { position: { kind: "operand" }, executes_code: false },
    ],
  };

  // proves §2.3.1 rule 6: every element stays data, and the first undeclared flag is named for the boundary to reject
  it.each([
    ["an undeclared flag", ["-q", "-Z", "file"], 1],
    ["a short-flag cluster", ["-qZ", "file"], 0],
    ["a value attached to a flag", ["-q=2", "file"], 0],
    ["two undeclared flags", ["file", "-c", "-Z"], 1],
  ])("names %s and promotes nothing", (_name, argv, at) => {
    expect(argvRoles(TOOL, codeFree, argv)).toEqual({ elements: argv.map((_e, index) => ({ index, role: "data" })), failClosed: false, undeclaredFlag: at });
  });

  // proves §2.3.1 rules 5 and 6: an undeclared operand anywhere still promotes every element, so a park is never turned
  // into a retryable rejection (§2.7.1 D5)
  it("still promotes every element when an operand is also undeclared", () => {
    const flagsOnly: FlagSurface = { program: TOOL, positions: [{ position: { kind: "flag", flag: "-q" }, executes_code: false }] };
    expect(argvRoles(TOOL, flagsOnly, ["-Z", "file"])).toMatchObject({ failClosed: true, undeclaredFlag: null, elements: [{ reason: "uncovered_flag", at: 0 }, { reason: "uncovered_flag", at: 0 }] });
  });

  // proves §2.3.1 rule 5: on a surface with any code-bearing position, an undeclared flag still promotes every element
  it("still promotes every element when the surface has a code-bearing position", () => {
    expect(argvRoles(TOOL, toolSurface, ["-Z", "file"])).toMatchObject({ failClosed: true, undeclaredFlag: null });
  });

  // proves §2.3.1 rules 5 and 6: a program on the §2.3 list is never read as code-free, whatever its surface claims
  it("never treats a listed interpreter as code-free", () => {
    const python = "/usr/bin/python3";
    const honest: FlagSurface = {
      program: python,
      positions: [
        { position: { kind: "flag", flag: "-c" }, executes_code: true },
        { position: { kind: "operand" }, executes_code: true },
      ],
    };
    expect(argvRoles(python, honest, ["-Z", "x"])).toMatchObject({ failClosed: true, undeclaredFlag: null });
    const lying: FlagSurface = { program: python, positions: [{ position: { kind: "operand" }, executes_code: false }] };
    expect(argvRoles(python, lying, ["-Z", "x"])).toMatchObject({ failClosed: true, undeclaredFlag: null, elements: [{ reason: "known_interpreter_without_code_position" }, {}] });
  });
});
