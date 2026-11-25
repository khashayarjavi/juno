import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Operator ruling D-247 item 1: every refusal or remedy that names a file, folder or command builds that name through
// one shared helper (packages/journal/src/operator-names.ts), never from a literal or a descriptor path. This test reads
// every source file and fails on any literal outside the helper that names the hook service's unit, a program a remedy
// runs (systemctl, pgrep, sudo, rm), an installed path (/opt/juno, /opt/node22), the lock or take-over file, the journal
// key's public file, a descriptor path, or a `juno <command> <subcommand> --…` command line. The few places that hold
// such a literal for another reason are listed below, each with that reason; every other one fails this test.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HELPER = "packages/journal/src/operator-names.ts";

const FORBIDDEN: readonly { readonly what: string; readonly pattern: RegExp }[] = [
  { what: "the hook service's unit", pattern: /juno-hook\.service/ },
  { what: "a systemctl or journalctl command", pattern: /\b(?:systemctl|journalctl)\b/ },
  { what: "a pgrep command", pattern: /\bpgrep\b/ },
  { what: "a sudo command", pattern: /\bsudo\s+-/ },
  { what: "an rm command", pattern: /(?:^|[`'"(:]\s*)rm\s+(?:-|\/|\$\{)/ },
  { what: "an installed path", pattern: /\/opt\/(?:juno|node\d*)\b/ },
  { what: "the lock or take-over file", pattern: /runner\.lock/ },
  { what: "the journal key's public file", pattern: /journal-key\.pub\.pem/ },
  { what: "a descriptor path", pattern: /\/proc\/(?:self|thread-self|\d+)\/fd|\/dev\/fd\// },
  { what: "a juno command line", pattern: /\bjuno (?:hook|checkpoint|journal|gateway|grant|runtime) [a-z]+ --[a-z]/ },
  // Review round 4 of PR #66 (D-249): a remedy's program as one word of an argument vector, too.
  { what: "a remedy's program as an argument", pattern: /["'`](?:sudo|chmod|chown|rm|pgrep|systemctl|journalctl|setfacl)["'`]/ },
];

/** Literals that name such a thing for another reason than a message: file, the text the line holds, and why. */
const ALLOWED: readonly { readonly file: string; readonly holds: string; readonly why: string }[] = [
  { file: "packages/contracts/src/interpreter.ts", holds: '"sudo",', why: "a program the interpreter table knows runs other programs (§2.3.1); not a remedy" },
  { file: "packages/journal/src/sinks.ts", holds: 'export const JOURNAL_KEY_PUBLIC_FILE = "journal-key.pub.pem";', why: "the file the journal key is written to; messages name it through this constant" },
  { file: "packages/journal/src/handle.ts", holds: "return `/proc/self/fd/${String(fd)}/${name}`;", why: "opens a name inside a held folder (D-213); never a message" },
  { file: "packages/journal/src/handle.ts", holds: 'const via = parseAtBoundary("journal handle", AbsolutePath, `/proc/self/fd/${String(fd)}`);', why: "the handle the journal is held by (D-213); messages name the journal's path, and operatorText names any handle by its folder" },
  { file: "packages/enforcement/src/host-restore.ts", holds: "const at = (fd: number, name: string): string => `/proc/self/fd/${String(fd)}/${name}`;", why: "opens a name inside a held folder (D-228); never a message" },
  { file: "packages/enforcement/src/host-restore.ts", holds: "const names = readdirSync(`/proc/self/fd/${String(dirFd)}`)", why: "lists a held folder (D-228); never a message" },
  { file: "packages/registry/src/fs-write.ts", holds: 'const at = "/proc/self/fd/" + dir + "/" + part; let next;', why: "the sealed write program opens inside a held folder (D-228); never a message" },
  { file: "packages/registry/src/fs-write.ts", holds: 'try { fd = fs.openSync("/proc/self/fd/" + dir + "/" + name,', why: "the sealed write program opens inside a held folder (D-228); never a message" },
  { file: "packages/runner/src/journal-cli.ts", holds: "--key <journal-key.pub.pem> [--no-history] <task id>", why: "usage syntax: the key file's kind, as a placeholder, not a file named" },
  { file: "packages/enforcement/src/workspace-copy.mjs", holds: "const at = (fd, name) => (typeof name === \"string\" ? `/proc/self/fd/${String(fd)}/${name}`", why: "the sealed program opens inside a held folder (D-228); its messages name entries from the workspace root" },
  { file: "packages/enforcement/src/workspace-copy.mjs", holds: "const self = (fd) => `/proc/self/fd/${String(fd)}`;", why: "the sealed program reads a held folder (D-228); never a message" },
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name === "test" ? [] : sources(path);
    return /\.(?:ts|mjs|js)$/.test(name) && path.includes(`${"/"}src${"/"}`) ? [path] : [];
  });
}

/** Each line of `text` with its comments blanked: a `//` comment, and every line inside a block comment. */
function code(text: string): string[] {
  let inBlock = false;
  return text.split("\n").map((line) => {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes("*/")) inBlock = false;
      return "";
    }
    if (trimmed.startsWith("/*")) {
      inBlock = !trimmed.includes("*/");
      return "";
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return "";
    // A trailing `// …` comment (never inside a URL or a pattern, which this source does not place after code).
    const at = line.indexOf(" // ");
    return at >= 0 ? line.slice(0, at) : line;
  });
}

