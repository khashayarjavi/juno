import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { parseAtBoundary } from "../../packages/contracts/src/index.js";

// Increment 3, operator directive D-025: the workload container has fixed CPU,
// memory and process-count limits, and each one is proven by hitting it. The
// probes run inside the workload with its own node runtime; every Docker call
// goes through execFile with an argv array (§2.4). The probes read no cgroup
// accounting files except pids.max, so they hold on cgroup v1 and v2 alike.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const composeFile = fileURLToPath(new URL("../../containers/docker-compose.yml", import.meta.url));
const project = "juno-verify-limits";
const compose = ["compose", "-f", composeFile, "-p", project];
const WORKLOAD_IMAGE = "juno-workload:local";

// The limits docker-compose.yml declares (DECISIONS.md D-030).
const CPUS = 1;
const MEMORY_BYTES = 512 * 1024 * 1024;
const PIDS = 128;

type Outcome = { readonly code: number; readonly stdout: string; readonly stderr: string };

/** Runs docker and reports the exit code instead of throwing, so a killed container is a result. */
function docker(args: readonly string[]): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) return resolve({ code: 0, stdout, stderr });
      if (typeof error.code === "number") return resolve({ code: error.code, stdout, stderr });
      reject(error);
    });
  });
}

async function dockerOk(args: readonly string[]): Promise<string> {
  const outcome = await docker(args);
  if (outcome.code !== 0) throw new Error(`docker ${args.join(" ")} exited ${outcome.code}: ${outcome.stderr}`);
  return outcome.stdout;
}

/** Runs a node program in the workload exactly as docker-compose.yml configures it. */
function inWorkload(program: string, args: readonly string[], name?: string): Promise<Outcome> {
  const naming = name === undefined ? ["--rm"] : ["--name", name];
  return docker([...compose, "run", ...naming, "--no-deps", "-T", "workload", "-e", program, ...args]);
}

// Allocates the given number of MiB in 16 MiB buffers, writing every byte so
// the pages are really used, then reports how much it allocated.
const MEMORY_PROBE = [
  "const mib = Number(process.argv[1]);",
  "const keep = [];",
  "for (let done = 0; done < mib; done += 16) keep.push(Buffer.alloc(16 * 1024 * 1024, 1));",
  'process.stdout.write("allocated " + mib);',
].join("\n");

// Starts the given number of child processes (each a `cat` waiting on its
// stdin) through execFile, then reports how many are running and which spawn
// errors occurred. The thread pool is started first, so the parent itself
// needs no new threads once the limit is reached.
const PIDS_PROBE = [
  'const { execFile } = require("node:child_process");',
  'const fs = require("node:fs");',
  "const wanted = Number(process.argv[1]);",
  "const children = [];",
  "const errors = [];",
  'const read = (path) => { try { return fs.readFileSync(path, "utf8").trim(); } catch { return null; } };',
  'fs.promises.stat("/").then(() => {',
  "  for (let i = 0; i < wanted; i++) {",
  '    const child = execFile("/usr/bin/cat", [], () => {});',
  '    child.on("error", (error) => errors.push(error.code));',
  "    children.push(child);",
  "  }",
  "  setTimeout(() => {",
  "    const running = children.filter((child) => child.pid !== undefined && child.exitCode === null).length;",
  '    const pidsMax = read("/sys/fs/cgroup/pids.max") ?? read("/sys/fs/cgroup/pids/pids.max");',
  "    process.stdout.write(JSON.stringify({ running, errors: [...new Set(errors)], pidsMax }));",
  "    for (const child of children) child.kill();",
  "  }, 1500);",
  "});",
].join("\n");

const PidsReport = z.object({ running: z.number(), errors: z.array(z.string()), pidsMax: z.string().nullable() });

// Keeps the given number of threads busy for the given time, then reports the
// process's CPU time divided by wall time: how many CPUs it actually got.
const CPU_PROBE = [
  'const { Worker } = require("node:worker_threads");',
  'const os = require("node:os");',
  "const [threads, ms] = process.argv.slice(1).map(Number);",
  "const start = process.hrtime.bigint();",
  "const cpuStart = process.cpuUsage();",
  "let left = threads;",
  "for (let i = 0; i < threads; i++) {",
  '  const worker = new Worker("const end = Date.now() + " + ms + "; while (Date.now() < end) {}", { eval: true });',
  '  worker.on("exit", () => {',
  "    if (--left > 0) return;",
  "    const wallMicros = Number(process.hrtime.bigint() - start) / 1000;",
  "    const used = process.cpuUsage(cpuStart);",
  "    process.stdout.write(JSON.stringify({ cpusUsed: (used.user + used.system) / wallMicros, hostCpus: os.availableParallelism() }));",
  "  });",
  "}",
].join("\n");

const CpuReport = z.object({ cpusUsed: z.number(), hostCpus: z.number() });

afterAll(async () => {
  await docker([...compose, "down", "--volumes", "--remove-orphans"]);
});

const ComposeService = z.object({
  cpus: z.number().optional(),
  mem_limit: z.string().optional(),
  memswap_limit: z.string().optional(),
  pids_limit: z.number().optional(),
});
const ComposeConfig = z.object({ services: z.record(z.string(), ComposeService) });

