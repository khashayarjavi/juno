import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BoundaryError, KNOWN_INTERPRETERS } from "../../contracts/src/index.js";
import {
  type Adapter,
  CANARY_PAYLOAD,
  type CapabilityCall,
  CapabilityRegistry,
  type OutboundInvocation,
  RegistryEntry,
  RegistryError,
  WORKLOAD_EXECFILE,
  WorkloadExecFileAdapter,
  canaryValue,
  executeOutbound,
  loadRegistryEntry,
  reviewProgramEnum,
  runConformanceSuite,
} from "../src/index.js";

const SHELL_RUN_FILE = fileURLToPath(new URL("../definitions/shell.run.json", import.meta.url));
const shipped = (): RegistryEntry => loadRegistryEntry(SHELL_RUN_FILE);
const raw = (): { capability: { interface: Record<string, Record<string, unknown>> } } & Record<string, unknown> =>
  JSON.parse(readFileSync(SHELL_RUN_FILE, "utf8")) as never;

const workloadAdapter = (): WorkloadExecFileAdapter =>
  new WorkloadExecFileAdapter({ composeFile: "/repo/containers/docker-compose.yml", project: "juno-test", service: "workload" });

/** The shipped definition with extra programs added to its enum, and optionally their surfaces. */
function withPrograms(programs: readonly string[], surfaces: RegistryEntry["program_surfaces"] = []): unknown {
  const entry = raw() as { capability: { interface: { program: { type: { values: string[] } } } }; program_surfaces: unknown[] };
  entry.capability.interface.program.type.values.push(...programs);
  entry.program_surfaces.push(...surfaces);
  return entry;
}

/** An adapter with the shipped provider id whose plan is supplied by the test. */
const adapterWith = (plan: (call: CapabilityCall) => OutboundInvocation, id = WORKLOAD_EXECFILE): Adapter => ({ id, plan });

const field = (call: CapabilityCall, name: string): string => String(call[name]);
const list = (call: CapabilityCall, name: string): string[] => (call[name] as string[]).map(String);

describe("capability definitions are versioned files (§2.5)", () => {
  // proves §2.5 / build plan Inc 3: shell.run is a definition file in source control that parses as a registry entry
  it("loads the shell.run definition file", () => {
    const entry = shipped();
    expect(entry.capability.id).toBe("shell.run");
    expect(entry.program_field).toBe("program");
  });

  // proves §2.2 and §18: shell.run declares every role explicitly, as §2.2 illustrates: program instruction, argv and cwd data
  it("declares each shell.run role explicitly in the file", () => {
    const fields = raw().capability.interface;
    expect(Object.keys(fields).sort()).toEqual(["argv", "cwd", "program"]);
    expect(fields["program"]).toMatchObject({ role: "instruction", type: { kind: "enum" } });
    expect(fields["argv"]).toMatchObject({ role: "data", type: { kind: "list", items: { kind: "string" } } });
    expect(fields["cwd"]).toMatchObject({ role: "data", type: { kind: "path" } });
  });

  // proves §2.3 rule 1 and §18: the shipped program enum is interpreter-free, and every program has a declared surface
  it("ships an interpreter-free program enum", () => {
    const entry = shipped();
    expect(reviewProgramEnum(entry)).toEqual([]);
    const programs = entry.capability.interface["program"]?.type;
    expect(programs?.kind === "enum" ? programs.values.length : 0).toBeGreaterThan(0);
  });

  // proves §2.1 / §2.4: the shipped definition registers with its listed adapter
  it("registers shell.run with the workload adapter", () => {
    const registry = new CapabilityRegistry();
    expect(registry.register(raw(), [workloadAdapter()])).toEqual({ registered: true, id: "shell.run" });
    expect(registry.isRegistered("shell.run")).toBe(true);
  });

  // proves §2.2 rule 2 at registration: argv cannot be made a whole-list instruction field
  it("refuses a definition that declares argv instruction", () => {
    const entry = raw();
    (entry.capability.interface["argv"] as Record<string, unknown>)["role"] = "instruction";
    expect(RegistryEntry.safeParse(entry).success).toBe(false);
  });

  // proves §2.2 rule 1 at registration: a program field left without a role is instruction, and a data program field is refused
  it("treats a program field without a role as instruction and refuses one declared data", () => {
    const noRole = raw();
    delete noRole.capability.interface["program"]?.["role"];
    expect(RegistryEntry.parse(noRole).capability.interface["program"]?.role).toBe("instruction");
    const dataRole = raw();
    (dataRole.capability.interface["program"] as Record<string, unknown>)["role"] = "data";
    expect(RegistryEntry.safeParse(dataRole).success).toBe(false);
  });

  // records D-032: the program field must exist and be an enum; programs are absolute paths with one surface each; unknown keys fail
  it.each([
    ["a program field that names no field", (entry: Record<string, unknown>) => { entry["program_field"] = "binary"; }],
    ["a program field that is not an enum", (entry: Record<string, unknown>) => { entry["program_field"] = "cwd"; }],
    ["a program named without its path", (entry: Record<string, unknown>) => {
      ((entry["capability"] as never)["interface"]["program"]["type"]["values"] as string[]).push("cat");
    }],
    ["two surfaces for one program", (entry: Record<string, unknown>) => {
      const surfaces = entry["program_surfaces"] as unknown[];
      surfaces.push(surfaces[0]);
    }],
    ["an unknown key", (entry: Record<string, unknown>) => { entry["version"] = 2; }],
  ])("refuses %s", (_name, mutate) => {
    const entry = raw();
    mutate(entry);
    const result = new CapabilityRegistry().register(entry, [workloadAdapter()]);
    expect(result).toMatchObject({ registered: false, refusals: [{ kind: "invalid_definition" }] });
  });
});

