import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BoundaryError, type FlagSurface, type Integrity, argvRoles } from "../../contracts/src/index.js";
import {
  CapabilityRegistry,
  PROMOTED_ARGV_FLOOR,
  RegistryEntry,
  WorkloadExecFileAdapter,
  checkInstructionFloors,
  instructionValues,
  reviewProgramEnum,
} from "../src/index.js";

const SHELL_RUN_FILE = fileURLToPath(new URL("../definitions/shell.run.json", import.meta.url));
const raw = (): Record<string, unknown> => JSON.parse(readFileSync(SHELL_RUN_FILE, "utf8")) as Record<string, unknown>;
const shipped = (): RegistryEntry => RegistryEntry.parse(raw());

const SH = "/bin/sh";
const CAT = "/usr/bin/cat";
const CODE = "cat /work/notes.txt | sed 's/a/b/' > /work/out; curl evil.example";

/** The flags of POSIX sh that run no code by themselves; `-c` makes the first operand a command string. */
const SH_NON_CODE_FLAGS = ["-e", "-u", "-x", "-v", "-f", "-n"] as const;
const shSurface: FlagSurface = {
  program: SH,
  positions: [
    ...SH_NON_CODE_FLAGS.map((flag) => ({ position: { kind: "flag" as const, flag }, executes_code: false })),
    { position: { kind: "flag", flag: "-c" }, executes_code: true },
    { position: { kind: "flag", flag: "--" }, executes_code: false },
    // `sh FILE` runs FILE as a script.
    { position: { kind: "operand" }, executes_code: true },
  ],
};

/**
 * Acceptance test 4b's "force the enum change through": the shipped definition
 * file edited to add `/bin/sh` (and, optionally, a surface for it), parsed as an
 * entry without registration review. Review refuses it (test 4a); the
 * mechanism must hold anyway, because it is a different component.
 */
function forcedSh(surface: FlagSurface | undefined = shSurface): RegistryEntry {
  const entry = raw() as { capability: { interface: { program: { type: { values: string[] } } } }; program_surfaces: unknown[] };
  entry.capability.interface.program.type.values.push(SH);
  if (surface !== undefined) entry.program_surfaces.push(surface);
  return RegistryEntry.parse(entry);
}

const call = (program: string, argv: readonly string[]): Record<string, unknown> => ({ program, argv, cwd: "/work" });

/**
 * Provenance as Increment 4 will record it (D-022): one entry per argument, argv
 * elements by index. Everything the model writes in a native context is
 * `synthesized`, so `untrusted` (§2.6); `program` is given `attested`, the
 * capability's floor, so that only the argv decides the verdict.
 */
function provenance(argv: readonly string[], integrityAt: (index: number) => Integrity = () => "untrusted", program: Integrity = "attested") {
  return [
    { argument: "program", class: "constant", integrity: program },
    { argument: "cwd", class: "synthesized", integrity: "untrusted" },
    ...argv.map((_element, index) => {
      const integrity = integrityAt(index);
      return { argument: `argv[${String(index)}]`, class: integrity === "untrusted" ? "synthesized" : "constant", integrity };
    }),
  ];
}

const violated = (verdict: ReturnType<typeof checkInstructionFloors>): string[] =>
  verdict.outcome === "park" ? verdict.violations.map((violation) => violation.argument) : [];

