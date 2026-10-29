import { type FlagSurface, KNOWN_INTERPRETERS, programBaseName } from "./interpreter.js";

/**
 * Per-call promotion of code-bearing argv positions (spec §2.3 rule 2,
 * DECISIONS.md D-036 and D-037).
 *
 * On every call the argv is read against the program's declared flag surface.
 * Each element in a code-bearing position becomes its own scalar `instruction`
 * value, judged alone at the `operator` floor; every other element stays
 * `data`. When the call uses anything the surface does not declare, the
 * boundary cannot know how the program will read it, so every element is
 * promoted (fail-closed, §0.2 D8).
 */

export type PromotionReason =
  /** The program has no declared surface: nothing about its argv is known. */
  | "no_declared_surface"
  /** The surface names a different program, so it describes nothing about this one. */
  | "surface_names_another_program"
  /** The program is on the §2.3 list, yet its surface declares no position that executes code: the surface is wrong (D-018). */
  | "known_interpreter_without_code_position"
  /** The element at `at` is a flag the surface does not declare. */
  | "uncovered_flag"
  /** The element at `at` is an operand, and the surface declares no operand. */
  | "uncovered_operand"
  /** The element at `at` is declared as executing code; it and everything after it carry code. */
  | "code_bearing_position";

export type ArgvElementRole =
  | { readonly index: number; readonly role: "data" }
  | { readonly index: number; readonly role: "instruction"; readonly reason: PromotionReason; readonly at: number | null };

export type ArgvRoles = {
  readonly elements: readonly ArgvElementRole[];
  /** True when every element was promoted because the surface does not cover the call. */
  readonly failClosed: boolean;
};

const OPTIONS_END = "--";

function isFlagToken(element: string): boolean {
  return element.startsWith("-") && element !== "-";
}

/** How the D-037 reading classes one argv element. */
export type ArgvTokenKind = "flag" | "subcommand" | "operand";

type Token = {
  readonly kind: ArgvTokenKind;
  /** Whether the declared position executes code; `undefined` when the surface does not declare it. */
  readonly executesCode: boolean | undefined;
};

/**
 * The one reading of an argv against a declared surface (D-037), shared by
 * promotion and by the scope check (D-047), so the two can never read the
 * same argv differently:
 *   - `--`, when declared, ends option parsing; every later element is an operand.
 *   - A token starting with `-` (other than `-` alone) is a flag, matched exactly.
 *   - Any other token is a declared subcommand if one has that name, else an operand.
 */
function readTokens(surface: FlagSurface, argv: readonly string[]): Token[] {
  const flags = new Map<string, boolean>();
  const subcommands = new Map<string, boolean>();
  let operand: boolean | undefined;
  for (const { position, executes_code } of surface.positions) {
    // A position declared twice counts as code if either declaration says so.
    if (position.kind === "flag") flags.set(position.flag, (flags.get(position.flag) ?? false) || executes_code);
    else if (position.kind === "subcommand") subcommands.set(position.name, (subcommands.get(position.name) ?? false) || executes_code);
    else operand = (operand ?? false) || executes_code;
  }
  let optionsEnded = false;
  return argv.map((element) => {
    if (!optionsEnded && isFlagToken(element)) {
      const declared = flags.get(element);
      if (declared !== undefined && element === OPTIONS_END) optionsEnded = true;
      return { kind: "flag", executesCode: declared };
    }
    const subcommand = optionsEnded ? undefined : subcommands.get(element);
    if (subcommand !== undefined) return { kind: "subcommand", executesCode: subcommand };
    return { kind: "operand", executesCode: operand };
  });
}

/**
 * How each element of one call's argv is read (D-037, D-047). With no
 * surface for `program`, or one naming another program, nothing about the
 * argv is known, so every element is read as an operand: for the scope check
 * that is the reading that checks the most.
 */
export function argvTokenKinds(program: string, surface: FlagSurface | undefined, argv: readonly string[]): ArgvTokenKind[] {
  if (surface === undefined || surface.program !== program) return argv.map(() => "operand");
  return readTokens(surface, argv).map((token) => token.kind);
}

/**
 * Reads one call's argv against `program`'s declared surface (D-037):
 *   - `--`, when declared, ends option parsing; every later element is an operand.
 *   - A token starting with `-` (other than `-` alone) is a flag. It must match a
 *     declared flag exactly: no clusters, no attached values, no abbreviations.
 *   - Any other token is a declared subcommand if one has that name, else an operand.
 *   - The first element whose declared position executes code is promoted
 *     together with every element after it.
 *   - Anything undeclared, anywhere in the argv, promotes every element.
 *   - So does a surface for a listed interpreter that declares no code-bearing
 *     position, because the list says it runs code (D-018).
 */
export function argvRoles(program: string, surface: FlagSurface | undefined, argv: readonly string[]): ArgvRoles {
  const all = (reason: PromotionReason, at: number | null): ArgvRoles => ({
    elements: argv.map((_element, index) => ({ index, role: "instruction", reason, at })),
    failClosed: true,
  });
  if (surface === undefined) return all("no_declared_surface", null);
  if (surface.program !== program) return all("surface_names_another_program", null);
  if (KNOWN_INTERPRETERS.has(programBaseName(program)) && !surface.positions.some((entry) => entry.executes_code)) {
    return all("known_interpreter_without_code_position", null);
  }

  let codeFrom: number | undefined;
  for (const [index, token] of readTokens(surface, argv).entries()) {
    if (token.executesCode === undefined) return all(token.kind === "flag" ? "uncovered_flag" : "uncovered_operand", index);
    // Keep reading after the first code-bearing element: an undeclared element anywhere still promotes all.
    if (token.executesCode && codeFrom === undefined) codeFrom = index;
  }

  return {
    elements: argv.map((_element, index) =>
      codeFrom !== undefined && index >= codeFrom
        ? { index, role: "instruction", reason: "code_bearing_position", at: codeFrom }
        : { index, role: "data" },
    ),
    failClosed: false,
  };
}
