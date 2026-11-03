import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TrajectoryEntry } from "../../contracts/src/index.js";
import { type CanonicalPaths, GrantStore, type PathResolver, RESOLVER_SCRIPT, readResolverOutput } from "../../enforcement/src/index.js";
import { JournalWriter, readPayload, readTrajectory } from "../../journal/src/index.js";
import { type Adapter, type CapabilityCall, CapabilityRegistry, WORKLOAD_EXECFILE, executeOutbound, loadRegistryEntry } from "../../registry/src/index.js";
import type { SourceRegistration } from "../src/admission.js";
import { type ProviderProfile, SCRIPTED_PROFILE_FILE, loadProviderProfile } from "../src/profile.js";
import { type ScriptStep, ScriptedProvider } from "../src/provider.js";
import { Runner, type RunnerOptions } from "../src/runner.js";
import { TEST_ANCHOR, signed } from "../../enforcement/test/test-keys.js";

export const SHELL_RUN_FILE = fileURLToPath(new URL("../../registry/definitions/shell.run.json", import.meta.url));
export const CAT = "/usr/bin/cat";
export const PRINCIPAL = "alireza";
export const T0 = "2026-10-28T09:00:00.000Z";
export const DAY_MS = 24 * 60 * 60 * 1000;
export const PROFILE: ProviderProfile = loadProviderProfile(SCRIPTED_PROFILE_FILE);

/**
 * A stand-in workload for unit tests: node on the host, with each data value
 * one discrete argv element (§2.4).
 *   - For `cat` (and anything else) it prints one line per operand: the operand `listing` prints two file names,
 *     `fail` makes it exit 3, and any other operand prints `read:<operand>`.
 *   - For the verifier's pin listing (`ls ... --quoting-style=escape`) and hashing (`sha256sum -z`) it does what those
 *     programs do (D-112), over a host directory standing for `/work`: the current harness's `work` directory. The
 *     real programs' output is proven by the container tests. A file whose name starts with `unhashable` cannot be read
 *     by its sha256sum, as a read error would leave it.
 */
const STAND_IN = String.raw`
const fs = require("node:fs"); const path = require("node:path"); const crypto = require("node:crypto");
const [root, program, cwd, ...args] = process.argv.slice(1);
const host = (p) => path.join(root, p.replace(/^\/work/, ""));
const escape = (name, header) => [...Buffer.from(name, "utf8")].map((b) => {
  const c = String.fromCharCode(b);
  if (c === "\\") return "\\\\"; if (c === " ") return "\\ "; if (c === "\n") return "\\n"; if (c === "\t") return "\\t";
  if (header && c === ":") return "\\:";
  return b < 32 || b > 126 ? "\\" + b.toString(8).padStart(3, "0") : c;
}).join("");
const typeChar = (s) => s.isDirectory() ? "d" : s.isSymbolicLink() ? "l" : s.isFile() ? "-" : "p";
const perms = (m) => ["r", "w", "x", "r", "w", "x", "r", "w", "x"].map((ch, i) => (m & (256 >> i)) ? ch : "-").join("");
const line = (p, name) => { const s = fs.lstatSync(host(p)); const t = s.mtime.toISOString();
  return typeChar(s) + perms(s.mode) + " " + s.nlink + " " + s.uid + " " + s.gid + " " + s.size + " " + t.slice(0, 10) + " " + t.slice(11, 23) + "000000 +0000 " + escape(name, false)
    + (s.isSymbolicLink() ? " -> " + escape(fs.readlinkSync(host(p)), false) : ""); };
const sorted = (xs) => [...xs].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
if (program.endsWith("/ls") && args.includes("--quoting-style=escape")) {
  const operands = args.slice(args.indexOf("--") + 1); let code = 0; const files = []; const dirs = [];
  for (const o of sorted(operands)) { let s; try { s = fs.lstatSync(host(o)); } catch { process.stderr.write("ls: cannot access " + o); code = 2; continue; } (s.isDirectory() ? dirs : files).push(o); }
  const blocks = []; if (files.length > 0) blocks.push(files.map((f) => line(f, f)).join("\n"));
  const walk = (d) => { const names = sorted(fs.readdirSync(host(d)));
    blocks.push([escape(d, true) + ":", "total 0", line(d, "."), line(path.posix.dirname(d), ".."), ...names.map((n) => line(path.posix.join(d, n), n))].join("\n"));
    for (const n of names) { const p = path.posix.join(d, n); if (fs.lstatSync(host(p)).isDirectory()) walk(p); } };
  for (const d of dirs) walk(d);
  process.stdout.write(blocks.length === 0 ? "" : blocks.join("\n\n") + "\n"); process.exit(code);
} else if (program.endsWith("/sha256sum")) {
  let code = 0; const out = [];
  for (const o of args.slice(args.indexOf("--") + 1)) { try { if (path.basename(o).startsWith("unhashable")) throw new Error("read error"); out.push(crypto.createHash("sha256").update(fs.readFileSync(host(o))).digest("hex") + "  " + o + "\0"); } catch { code = 1; } }
  process.stdout.write(out.join("")); process.exit(code);
} else {
  let code = 0; const out = [];
  for (const arg of args) { if (arg === "listing") out.push("found.txt", "other.txt"); else if (arg === "fail") code = 3; else out.push("read:" + arg); }
  process.stdout.write(out.map((l) => l + "\n").join("")); process.stderr.write("cwd=" + cwd); process.exit(code);
}`;

