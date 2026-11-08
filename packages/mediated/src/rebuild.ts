import { readCommandString } from "../../enforcement/src/index.js";

/**
 * What runs is what was judged (operator ruling of 2026-11-07, DECISIONS.md D-152, D-153).
 *
 * When JUNO allows a Bash call in mode C, the hook answers `allow` with `updatedInput`, and the command Claude Code runs
 * is rebuilt here from what JUNO judged: the name map's absolute program path, then each argument single-quoted. This is
 * a string built for another program's shell (Claude Code's Bash tool). JUNO never runs it, so it is not an `execFile`
 * call and the `juno/no-shell` lint rule needs no exemption.
 *
 * A `'` inside an argument is written `'"'"'` (close the quote, a double-quoted `'`, reopen), not `'\''`: §2.3.2 makes
 * JUNO's strict reader park on a `\` outside single quotes, so only the `'"'"'` form reads back to the same argument
 * (D-153, autopilot ruling). Both are the same word to the shell.
 *
 * Before the string is handed out it is read back by the strict reader (`readCommandString`, §2.3.2) and must give
 * exactly the judged program and argv; otherwise there is no rebuilt command and the call is denied.
 */

/** An absolute program path the rebuilt command may start with: plain path characters only, so it needs no quoting. */
const PROGRAM_PATH = /^\/[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/;

/** One argument as a single shell word: single-quoted, with each `'` written as `'"'"'`. */
export function quoteArgument(argument: string): string {
  return ["'", argument.split("'").join(`'"'"'`), "'"].join("");
}

/** Reads a rebuilt command with the strict reader, whose name map holds the program's absolute path only. */
export function readRebuiltCommand(text: string, program: string): ReturnType<typeof readCommandString> {
  return readCommandString(text, new Map([[program, program]]));
}

/**
 * The command Claude Code is told to run for a judged program and argv, or null when it cannot be written so that the
 * strict reader gives back exactly that program and argv (then the call is denied).
 */
export function rebuildBashCommand(program: string, argv: readonly string[]): string | null {
  if (!PROGRAM_PATH.test(program) || program.split("/").includes("..")) return null;
  // execve cannot pass a NUL inside an argument, so such an argument can never run as judged.
  if (argv.some((argument) => argument.includes("\0"))) return null;
  const command = [program, ...argv.map(quoteArgument)].join(" ");
  const back = readRebuiltCommand(command, program);
  if (!back.ok || back.program !== program || back.argv.length !== argv.length || back.argv.some((argument, index) => argument !== argv[index])) return null;
  return command;
}
