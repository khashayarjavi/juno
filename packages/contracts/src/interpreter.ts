import { z } from "zod";

/**
 * The interpreter test (spec §2.3):
 *
 *   A program is an interpreter if any argv position can cause execution of
 *   code not named by `program`.
 *
 * The predicate takes a program name and its known flag surface: the argv
 * positions an operator has declared for that program, each marked with
 * whether it can execute code. The rules it applies are in DECISIONS.md D-018.
 */

/**
 * The spec's illustrative list (§2.3), verbatim. Membership alone makes a
 * program an interpreter, whatever surface is declared for it. The list is
 * incomplete by design: the test is primary.
 */
export const KNOWN_INTERPRETERS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "python",
  "node",
  "ruby",
  "perl",
  "php",
  "find",
  "xargs",
  "awk",
  "sed",
  "env",
  "make",
  "ssh",
  "sudo",
  "docker",
  "kubectl",
  "npm",
  "yarn",
  "pnpm",
  "tar",
  "rsync",
  "git",
]);

const Token = z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/, "must be printable ASCII with no whitespace");

/** One argv position a program accepts. */
export const ArgvPosition = z.discriminatedUnion("kind", [
  /** A flag or option, e.g. `-c`, `--exec`, `-exec`. */
  z.strictObject({ kind: z.literal("flag"), flag: Token }),
  /** A subcommand word, e.g. `run` for `npm run`. */
  z.strictObject({ kind: z.literal("subcommand"), name: Token }),
  /** Any positional operand, e.g. the script path in `sh script.sh`. */
  z.strictObject({ kind: z.literal("operand") }),
]);
export type ArgvPosition = z.infer<typeof ArgvPosition>;

/** The known flag surface of one program, as declared by the operator. */
export const FlagSurface = z.strictObject({
  program: Token,
  positions: z.array(
    z.strictObject({
      position: ArgvPosition,
      executes_code: z.boolean(),
    }),
  ),
});
export type FlagSurface = z.infer<typeof FlagSurface>;

/**
 * The name a program is compared under: its last path segment with any
 * trailing version number removed (`/usr/bin/python3.12` → `python`).
 */
export function programBaseName(program: string): string {
  const lastSegment = program.slice(program.lastIndexOf("/") + 1);
  return lastSegment.replace(/[0-9][0-9.]*$/, "");
}

export type InterpreterVerdict =
  | { readonly interpreter: false }
  | {
      readonly interpreter: true;
      readonly reason: "known_interpreter" | "no_declared_surface" | "surface_names_another_program" | "code_bearing_position";
      readonly positions: readonly ArgvPosition[];
    };

/**
 * Applies the §2.3 test. A program is judged non-interpreter only when it is
 * not on the known list, its flag surface is declared for that same program,
 * and no declared position can execute code. Anything less fails closed.
 */
export function interpreterVerdict(program: string, surface: FlagSurface | undefined): InterpreterVerdict {
  if (KNOWN_INTERPRETERS.has(programBaseName(program))) {
    return { interpreter: true, reason: "known_interpreter", positions: [] };
  }
  if (surface === undefined) {
    return { interpreter: true, reason: "no_declared_surface", positions: [] };
  }
  // Exact match: normalising names only ever widens the known list, never a declared surface.
  if (surface.program !== program) {
    return { interpreter: true, reason: "surface_names_another_program", positions: [] };
  }
  const codeBearing = surface.positions.filter((entry) => entry.executes_code).map((entry) => entry.position);
  if (codeBearing.length > 0) {
    return { interpreter: true, reason: "code_bearing_position", positions: codeBearing };
  }
  return { interpreter: false };
}

export function isInterpreter(program: string, surface: FlagSurface | undefined): boolean {
  return interpreterVerdict(program, surface).interpreter;
}
