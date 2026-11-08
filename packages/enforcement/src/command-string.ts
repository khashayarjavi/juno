/**
 * Reading a shell command string in mediated modes (spec §2.3.2, v0.6 E1 and v0.6.1 V6-5; DECISIONS.md D-105, D-140).
 *
 * The string is split into words **without a shell**:
 *   - words are separated by spaces or tabs;
 *   - a single-quoted word is literal (no expansion inside);
 *   - a double-quoted word may contain none of `$`, `` ` ``, `\`, `!`.
 * Shell syntax parks `integrity_floor`: outside single quotes any of `|` `&` `;` `<` `>` `(` `)` `$` `` ` `` `\` `{`
 * `}` or a newline; an unquoted `*` `?` `[` `]`; a leading `~`; a leading `NAME=value` assignment; a word that is a
 * shell keyword or builtin, in any position; and (D-105) a `#` anywhere outside single quotes. `!` outside quotes parks
 * too (D-140: it is the shell's negation keyword and history character).
 *
 * The first word is the program. It maps to an absolute program path **only through the operator-authored name map**;
 * `PATH` is never consulted. A name not in the map parks. The remaining words are the argv, as data.
 *
 * A pure function: it reads nothing, runs nothing.
 */

/** Shell keywords and bash builtins (bash 5 `help` list and its reserved words). Any word equal to one parks (D-140). */
export const SHELL_WORDS: ReadonlySet<string> = new Set([
  // reserved words
  "!", "[[", "]]", "{", "}", "case", "coproc", "do", "done", "elif", "else", "esac", "fi", "for", "function", "if", "in", "select", "then", "time", "until", "while",
  // builtins
  ".", ":", "[", "alias", "bg", "bind", "break", "builtin", "caller", "cd", "command", "compgen", "complete", "compopt", "continue", "declare", "dirs", "disown",
  "echo", "enable", "eval", "exec", "exit", "export", "false", "fc", "fg", "getopts", "hash", "help", "history", "jobs", "kill", "let", "local", "logout", "mapfile",
  "popd", "printf", "pushd", "pwd", "read", "readarray", "readonly", "return", "set", "shift", "shopt", "source", "suspend", "test", "times", "trap", "true", "type",
  "typeset", "ulimit", "umask", "unalias", "unset", "wait",
]);

/** Outside single quotes these are shell syntax wherever they appear (§2.3.2; `#` by D-105). */
const SYNTAX_OUTSIDE_SINGLE = new Set(["|", "&", ";", "<", ">", "(", ")", "$", "`", "\\", "{", "}", "\n", "\r", "#"]);
/** Unquoted, these are globs (§2.3.2), and `!` is negation or history (D-140). */
const UNQUOTED_ONLY = new Set(["*", "?", "[", "]", "!"]);
/** Inside double quotes these expand or escape (§2.3.2). */
const NOT_IN_DOUBLE = new Set(["$", "`", "\\", "!"]);

export type CommandReading =
  | { readonly ok: true; readonly program: string; readonly name: string; readonly argv: readonly string[] }
  | { readonly ok: false; readonly reason: string };

type Word = { readonly value: string; readonly leadingUnquoted: string };

function split(text: string): { ok: true; words: Word[] } | { ok: false; reason: string } {
  const words: Word[] = [];
  let value = "";
  let leading = "";
  let started = false;
  let quotedYet = false;
  const finish = (): void => {
    if (started) words.push({ value, leadingUnquoted: leading });
    value = "";
    leading = "";
    started = false;
    quotedYet = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (char === " " || char === "\t") {
      finish();
      continue;
    }
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      if (end === -1) return { ok: false, reason: "an unterminated single quote" };
      value += text.slice(index + 1, end);
      started = true;
      quotedYet = true;
      index = end;
      continue;
    }
    if (char === '"') {
      const end = text.indexOf('"', index + 1);
      if (end === -1) return { ok: false, reason: "an unterminated double quote" };
      const inside = text.slice(index + 1, end);
      for (const c of inside) {
        if (NOT_IN_DOUBLE.has(c) || SYNTAX_OUTSIDE_SINGLE.has(c)) return { ok: false, reason: `shell syntax ${JSON.stringify(c)} inside double quotes` };
      }
      value += inside;
      started = true;
      quotedYet = true;
      index = end;
      continue;
    }
    if (SYNTAX_OUTSIDE_SINGLE.has(char)) return { ok: false, reason: `shell syntax ${JSON.stringify(char)}` };
    if (UNQUOTED_ONLY.has(char)) return { ok: false, reason: `an unquoted ${JSON.stringify(char)}` };
    if (char === "~" && !started) return { ok: false, reason: "a leading ~" };
    if (!quotedYet) leading += char;
    value += char;
    started = true;
  }
  finish();
  return { ok: true, words };
}

/** Reads `text` against the operator's name map (name → absolute program path). */
export function readCommandString(text: string, nameMap: ReadonlyMap<string, string>): CommandReading {
  const split_ = split(text);
  if (!split_.ok) return split_;
  const { words } = split_;
  const [first, ...rest] = words;
  if (first === undefined) return { ok: false, reason: "no program" };
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first.leadingUnquoted)) return { ok: false, reason: "a leading NAME=value assignment" };
  for (const word of words) if (SHELL_WORDS.has(word.value)) return { ok: false, reason: `the shell keyword or builtin ${JSON.stringify(word.value)}` };
  const program = nameMap.get(first.value);
  if (program === undefined) return { ok: false, reason: `${JSON.stringify(first.value)} is not in the operator's name map` };
  return { ok: true, program, name: first.value, argv: rest.map((word) => word.value) };
}