describe("every name a message gives is built by the one shared helper (D-247)", () => {
  // proves D-247 item 1: no literal names the unit, a remedy's program, an installed path, the lock, the key or a
  // descriptor path outside the helper, except where listed with its reason
  it("finds no such literal outside the helper", () => {
    const found: string[] = [];
    const used = new Set<number>();
    for (const path of sources(join(ROOT, "packages"))) {
      const file = relative(ROOT, path);
      if (file === HELPER) continue;
      code(readFileSync(path, "utf8")).forEach((line, index) => {
        for (const { what, pattern } of FORBIDDEN) {
          if (!pattern.test(line)) continue;
          const allowed = ALLOWED.findIndex((entry) => entry.file === file && line.includes(entry.holds));
          if (allowed >= 0) used.add(allowed);
          else found.push(`${file}:${String(index + 1)}: ${what}: ${line.trim()}`);
        }
      });
    }
    expect(found).toEqual([]);
    // Every allowance is still needed: none outlives the line it names.
    expect(ALLOWED.filter((_, index) => !used.has(index))).toEqual([]);
  });

  // proves the scan itself: it catches each kind of literal this rule forbids (D-247)
  it("catches every kind of forbidden literal", () => {
    const samples = [
      "`stop it (systemctl --user stop juno-hook.service)`",
      "`as juno-runner, pgrep -af 'juno' prints nothing`",
      '"run it as juno-runner (sudo -iu juno-runner)"',
      "`remove it: rm ${shown}`",
      '"node /opt/juno/dist/runner/src/juno.js journal check"',
      "`${dir}/runner.lock.takeover`",
      "`${keys}/journal-key.pub.pem`",
      "`/proc/self/fd/${String(fd)}/runner`",
      "`admit a session with: juno hook admit --control ${control}`",
      'commandText(["sudo", "-u", owner, ...chmod])',
      'const chmod = ["chmod", "u-s,g-s,o-t", host];',
    ];
    for (const sample of samples) expect(FORBIDDEN.some(({ pattern }) => pattern.test(sample)), sample).toBe(true);
    expect(FORBIDDEN.some(({ pattern }) => pattern.test('import { rmSync } from "node:fs";'))).toBe(false);
  });
});

