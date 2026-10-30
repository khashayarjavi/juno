import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TrajectoryEntry } from "../../contracts/src/index.js";
import { GrantStore } from "../../enforcement/src/index.js";
import { JournalWriter, readPayload, readTrajectory } from "../../journal/src/index.js";
import { type Adapter, type CapabilityCall, CapabilityRegistry, WORKLOAD_EXECFILE, loadRegistryEntry } from "../../registry/src/index.js";
import type { SourceRegistration } from "../src/admission.js";
import { type ProviderProfile, SCRIPTED_PROFILE_FILE, loadProviderProfile } from "../src/profile.js";
import { type ScriptStep, ScriptedProvider } from "../src/provider.js";
import { Runner, type RunnerOptions } from "../src/runner.js";

export const SHELL_RUN_FILE = fileURLToPath(new URL("../../registry/definitions/shell.run.json", import.meta.url));
export const CAT = "/usr/bin/cat";
export const PRINCIPAL = "alireza";
export const T0 = "2026-10-28T09:00:00.000Z";
export const DAY_MS = 24 * 60 * 60 * 1000;
export const PROFILE: ProviderProfile = loadProviderProfile(SCRIPTED_PROFILE_FILE);

/**
 * A stand-in workload for unit tests: node on the host, with each data value
 * one discrete argv element (§2.4). It prints one line per operand: the
 * operand `listing` prints two file names, `fail` makes it exit 3, and any
 * other operand prints `read:<operand>`.
 */
const STAND_IN = [
  "const [cwd, ...args] = process.argv.slice(1);",
  "let code = 0; const out = [];",
  'for (const arg of args) { if (arg === "listing") out.push("found.txt", "other.txt"); else if (arg === "fail") code = 3; else out.push("read:" + arg); }',
  'process.stdout.write(out.map((line) => line + "\\n").join("")); process.stderr.write("cwd=" + cwd); process.exit(code);',
].join("\n");

export const standInAdapter: Adapter = {
  id: WORKLOAD_EXECFILE,
  plan: (call: CapabilityCall) => ({ file: process.execPath, args: ["-e", STAND_IN, String(call["cwd"]), ...(call["argv"] as readonly unknown[]).map(String)] }),
};

export const PROJECT_SOURCE: SourceRegistration = {
  id: "project",
  selector: { kind: "path", prefix: "/work/project" },
  data_class: { sensitivity: "internal", integrity: "untrusted" },
};

export function grant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "grant-1",
    principal: PRINCIPAL,
    capability_selector: { capabilities: ["shell.run"] },
    resource_scope: [{ kind: "path", prefix: "/work/project" }],
    data_class_bounds: { max_sensitivity: "secret", min_integrity: "untrusted" },
    issuance: "preissued",
    issued_by: PRINCIPAL,
    issued_at: T0,
    expires_at: new Date(Date.parse(T0) + DAY_MS).toISOString(),
    max_invocations: null,
    attenuation_parent: null,
    revoked_at: null,
    ...overrides,
  };
}

export const OPERATOR_CRITERION = {
  author: "operator",
  statement: { command: { capability: "shell.run", arguments: { program: CAT, argv: ["done.txt"], cwd: "/work/project" } }, expect_exit_code: 0 },
} as const;

export function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-1",
    principal: PRINCIPAL,
    objective: "read the notes in the project",
    criterion: null,
    verification: null,
    attendance: "autonomous",
    strategy: "direct",
    sources: ["project"],
    sensitivity_floor: "internal",
    model_policy: { permitted_providers: [PROFILE.id], posture: PROFILE.posture, conversation_state: "any" },
    budget: { tokens: 1_000_000, currency: 100, wall_clock_ms: 60 * 60 * 1000, turns: 50 },
    ttl: DAY_MS,
    grants: ["grant-1"],
    parent: null,
    constants: { cat: { value: CAT }, project: { value: "/work/project" } },
    ...overrides,
  };
}

export type Usage = { tokens_in: number; tokens_out: number; tokens_cached: number };
const NO_USAGE: Usage = { tokens_in: 0, tokens_out: 0, tokens_cached: 0 };

/** One scripted turn proposing these calls (none: the model claims it is done). */
export function turn(calls: readonly unknown[] = [], usage: Usage = NO_USAGE): unknown {
  return { model: PROFILE.model, model_version: PROFILE.model_version, text: null, tool_calls: calls, usage };
}

let callIds = 0;
/** A `shell.run` call as the model writes it (D-060): literals are synthesized, `{slot}` is a constant, `{ref}` is bound. */
export function shellRun(argv: readonly unknown[], program: unknown = { slot: "cat" }, cwd: unknown = { slot: "project" }): unknown {
  callIds += 1;
  return { id: `call-${String(callIds)}`, capability: "shell.run", arguments: { program, argv, cwd } };
}

export type Harness = {
  dir: string;
  journal: JournalWriter;
  registry: CapabilityRegistry;
  grants: GrantStore;
  now: { value: Date };
  runner: (steps: readonly ScriptStep[], options?: Partial<RunnerOptions> & { profile?: ProviderProfile }) => { runner: Runner; provider: ScriptedProvider };
  entries: (taskId?: string) => readonly TrajectoryEntry[];
  payload: (entry: TrajectoryEntry) => Record<string, unknown>;
  cleanup: () => void;
};

export function harness(adapter: Adapter = standInAdapter): Harness {
  const dir = mkdtempSync(join(tmpdir(), "juno-runner-"));
  const journal = JournalWriter.open(join(dir, "journal"));
  const registry = new CapabilityRegistry();
  const registered = registry.register(loadRegistryEntry(SHELL_RUN_FILE), [adapter]);
  if (!registered.registered) throw new Error(`shell.run did not register: ${JSON.stringify(registered.refusals)}`);
  const grants = new GrantStore();
  grants.add(grant());
  const now = { value: new Date(Date.parse(T0) + 60 * 60 * 1000) };
  const runners: Runner[] = [];
  return {
    dir,
    journal,
    registry,
    grants,
    now,
    runner: (steps, options = {}) => {
      const provider = new ScriptedProvider(options.profile ?? PROFILE, steps);
      const runner = new Runner({ journal, registry, grants, providers: [provider], sources: [PROJECT_SOURCE], clock: () => now.value, ...options });
      runners.push(runner);
      return { runner, provider };
    },
    entries: (taskId = "task-1") => readTrajectory(journal.root, taskId),
    payload: (entry) => {
      const blob = readPayload(journal.root, entry.payload_ref);
      if (blob.status !== "present") throw new Error("payload missing");
      return JSON.parse(new TextDecoder().decode(blob.bytes)) as Record<string, unknown>;
    },
    cleanup: () => {
      for (const runner of runners) runner.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