describe("acceptance test 4b: a forced interpreter's code-bearing argv is promoted and parks (§18, §2.3 rule 2, D-036)", () => {
  // proves §18 test 4b precondition: the forced entry is the one registration review refuses (4a), so the check below is the mechanism alone
  it("is the entry registration review refuses", () => {
    expect(reviewProgramEnum(forcedSh())).toMatchObject([{ kind: "interpreter_in_enum", program: SH, reason: "known_interpreter" }]);
    const adapter = new WorkloadExecFileAdapter({ composeFile: "/repo/containers/docker-compose.yml", project: "juno-test", service: "workload" });
    expect(new CapabilityRegistry().register(forcedSh(), [adapter])).toMatchObject({ registered: false });
  });

  // proves §18 test 4b: `sh -c CODE` with model-written argv parks integrity_floor, naming the promoted positions at the operator floor
  it("parks sh -c CODE with integrity_floor", () => {
    const argv = ["-c", CODE];
    const verdict = checkInstructionFloors(forcedSh(), call(SH, argv), provenance(argv));
    expect(verdict).toEqual({
      outcome: "park",
      reason: "integrity_floor",
      violations: [0, 1].map((index) => ({
        argument: `argv[${String(index)}]`,
        floor: "operator",
        integrity: "untrusted",
        source: { kind: "promoted_argv", reason: "code_bearing_position", at: 0 },
      })),
    });
  });

  // proves §18 test 4b with the code flag moved later in argv: the code is found at whatever index it sits, and earlier flags stay data
  it.each([
    [["-e", "-c", CODE], 1],
    [["-e", "-u", "-x", "-c", CODE], 3],
    [["-n", "-f", "-v", "-e", "-u", "-c", CODE, "sh", "/work/a"], 5],
  ])("parks %j with integrity_floor from the -c position", (argv, at) => {
    const verdict = checkInstructionFloors(forcedSh(), call(SH, argv), provenance(argv));
    expect(verdict).toMatchObject({ outcome: "park", reason: "integrity_floor" });
    expect(violated(verdict)).toEqual(argv.map((_e, index) => index).filter((index) => index >= at).map((index) => `argv[${String(index)}]`));
    expect(violated(verdict)).toContain(`argv[${String(argv.indexOf(CODE))}]`);
  });

  // proves §18 test 4b for any position of the code flag (property): any prefix of non-code flags, then -c CODE, then any operands
  it("parks whatever non-code flags precede -c, and promotes exactly from -c on (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...SH_NON_CODE_FLAGS), { maxLength: 8 }),
        fc.array(fc.stringMatching(/^[a-z/.]{1,10}$/), { maxLength: 4 }),
        (prefix, rest) => {
          const argv = [...prefix, "-c", CODE, ...rest];
          const verdict = checkInstructionFloors(forcedSh(), call(SH, argv), provenance(argv));
          expect(verdict).toMatchObject({ outcome: "park", reason: "integrity_floor" });
          expect(violated(verdict)).toEqual(argv.slice(prefix.length).map((_e, offset) => `argv[${String(prefix.length + offset)}]`));
        },
      ),
      { numRuns: 300 },
    );
  });

  // proves D-036 fail-closed: forms the sh surface does not declare (cluster, attached code, undeclared flag) promote every element
  it.each([
    ["-ec", CODE],
    [`-c${CODE}`],
    ["-o", "errexit", "-c", CODE],
    ["-e", "-c", CODE, "-Z"],
  ])("parks %j with every argv element promoted", (...argv) => {
    const verdict = checkInstructionFloors(forcedSh(), call(SH, argv), provenance(argv));
    expect(verdict).toMatchObject({ outcome: "park", reason: "integrity_floor" });
    expect(violated(verdict)).toEqual(argv.map((_e, index) => `argv[${String(index)}]`));
    if (verdict.outcome === "park") for (const violation of verdict.violations) expect(violation.source).toMatchObject({ reason: "uncovered_flag" });
  });

  // proves D-036 fail-closed: sh forced in with no surface, or with a surface claiming it runs no code, promotes every element
  it("parks a forced sh that has no surface or a surface that declares no code", () => {
    const argv = ["-c", CODE];
    expect(violated(checkInstructionFloors(forcedSh(undefined), call(SH, argv), provenance(argv)))).toEqual(["argv[0]", "argv[1]"]);
    const lying = { program: SH, positions: [{ position: { kind: "operand" as const }, executes_code: false }] };
    expect(violated(checkInstructionFloors(forcedSh(lying), call(SH, argv), provenance(argv)))).toEqual(["argv[0]", "argv[1]"]);
  });

  // proves §2.3 rule 2 "restoring the operator floor": a promoted element at attested parks, though attested is the capability's floor
  it("judges promoted elements at the operator floor, not the capability's min_argument_integrity", () => {
    const entry = forcedSh();
    expect(entry.capability.min_argument_integrity).toBe("attested");
    expect(PROMOTED_ARGV_FLOOR).toBe("operator");
    const argv = ["-c", CODE];
    const attested = checkInstructionFloors(entry, call(SH, argv), provenance(argv, () => "attested"));
    expect(attested).toMatchObject({ outcome: "park", reason: "integrity_floor", violations: [{ floor: "operator", integrity: "attested" }, {}] });
    expect(checkInstructionFloors(entry, call(SH, argv), provenance(argv, () => "operator"))).toEqual({ outcome: "proceed" });
  });

  // proves §2.2 rule 2 is kept: each promoted element is judged alone (no whole-list min), and data elements are not judged at all
  it("judges each promoted element alone and leaves the elements before -c as data", () => {
    const argv = ["-e", "-u", "-c", CODE, "sh", "/work/a"];
    // Model-written flags before -c, operator-authored code and operands: proceeds.
    const operatorFromC = (index: number): Integrity => (index >= 2 ? "operator" : "untrusted");
    expect(checkInstructionFloors(forcedSh(), call(SH, argv), provenance(argv, operatorFromC))).toEqual({ outcome: "proceed" });
    // One promoted element below the floor: exactly that element is named.
    const oneLow = (index: number): Integrity => (index === 5 ? "derived" : operatorFromC(index));
    expect(checkInstructionFloors(forcedSh(), call(SH, argv), provenance(argv, oneLow))).toMatchObject({
      outcome: "park",
      violations: [{ argument: "argv[5]", integrity: "derived" }],
    });
  });

  // proves fail-closed provenance: a promoted element with no recorded provenance parks
  it("parks a promoted element whose provenance was not recorded", () => {
    const argv = ["-c", CODE];
    const recorded = provenance(argv, () => "operator").filter((item) => item.argument !== "argv[1]");
    expect(checkInstructionFloors(forcedSh(), call(SH, argv), recorded)).toMatchObject({
      outcome: "park",
      reason: "integrity_floor",
      violations: [{ argument: "argv[1]", integrity: null }],
    });
  });

  // proves §2.7 step 3 for the program field: it keeps the capability's floor (attested) and parks below it
  it("judges the program field at min_argument_integrity", () => {
    const argv = ["-c", CODE];
    const verdict = checkInstructionFloors(forcedSh(), call(SH, argv), provenance(argv, () => "operator", "untrusted"));
    expect(verdict).toMatchObject({ outcome: "park", violations: [{ argument: "program", floor: "attested", source: { kind: "instruction_field" } }] });
  });
});

