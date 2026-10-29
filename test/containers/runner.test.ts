import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GrantStore } from "../../packages/enforcement/src/index.js";
import { JournalWriter, readPayload, readTrajectory, verifyTrajectory } from "../../packages/journal/src/index.js";
import { CapabilityRegistry, WorkloadExecFileAdapter, loadRegistryEntry } from "../../packages/registry/src/index.js";
import { type ModelOutput, Runner, ScriptedProvider, VERIFY_EXIT_CODE, loadProviderProfile } from "../../packages/runner/src/index.js";

// Increment 5: the runner's turn loop against the real workload container,
// and the one-runner-per-journal-volume rule in the real runner container.
// Every Docker call goes through execFile with an argv array; there is no shell.

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const composeFile = fileURLToPath(new URL("../../containers/docker-compose.yml", import.meta.url));
const shellRunFile = fileURLToPath(new URL("../../packages/registry/definitions/shell.run.json", import.meta.url));
const profileFile = fileURLToPath(new URL("../../packages/runner/providers/scripted-fake.json", import.meta.url));
const project = "juno-verify-runner";
const compose = ["compose", "-f", composeFile, "-p", project];
const PRINCIPAL = "alireza";
const DAY_MS = 24 * 60 * 60 * 1000;

async function docker(args: readonly string[]): Promise<string> {
  const { stdout } = await run("docker", args, { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

const marker = "juno-notes-" + randomBytes(8).toString("hex");
let dir: string;

beforeAll(async () => {
  await docker([...compose, "down", "--volumes", "--remove-orphans"]);
  // The work content, written as the workload user, outside the capability under test.
  const setup = 'require("node:fs").writeFileSync("/work/notes.txt", process.argv[1]);';
  await docker([...compose, "run", "--rm", "--no-deps", "-T", "workload", "-e", setup, marker]);
  dir = mkdtempSync(join(tmpdir(), "juno-runner-containers-"));
});

afterAll(async () => {
  await docker([...compose, "down", "--volumes", "--remove-orphans"]);
  rmSync(dir, { recursive: true, force: true });
});

describe("the turn loop against the workload container (build plan Inc 5)", () => {
  // proves §3.4.4 and §2.7 end to end: a task reads a file through shell.run in the workload, and the runner verifies and closes it
  it("runs a task to verified closure through the real workload", async () => {
    const journal = JournalWriter.open(join(dir, "journal"));
    const registry = new CapabilityRegistry();
    expect(registry.register(loadRegistryEntry(shellRunFile), [new WorkloadExecFileAdapter({ composeFile, project, service: "workload" })]).registered).toBe(true);
    const grants = new GrantStore();
    const issued = new Date(Date.now() - 60_000);
    grants.add({
      id: "grant-1",
      principal: PRINCIPAL,
      capability_selector: { capabilities: ["shell.run"] },
      resource_scope: [{ kind: "path", prefix: "/work" }],
      data_class_bounds: { max_sensitivity: "internal", min_integrity: "untrusted" },
      issuance: "preissued",
      issued_by: PRINCIPAL,
      issued_at: issued.toISOString(),
      expires_at: new Date(issued.getTime() + DAY_MS).toISOString(),
      max_invocations: 5,
      attenuation_parent: null,
      revoked_at: null,
    });
    const cat: ModelOutput = { kind: "tool_call", capability: "shell.run", input: { program: { slot: "cat" }, argv: ["notes.txt"], cwd: { slot: "work" } } };
    const provider = new ScriptedProvider({ profile: loadProviderProfile(profileFile), script: [cat, { kind: "done", summary: "printed" }] });
    const runner = await Runner.open({
      journal,
      registry,
      grants,
      provider,
      sources: [{ id: "work-vol", selector: { kind: "path", prefix: "/work" }, data_class: { sensitivity: "internal", integrity: "untrusted" } }],
    });
    try {
      const admitted = runner.admit({
        id: "task-containers",
        principal: PRINCIPAL,
        objective: "print the notes file",
        criterion: { capability: "shell.run", arguments: { program: "/usr/bin/cat", argv: ["notes.txt"], cwd: "/work" }, exit_code: 0 },
        criterion_author: "operator",
        verification: VERIFY_EXIT_CODE,
        attendance: "autonomous",
        strategy: "direct",
        sensitivity_floor: "internal",
        model_policy: { permitted_providers: ["scripted-fake"], posture: "local", conversation_state: "any" },
        budget: { tokens: 10_000, currency: 1, wall_clock_ms: 600_000, turns: 5 },
        ttl: DAY_MS,
        grants: ["grant-1"],
        constants: { cat: "/usr/bin/cat", work: "/work" },
      });
      expect(admitted.admitted).toBe(true);
      expect(await runner.run("task-containers")).toEqual({ task_id: "task-containers", state: "verified", reason: null });
    } finally {
      await runner.shutdown();
    }
    // The model saw what the workload printed, and the journal holds the whole account.
    const input = provider.requests[1]?.input[0];
    expect(input?.kind === "result" ? input.stdout : null).toBe(marker);
    expect(verifyTrajectory(journal.root, "task-containers").ok).toBe(true);
    const results = readTrajectory(journal.root, "task-containers").filter((entry) => entry.kind === "capability_result");
    expect(results).toHaveLength(2);
    for (const entry of results) {
      const blob = readPayload(journal.root, entry.payload_ref);
      if (blob.status !== "present") throw new Error("payload missing");
      expect(JSON.parse(new TextDecoder().decode(blob.bytes))).toMatchObject({ exit_code: 0, stdout: marker, adapter: "workload.execfile" });
    }
  });
});

describe("one runner per journal volume, in the runner container (D-025, D-064)", () => {
  const holder = `${project}-holder`;
  const HOLD = [
    'const { acquireRunnerLock } = await import("/app/dist/runner/src/lock.js");',
    "await acquireRunnerLock(process.env.JUNO_JOURNAL_DIR);",
    'process.stdout.write("held\\n");',
    "setInterval(() => {}, 1000);",
  ].join("\n");

  afterAll(async () => {
    await docker(["rm", "-f", holder]).catch(() => "");
  });

  // proves D-025 Increment 5: while one runner holds journal-vol, a second runner container refuses to start; after the holder is killed, the next one starts
  it("refuses a second runner on the same journal volume, and starts once the holder is gone", async () => {
    await docker(["rm", "-f", holder]).catch(() => "");
    await docker([...compose, "run", "-d", "--no-deps", "--name", holder, "runner", "node", "--input-type=module", "-e", HOLD]);
    let held = false;
    for (let attempt = 0; attempt < 60 && !held; attempt += 1) {
      held = (await docker(["logs", holder])).includes("held");
      if (!held) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(held).toBe(true);

    const second = await run("docker", [...compose, "run", "--rm", "--no-deps", "-T", "runner"], { cwd: repoRoot }).then(
      () => ({ code: 0, stderr: "" }),
      (error: { code?: number; stderr?: string }) => ({ code: error.code ?? -1, stderr: error.stderr ?? "" }),
    );
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("another runner holds the journal");

    // Killed, not stopped cleanly: its socket file stays behind, and nobody answers it.
    await docker(["rm", "-f", holder]);
    const third = await docker([...compose, "run", "--rm", "--no-deps", "-T", "runner"]);
    expect(third).toContain("juno-runner: ready");
  });
});
