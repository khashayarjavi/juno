import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Queue item 3 of the operator's instructions of 2026-11-25 (D-251), built as D-260: the repository is public, so every
// workflow is safe to run on a pull request from anyone, a fork included. This test reads every workflow and fails on:
// a `pull_request_target` trigger; any permission but `contents: read`, or one granted per job; a secret; a third-party
// action not pinned by its full commit SHA; a checkout that keeps the token; and a concurrency setting that could cancel
// a run on main or a manual run, or that is missing. It also pins the three verify jobs and their commands, so none can
// quietly stop running (CLAUDE.md §7: the CI workflow's checks are never loosened).

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DIR = join(ROOT, ".github", "workflows");
const workflows = (): { readonly name: string; readonly text: string }[] =>
  readdirSync(DIR)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => ({ name, text: readFileSync(join(DIR, name), "utf8") }));

/** Every rule, as a function of a workflow's text: the problems it finds. */
function problems(text: string): string[] {
  const found: string[] = [];
  const code = text
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .join("\n");
  if (/pull_request_target/.test(code)) found.push("pull_request_target");
  if (/\bsecrets\./.test(code) || /\$\{\{\s*secrets/.test(code)) found.push("a secret");
  // One top-level permissions block, exactly `contents: read`; none per job.
  const blocks = [...code.matchAll(/^([ \t]*)permissions:[ \t]*(.*)$/gm)];
  if (blocks.length !== 1 || blocks[0]?.[1] !== "" || (blocks[0]?.[2] ?? "").trim() !== "") found.push("permissions: one top-level block only");
  const top = /^permissions:\n((?:[ \t]+.*\n)+)/m.exec(code)?.[1] ?? "";
  if (top.trim().split("\n").map((line) => line.trim()).join(";") !== "contents: read") found.push("permissions: contents: read only");
  if (/\bwrite-all\b|:\s*write\b/.test(code)) found.push("a write permission");
  for (const [, action] of code.matchAll(/uses:\s*([^\s]+)/g)) {
    if (action === undefined || action.startsWith("./")) continue;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/.test(action)) found.push(`an action not pinned by full commit SHA: ${action}`);
  }
  const checkouts = [...code.matchAll(/uses:\s*actions\/checkout@[^\n]*\n((?:[ \t]+(?!- ).*\n)*)/g)];
  for (const [, body] of checkouts) if (!/persist-credentials:\s*false/.test(body ?? "")) found.push("a checkout that keeps the token");
  const concurrency = /^concurrency:\n((?:[ \t]+.*\n)+)/m.exec(code)?.[1] ?? "";
  if (!/group:.*github\.event_name == 'pull_request' && format\('pr-\{0\}', github\.event\.pull_request\.number\) \|\| github\.sha/.test(concurrency)) found.push("concurrency: one group per pull request, and one per commit otherwise");
  if (!/cancel-in-progress:\s*\$\{\{\s*github\.event_name == 'pull_request'\s*\}\}/.test(concurrency)) found.push("concurrency: cancel only a pull request's superseded run");
  return found;
}

describe("the workflows are safe for a public repository (D-251 queue item 3, D-260)", () => {
  // proves D-260: no workflow can give a fork's code write access or a secret, every action is pinned, and only a pull
  // request's superseded run is cancelled
  it("finds no problem in any workflow", () => {
    const all = workflows();
    expect(all.map(({ name }) => name)).toEqual(["verify.yml"]);
    for (const { name, text } of all) expect(problems(text), name).toEqual([]);
  });

  // proves CLAUDE.md §7 (the CI workflow's checks are never loosened): the three jobs the merge gate reads still run
  // their full commands, on pull requests into main and on main
  it("keeps the three verify jobs and the commands the merge gate reads", () => {
    const text = readFileSync(join(DIR, "verify.yml"), "utf8");
    expect(text).toContain("on:\n  pull_request:\n    branches: [main]\n  push:\n    branches: [main]\n");
    for (const [job, command] of [
      ["verify", "run: make verify"],
      ["verify-rootless", 'run: sudo env JUNO_NODE_BIN="$(dirname "$(command -v node)")" bash scripts/rootless/run-verify.sh\n'],
      ["verify-rootless-operator", 'run: sudo env JUNO_NODE_BIN="$(dirname "$(command -v node)")" bash scripts/rootless/run-verify.sh --login-shell'],
    ] as const) {
      expect(text, job).toContain(`\n  ${job}:\n`);
      expect(text, job).toContain(command);
    }
    expect(text).not.toMatch(/continue-on-error|if:\s*false/);
  });

  // proves the scan itself: each rule catches what it forbids
  it("catches each unsafe form", () => {
    const safe = readFileSync(join(DIR, "verify.yml"), "utf8");
    const planted: readonly (readonly [string, string])[] = [
      ["pull_request_target", safe.replace("  pull_request:\n", "  pull_request_target:\n")],
      ["a secret", safe.replace("run: make verify", "run: make verify ${{ secrets.TOKEN }}")],
      ["a write permission", safe.replace("  contents: read\n", "  contents: write\n")],
      ["permissions: one top-level block only", safe.replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n")],
      ["an action not pinned by full commit SHA: actions/setup-node@v5", safe.replace(/actions\/setup-node@[0-9a-f]{40}/, "actions/setup-node@v5")],
      ["a checkout that keeps the token", safe.replace("          persist-credentials: false\n", "")],
      ["concurrency: cancel only a pull request's superseded run", safe.replace("cancel-in-progress: ${{ github.event_name == 'pull_request' }}", "cancel-in-progress: true")],
      ["concurrency: one group per pull request, and one per commit otherwise", safe.replace("|| github.sha }}", "|| github.ref }}")],
    ];
    for (const [rule, text] of planted) expect(problems(text), rule).toContain(rule);
  });
});