const HostConfig = z.object({
  NanoCpus: z.number(),
  Memory: z.number(),
  MemorySwap: z.number(),
  PidsLimit: z.number().nullable(),
});

describe("workload resource limits are declared and applied (D-025 Inc 3)", () => {
  let declared: z.output<typeof ComposeService> | undefined;
  let applied: z.output<typeof HostConfig>;

  beforeAll(async () => {
    const config = parseAtBoundary("compose config", ComposeConfig, JSON.parse(await dockerOk([...compose, "config", "--format", "json"])));
    declared = config.services["workload"];
    const id = (await dockerOk([...compose, "run", "-d", "--no-deps", "workload", "-e", "setTimeout(() => {}, 30000)"])).trim();
    try {
      const inspected: unknown = JSON.parse(await dockerOk(["inspect", "--format", "{{json .HostConfig}}", id]));
      applied = parseAtBoundary("container host config", HostConfig, inspected);
    } finally {
      await docker(["rm", "-f", id]);
    }
  });

  // proves D-025 Inc 3: the limits are fixed in docker-compose.yml, not left to Docker's defaults
  it("declares a CPU, memory and process-count limit for the workload, with swap equal to memory", () => {
    expect(declared).toEqual({
      cpus: CPUS,
      mem_limit: String(MEMORY_BYTES),
      memswap_limit: String(MEMORY_BYTES),
      pids_limit: PIDS,
    });
  });

  // proves D-025 Inc 3: Docker applies those limits to a workload container it starts
  it("starts the workload container with exactly those limits", () => {
    expect(applied).toEqual({ NanoCpus: CPUS * 1e9, Memory: MEMORY_BYTES, MemorySwap: MEMORY_BYTES, PidsLimit: PIDS });
  });
});

describe("the workload memory limit is hit (D-025 Inc 3)", () => {
  // guards the next test: the probe itself works, so a kill above the limit is the limit's doing
  it("lets the workload use 256 MiB", async () => {
    const outcome = await inWorkload(MEMORY_PROBE, ["256"]);
    expect(outcome).toMatchObject({ code: 0, stdout: "allocated 256" });
  });

  // proves D-025 Inc 3: a workload that tries to use more than 512 MiB is killed by the memory limit
  it("kills the workload when it tries to use 1024 MiB", async () => {
    const name = `${project}-oom`;
    try {
      const outcome = await inWorkload(MEMORY_PROBE, ["1024"], name);
      expect(outcome.code).toBe(137);
      expect(outcome.stdout).not.toContain("allocated");
      const state = JSON.parse(await dockerOk(["inspect", "--format", "{{json .State}}", name])) as { OOMKilled?: unknown };
      expect(state.OOMKilled).toBe(true);
    } finally {
      await docker(["rm", "-f", name]);
    }
  });
});

describe("the workload process-count limit is hit (D-025 Inc 3)", () => {
  // guards the next test: below the limit every child process starts
  it("lets the workload run 40 child processes", async () => {
    const outcome = await inWorkload(PIDS_PROBE, ["40"]);
    expect(outcome.code).toBe(0);
    const report = parseAtBoundary("pids probe", PidsReport, JSON.parse(outcome.stdout));
    expect(report).toEqual({ running: 40, errors: [], pidsMax: String(PIDS) });
  });

  // proves D-025 Inc 3: asking for 400 processes stops at the 128-task limit with EAGAIN
  it("refuses new processes once the workload holds 128 tasks", async () => {
    const outcome = await inWorkload(PIDS_PROBE, ["400"]);
    expect(outcome.code).toBe(0);
    const report = parseAtBoundary("pids probe", PidsReport, JSON.parse(outcome.stdout));
    expect(report.errors).toEqual(["EAGAIN"]);
    expect(report.pidsMax).toBe(String(PIDS));
    // The node parent's own threads count against the limit too; it has far fewer than 32.
    expect(report.running).toBeLessThan(PIDS);
    expect(report.running).toBeGreaterThanOrEqual(PIDS - 32);
  });
});

describe("the workload CPU limit is hit (D-025 Inc 3)", () => {
  // guards the next test: unlimited, the same probe uses well over one CPU, so its demand exceeds the limit
  it("uses more than 1.5 CPUs with three busy threads when no CPU limit is set", async () => {
    const outcome = await docker([
      "run", "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      WORKLOAD_IMAGE, "-e", CPU_PROBE, "3", "3000",
    ]);
    expect(outcome.code).toBe(0);
    const report = parseAtBoundary("cpu probe", CpuReport, JSON.parse(outcome.stdout));
    // The proof needs a host with at least two CPUs; on fewer the host, not the limit, would cap the probe.
    expect(report.hostCpus).toBeGreaterThanOrEqual(2);
    expect(report.cpusUsed).toBeGreaterThan(1.5);
  });

  // proves D-025 Inc 3: under docker-compose.yml the same demand is held to the one-CPU limit
  it("holds three busy threads to one CPU in the workload", async () => {
    const outcome = await inWorkload(CPU_PROBE, ["3", "3000"]);
    expect(outcome.code).toBe(0);
    const report = parseAtBoundary("cpu probe", CpuReport, JSON.parse(outcome.stdout));
    expect(report.cpusUsed).toBeLessThanOrEqual(CPUS * 1.15);
    expect(report.cpusUsed).toBeGreaterThanOrEqual(CPUS * 0.8);
  });
});