describe("registration review of the program enum (§2.3, acceptance test 4a)", () => {
  // proves §18 acceptance test 4a: adding sh to the enum is rejected by registration review under §2.3
  it("rejects adding sh to the enum, even with a surface that claims sh runs no code", () => {
    const registry = new CapabilityRegistry();
    const result = registry.register(withPrograms(["/bin/sh"], [{ program: "/bin/sh", positions: [] }]), [workloadAdapter()]);
    expect(result).toEqual({
      registered: false,
      refusals: [{ kind: "interpreter_in_enum", program: "/bin/sh", reason: "known_interpreter", positions: [] }],
    });
    expect(registry.isRegistered("shell.run")).toBe(false);
  });

  // proves §2.3 rule 1: every listed interpreter is refused, whatever path it is installed under
  it.each(["/bin/sh", "/usr/bin/bash", "/usr/bin/env", "/usr/bin/git", "/usr/bin/python3", "/usr/bin/find", "/usr/bin/xargs", "/usr/local/bin/node22"])(
    "rejects %s in the enum",
    (program) => {
      const result = new CapabilityRegistry().register(withPrograms([program]), [workloadAdapter()]);
      expect(result).toMatchObject({ registered: false, refusals: [{ kind: "interpreter_in_enum", program, reason: "known_interpreter" }] });
    },
  );

  // proves §2.3 rule 1 for any enum: a program list containing any known interpreter, under any directory, is refused, and each interpreter is named
  it("refuses every enum that contains a known interpreter (property)", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...KNOWN_INTERPRETERS), { minLength: 1, maxLength: 5 }),
        fc.constantFrom("/bin", "/usr/bin", "/usr/local/bin", "/opt/tools/bin"),
        fc.constantFrom("", "3", "5.1"),
        (names, dir, version) => {
          const programs = names.map((name) => dir + "/" + name + version);
          const result = new CapabilityRegistry().register(withPrograms(programs), [workloadAdapter()]);
          expect(result.registered).toBe(false);
          if (result.registered) return;
          const refused = result.refusals.flatMap((refusal) => (refusal.kind === "interpreter_in_enum" ? [refusal.program] : []));
          expect(refused.sort()).toEqual([...programs].sort());
        },
      ),
    );
  });

  // proves §2.3 "the test is primary": an unlisted program whose declared surface has a code-bearing position is refused
  it("rejects an unlisted program with a code-bearing flag", () => {
    const surface = {
      program: "/usr/bin/fd",
      positions: [
        { position: { kind: "flag" as const, flag: "-H" }, executes_code: false },
        { position: { kind: "flag" as const, flag: "--exec" }, executes_code: true },
      ],
    };
    const result = new CapabilityRegistry().register(withPrograms(["/usr/bin/fd"], [surface]), [workloadAdapter()]);
    expect(result).toEqual({
      registered: false,
      refusals: [{ kind: "interpreter_in_enum", program: "/usr/bin/fd", reason: "code_bearing_position", positions: [{ kind: "flag", flag: "--exec" }] }],
    });
  });

  // proves §2.3 with §0.2 D8: an unlisted program with no declared surface, or a surface for another program, fails closed
  it("rejects an unlisted program with no surface, or with a surface declared for another program", () => {
    const missing = new CapabilityRegistry().register(withPrograms(["/usr/bin/wc"]), [workloadAdapter()]);
    expect(missing).toMatchObject({ registered: false, refusals: [{ kind: "interpreter_in_enum", program: "/usr/bin/wc", reason: "no_declared_surface" }] });
    const other = new CapabilityRegistry().register(withPrograms(["/usr/bin/wc"], [{ program: "/bin/wc", positions: [] }]), [workloadAdapter()]);
    expect(other).toMatchObject({ registered: false, refusals: [{ kind: "interpreter_in_enum", program: "/usr/bin/wc", reason: "no_declared_surface" }] });
  });

  // proves §2.3 rule 3: a non-interpreter with a declared, code-free surface is accepted into the enum
  it("accepts an unlisted program whose declared surface carries no code", () => {
    const surface = { program: "/usr/bin/wc", positions: [{ position: { kind: "operand" as const }, executes_code: false }] };
    expect(new CapabilityRegistry().register(withPrograms(["/usr/bin/wc"], [surface]), [workloadAdapter()]).registered).toBe(true);
  });
});

