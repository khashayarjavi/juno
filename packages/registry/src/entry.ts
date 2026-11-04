import { readFileSync } from "node:fs";
import { z } from "zod";
import { AbsolutePath, Capability, FlagSurface, parseAtBoundary } from "../../contracts/src/index.js";

/**
 * A registry entry: one capability definition kept as an operator-authored,
 * versioned file under source control (spec §2.5), together with the flag
 * surface of every program its program enum names, so that registration
 * review can apply the interpreter test (§2.3 rule 3). Format: DECISIONS.md D-032.
 *
 * The schema checks structure only. Whether the enum is interpreter-free is
 * decided by registration review (`review.ts`), so a refusal can say why.
 */
export const RegistryEntry = z
  .strictObject({
    capability: Capability,
    /** The interface field naming the program to run: a scalar `instruction` enum (§2.2, §2.3). Absent on a typed entry (D-134). */
    program_field: z.string().optional(),
    /** The interface field holding the program's argv: a `data` list of strings, read per call against the surfaces (D-036, D-038). */
    argv_field: z.string().optional(),
    /** The interface field holding the working directory: a scalar `data` path. Relative argv operands are read against it (D-047). */
    cwd_field: z.string().optional(),
    /** The declared flag surface of each program in that enum (DECISIONS.md D-018). */
    program_surfaces: z.array(FlagSurface).default([]),
  })
  .superRefine((entry, ctx) => {
    const named = [entry.program_field, entry.argv_field, entry.cwd_field].filter((field) => field !== undefined).length;
    if (named === 0) {
      // A typed entry (D-134): no program is chosen per call, so no field may be an instruction and no surface applies.
      for (const [name, field] of Object.entries(entry.capability.interface)) {
        if (field.role === "instruction") {
          ctx.addIssue({
            code: "custom",
            path: ["capability", "interface", name, "role"],
            message: "a capability with no program field has data fields only (DECISIONS.md D-134)",
          });
        }
      }
      if (entry.program_surfaces.length > 0) {
        ctx.addIssue({ code: "custom", path: ["program_surfaces"], message: "a capability with no program field declares no program surface" });
      }
      return;
    }
    if (named !== 3) {
      ctx.addIssue({ code: "custom", path: ["program_field"], message: "program_field, argv_field and cwd_field are named together or not at all (D-134)" });
      return;
    }
    const programField = entry.program_field ?? "";
    const argvField = entry.argv_field ?? "";
    const cwdField = entry.cwd_field ?? "";
    const field = entry.capability.interface[programField];
    if (field === undefined) {
      ctx.addIssue({ code: "custom", path: ["program_field"], message: "must name a field of the capability interface" });
      return;
    }
    if (field.role !== "instruction") {
      ctx.addIssue({ code: "custom", path: ["program_field"], message: "the program field must be an instruction field (spec §2.2)" });
    }
    if (field.type.kind !== "enum") {
      ctx.addIssue({ code: "custom", path: ["program_field"], message: "the program field must be an enum (spec §2.2, §2.3)" });
      return;
    }
    field.type.values.forEach((program, index) => {
      if (!AbsolutePath.safeParse(program).success) {
        ctx.addIssue({
          code: "custom",
          path: ["capability", "interface", programField, "type", "values", index],
          message: "a program must be named by its absolute, normalised path, so no search path decides what runs",
        });
      }
    });
    const argv = entry.capability.interface[argvField];
    if (argv === undefined) {
      ctx.addIssue({ code: "custom", path: ["argv_field"], message: "must name a field of the capability interface" });
    } else if (argv.role !== "data" || argv.type.kind !== "list" || argv.type.items.kind !== "string") {
      ctx.addIssue({ code: "custom", path: ["argv_field"], message: "the argv field must be a data list of strings (spec §2.2, §2.3 rule 2)" });
    }
    const cwd = entry.capability.interface[cwdField];
    if (cwd === undefined) {
      ctx.addIssue({ code: "custom", path: ["cwd_field"], message: "must name a field of the capability interface" });
    } else if (cwd.role !== "data" || cwd.type.kind !== "path") {
      ctx.addIssue({ code: "custom", path: ["cwd_field"], message: "the cwd field must be a scalar data path (spec §2.2; D-047)" });
    }
    const seen = new Set<string>();
    entry.program_surfaces.forEach((surface, index) => {
      if (seen.has(surface.program)) {
        ctx.addIssue({ code: "custom", path: ["program_surfaces", index, "program"], message: "a program may have only one declared surface" });
      }
      seen.add(surface.program);
    });
  });
export type RegistryEntry = z.output<typeof RegistryEntry>;

/** The program, argv and cwd fields of a program entry; `null` for a typed entry, which runs no chosen program (D-134). */
export type ProgramShape = { readonly program: string; readonly argv: string; readonly cwd: string };

export function programShape(entry: RegistryEntry): ProgramShape | null {
  const { program_field: program, argv_field: argv, cwd_field: cwd } = entry;
  return program === undefined || argv === undefined || cwd === undefined ? null : { program, argv, cwd };
}

/** The values of an entry's program enum; none for a typed entry. */
export function programsOf(entry: RegistryEntry): readonly string[] {
  const shape = programShape(entry);
  const type = shape === null ? undefined : entry.capability.interface[shape.program]?.type;
  return type?.kind === "enum" ? type.values : [];
}

/** Reads a definition file. The file is a boundary: it is parsed before anything uses it. */
export function loadRegistryEntry(file: string): RegistryEntry {
  const text = readFileSync(file, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error: unknown) {
    throw new Error(`capability definition ${file} is not valid JSON`, { cause: error });
  }
  return parseAtBoundary(`capability definition ${file}`, RegistryEntry, json);
}