// Operator ruling D-251: no refusal or advice text prints a runnable command holding a value derived from a workspace or
// from anything the Claude Code user can name (file names, owners, paths inside /srv/juno-work). The class is closed in
// the structure: the helper has no builder that takes a workspace entry (D-251 removed `asUserCommand` and
// `removeBitsCommand`), and every place in the sources that builds a command for the operator is listed here, with where
// each of its values comes from. A new place, or a changed one, fails this test until it is listed with its provenance;
// none may take its values from a workspace. packages/mediated/test/hostile-names.test.ts proves the property over every
// refusal a hostile workspace name can reach.
const BUILDS_A_COMMAND = /\b(?:commandText|removeIfNoJunoRuns|socketInUse)\(/;
// Review round 6 of PR #67: a command line can also be written straight into a text, a program followed by an option.
// Every such line in the sources is listed too, with where its values come from.
const WRITES_A_COMMAND = /\b(?:claude|dumpe2fs|chmod|chown|chattr|setfacl|getfacl|find|git|docker|sudo|rm|pgrep|systemctl|journalctl|lsattr|tune2fs|mkfs\.ext4|findmnt|node)\s+(?:-{1,2}[a-zA-Z]|\+[a-zA-Z])/;
const COMMAND_SITES: readonly { readonly file: string; readonly holds: string; readonly from: string }[] = [
  { file: "packages/enforcement/src/host-restore.ts", holds: 'commandText(junoCommand(["checkpoint", "restore"]))', from: "this copy's Node and juno.js, and fixed words" },
  { file: "packages/journal/src/lock.ts", holds: 'commandText(serviceCommand("stop"))', from: "the service unit's fixed name" },
  { file: "packages/journal/src/lock.ts", holds: "removeIfNoJunoRuns([shownTakeover, shown], owner)", from: "the journal folder the service was configured with (its lock and take-over file); the owner only in words" },
  { file: "packages/journal/src/lock.ts", holds: "removeIfNoJunoRuns([shown], owner)", from: "the journal folder the service was configured with (its lock); the owner only in words" },
  { file: "packages/runner/src/restore.ts", holds: 'Stop it first (${commandText(serviceCommand("stop"))})', from: "the service unit's fixed name" },
  { file: "packages/runner/src/restore.ts", holds: 'records that and checks the journal (${commandText(serviceCommand("start"))}', from: "the service unit's fixed name" },
  { file: "packages/runner/src/restore.ts", holds: 'then ${commandText(serviceCommand("status"))}', from: "the service unit's fixed name" },
  { file: "packages/runner/src/restore.ts", holds: 'stop it again (${commandText(serviceCommand("stop"))})', from: "the service unit's fixed name" },
  { file: "packages/mediated/src/superblock.ts", holds: "commandText(asRootCommand(rerun))", from: "this very `juno hook check` command line, as the operator gave it (its configured paths), never a mount or name read from the workspace" },
  { file: "packages/mediated/src/hook-service.ts", holds: "socketInUse(path)", from: "the socket path the service was configured with; its owner only in words" },
  { file: "packages/mediated/src/install.ts", holds: 'commandText(asRootCommand(junoCommand(["hook", "check"])))', from: "this copy's Node and juno.js, and fixed words" },
  { file: "packages/mediated/src/hook-serve.ts", holds: 'commandText(junoCommand(["hook", "admit", "--control", control]), "<session file>")', from: "the control socket the service was configured with" },
  { file: "packages/mediated/src/hook-serve.ts", holds: 'commandText(junoCommand(["journal", "check", "--journal", check.journal, "--anchors", check.anchors, "--key", check.key, parsed.data.task_id]))', from: "the service's configured journal, anchors and key, and the session id (letters, digits and hyphens only, checked at admission) from the operator's session file" },
  { file: "packages/mediated/src/superblock.ts", holds: "(dumpe2fs -h ${node} must not list casefold)", from: "the block device the kernel names for the mount, checked against DEVICE_NAME" },
  { file: "packages/mediated/src/filesystem.ts", holds: "has the case-folding attribute (chattr +F)", from: "fixed words naming the attribute; the folder is shown as a name and is not part of it" },
  { file: "packages/mediated/src/install.ts", holds: "refusals.push(`claude --version did not run:", from: "fixed words: the program JUNO ran; Node's error follows as prose" },
  { file: "packages/mediated/src/hook-serve.ts", holds: "Start Claude Code for it with: claude --session-id ${sessionId}", from: "the session id from the operator's session file, letters, digits and hyphens only (checked at admission)" },
];

describe("no command a message gives holds a value from a workspace (operator ruling D-251)", () => {
  // proves D-251: every place that builds a command for the operator is one listed with its provenance, none from a
  // workspace; and no listed place outlives its line
  it("finds every command built for the operator at a listed place", () => {
    const found: string[] = [];
    const used = new Set<number>();
    for (const path of sources(join(ROOT, "packages"))) {
      const file = relative(ROOT, path);
      if (file === HELPER) continue;
      code(readFileSync(path, "utf8")).forEach((line, index) => {
        if (!BUILDS_A_COMMAND.test(line) && !WRITES_A_COMMAND.test(line)) return;
        let rest = line;
        for (const [at, site] of COMMAND_SITES.entries()) {
          if (site.file === file && rest.includes(site.holds)) {
            used.add(at);
            rest = rest.replace(site.holds, "");
          }
        }
        if (BUILDS_A_COMMAND.test(rest) || WRITES_A_COMMAND.test(rest)) found.push(`${file}:${String(index + 1)}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
    expect(COMMAND_SITES.filter((_, index) => !used.has(index))).toEqual([]);
  });

  // proves D-251's structure: the helper exports no builder that turns a path or an owner into a command run as that owner
  it("keeps no builder of a command from a workspace entry in the helper", () => {
    const helper = readFileSync(join(ROOT, HELPER), "utf8");
    for (const gone of ["asUserCommand", "removeBitsCommand", "knownUserName", '"-u"']) expect(helper, gone).not.toContain(gone);
  });

  // proves the scan itself: a new command built anywhere else is caught
  it("catches a command built at an unlisted place", () => {
    for (const sample of ["`remove it: ${commandText(removeCommand([entry]))}`", "socketInUse(join(workspace, name))", "removeIfNoJunoRuns([host], owner)"]) expect(BUILDS_A_COMMAND.test(sample), sample).toBe(true);
    for (const sample of ["`run: chmod -R u-s ${entry}`", "`fix it with chattr -F ${folder}`", "`then: sudo -u ${owner} rm -rf ${kept}`", "`claude --session-id ${id}`"]) expect(WRITES_A_COMMAND.test(sample), sample).toBe(true);
  });
});
