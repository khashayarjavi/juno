import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CanonicalPaths, CheckpointStore, type ContainerRuntime, GrantStore, type PathResolver, WorkloadPathResolver, probeContainerRuntime, workloadWorkspace } from "../../packages/enforcement/src/index.js";
import { JournalWriter, readPayload, readTrajectory } from "../../packages/journal/src/index.js";
import { CapabilityRegistry, WorkloadExecFileAdapter, WorkloadWriteAdapter, loadRegistryEntry } from "../../packages/registry/src/index.js";
import { SCRIPTED_PROFILE_FILE, loadProviderProfile } from "../../packages/runner/src/profile.js";
import { ScriptedProvider } from "../../packages/runner/src/provider.js";
import { Runner } from "../../packages/runner/src/runner.js";
import { MemoryAnchorSink, testAnchoring } from "../../packages/runner/test/anchor-sink.js";
import { TEST_ANCHOR, signed } from "../../packages/enforcement/test/test-keys.js";

// Slice 1.5 Increment 3 in the real workload container (§2.2.2, §2.4; D-121, D-136, D-137):
//   - fs.file.write writes inside a reversible workspace, through the boundary, as the workload user;
//   - D-121: a path component swapped for a symlink after the boundary's check and before the write fails the write,
//     nothing outside the scope changes, and the journal records why;
//   - the checkpoint taken before the first turn is restored byte for byte by the operator's action.
// Every Docker call is execFile with an argv array (§2.4).

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const composeFile = fileURLToPath(new URL("../../containers/docker-compose.yml", import.meta.url));
const project = "juno-verify-write";
const compose = ["compose", "-f", composeFile, "-p", project];
const target = { composeFile, project, service: "workload" };
const PRINCIPAL = "alireza";
const T0 = new Date();

