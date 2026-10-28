import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// These tests lint source text through the repository's real eslint.config.js,
// with a file path inside packages/, so they exercise the same configuration
// that `make lint` applies to product code.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const probePath = "packages/runner/src/lint-probe.ts";

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: repoRoot });
});

async function noShellMessages(code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: probePath });
  if (!result) throw new Error("ESLint returned no result");
  const fatal = result.messages.filter((message) => message.fatal === true);
  if (fatal.length > 0) throw new Error(`parse error: ${fatal.map((m) => m.message).join("; ")}`);
  return result.messages.filter((message) => message.ruleId === "juno/no-shell").map((message) => message.message);
}

describe("juno/no-shell", () => {
  // proves §2.4: the done-when probe; a deliberately added exec() call fails lint
  it("fails a deliberately added exec() call", async () => {
    const code = 'import { exec } from "node:child_process";\nexec("ls -la");\n';
    expect(await noShellMessages(code)).toHaveLength(1);
  });

  // proves §2.4 and CLAUDE.md rule 8: the rule cannot be switched off with an inline comment
  it("ignores inline disable comments", async () => {
    const fixture = await readFile(new URL("fixtures/exec-probe.ts.txt", import.meta.url), "utf8");
    expect(await noShellMessages(fixture)).toHaveLength(1);
  });

  // proves §2.4: every route to a shell-parsing launcher is closed
  it.each([
    ["execSync", 'import { execSync } from "child_process";\nexecSync("ls");\n'],
    ["renamed exec", 'import { exec as run } from "node:child_process";\nrun("ls");\n'],
    ["spawn", 'import { spawn } from "node:child_process";\nspawn("ls", []);\n'],
    ["namespace import", 'import * as cp from "node:child_process";\ncp.execFile("ls", []);\n'],
    ["default import", 'import cp from "node:child_process";\ncp.execFile("ls", []);\n'],
    ["require", 'const cp = require("child_process");\ncp.exec("ls");\n'],
    ["dynamic import", 'const cp = await import("node:child_process");\ncp.exec("ls");\n'],
    ["re-export", 'export { exec } from "node:child_process";\n'],
    ["export all", 'export * from "node:child_process";\n'],
  ])("bans %s", async (_label, code) => {
    expect((await noShellMessages(code)).length).toBeGreaterThan(0);
  });

  // proves §2.4: a shell option is banned unless it is the literal false
  it.each([
    ["shell: true", 'import { execFile } from "node:child_process";\nexecFile("ls", [], { shell: true });\n'],
    ["shell path", 'const options = { shell: "/bin/sh" };\nexport { options };\n'],
    ["shell variable", 'declare const s: boolean;\nconst options = { shell: s };\nexport { options };\n'],
    ["shell assignment", 'const options: { shell?: boolean } = {};\noptions.shell = true;\nexport { options };\n'],
  ])("bans %s", async (_label, code) => {
    expect((await noShellMessages(code)).length).toBeGreaterThan(0);
  });

  // proves §2.4: no command or argv element is built by interpolation or concatenation
  it.each([
    ["template program", 'import { execFile } from "node:child_process";\ndeclare const p: string;\nexecFile(`/usr/bin/${p}`, []);\n'],
    ["concatenated program", 'import { execFile } from "node:child_process";\ndeclare const p: string;\nexecFile("/usr/bin/" + p, []);\n'],
    ["template argv element", 'import { execFile } from "node:child_process";\ndeclare const f: string;\nexecFile("ls", [`--file=${f}`]);\n'],
    ["concatenated argv element", 'import { execFile } from "node:child_process";\ndeclare const f: string;\nexecFile("ls", ["--file=" + f]);\n'],
    [
      "promisified launcher",
      'import { execFile } from "node:child_process";\nimport { promisify } from "node:util";\nconst run = promisify(execFile);\ndeclare const f: string;\nawait run(`ls ${f}`, []);\n',
    ],
  ])("bans %s", async (_label, code) => {
    expect((await noShellMessages(code)).length).toBeGreaterThan(0);
  });

  // proves §2.4: the structural channel stays usable; execFile(program, argv[]) passes
  it.each([
    ["execFile with argv array", 'import { execFile } from "node:child_process";\ndeclare const f: string;\nexecFile("ls", ["-l", f], { shell: false });\n'],
    ["type-only import", 'import type { ExecFileOptions } from "node:child_process";\nexport type O = ExecFileOptions;\n'],
    ["template literal without substitutions", 'import { execFile } from "node:child_process";\nexecFile(`ls`, []);\n'],
  ])("allows %s", async (_label, code) => {
    expect(await noShellMessages(code)).toEqual([]);
  });

  // proves §2.4 and CLAUDE.md rule 8: the rule is on, at error level, for product and test code
  it.each(["packages/runner/src/main.ts", "packages/contracts/test/boundary.test.ts", "tools/eslint-plugin-juno/index.js"])(
    "is enabled at error level for %s",
    async (file) => {
      const config = (await eslint.calculateConfigForFile(file)) as {
        rules?: Record<string, unknown>;
        linterOptions?: { noInlineConfig?: boolean };
      };
      const setting = config.rules?.["juno/no-shell"];
      const severity = Array.isArray(setting) ? setting[0] : setting;
      expect([2, "error"]).toContain(severity);
      expect(config.linterOptions?.noInlineConfig).toBe(true);
    },
  );
});
