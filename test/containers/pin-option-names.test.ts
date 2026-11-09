import { execFile } from "node:child_process";
import { openTestLayer } from "../../packages/enforcement/test/layer.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GrantStore, WorkloadPathResolver } from "../../packages/enforcement/src/index.js";
import { TEST_ANCHOR, signed } from "../../packages/enforcement/test/test-keys.js";
import { readPayload, readTrajectory } from "../../packages/journal/src/index.js";
import { CapabilityRegistry, WorkloadExecFileAdapter } from "../../packages/registry/src/index.js";
import { SCRIPTED_PROFILE_FILE, loadProviderProfile } from "../../packages/runner/src/profile.js";
import { ScriptedProvider } from "../../packages/runner/src/provider.js";
import { Runner, type RunOutcome } from "../../packages/runner/src/runner.js";

// D-112 hardening (operator ruling D-120): file names found in the verification scope reach the real ls, sha256sum
// and resolver in the workload only after a `--`. Files named `-c` and `--help` are planted in the scope; the pins
// must still be computed, so a task that leaves them unchanged closes verified. Every Docker call is execFile with
// an argv array.

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const composeFile = fileURLToPath(new URL("../../containers/docker-compose.yml", import.meta.url));
const definitionFile = fileURLToPath(new URL("../../packages/registry/definitions/shell.run.json", import.meta.url));
const project = "juno-verify-pin-options";
const compose = ["compose", "-f", composeFile, "-p", project];
const CAT = "/usr/bin/cat";
const PRINCIPAL = "alireza";
const PLANTED = ["/work/project/-c", "/work/project/--help", "/work/project/protected/-c", "/work/project/protected/--help"];

