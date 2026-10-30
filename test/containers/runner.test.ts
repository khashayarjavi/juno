import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { parseAtBoundary } from "../../packages/contracts/src/index.js";
import { GrantStore } from "../../packages/enforcement/src/index.js";
import { JournalWriter, readPayload, readTrajectory, verifyTrajectory } from "../../packages/journal/src/index.js";
import { blobFile, entriesFile, headFile } from "../../packages/journal/src/layout.js";
import { CapabilityRegistry, WorkloadExecFileAdapter } from "../../packages/registry/src/index.js";
import { parseRunnerConfig } from "../../packages/runner/src/config.js";
import { SCRIPTED_PROFILE_FILE, loadProviderProfile } from "../../packages/runner/src/profile.js";
import { ScriptedProvider } from "../../packages/runner/src/provider.js";
import { Runner, type RunOutcome } from "../../packages/runner/src/runner.js";

// Increment 5 with DECISIONS.md D-065: the runner runs on the host, starts
// each workload container through the docker CLI, and keeps the journal in a
// host directory that no container mounts. A task runs end to end against the
// real workload, and the workload then tries to reach the journal by the
// exact host paths the runner used. Every Docker call goes through execFile
// with an argv array; there is no shell.

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const composeFile = fileURLToPath(new URL("../../containers/docker-compose.yml", import.meta.url));
const definitionFile = fileURLToPath(new URL("../../packages/registry/definitions/shell.run.json", import.meta.url));
const project = "juno-verify-runner";
const compose = ["compose", "-f", composeFile, "-p", project];
const CAT = "/usr/bin/cat";
const PRINCIPAL = "alireza";

async function docker(args: readonly string[]): Promise<string> {
  const { stdout } = await run("docker", args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

// Runs in the workload. It tries to read and write the journal by the host paths
// the runner used, reports whether the Docker socket exists, then reads every file
// it can reach looking for the canary. A control marker it writes itself must be
// found, so the scan cannot pass by reading nothing.
const WORKLOAD_PROBE = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  "const [canary, control, root, entriesPath, headPath, blobPath] = process.argv.slice(1);",
  "const attempt = (action) => { try { action(); return null; } catch (error) { return error.code || String(error); } };",
  "const report = {",
  "  readEntries: attempt(() => fs.readFileSync(entriesPath)),",
  "  readHead: attempt(() => fs.readFileSync(headPath)),",
  "  readBlob: attempt(() => fs.readFileSync(blobPath)),",
  "  listRoot: attempt(() => fs.readdirSync(root)),",
  '  appendEntries: attempt(() => fs.appendFileSync(entriesPath, "forged\\n")),',
  '  replaceHead: attempt(() => fs.writeFileSync(headPath, "forged")),',
  '  dockerSocket: ["/var/run/docker.sock", "/run/docker.sock"].some((socket) => fs.existsSync(socket)),',
  "};",
  'fs.writeFileSync("/tmp/juno-scan-control", control);',
  "const needles = { canary: Buffer.from(canary), control: Buffer.from(control) };",
  "const found = { canary: [], control: [] };",
  "let files = 0;",
  'const skip = new Set(["/proc", "/sys", "/dev"]);',
  "const walk = (dir) => {",
  "  let names;",
  "  try { names = fs.readdirSync(dir); } catch { return; }",
  "  for (const name of names) {",
  "    const full = path.join(dir, name);",
  "    if (skip.has(full)) continue;",
  "    let stat;",
  "    try { stat = fs.lstatSync(full); } catch { continue; }",
  "    if (stat.isDirectory()) { walk(full); continue; }",
  "    if (!stat.isFile()) continue;",
  "    let data;",
  "    try { data = fs.readFileSync(full); } catch { continue; }",
  "    files += 1;",
  "    if (data.includes(needles.canary)) found.canary.push(full);",
  "    if (data.includes(needles.control)) found.control.push(full);",
  "  }",
  "};",
  'walk("/");',
  "process.stdout.write(JSON.stringify({ ...report, files, found }));",
].join("\n");

const WorkloadReport = z.object({
  readEntries: z.string().nullable(),
  readHead: z.string().nullable(),
  readBlob: z.string().nullable(),
  listRoot: z.string().nullable(),
  appendEntries: z.string().nullable(),
  replaceHead: z.string().nullable(),
  dockerSocket: z.boolean(),
  files: z.number(),
  found: z.object({ canary: z.array(z.string()), control: z.array(z.string()) }),
});

/** Every file under the journal root, with its bytes, so any change is visible. */
function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.set(full, readFileSync(full).toString("base64"));
    }
  };
  walk(root);
  return files;
}

const canary = `juno-canary-${randomBytes(16).toString("hex")}`;
const control = `juno-control-${randomBytes(16).toString("hex")}`;
const T0 = new Date();
const hostDir = mkdtempSync(join(tmpdir(), "juno-host-journal-"));
const journalRoot = join(hostDir, "journal");
let outcome: RunOutcome;
let before: Map<string, string>;
let probe: z.output<typeof WorkloadReport>;
let runner: Runner;