describe("the registration conformance suite (§2.4)", () => {
  // guards every suite test: the canary really carries shell metacharacters, both quotes and argv's delimiters
  it("uses a canary with metacharacters, quotes, and space, tab and newline", () => {
    for (const character of [";", "|", "&", "$", "`", "(", ")", "<", ">", "*", "?", "'", '"', "\\", " ", "\t", "\n"]) {
      expect(CANARY_PAYLOAD).toContain(character);
    }
    expect(canaryValue("t", 0).startsWith("-")).toBe(false);
  });

  // proves §2.4 / build plan Inc 3: through the conforming adapter every canary is one whole argv element, in order, and in no other string
  it("passes the conforming workload adapter with each canary a discrete, intact argv element", () => {
    const result = runConformanceSuite(shipped().capability, workloadAdapter(), "fixed");
    expect(result.conforming).toBe(true);
    if (!result.conforming) return;
    expect(result.canaries).toBe(3);
    // Canaries are numbered in interface order: argv takes 0 and 1, cwd takes 2.
    const [first, second, cwd] = [canaryValue("fixed", 0), canaryValue("fixed", 1), "/work/" + canaryValue("fixed", 2)];
    const args = result.invocation.args;
    expect(args.slice(-2)).toEqual([first, second]);
    expect(args.filter((element) => element === cwd)).toHaveLength(1);
    expect([result.invocation.file, ...args].filter((element) => element.includes("juno-canary-") && ![first, second, cwd].includes(element))).toEqual([]);
  });

  // proves §18 acceptance test 5: an adapter that interpolates argv into a command string is blocked at registration, before any task can use it
  it("blocks a string-interpolating adapter at registration, so the capability cannot be invoked", async () => {
    const interpolating = adapterWith((call) => ({
      file: "docker",
      args: ["compose", "run", "--rm", "--workdir", field(call, "cwd"), "--entrypoint", "/bin/sh", "workload", "-c", field(call, "program") + " " + list(call, "argv").join(" ")],
    }));
    const registry = new CapabilityRegistry();
    const result = registry.register(raw(), [interpolating]);
    expect(result.registered).toBe(false);
    if (result.registered) return;
    expect(result.refusals).toHaveLength(1);
    const refusal = result.refusals[0];
    expect(refusal?.kind).toBe("nonconforming_adapter");
    if (refusal?.kind !== "nonconforming_adapter") return;
    expect(refusal.failures).toContainEqual(expect.objectContaining({ kind: "canary_in_parsed_string", field: "argv" }));
    expect(refusal.failures).toContainEqual(expect.objectContaining({ kind: "canary_not_discrete", field: "argv", occurrences: 0 }));
    expect(registry.isRegistered("shell.run")).toBe(false);
    expect(registry.capability("shell.run")).toBeUndefined();
    await expect(registry.invoke("shell.run", { program: "/usr/bin/cat", argv: [], cwd: "/work" })).rejects.toThrow(RegistryError);
  });

  // proves §2.4: interpolation is blocked in every form the suite can see, including quoting and joining without a shell
  it.each<[string, (call: CapabilityCall) => OutboundInvocation, string]>([
    ["shell-quotes each value and joins them", (call) => ({
      file: "docker",
      args: ["run", "--entrypoint", "/bin/sh", "w", "-c", list(call, "argv").map((value) => "'" + value.replaceAll("'", "'\\''") + "'").join(" ")],
    }), "canary_in_parsed_string"],
    ["joins argv into one element without a shell", (call) => ({ file: "docker", args: ["run", "--workdir", field(call, "cwd"), "w", list(call, "argv").join(" ")] }), "canary_in_parsed_string"],
    ["writes cwd as --workdir=<cwd>", (call) => ({ file: "docker", args: ["run", "--workdir=" + field(call, "cwd"), "w", ...list(call, "argv")] }), "canary_in_parsed_string"],
    ["builds the program path from data", (call) => ({ file: field(call, "cwd") + "/run", args: list(call, "argv") }), "canary_in_parsed_string"],
    ["drops argv", (call) => ({ file: "docker", args: ["run", "--workdir", field(call, "cwd"), "w"] }), "canary_not_discrete"],
    ["passes an argv element twice", (call) => ({ file: "docker", args: ["run", "--workdir", field(call, "cwd"), "w", ...list(call, "argv"), ...list(call, "argv")] }), "canary_not_discrete"],
    ["reverses argv", (call) => ({ file: "docker", args: ["run", "--workdir", field(call, "cwd"), "w", ...list(call, "argv").reverse()] }), "list_not_intact"],
    ["inserts an element inside argv", (call) => {
      const [first, ...rest] = list(call, "argv");
      return { file: "docker", args: ["run", "--workdir", field(call, "cwd"), "w", first ?? "", "--", ...rest] };
    }, "list_not_intact"],
    ["refuses values with metacharacters", (call) => {
      if (list(call, "argv").some((value) => /[;|&$]/.test(value))) throw new Error("unsafe characters");
      return { file: "docker", args: list(call, "argv") };
    }, "refused_canary"],
  ])("blocks an adapter that %s", (_name, plan, failure) => {
    const result = new CapabilityRegistry().register(raw(), [adapterWith(plan)]);
    expect(result).toMatchObject({ registered: false, refusals: [{ kind: "nonconforming_adapter", adapter: WORKLOAD_EXECFILE }] });
    if (result.registered) return;
    const refusal = result.refusals[0];
    expect(refusal?.kind === "nonconforming_adapter" ? refusal.failures.map((entry) => entry.kind) : []).toContain(failure);
  });

  // proves §2.4: each registration feeds a fresh canary, so an adapter cannot pass by recognising a fixed one
  it("feeds a different canary on each run", () => {
    const seen: string[] = [];
    const recording = adapterWith((call) => {
      seen.push(...list(call, "argv"));
      return workloadAdapter().plan(call);
    });
    runConformanceSuite(shipped().capability, recording);
    runConformanceSuite(shipped().capability, recording);
    expect(new Set(seen).size).toBe(4);
  });
});

