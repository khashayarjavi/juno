import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GrantStore, WorkloadPathResolver } from "../../packages/enforcement/src/index.js";
import { JournalWriter, readPayload, readTrajectory } from "../../packages/journal/src/index.js";
import { CapabilityRegistry, WorkloadExecFileAdapter } from "../../packages/registry/src/index.js";
import { SCRIPTED_PROFILE_FILE, loadProviderProfile } from "../../packages/runner/src/profile.js";
import { ScriptedProvider } from "../../packages/runner/src/provider.js";
import { Runner } from "../../packages/runner/src/runner.js";
import { TEST_ANCHOR, signed } from "../../packages/enforcement/test/test-keys.js";
import { testAnchoring } from "../../packages/runner/test/anchor-sink.js";

// §2.7.1 "Data fields and scope" (v0.6 C4) and "Paths that do not exist yet" (v0.6.1 V6-2), D-113, against the real
// workload: paths are resolved where the effect runs, by the resolver the runner uses, and the boundary judges the
// canonical form. Every Docker call goes through execFile with an argv array; there is no shell.

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const composeFile = fileURLToPath(new URL("../../containers/docker-compose.yml", import.meta.url));
const definitionFile = fileURLToPath(new URL("../../packages/registry/definitions/shell.run.json", import.meta.url));
const project = "juno-verify-canonical";
const compose = ["compose", "-f", composeFile, "-p", project];
const PRINCIPAL = "alireza";
const T0 = new Date();
const hostDir = mkdtempSync(join(tmpdir(), "juno-canonical-journal-"));
const journalRoot = join(hostDir, "journal");