beforeAll(async () => {
  await docker([...compose, "down", "--volumes", "--remove-orphans"]);
  // The operator's work content, written as the workload user, outside the capability under test.
  const setup = 'const fs = require("node:fs"); fs.mkdirSync("/work/project"); fs.writeFileSync("/work/project/notes.txt", "hello\\n"); fs.writeFileSync("/work/project/done.txt", "ok\\n");';
  await docker([...compose, "run", "--rm", "--no-deps", "-T", "workload", "-e", setup]);

  const config = parseRunnerConfig({ JUNO_JOURNAL_DIR: journalRoot, JUNO_WORK_DIR: "/work" });
  const journal = JournalWriter.open(config.journalDir);
  const registry = new CapabilityRegistry();
  const registered = registry.register(JSON.parse(readFileSync(definitionFile, "utf8")), [new WorkloadExecFileAdapter({ composeFile, project, service: "workload" })]);
  if (!registered.registered) throw new Error(`shell.run did not register: ${JSON.stringify(registered.refusals)}`);
  const grants = new GrantStore();
  grants.add({
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
  });
  const profile = loadProviderProfile(SCRIPTED_PROFILE_FILE);
  const usage = { tokens_in: 10, tokens_out: 5, tokens_cached: 0 };
  const call = { id: "call-1", capability: "shell.run", arguments: { program: { slot: "cat" }, argv: ["notes.txt"], cwd: { slot: "project" } } };
  const provider = new ScriptedProvider(profile, [
    { model: profile.model, model_version: profile.model_version, text: null, tool_calls: [call], usage },
    { model: profile.model, model_version: profile.model_version, text: "done", tool_calls: [], usage },
  ]);
  runner = new Runner({
    journal,
    registry,
    grants,
    providers: [provider],
    sources: [{ id: "project", selector: { kind: "path", prefix: "/work/project" }, data_class: { sensitivity: "internal", integrity: "untrusted" } }],
  });
  const admission = runner.admit({
    id: "task-host",
    principal: PRINCIPAL,
    objective: `read the notes (${canary})`,
    criterion: { author: "operator", statement: { command: { capability: "shell.run", arguments: { program: CAT, argv: ["done.txt"], cwd: "/work/project" } }, expect_exit_code: 0 } },
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
    constants: { cat: { value: CAT }, project: { value: "/work/project" } },
  });
  if (!admission.admitted) throw new Error(`not admitted: ${JSON.stringify(admission.failures)}`);
  outcome = await runner.run("task-host");

  before = snapshot(journalRoot);
  const [first] = readTrajectory(journalRoot, "task-host");
  if (first === undefined) throw new Error("the task has no entries");
  const stdout = await docker([
    ...compose, "run", "--rm", "--no-deps", "-T", "workload", "-e", WORKLOAD_PROBE,
    canary, control, journalRoot, entriesFile(config.journalDir, "task-host"), headFile(config.journalDir, "task-host"), blobFile(config.journalDir, first.payload_ref),
  ]);
  probe = parseAtBoundary("workload journal probe", WorkloadReport, JSON.parse(stdout));
});

afterAll(async () => {
  runner.close();
  await docker([...compose, "down", "--volumes", "--remove-orphans"]);
  rmSync(hostDir, { recursive: true, force: true });
});

describe("a task run by the host runner against the real workload (build plan Inc 5, D-065)", () => {
  // proves build plan Inc 5 / §3.4.4 / §6.1: the task runs end to end in the workload and the runner verifies and closes it
  it("runs the task's call in the workload and closes it verified", () => {
    expect(outcome).toEqual({ task_id: "task-host", state: "verified", reason: "verification_pass" });
    const entries = readTrajectory(journalRoot, "task-host");
    const results = entries.filter((entry) => entry.kind === "capability_result").map((entry) => {
      const blob = readPayload(journalRoot, entry.payload_ref);
      return blob.status === "present" ? (JSON.parse(new TextDecoder().decode(blob.bytes)) as Record<string, unknown>) : null;
    });
    expect(results.map((result) => [result?.["exit_code"], result?.["stdout"]])).toEqual([
      [0, "hello\n"],
      [0, "ok\n"],
    ]);
  });
});

describe("the host journal is unreachable from the workload (§3.4.1, D-065)", () => {
  // proves §3.4.1 / D-065: the workload cannot read the journal by the runner's exact host paths
  it("fails every workload read of the journal", () => {
    expect([probe.readEntries, probe.readHead, probe.readBlob, probe.listRoot]).toEqual(["ENOENT", "ENOENT", "ENOENT", "ENOENT"]);
  });

  // proves §3.4.1 / D-065: the workload cannot write the journal
  it("fails every workload write to the journal", () => {
    expect([probe.appendEntries, probe.replaceHead]).toEqual(["ENOENT", "ENOENT"]);
  });

  // proves §3.4.1: what the journal holds is nowhere the workload can read
  it("finds the journal's canary in no file the workload can read", () => {
    expect(probe.found.canary).toEqual([]);
    expect(probe.files).toBeGreaterThan(100);
    expect(probe.found.control).toEqual(["/tmp/juno-scan-control"]);
  });

  // proves §3.4.2 / D-065: after the workload's attempts the host journal is byte-for-byte unchanged and verifies
  it("leaves the host journal unchanged and verifiable", () => {
    expect(snapshot(journalRoot)).toEqual(before);
    expect(verifyTrajectory(journalRoot, "task-host").ok).toBe(true);
  });

  // proves D-065: no container is given the Docker socket
  it("gives no container the Docker socket", async () => {
    expect(probe.dockerSocket).toBe(false);
    const config = z
      .object({ services: z.record(z.string(), z.object({ volumes: z.array(z.object({ source: z.string().optional(), target: z.string() })).optional() })) })
      .parse(JSON.parse(await docker([...compose, "config", "--format", "json"])));
    const mounts = Object.values(config.services).flatMap((service) => service.volumes ?? []);
    expect(mounts.filter((mount) => `${mount.source ?? ""} ${mount.target}`.includes("docker.sock"))).toEqual([]);
  });
});
