import { execFile } from "node:child_process";
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  HOOK_SERVICE_UNIT,
  LOCK_HOLDING_COMMANDS,
  commandText,
  junoCommand,
  junoEntry,
  lockFileOf,
  noJunoProcessCommand,
  operatorPath,
  operatorText,
  quoteArgument,
  removeCommand,
  serviceCommand,
  takeoverFileOf,
  userName,
} from "../../journal/src/index.js";
import { ENTRY_POINTS } from "../src/entry-points.js";

// Operator ruling D-247 item 1: the one shared helper every refusal and remedy builds its names with. These tests pin
// what it builds from: the journal folder the code opened (a descriptor path named by the folder it holds), this copy's
// own Node and juno.js, the registry's lock-holding commands, and argument vectors a POSIX reader reads back unchanged.

const dir = mkdtempSync(join(tmpdir(), "juno-operator-names-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** How xargs (not JUNO, and no shell) reads a command's words back: its quoting is the POSIX shell's for these. */
const readBack = (text: string): Promise<string[]> => new Promise((resolve, reject) => {
  const child = execFile("xargs", ["printf", "%s\\0"], (error, stdout) => (error === null ? resolve(stdout.split("\0").slice(0, -1)) : reject(error)));
  child.stdin?.end(text);
});

describe("the names refusals and remedies give (D-247)", () => {
  // proves D-247 item 1: a descriptor path is never named; it is named by the folder the descriptor holds
  it("names a path under a held descriptor by the folder it holds, and a closed one in words", () => {
    const journal = join(dir, "journal");
    mkdirSync(journal);
    const fd = openSync(journal, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      expect(operatorPath(`/proc/self/fd/${String(fd)}/runner.lock`)).toBe(join(journal, "runner.lock"));
      expect(operatorPath(`/proc/${String(process.pid)}/fd/${String(fd)}`)).toBe(journal);
      expect(operatorPath(`/dev/fd/${String(fd)}/runner.lock.takeover`)).toBe(join(journal, "runner.lock.takeover"));
      expect(lockFileOf(`/proc/self/fd/${String(fd)}`)).toBe(join(journal, "runner.lock"));
      expect(takeoverFileOf(`/proc/self/fd/${String(fd)}`)).toBe(join(journal, "runner.lock.takeover"));
      expect(operatorText(`ENOENT: no such file or directory, open '/proc/self/fd/${String(fd)}/tasks/x'`)).toBe(`ENOENT: no such file or directory, open '${journal}/tasks/x'`);
    } finally {
      closeSync(fd);
    }
    const closed = operatorText(`the journal /proc/self/fd/${String(fd)} is held`);
    expect(closed).not.toMatch(/\/proc\/self\/fd/);
    expect(closed).toContain(`descriptor ${String(fd)}`);
  });

  // proves D-247 item 1: every command is an argument vector; its text reads back as exactly those words
  it("writes every command so that a POSIX reader reads back exactly its words", async () => {
    const odd = [join(dir, "a b"), "it's", "x|y", "$HOME", "`z`", "*"];
    for (const argv of [noJunoProcessCommand(), removeCommand(odd), junoCommand(["hook", "admit", "--control", join(dir, "admit sock")]), serviceCommand("status")]) {
      const text = commandText(argv);
      expect(text.startsWith("`") && text.endsWith("`")).toBe(true);
      expect(await readBack(text.slice(1, -1))).toEqual([...argv]);
    }
    expect(quoteArgument("/var/lib/juno-runner/journal/runner.lock")).toBe("/var/lib/juno-runner/journal/runner.lock");
  });

  // proves D-247 item 1: a JUNO command is this copy's own Node and juno.js, never a literal path or `juno` on a PATH
  it("builds a JUNO command from this process's Node and this copy's juno.js", () => {
    const [node, entry, ...rest] = junoCommand(["journal", "check"]);
    expect(node).toBe(process.execPath);
    expect(entry).toBe(junoEntry());
    expect(entry).toBe(join(process.cwd(), "packages", "runner", "src", "juno.js"));
    expect(rest).toEqual(["journal", "check"]);
  });

  // proves D-247 item 1: the pgrep the remedies give lists exactly the processes that can hold a journal's lock
  it("lists every lock-holding JUNO process, and never pgrep itself", async () => {
    const [program, flags, pattern] = noJunoProcessCommand();
    expect([program, flags]).toEqual(["pgrep", "-af"]);
    expect(pattern).toBe("juno[.]js (hook serve|gateway serve|checkpoint restore)|runner/src/main[.]js");
    const matches = new RegExp(pattern ?? "");
    for (const line of ["/opt/node22/bin/node /opt/juno/dist/runner/src/juno.js hook serve --socket x", "node /app/dist/runner/src/juno.js gateway serve --session y", "node juno.js checkpoint restore --journal j", "node /app/dist/runner/src/main.js"]) expect(matches.test(line), line).toBe(true);
    for (const line of ["node juno.js hook admit --control c", "node juno.js checkpoint list --journal j", "node juno.js journal check", `pgrep -af ${pattern ?? ""}`]) expect(matches.test(line), line).toBe(false);
    // The registry's lock holders: the commands that start a service, the command that writes the journal as the operator
    // (its restore), and the Slice 1 runner's program.
    const holders = ENTRY_POINTS.filter((entry) => entry.kind === "command" && (entry.service !== null || entry.operatorJournalWrite !== undefined)).map((entry) => (Array.isArray(entry.name) ? entry.name[0] : entry.name));
    expect(new Set(holders)).toEqual(new Set(LOCK_HOLDING_COMMANDS.map((words) => words[0])));
    expect(ENTRY_POINTS.find((entry) => entry.id === "runner.process")?.program).toBe("packages/runner/src/main.ts");
    expect(ENTRY_POINTS.find((entry) => entry.id === "juno")?.program).toBe("packages/runner/src/juno.ts");
    // Run exactly as given: no JUNO process runs in a unit test, so it prints nothing and says so by its exit code.
    const exit = await new Promise<{ code: number; out: string }>((resolve) => execFile(program ?? "", [flags ?? "", pattern ?? ""], (error, out) => resolve({ code: error === null ? 0 : Number(error.code), out })));
    expect(exit).toEqual({ code: 1, out: "" });
  });

  // proves D-247 item 1: the service commands name the unit the guide installs, under the user's own systemd
  it("names the hook service's unit as the guide installs it", () => {
    expect(HOOK_SERVICE_UNIT).toBe("juno-hook.service");
    expect(serviceCommand("stop")).toEqual(["systemctl", "--user", "stop", HOOK_SERVICE_UNIT]);
    expect(serviceCommand("start")).toEqual(["systemctl", "--user", "start", HOOK_SERVICE_UNIT]);
    expect(serviceCommand("status")).toEqual(["systemctl", "--user", "status", HOOK_SERVICE_UNIT, "--no-pager"]);
  });

  // proves D-247 item 1: the user named is a real user, by name
  it("names a user by its name, and a user with no name by its uid", () => {
    expect(userName(0)).toBe("root");
    expect(userName(4_000_000)).toBe("the user with uid 4000000");
  });
});
