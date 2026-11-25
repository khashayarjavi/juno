import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { basename, isAbsolute, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE one place that builds every name a refusal or a remedy gives the operator (operator ruling D-247 item 1): the
 * journal's lock and take-over file, a socket, the journal, a checkpoint store, the anchor pin, the hook service's unit,
 * and every command to run. Each is built from the value the code itself uses, never from a literal and never from a
 * descriptor path:
 *   - a path is the one the code opened (the journal as given, a socket as judged); a path under one of this process's
 *     descriptors (`/proc/self/fd/<n>/…`, how the services hold the journal, D-213) is named by the folder that very
 *     descriptor holds, as the kernel names it (`operatorPath`, and `operatorText` for any text, a Node error included);
 *   - a JUNO command is this copy's own Node (`process.execPath`) and this copy's own `juno.js`, found from where this
 *     module itself was loaded (the build puts both under one `dist`);
 *   - the user to run a command as is the owner of the file it acts on, by name from `/etc/passwd`;
 *   - the hook service's unit is `HOOK_SERVICE_UNIT`, the name the guide installs `docs/examples/juno-hook.service`
 *     under (a test pins the two together).
 * Commands are argument vectors; `commandText` writes one for the operator, quoted as a POSIX shell reads it, between
 * backticks. JUNO itself never runs these strings (CLAUDE.md §2 rule 8); a test runs every one as an argument vector.
 */

/** The journal's one-writer lock (D-025, D-064, D-069). */
export const LOCK_FILE = "runner.lock";
/** Held only while a stale lock is cleared, so two runners never clear one lock together (D-243). */
export const TAKEOVER_FILE = "runner.lock.takeover";
/** The hook service's systemd user unit, as the guide installs it (Part E step 11; `docs/examples/juno-hook.service`). */
export const HOOK_SERVICE_UNIT = "juno-hook.service";
/** The `juno` command's entry file and the Slice 1 runner's, under `dist`, as the build lays them out (tsconfig.build.json). */
const JUNO_ENTRY = new URL("../../runner/src/juno.js", import.meta.url);
const RUNNER_ENTRY = new URL("../../runner/src/main.js", import.meta.url);
/** The JUNO commands that hold a journal's lock (D-221, D-243): a test pins this list to the entry-point registry. */
export const LOCK_HOLDING_COMMANDS: readonly (readonly string[])[] = [["hook", "serve"], ["gateway", "serve"], ["checkpoint", "restore"]];

const DESCRIPTOR = /(?:\/proc\/(?:self|thread-self|\d+)\/fd|\/dev\/fd)\/(\d+)/g;

/** The folder a descriptor of this process holds, as the kernel names it; null when it holds none any more. */
function heldFolder(prefix: string, fd: string): string | null {
  const owner = /^\/proc\/(\d+)\//.exec(prefix)?.[1];
  const at = owner === undefined || Number(owner) === process.pid ? `/proc/self/fd/${fd}` : `/proc/${owner}/fd/${fd}`;
  try {
    const target = readlinkSync(at);
    return isAbsolute(target) && !target.endsWith(" (deleted)") ? target : null;
  } catch {
    return null;
  }
}

/**
 * Every descriptor path in `text` (`/proc/self/fd/<n>`, `/proc/<pid>/fd/<n>`, `/dev/fd/<n>`) replaced by the folder the
 * descriptor holds, so no refusal ever names a handle the operator cannot use (D-243, D-247). A descriptor this process
 * no longer holds is said so in words; it is never printed as a path.
 */
export function operatorText(text: string): string {
  return text.replace(DESCRIPTOR, (prefix: string, fd: string) => heldFolder(prefix, fd) ?? `(a folder JUNO held open as descriptor ${fd} and has closed)`);
}

/** A path as the operator can use it: absolute, normalised, and never a descriptor path (D-247). */
export function operatorPath(path: string): string {
  return operatorText(isAbsolute(path) ? posix.normalize(path) : path);
}

/** The journal's lock file, named from the journal folder the code opened. */
export function lockFileOf(journal: string): string {
  return join(operatorPath(journal), LOCK_FILE);
}

/** The take-over file beside the lock (D-243). */
export function takeoverFileOf(journal: string): string {
  return join(operatorPath(journal), TAKEOVER_FILE);
}

/** The name of the user `uid`, from `/etc/passwd`; `the user with uid <n>` when it has none. */
export function userName(uid: number): string {
  try {
    for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const [name, , id] = line.split(":");
      if (name !== undefined && name !== "" && id !== undefined && Number(id) === uid && /^\d+$/.test(id)) return name;
    }
  } catch {
    // Unreadable: named by its number below.
  }
  return `the user with uid ${String(uid)}`;
}

/** The owner of `path` (not following a final link), by name; null when it cannot be read. */
export function ownerName(path: string): string | null {
  try {
    return userName(lstatSync(path).uid);
  } catch {
    return null;
  }
}

/**
 * Characters a terminal may act on or that can make one text look like another, never printed as they are (review
 * round 4 of PR #66, D-249): every control character (C0 with tab and line breaks, DEL, C1), Unicode's format characters
 * (direction overrides and isolates, zero-width marks), line and paragraph separators, private-use and unassigned ones.
 */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/gu;
const escaped = (char: string): string => [...char].map((unit) => `\\u{${(unit.codePointAt(0) ?? 0).toString(16)}}`).join("");

/**
 * One line of a refusal or remedy as it is printed (D-249): every character a terminal may act on, escaped as `\u{…}`,
 * so no value in it can start a line, move the cursor or reorder what is shown. Applied by every printer, to each line.
 */
export function displayLine(text: string): string {
  return text.replace(UNPRINTABLE, escaped);
}