async function docker(args: readonly string[]): Promise<string> {
  const { stdout } = await run("docker", args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Runs a node program in the workload, as docker-compose.yml configures it, and returns what it printed. */
const inWorkload = (program: string): Promise<string> => docker([...compose, "run", "--rm", "--no-deps", "-T", "workload", "-e", program]);
const readWork = async (path: string): Promise<string> =>
  inWorkload(`const fs = require("node:fs"); try { process.stdout.write(fs.readFileSync(${JSON.stringify(path)}, "utf8")); } catch (e) { process.stdout.write("<" + e.code + ">"); }`);

const hostDir = mkdtempSync(join(tmpdir(), "juno-write-"));
let journal: JournalWriter;
let registry: CapabilityRegistry;
let grants: GrantStore;
const runners: Runner[] = [];
let runtime: ContainerRuntime;

function grant(id: string, capabilities: readonly string[]): Record<string, unknown> {
  return signed({
    id,
    principal: PRINCIPAL,
    capability_selector: { capabilities: [...capabilities] },
    resource_scope: [{ kind: "path", prefix: "/work/scope" }],
    data_class_bounds: { max_sensitivity: "internal", min_integrity: "untrusted" },
    issuance: "preissued",
    issued_by: PRINCIPAL,
    issued_at: new Date(T0.getTime() - 60_000).toISOString(),
    expires_at: new Date(T0.getTime() + 3_600_000).toISOString(),
    max_invocations: 10,
    attenuation_parent: null,
    revoked_at: null,
  });
}

function request(id: string, reversible: readonly string[]): Record<string, unknown> {
  const profile = loadProviderProfile(SCRIPTED_PROFILE_FILE);
  return {
    id,
    principal: PRINCIPAL,
    objective: "write the report",
    criterion: null,
    verification: null,
    attendance: "autonomous",
    strategy: "direct",
    sources: ["scope"],
    sensitivity_floor: "internal",
    model_policy: { permitted_providers: [profile.id], posture: profile.posture, conversation_state: "any" },
    budget: { tokens: 100000, currency: 10, wall_clock_ms: 600000, turns: 10 },
    ttl: 3_600_000,
    grants: ["grant-write"],
    parent: null,
    reversible_workspaces: [...reversible],
  };
}

function runnerWith(calls: readonly unknown[], resolver: PathResolver = new WorkloadPathResolver(target)): Runner {
  const profile = loadProviderProfile(SCRIPTED_PROFILE_FILE);
  const usage = { tokens_in: 10, tokens_out: 5, tokens_cached: 0 };
  const provider = new ScriptedProvider(profile, [
    { model: profile.model, model_version: profile.model_version, text: null, tool_calls: [...calls], usage },
    { model: profile.model, model_version: profile.model_version, text: "done", tool_calls: [], usage },
  ]);
  for (const previous of runners.splice(0)) previous.close();
  // Each runner rebuilds grant charges from the journal's record, so it starts from a store with none (D-066).
  grants = new GrantStore(TEST_ANCHOR);
  grants.add(grant("grant-write", ["fs.file.write"]));
  const runner = new Runner({
    journal,
    registry,
    grants,
    providers: [provider],
    sources: [{ id: "scope", selector: { kind: "path", prefix: "/work/scope" }, data_class: { sensitivity: "internal", integrity: "untrusted" } }],
    resolver,
    anchoring: testAnchoring({ sink: new MemoryAnchorSink() }),
    checkpoints: { workspace: workloadWorkspace(target), store: new CheckpointStore(join(hostDir, "checkpoints")) },
    // D-149: a runner that starts real workloads checks that the runtime enforces their limits.
    containerRuntime: runtime,
  });
  runners.push(runner);
  return runner;
}

const writeCall = (path: string, content: string): unknown => ({ id: `w-${path}`, capability: "fs.file.write", arguments: { path, content } });
const payloads = (taskId: string): Record<string, unknown>[] =>
  readTrajectory(journal.root, taskId).map((entry) => {
    const blob = readPayload(journal.root, entry.payload_ref);
    return blob.status === "present" ? (JSON.parse(new TextDecoder().decode(blob.bytes)) as Record<string, unknown>) : {};
  });

beforeAll(async () => {
  await docker([...compose, "down", "--volumes", "--remove-orphans"]);
  runtime = await probeContainerRuntime();
  await inWorkload(
    'const fs = require("node:fs"); fs.mkdirSync("/work/scope/sub", { recursive: true }); fs.mkdirSync("/work/outside"); fs.writeFileSync("/work/scope/notes.txt", "the original notes\\n"); fs.writeFileSync("/work/outside/keep.txt", "outside\\n");',
  );
  journal = JournalWriter.open(join(hostDir, "journal"));
  registry = new CapabilityRegistry();
  const shell = registry.register(loadRegistryEntry(fileURLToPath(new URL("../../packages/registry/definitions/shell.run.json", import.meta.url))), [new WorkloadExecFileAdapter(target)]);
  const write = registry.register(loadRegistryEntry(fileURLToPath(new URL("../../packages/registry/definitions/fs.file.write.json", import.meta.url))), [new WorkloadWriteAdapter(target)]);
  if (!shell.registered || !write.registered) throw new Error("registration failed");
});

afterAll(async () => {
  for (const runner of runners) runner.close();
  await docker([...compose, "down", "--volumes", "--remove-orphans"]);
  rmSync(hostDir, { recursive: true, force: true });
});

describe("fs.file.write in the real workload (§2.2.2, D-137)", () => {
  // proves §2.2.2 write row in the real workload: an untrusted path inside the checkpointed workspace is written,
  // and the checkpoint is restored byte for byte by the operator's action, both journalled
  it("writes inside the reversible workspace, and the checkpoint restores the prior content", async () => {
    const runner = runnerWith([writeCall("/work/scope/notes.txt", "injected notes\n"), writeCall("/work/scope/new/added.txt", "added\n")]);
    expect(runner.admit(request("task-write", ["/work/scope"]))).toMatchObject({ admitted: true });
    expect(await runner.run("task-write")).toMatchObject({ state: "complete_unverified" });
    expect(await readWork("/work/scope/notes.txt")).toBe("injected notes\n");
    expect(await readWork("/work/scope/new/added.txt")).toBe("added\n");
    const checkpoint = payloads("task-write").find((payload) => payload["type"] === "checkpoint");
    expect(checkpoint).toMatchObject({ root: "/work/scope" });
    expect(await runner.restoreCheckpoint("task-write", String(checkpoint?.["checkpoint"]), PRINCIPAL)).toEqual({ ok: true, root: "/work/scope" });
    expect(await readWork("/work/scope/notes.txt")).toBe("the original notes\n");
    expect(await readWork("/work/scope/new/added.txt")).toBe("<ENOENT>");
    expect(payloads("task-write").find((payload) => payload["type"] === "checkpoint_restore")).toMatchObject({ outcome: "restored" });
  });

  // proves §2.2.2 write row: with no checkpoint the same untrusted write parks integrity_floor and nothing is written
  it("parks the same write with no reversible workspace", async () => {
    const runner = runnerWith([writeCall("/work/scope/notes.txt", "injected again\n")]);
    expect(runner.admit(request("task-unchecked", []))).toMatchObject({ admitted: true });
    expect(await runner.run("task-unchecked")).toMatchObject({ state: "parked", reason: "integrity_floor" });
    expect(await readWork("/work/scope/notes.txt")).toBe("the original notes\n");
  });

  // proves D-121: a path component swapped for a symlink after the boundary's check and before the write makes the write
  // fail; nothing outside the scope changes; the journal records why
  it("refuses a component swapped for a symlink between the boundary's check and the write", async () => {
    const real = new WorkloadPathResolver(target);
    // The boundary judges the paths the real resolver returns; then, before the call is performed, `sub` becomes a
    // symlink to a directory outside the scope.
    const swapping: PathResolver = {
      async resolve(paths: readonly string[]): Promise<CanonicalPaths> {
        const answers = await real.resolve(paths);
        if (paths.includes("/work/scope/sub/out.txt")) {
          await inWorkload('const fs = require("node:fs"); fs.rmSync("/work/scope/sub", { recursive: true }); fs.symlinkSync("/work/outside", "/work/scope/sub");');
        }
        return answers;
      },
    };
    const runner = runnerWith([writeCall("/work/scope/sub/out.txt", "escaped\n")], swapping);
    expect(runner.admit(request("task-swap", ["/work/scope"]))).toMatchObject({ admitted: true });
    await runner.run("task-swap");
    const call = payloads("task-swap").find((payload) => payload["capability"] === "fs.file.write" && "verdict" in payload);
    expect(call).toMatchObject({ verdict: { outcome: "proceed" } });
    const result = payloads("task-swap").find((payload) => "exit_code" in payload);
    expect(result).toMatchObject({ exit_code: 5, stderr: expect.stringMatching(/"sub" is a symlink or not a directory.*no symlink is followed/) });
    expect(await readWork("/work/outside/out.txt")).toBe("<ENOENT>");
    expect(await readWork("/work/outside/keep.txt")).toBe("outside\n");
  });
});