async function docker(args: readonly string[]): Promise<string> {
  const { stdout } = await run("docker", args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

const hostDir = mkdtempSync(join(tmpdir(), "juno-pin-options-"));
const journalRoot = join(hostDir, "journal");
let outcome: RunOutcome;
let runner: Runner;

const payloads = (kind: string): Record<string, unknown>[] =>
  readTrajectory(journalRoot, "task-options")
    .filter((entry) => entry.kind === kind)
    .map((entry) => {
      const blob = readPayload(journalRoot, entry.payload_ref);
      return blob.status === "present" ? (JSON.parse(new TextDecoder().decode(blob.bytes)) as Record<string, unknown>) : {};
    });

beforeAll(async () => {
  await docker([...compose, "down", "--volumes", "--remove-orphans"]);
  const files = { "/work/project/notes.txt": "hello\n", "/work/project/done.txt": "ok\n", "/work/project/protected/keep.txt": "keep\n", ...Object.fromEntries(PLANTED.map((path) => [path, `planted ${path}\n`])) };
  const setup = `const fs = require("node:fs"); fs.mkdirSync("/work/project/protected", { recursive: true }); for (const [p, c] of Object.entries(${JSON.stringify(files)})) fs.writeFileSync(p, c);`;
  await docker([...compose, "run", "--rm", "--no-deps", "-T", "workload", "-e", setup]);

  const T0 = new Date();
  const registry = new CapabilityRegistry();
  const registered = registry.register(JSON.parse(readFileSync(definitionFile, "utf8")), [new WorkloadExecFileAdapter({ composeFile, project, service: "workload" })]);
  if (!registered.registered) throw new Error(`shell.run did not register: ${JSON.stringify(registered.refusals)}`);
  const grants = new GrantStore(TEST_ANCHOR);
  grants.add(signed({
    id: "grant-1",
    principal: PRINCIPAL,
    capability_selector: { capabilities: ["shell.run"] },
    resource_scope: [{ kind: "path", prefix: "/work/project" }],
    data_class_bounds: { max_sensitivity: "internal", min_integrity: "untrusted" },
    issuance: "preissued",
    issued_by: PRINCIPAL,
    issued_at: new Date(T0.getTime() - 60_000).toISOString(),
    expires_at: new Date(T0.getTime() + 3_600_000).toISOString(),
    max_invocations: 10,
    attenuation_parent: null,
    revoked_at: null,
  }));
  const profile = loadProviderProfile(SCRIPTED_PROFILE_FILE);
  const usage = { tokens_in: 10, tokens_out: 5, tokens_cached: 0 };
  const provider = new ScriptedProvider(profile, [{ model: profile.model, model_version: profile.model_version, text: "done", tool_calls: [], usage }]);
  runner = new Runner({
    layer: openTestLayer("runner", { journal: journalRoot, workspaces: [] }),
    registry,
    grants,
    providers: [provider],
    sources: [{ id: "project", selector: { kind: "path", prefix: "/work/project" }, data_class: { sensitivity: "internal", integrity: "untrusted" } }],
    resolver: new WorkloadPathResolver({ composeFile, project, service: "workload" }),
  });
  const admission = runner.admit({
    id: "task-options",
    principal: PRINCIPAL,
    objective: "leave the work unchanged",
    criterion: { author: "operator", statement: { command: { capability: "shell.run", arguments: { program: CAT, argv: ["done.txt"], cwd: "/work/project" } }, expect_exit_code: 0, protected_paths: ["/work/project/protected"] } },
    verification: "command_exit",
    attendance: "autonomous",
    strategy: "direct",
    sources: ["project"],
    sensitivity_floor: "internal",
    model_policy: { permitted_providers: [profile.id], posture: profile.posture, conversation_state: "any" },
    budget: { tokens: 10_000, currency: 1, wall_clock_ms: 600_000, turns: 10 },
    ttl: 3_600_000,
    grants: ["grant-1"],
    parent: null,
    constants: {},
  });
  if (!admission.admitted) throw new Error(`not admitted: ${JSON.stringify(admission.failures)}`);
  outcome = await runner.run("task-options");
});

afterAll(async () => {
  runner.close();
  await docker([...compose, "down", "--volumes", "--remove-orphans"]);
  rmSync(hostDir, { recursive: true, force: true });
});

describe("files named like options in the verification scope (D-112 hardening, D-120)", () => {
  // proves §3.4.4 B2 with D-120: files named -c and --help are pinned by hash, and the unchanged scope closes verified
  it("computes a hash for every planted file and closes verified", () => {
    expect(outcome).toEqual({ task_id: "task-options", state: "verified", reason: "verification_pass" });
    const baseline = payloads("note").find((note) => note["type"] === "verification_pins" && note["phase"] === "baseline");
    const pins = baseline?.["pins"] as Record<string, { type: string; sha256: string | null }>;
    for (const path of PLANTED) expect(pins[path], path).toMatchObject({ type: "file", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(payloads("note").filter((note) => note["type"] === "verification").at(-1)).toMatchObject({ result: "pass", inputs: "unchanged", protected_paths: "unchanged", changed_paths: [] });
  });

  // proves D-120: in every listing and hashing call the verifier made, each file name follows a `--`
  it("passes every file name after a --", () => {
    const calls = payloads("capability_call").map((call) => {
      const args = call["arguments"] as { argument: string; value: unknown }[];
      return { program: args.find((arg) => arg.argument === "program")?.value, argv: args.filter((arg) => arg.argument.startsWith("argv")).map((arg) => String(arg.value)) };
    });
    const verifierCalls = calls.filter((call) => call.program === "/usr/bin/sha256sum" || call.program === "/usr/bin/ls");
    expect(verifierCalls.length).toBeGreaterThanOrEqual(4);
    for (const call of verifierCalls) {
      const dashes = call.argv.indexOf("--");
      expect(dashes, JSON.stringify(call)).toBeGreaterThanOrEqual(0);
      const names = call.argv.filter((value) => value.startsWith("/work/"));
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(call.argv.indexOf(name)).toBeGreaterThan(dashes);
    }
    const hashed = calls.filter((call) => call.program === "/usr/bin/sha256sum").flatMap((call) => call.argv);
    for (const path of PLANTED) expect(hashed).toContain(path);
  });
});