/**
 * A name that is not JUNO's to choose (a file or folder in a workspace, what a program printed about one) as a refusal
 * shows it (D-249): what `displayLine` escapes, and a backtick too, so no such name can look like a command JUNO gives.
 */
export function shownName(text: string): string {
  return displayLine(text).replace(/`/g, escaped);
}

/** What a command may hold, every word: printable ASCII, no backtick (D-249). Anything else gets no command. */
const COMMAND_WORD = /^[\x20-\x5f\x61-\x7e]+$/;

const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;
/** One argument as a POSIX shell reads it back unchanged. */
export function quoteArgument(argument: string): string {
  return PLAIN.test(argument) ? argument : `'${argument.replaceAll("'", "'\\''")}'`;
}

/**
 * A command for the operator, between backticks (D-247). A command any of whose words holds a character outside
 * printable ASCII, or a backtick, is not given at all (D-249): it is said in words instead, so a name no one chose for
 * the operator never appears inside, or as, a command.
 */
export function commandText(argv: readonly string[], placeholder?: string): string {
  const words = [...argv.map(quoteArgument), ...(placeholder === undefined ? [] : [placeholder])];
  if (words.length === 0 || !words.every((word) => COMMAND_WORD.test(word))) return "(no command is given here: a name in it holds characters JUNO does not print in a command)";
  return `\`${words.join(" ")}\``;
}

/** `argv` run as root, through `sudo` (D-249). Only ever for a command built from JUNO's own configured values (D-251). */
export function asRootCommand(argv: readonly string[]): readonly string[] {
  return ["sudo", ...argv];
}

/**
 * The guide a refusal points to when the fix would need a command naming something in a workspace (operator ruling
 * D-251): such a refusal says what is wrong in plain words, names the entry only as an escaped quotation, and points to
 * the guide's section holding the fixed command. A test pins each section's title to the guide's text.
 */
export const OPERATOR_GUIDE = "docs/operator-setup.md";
/** The guide's sections a refusal may point to, by the words of their bold title in "When something goes wrong". */
export const GUIDE_SECTIONS = {
  specialBits: "A refusal names a set-user-ID, set-group-ID or sticky bit in the workspace",
} as const;

/** Where in the guide the fixed command for `section` is: its title, in the guide's "When something goes wrong" part. */
export function guidePointer(section: keyof typeof GUIDE_SECTIONS): string {
  return `see the guide (${OPERATOR_GUIDE}), "When something goes wrong", the item "${GUIDE_SECTIONS[section]}", which holds the command to run; JUNO prints no command that names something in a workspace (D-251)`;
}

/** This copy of JUNO's `juno.js`. */
export function junoEntry(): string {
  return fileURLToPath(JUNO_ENTRY);
}

/** A `juno` command run with this copy's own Node and `juno.js` (never `juno` from a PATH, which the guide does not set). */
export function junoCommand(args: readonly string[]): readonly string[] {
  return [process.execPath, junoEntry(), ...args];
}

/** The hook service's unit, under the user's own systemd (as the runner; Part E step 11). */
export function serviceCommand(verb: "start" | "stop" | "status"): readonly string[] {
  return verb === "status" ? ["systemctl", "--user", "status", HOOK_SERVICE_UNIT, "--no-pager"] : ["systemctl", "--user", verb, HOOK_SERVICE_UNIT];
}

/** `.` as `[.]`, so the pattern matches the file name but never `pgrep`'s own command line, which holds the pattern. */
const literal = (text: string): string => text.replace(/[\\^$*+?()[\]{}|]/g, "\\$&").replaceAll(".", "[.]");

/**
 * Lists every JUNO process that can hold a journal's lock: `juno.js` running one of `LOCK_HOLDING_COMMANDS`, or the
 * Slice 1 runner. It prints nothing when none runs (exit 1).
 */
export function noJunoProcessCommand(): readonly string[] {
  const juno = literal(basename(junoEntry()));
  const runner = literal(fileURLToPath(RUNNER_ENTRY).split("/").slice(-3).join("/"));
  return ["pgrep", "-af", `${juno} (${LOCK_HOLDING_COMMANDS.map((words) => words.join(" ")).join("|")})|${runner}`];
}

/** Removes exactly these files. */
export function removeCommand(paths: readonly string[]): readonly string[] {
  return ["rm", ...paths.map(operatorPath)];
}

/**
 * The remedy for a file only a JUNO process that is no longer running could have left: check that none runs, then
 * remove exactly these files, as the user that owns them (D-243, D-247).
 */
export function removeIfNoJunoRuns(paths: readonly string[], owner: string | null): string {
  const as = owner === null ? "as the user that owns them" : `as ${owner}`;
  return `if no JUNO process runs on this machine (no service, no checkpoint restore, no runner: ${as}, ${commandText(noJunoProcessCommand())} prints nothing), remove ${paths.length === 1 ? "it" : "them"} ${as}: ${commandText(removeCommand(paths))}`;
}

/**
 * Why a service cannot listen on its socket `path` (`EADDRINUSE`): something is there that the start could not prove
 * left by a JUNO process that is no longer running (a live listener, or a file that is not a socket of this user, D-243).
 */
export function socketInUse(path: string): string {
  return `the socket ${operatorPath(path)} cannot be listened on (EADDRINUSE): something is already there (another process listening on it, or a file that is not a socket this service's user left); ${removeIfNoJunoRuns([path], ownerName(path))}`;
}

/** How a usage line names the `juno` command: this copy's own Node and juno.js, as the operator types them. */
export function junoProgramText(): string {
  return junoCommand([]).map(quoteArgument).join(" ");
}
