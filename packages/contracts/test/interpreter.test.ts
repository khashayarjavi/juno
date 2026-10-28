import { describe, expect, it } from "vitest";
import { type FlagSurface, KNOWN_INTERPRETERS, interpreterVerdict, isInterpreter, programBaseName } from "../src/index.js";

const surface = (program: string, positions: FlagSurface["positions"]): FlagSurface => ({ program, positions });

const lsSurface = surface("ls", [
  { position: { kind: "flag", flag: "-l" }, executes_code: false },
  { position: { kind: "flag", flag: "-a" }, executes_code: false },
  { position: { kind: "operand" }, executes_code: false },
]);

describe("the interpreter test (§2.3)", () => {
  // proves §2.3: every program on the spec's illustrative list is an interpreter
  it.each([...KNOWN_INTERPRETERS])("judges %s an interpreter", (program) => {
    expect(isInterpreter(program, undefined)).toBe(true);
  });

  // proves §2.3: `sh` is an interpreter (the program acceptance test 4a tries to add)
  it("judges sh an interpreter even with a surface that claims no code-bearing position", () => {
    expect(interpreterVerdict("sh", surface("sh", []))).toEqual({ interpreter: true, reason: "known_interpreter", positions: [] });
  });

  // proves §2.3: git is an interpreter despite looking like a tool
  it("judges git an interpreter even when its declared surface lists only harmless flags", () => {
    const gitSurface = surface("git", [{ position: { kind: "subcommand", name: "status" }, executes_code: false }]);
    expect(isInterpreter("git", gitSurface)).toBe(true);
  });

  // proves §2.3: the list cannot be walked around by path or version suffix
  it.each(["/bin/sh", "/usr/bin/bash", "python3", "/usr/bin/python3.12", "node22", "perl5"])("judges %s an interpreter", (program) => {
    expect(programBaseName(program)).not.toBe(program);
    expect(isInterpreter(program, surface(program, []))).toBe(true);
  });

  // proves §2.3 "the test is primary": a program off the list is an interpreter if any argv position executes code
  it("judges an unlisted program an interpreter when any declared position can execute code", () => {
    const fd = surface("fd", [
      { position: { kind: "flag", flag: "-H" }, executes_code: false },
      { position: { kind: "flag", flag: "--exec" }, executes_code: true },
    ]);
    expect(interpreterVerdict("fd", fd)).toEqual({
      interpreter: true,
      reason: "code_bearing_position",
      positions: [{ kind: "flag", flag: "--exec" }],
    });
  });

  // proves §2.3: a positional operand that is run as code (a script path) makes a program an interpreter
  it("judges a program an interpreter when an operand is executed", () => {
    const dash = surface("dash", [{ position: { kind: "operand" }, executes_code: true }]);
    expect(isInterpreter("dash", dash)).toBe(true);
  });

  // proves §2.3 with §0.2 D8: a program with no known flag surface cannot be shown safe, so it fails closed
  it("judges a program with no declared flag surface an interpreter", () => {
    expect(interpreterVerdict("ls", undefined)).toEqual({ interpreter: true, reason: "no_declared_surface", positions: [] });
  });

  // proves §2.3 with §0.2 D8: a surface declared for a different program does not vouch for this one
  it("judges a program an interpreter when the surface names a different program", () => {
    expect(isInterpreter("ls2", lsSurface)).toBe(true);
    expect(isInterpreter("/bin/ls", lsSurface)).toBe(true);
  });

  // proves §2.3: a program whose every known position is inert is not an interpreter
  it("judges ls with an inert declared surface not an interpreter", () => {
    expect(interpreterVerdict("ls", lsSurface)).toEqual({ interpreter: false });
  });
});