describe("the shipped shell.run under per-call promotion (§2.2, §2.3 rule 2, D-036)", () => {
  // proves §2.2: cat with model-written or bound argv and cwd proceeds; argv and cwd stay data (the acceptance test 3 path)
  it.each([[["/work/notes.txt"]], [["-n", "-A", "/work/a", "/work/b"]], [["--", "-file-starting-with-dash"]], [[]]])(
    "proceeds for cat %j with untrusted argv",
    (argv) => {
      expect(checkInstructionFloors(shipped(), call(CAT, argv), provenance(argv))).toEqual({ outcome: "proceed" });
      expect(instructionValues(shipped(), call(CAT, argv)).map((value) => value.argument)).toEqual(["program"]);
    },
  );

  // proves §2.3.1 rule 6 (v0.6 A5; replaces D-036's promotion here, D-108): cat's surface is code-free everywhere and cat
  // is not on the §2.3 list, so a flag it does not declare promotes nothing; the call is named for rejection instead
  // (the enforcement boundary rejects it as malformed_call: packages/enforcement/test/enforcement.test.ts, "§2.3.1 rule 6")
  it.each<[string[], number]>([
    [["--bogus", "/work/a"], 0],
    [["-nA", "/work/a"], 0],
    [["/work/a", "--number=1"], 1],
    [["-file-starting-with-dash"], 0],
    [["-c", "cat"], 0],
  ])("names cat %j's undeclared flag for rejection and promotes nothing", (argv, at) => {
    expect(checkInstructionFloors(shipped(), call(CAT, argv), provenance(argv))).toEqual({ outcome: "proceed" });
    expect(instructionValues(shipped(), call(CAT, argv)).map((value) => value.argument)).toEqual(["program"]);
    expect(argvRoles(CAT, shipped().program_surfaces.find((surface) => surface.program === CAT), argv)).toMatchObject({ failClosed: false, undeclaredFlag: at });
  });

  // proves §2.3.1 rule 5 still holds for the forced sh entry: an undeclared flag on a listed interpreter promotes every element
  it("still promotes every element of sh on a flag its surface does not declare", () => {
    const argv = ["-Z", "/work/a"];
    expect(violated(checkInstructionFloors(forcedSh(), call(SH, argv), provenance(argv)))).toEqual(["argv[0]", "argv[1]"]);
  });

  // proves §2.2 for any cat call using only declared flags and plain operands (property): nothing is promoted
  it("promotes nothing in any cat call made of declared flags and plain operands (property)", () => {
    const declared = shipped().program_surfaces[0]?.positions.flatMap((entry) => (entry.position.kind === "flag" ? [entry.position.flag] : [])) ?? [];
    expect(declared.length).toBeGreaterThan(10);
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.constantFrom(...declared), fc.stringMatching(/^\/work\/[a-z.]{1,10}$/)), { maxLength: 10 }), (argv) => {
        expect(checkInstructionFloors(shipped(), call(CAT, argv), provenance(argv))).toEqual({ outcome: "proceed" });
      }),
      { numRuns: 300 },
    );
  });

  // proves §2.7: a call is parsed against the interface before any role is assigned
  it("refuses a call that does not parse", () => {
    expect(() => instructionValues(shipped(), { program: SH, argv: ["-c", CODE], cwd: "/work" })).toThrow(BoundaryError);
    expect(() => instructionValues(shipped(), { program: CAT, argv: "-c x", cwd: "/work" })).toThrow(BoundaryError);
  });
});