async function docker(args: readonly string[]): Promise<string> {
  const { stdout } = await run("docker", args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** The outcome of one task proposing `argv` to cat in /work/project, then claiming done. */
const outcomes = new Map<string, { state: string; reason: string | null; park: Record<string, unknown> | null; exit: unknown }>();

const CASES: Readonly<Record<string, readonly string[]>> = {
  escape: ["escape/passwd"],
  chain: ["chain/file.txt"],
  loop: ["loop1/x"],
  fresh: ["new-dir/new.txt"],
  dotdot: ["missing/../notes.txt"],
  empty: ["missing//x"],
};

beforeAll(async () => {
  await docker([...compose, "down", "--volumes", "--remove-orphans"]);
  // The operator's work content, written as the workload user. `escape` points out of the volume; `chain` stays inside.
  const setup = [
    'const fs = require("node:fs");',
    'fs.mkdirSync("/work/project/sub", { recursive: true }); fs.writeFileSync("/work/project/sub/file.txt", "inside\\n"); fs.writeFileSync("/work/project/notes.txt", "notes\\n");',
    'fs.symlinkSync("/etc", "/work/project/escape"); fs.symlinkSync("sub", "/work/project/inner"); fs.symlinkSync("inner", "/work/project/chain");',
    'fs.symlinkSync("loop2", "/work/project/loop1"); fs.symlinkSync("loop1", "/work/project/loop2");',
  ].join(" ");
  await docker([...compose, "run", "--rm", "--no-deps", "-T", "workload", "-e", setup]);

  const journal = JournalWriter.open(journalRoot);
  let runner: Runner;
  const registry = new CapabilityRegistry();
  const registered = registry.register(JSON.parse(readFileSync(definitionFile, "utf8")), [new WorkloadExecFileAdapter({ composeFile, project, service: "workload" })]);
  if (!registered.registered) throw new Error(`shell.run did not register: ${JSON.stringify(registered.refusals)}`);
  // A fresh store for each runner: a new runner rebuilds every grant's charges from the journal.
  const grantsFor = (): GrantStore => {
    const store = new GrantStore(TEST_ANCHOR);
    store.add(signed({
      id: "grant-1",
      principal: PRINCIPAL,
      capability_selector: { capabilities: ["shell.run"] },
      resource_scope: [{ kind: "path", prefix: "/work/project" }],
      data_class_bounds: { max_sensitivity: "internal", min_integrity: "untrusted" },
      issuance: "preissued",
      issued_by: PRINCIPAL,
      issued_at: new Date(T0.getTime() - 60_000).toISOString(),
      expires_at: new Date(T0.getTime() + 3_600_000).toISOString(),
      max_invocations: 50,
      attenuation_parent: null,
      revoked_at: null,
    }));
    return store;
  };
  const profile = loadProviderProfile(SCRIPTED_PROFILE_FILE);
  const usage = { tokens_in: 1, tokens_out: 1, tokens_cached: 0 };
  // One runner per case, each with its own script (a task that parks uses fewer turns); one runner holds the journal at a time.
  const runnerFor = (argv: readonly string[]): Runner =>
    new Runner({
      journal,
      registry,
      grants: grantsFor(),
      providers: [
        new ScriptedProvider(profile, [
          { model: profile.model, model_version: profile.model_version, text: null, tool_calls: [{ id: "call-1", capability: "shell.run", arguments: { program: { slot: "cat" }, argv, cwd: { slot: "project" } } }], usage },
          { model: profile.model, model_version: profile.model_version, text: "done", tool_calls: [], usage },
        ]),
      ],
      sources: [{ id: "project", selector: { kind: "path", prefix: "/work/project" }, data_class: { sensitivity: "internal", integrity: "untrusted" } }],
      resolver: new WorkloadPathResolver({ composeFile, project, service: "workload" }),
      anchoring: testAnchoring(),
    });
  const payload = (ref: string): Record<string, unknown> => {
    const blob = readPayload(journalRoot, ref);
    return blob.status === "present" ? (JSON.parse(new TextDecoder().decode(blob.bytes)) as Record<string, unknown>) : {};
  };
  for (const [name, argv] of Object.entries(CASES)) {
    const id = ["task", name].join("-");
    runner = runnerFor(argv);
    const admission = runner.admit({
      id,
      principal: PRINCIPAL,
      objective: "read a file",
      criterion: null,
      verification: null,
      attendance: "autonomous",
      strategy: "direct",
      sources: ["project"],
      sensitivity_floor: "internal",
      model_policy: { permitted_providers: [profile.id], posture: profile.posture, conversation_state: "any" },
      budget: { tokens: 10_000, currency: 1, wall_clock_ms: 600_000, turns: 10 },
      ttl: 3_600_000,
      grants: ["grant-1"],
      parent: null,
      constants: { cat: { value: "/usr/bin/cat" }, project: { value: "/work/project" } },
    });
    if (!admission.admitted) throw new Error(`not admitted: ${JSON.stringify(admission.failures)}`);
    const outcome = await runner.run(id);
    const entries = readTrajectory(journalRoot, id);
    const park = entries.find((entry) => entry.kind === "park");
    const result = entries.find((entry) => entry.kind === "capability_result");
    outcomes.set(name, { state: outcome.state, reason: outcome.reason, park: park === undefined ? null : payload(park.payload_ref), exit: result === undefined ? null : payload(result.payload_ref)["exit_code"] });
    runner.close();
  }
}, 600_000);

afterAll(async () => {
  await docker([...compose, "down", "--volumes", "--remove-orphans"]);
  rmSync(hostDir, { recursive: true, force: true });
});

describe("canonical scope in the real workload (§2.7.1 C4, v0.6.1 V6-2, D-113)", () => {
  const outside = (name: string): Record<string, unknown>[] => {
    const detail = outcomes.get(name)?.park?.["detail"] as { grants?: { outside: Record<string, unknown>[] }[] } | undefined;
    return detail?.grants?.[0]?.outside ?? [];
  };

  // proves §2.7.1 C4: a symlink inside the scope that points outside it parks scope_violation; nothing ran (closes D-047's residual)
  it("parks a symlink that leaves the scope", () => {
    expect(outcomes.get("escape")).toMatchObject({ state: "parked", reason: "scope_violation", exit: null });
    expect(outside("escape")).toEqual([expect.objectContaining({ argument: "argv[0]", value: "escape/passwd" })]);
  });

  // proves §2.7.1 C4: a symlink chain that stays inside the scope proceeds, and cat reads the file it resolves to
  it("lets a symlink chain that stays inside proceed", () => {
    expect(outcomes.get("chain")).toMatchObject({ state: "complete_unverified", exit: 0 });
  });

  // proves §2.7.1 "cannot be resolved": a symlink loop parks
  it("parks a symlink loop", () => {
    expect(outcomes.get("loop")).toMatchObject({ state: "parked", reason: "scope_violation" });
    expect(outside("loop")).toEqual([expect.objectContaining({ argument: "argv[0]", unresolved: expect.stringContaining("ELOOP") })]);
  });

  // proves §2.7.1 V6-2: a new path whose longest existing ancestor is in scope proceeds (cat then finds no file)
  it("lets a path that does not exist yet proceed through its in-scope ancestor", () => {
    expect(outcomes.get("fresh")).toMatchObject({ state: "complete_unverified", exit: 1 });
  });

  // proves §2.7.1 V6-2: a missing remainder holding `..` or an empty component parks
  it.each([["dotdot"], ["empty"]])("parks a missing remainder that fails the conditions (%s)", (name) => {
    expect(outcomes.get(name)).toMatchObject({ state: "parked", reason: "scope_violation", exit: null });
    expect(outside(name)).toEqual([expect.objectContaining({ argument: "argv[0]", unresolved: expect.stringContaining("missing remainder") })]);
  });
});