/** The host directory standing for `/work` in the stand-in: set by each harness to its own `work` directory. */
let standInRoot = tmpdir();

export const standInAdapter: Adapter = {
  id: WORKLOAD_EXECFILE,
  plan: (call: CapabilityCall) => ({
    file: process.execPath,
    args: ["-e", STAND_IN, standInRoot, String(call["program"]), String(call["cwd"]), ...(call["argv"] as readonly unknown[]).map(String)],
  }),
};

/**
 * The resolver for unit tests (D-113): the same operator-fixed script the workload runs, run by this host's node over
 * the stand-in's host directory standing for `/work`, so symlinks there are resolved for real.
 */
export function hostResolver(root: string): PathResolver {
  return {
    async resolve(paths: readonly string[]): Promise<CanonicalPaths> {
      if (paths.length === 0) return new Map();
      const result = await executeOutbound({ file: process.execPath, args: ["-e", RESOLVER_SCRIPT, "/work", root, ...paths] });
      return readResolverOutput(paths, result.stdout.toString("utf8"));
    },
  };
}

/** The files every harness's `/work` starts with: what OPERATOR_CRITERION's verification scope holds. */
export const WORK_FILES: Readonly<Record<string, string>> = { "/work/project/done.txt": "ok\n", "/work/project/notes.txt": "notes\n", "/work/project/protected/keep.txt": "keep\n" };

/** Writes `files` (paths under `/work`) into the current harness's stand-in `/work`. */
export function writeWork(files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(standInRoot, path.replace(/^\/work/, ""));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

export const PROJECT_SOURCE: SourceRegistration = {
  id: "project",
  selector: { kind: "path", prefix: "/work/project" },
  data_class: { sensitivity: "internal", integrity: "untrusted" },
};

export function grant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return signed({
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
  });
}

export const OPERATOR_CRITERION = {
  author: "operator",
  statement: {
    command: { capability: "shell.run", arguments: { program: CAT, argv: ["done.txt"], cwd: "/work/project" } },
    expect_exit_code: 0,
    protected_paths: ["/work/project/protected"],
  },
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
  standInRoot = join(dir, "work");
  writeWork(WORK_FILES);
  const journal = JournalWriter.open(join(dir, "journal"));
  const registry = new CapabilityRegistry();
  const registered = registry.register(loadRegistryEntry(SHELL_RUN_FILE), [adapter]);
  if (!registered.registered) throw new Error(`shell.run did not register: ${JSON.stringify(registered.refusals)}`);
  const grants = new GrantStore(TEST_ANCHOR);
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
      const runner = new Runner({ journal, registry, grants, providers: [provider], sources: [PROJECT_SOURCE], clock: () => now.value, resolver: hostResolver(join(dir, "work")), ...options });
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