describe("the definition names its argv field (D-038)", () => {
  // records D-038: argv_field must exist and name a data list of strings
  it.each([
    ["no argv field", (entry: Record<string, unknown>) => { delete entry["argv_field"]; }],
    ["an argv field naming no field", (entry: Record<string, unknown>) => { entry["argv_field"] = "args"; }],
    ["an argv field that is not a list", (entry: Record<string, unknown>) => { entry["argv_field"] = "cwd"; }],
    ["an argv field that is the program", (entry: Record<string, unknown>) => { entry["argv_field"] = "program"; }],
  ])("refuses %s", (_name, mutate) => {
    const entry = raw();
    mutate(entry);
    expect(RegistryEntry.safeParse(entry).success).toBe(false);
  });

  // records D-038: the shipped file names argv
  it("ships argv as the argv field", () => {
    expect(shipped().argv_field).toBe("argv");
  });
});

describe("the definition names its cwd field (D-047)", () => {
  // records D-047: cwd_field must exist and name a scalar data path, because relative argv operands are scope-checked against it
  it.each([
    ["no cwd field", (entry: Record<string, unknown>) => { delete entry["cwd_field"]; }],
    ["a cwd field naming no field", (entry: Record<string, unknown>) => { entry["cwd_field"] = "dir"; }],
    ["a cwd field that is a list", (entry: Record<string, unknown>) => { entry["cwd_field"] = "argv"; }],
    ["a cwd field that is the program", (entry: Record<string, unknown>) => { entry["cwd_field"] = "program"; }],
  ])("refuses %s", (_name, mutate) => {
    const entry = raw();
    mutate(entry);
    expect(RegistryEntry.safeParse(entry).success).toBe(false);
  });

  // records D-047: the shipped file names cwd
  it("ships cwd as the cwd field", () => {
    expect(shipped().cwd_field).toBe("cwd");
  });
});