describe("registration refuses incomplete adapter bindings (§2.1 providers, §2.4)", () => {
  // records D-032: every listed provider needs an adapter, and every adapter must be listed
  it("refuses a missing adapter, an unlisted adapter, and a duplicate adapter", () => {
    expect(new CapabilityRegistry().register(raw(), [])).toEqual({
      registered: false,
      refusals: [{ kind: "adapter_missing", provider: WORKLOAD_EXECFILE }],
    });
    const stray = adapterWith((call) => workloadAdapter().plan(call), "other.adapter");
    expect(new CapabilityRegistry().register(raw(), [workloadAdapter(), stray])).toMatchObject({
      registered: false,
      refusals: [{ kind: "adapter_not_listed", adapter: "other.adapter" }],
    });
    expect(new CapabilityRegistry().register(raw(), [workloadAdapter(), workloadAdapter()])).toMatchObject({
      registered: false,
      refusals: [{ kind: "duplicate_adapter", adapter: WORKLOAD_EXECFILE }],
    });
  });

  // records D-032 with §0.2 D8: a capability with no provider cannot be registered
  it("refuses a capability that lists no provider", () => {
    const entry = raw() as unknown as { capability: { providers: string[] } };
    entry.capability.providers = [];
    expect(new CapabilityRegistry().register(entry, [])).toEqual({ registered: false, refusals: [{ kind: "no_provider" }] });
  });

  // records D-032: a registered capability cannot be replaced by registering it again
  it("refuses to register the same capability twice", () => {
    const registry = new CapabilityRegistry();
    expect(registry.register(raw(), [workloadAdapter()]).registered).toBe(true);
    expect(registry.register(raw(), [workloadAdapter()])).toEqual({ registered: false, refusals: [{ kind: "already_registered", id: "shell.run" }] });
  });
});

