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
    /** The interface field naming the program to run: a scalar `instruction` enum (§2.2, §2.3). */
    program_field: z.string(),
    /** The interface field holding the program's argv: a `data` list of strings, read per call against the surfaces (D-036, D-038). */
    argv_field: z.string(),
    /** The declared flag surface of each program in that enum (DECISIONS.md D-018). */
    program_surfaces: z.array(FlagSurface),
  })
  .superRefine((entry, ctx) => {
    const field = entry.capability.interface[entry.program_field];
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
          path: ["capability", "interface", entry.program_field, "type", "values", index],
          message: "a program must be named by its absolute, normalised path, so no search path decides what runs",
        });
      }
    });
    const argv = entry.capability.interface[entry.argv_field];
    if (argv === undefined) {
      ctx.addIssue({ code: "custom", path: ["argv_field"], message: "must name a field of the capability interface" });
    } else if (argv.role !== "data" || argv.type.kind !== "list" || argv.type.items.kind !== "string") {
      ctx.addIssue({ code: "custom", path: ["argv_field"], message: "the argv field must be a data list of strings (spec §2.2, §2.3 rule 2)" });
    }
    const seen = new Set<string>();
    entry.program_surfaces.forEach((surface, index) => {
      if (seen.has(surface.program)) {
        ctx.addIssue({ code: "custom", path: ["program_surfaces", index, "program"], message: "a program may have only one declared surface" });
      }
      seen.add(surface.program);
    });
  });
export type RegistryEntry = z.infer<typeof RegistryEntry>;

/** The values of an entry's program enum. */
export function programsOf(entry: RegistryEntry): readonly string[] {
  const type = entry.capability.interface[entry.program_field]?.type;
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
