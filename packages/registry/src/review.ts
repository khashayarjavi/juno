import { type ArgvPosition, interpreterVerdict } from "../../contracts/src/index.js";
import { type RegistryEntry, programsOf } from "./entry.js";

/**
 * Registration review of enum membership (spec §2.3 rules 1 and 3): every
 * program the program enum names must pass the interpreter test against its
 * declared flag surface. A program with no declared surface fails closed
 * (DECISIONS.md D-018).
 */

export type InterpreterInEnum = {
  readonly kind: "interpreter_in_enum";
  readonly program: string;
  readonly reason: "known_interpreter" | "no_declared_surface" | "surface_names_another_program" | "code_bearing_position";
  readonly positions: readonly ArgvPosition[];
};

export function reviewProgramEnum(entry: RegistryEntry): InterpreterInEnum[] {
  const refusals: InterpreterInEnum[] = [];
  for (const program of programsOf(entry)) {
    const surface = entry.program_surfaces.find((candidate) => candidate.program === program);
    const verdict = interpreterVerdict(program, surface);
    if (verdict.interpreter) {
      refusals.push({ kind: "interpreter_in_enum", program, reason: verdict.reason, positions: verdict.positions });
    }
  }
  return refusals;
}