/** Runs node on the host and prints the argv it received, as JSON: a stand-in provider for unit tests. */
const ECHO = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";
const echoAdapter = adapterWith((call) => ({ file: process.execPath, args: ["-e", ECHO, field(call, "cwd"), ...list(call, "argv")] }));

describe("invoking a registered capability (§2.1, §2.4)", () => {
  const registry = new CapabilityRegistry();
  registry.register(raw(), [echoAdapter]);

  // proves §2.4: a call's data values reach the program as the same argv array, element for element
  it("delivers cwd and every argv element to the program unchanged", async () => {
    const argv = [canaryValue("invoke", 1), "two words", "", "$HOME"];
    const result = await registry.invoke("shell.run", { program: "/usr/bin/cat", argv, cwd: "/work/" + canaryValue("invoke", 0) });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString("utf8"))).toEqual(["/work/" + canaryValue("invoke", 0), ...argv]);
  });

  // proves §2.1 / D-016: a call is parsed against the interface before anything runs
  it.each([
    ["an unknown field", { program: "/usr/bin/cat", argv: [], cwd: "/work", mode: "raw" }],
    ["a missing field", { program: "/usr/bin/cat", argv: [] }],
    ["a program outside the enum", { program: "/bin/sh", argv: ["-c", "id"], cwd: "/work" }],
    ["argv as one string", { program: "/usr/bin/cat", argv: "a b", cwd: "/work" }],
    ["a relative cwd", { program: "/usr/bin/cat", argv: [], cwd: "work" }],
    ["an argv element containing NUL", { program: "/usr/bin/cat", argv: ["a\0b"], cwd: "/work" }],
  ])("refuses a call with %s", async (_name, call) => {
    await expect(registry.invoke("shell.run", call)).rejects.toThrow(BoundaryError);
  });

  // proves build plan Inc 3: a capability that was never registered cannot be invoked
  it("refuses to invoke an unregistered capability", async () => {
    await expect(new CapabilityRegistry().invoke("shell.run", { program: "/usr/bin/cat", argv: [], cwd: "/work" })).rejects.toThrow(RegistryError);
  });
});

describe("executeOutbound (§2.4)", () => {
  // records D-033: a non-zero exit is a program result, not an error
  it("reports a non-zero exit code as a result", async () => {
    const result = await executeOutbound({ file: process.execPath, args: ["-e", "process.exit(3)"] });
    expect(result).toMatchObject({ exitCode: 3, signal: null });
  });

  // records D-033: no capability has a stdin channel, so a program reading stdin sees end of input instead of waiting
  it("closes the program's stdin", async () => {
    const result = await executeOutbound({ file: process.execPath, args: ["-e", 'process.stdin.on("end", () => process.stdout.write("eof")).resume()'] });
    expect({ exitCode: result.exitCode, stdout: result.stdout.toString("utf8") }).toEqual({ exitCode: 0, stdout: "eof" });
  });

  // records D-033: a program that cannot start is an error, never a result
  it("rejects when the program does not exist", async () => {
    await expect(executeOutbound({ file: "/nonexistent/juno-program", args: [] })).rejects.toThrow();
  });
});
