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
];

/** Literals that name such a thing for another reason than a message: file, the text the line holds, and why. */
const ALLOWED: readonly { readonly file: string; readonly holds: string; readonly why: string }[] = [
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
    ];
    for (const sample of samples) expect(FORBIDDEN.some(({ pattern }) => pattern.test(sample)), sample).toBe(true);
    expect(FORBIDDEN.some(({ pattern }) => pattern.test('import { rmSync } from "node:fs";'))).toBe(false);
  });
});
