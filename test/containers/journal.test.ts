import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { WORK_NAMESPACE, parseAtBoundary, pathWithin, pathsOverlap } from "../../packages/contracts/src/index.js";

// Increment 2: the journal lives on journal-vol, written by the runner, and
// the workload can neither read nor write it (§3.4.1, build plan §1). Every
// Docker call goes through execFile with an argv array; there is no shell (§2.4).

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const composeFile = fileURLToPath(new URL("../../containers/docker-compose.yml", import.meta.url));
// Its own project, so the volumes start empty and are removed afterwards.
const project = "juno-verify-journal";
const compose = ["compose", "-f", composeFile, "-p", project];

async function docker(args: string[]): Promise<string> {
  const { stdout } = await run("docker", args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

// Runs in the runner container with the built journal package. Mode `write`
// appends one entry whose actor and payload carry the canary; every mode then
// reads the trajectory back through the read interface, which verifies it.
const RUNNER_SCRIPT = [
  'const { JournalWriter, readTrajectory, readPayload } = await import("/app/dist/journal/src/index.js");',
  'const layout = await import("/app/dist/journal/src/layout.js");',
  "const [mode, canary] = process.argv.slice(1);",
  "const root = process.env.JUNO_JOURNAL_DIR;",
  'const task = "journal-isolation-probe";',
  'if (mode === "write") {',
  "  JournalWriter.open(root).append(task, {",
  '    kind: "note", actor: "probe-" + canary, provider: null,',
  '    data_class: { sensitivity: "internal", integrity: "operator" },',
  "    cost: { tokens_in: 0, tokens_out: 0, tokens_cached: 0, currency: 0, duration_ms: 0 },",
  '  }, new TextEncoder().encode("canary " + canary));',
  "}",
  "const entries = readTrajectory(root, task);",
  "const payloads = entries.map((entry) => {",
  "  const read = readPayload(root, entry.payload_ref);",
  '  return read.status === "present" ? new TextDecoder().decode(read.bytes) : read.status;',
  "});",
  "const first = entries[0];",
  "process.stdout.write(JSON.stringify({",
  "  uid: process.getuid(), actors: entries.map((entry) => entry.actor), payloads,",
  "  paths: { entries: layout.entriesFile(root, task), head: layout.headFile(root, task),",
  "    blob: first === undefined ? null : layout.blobFile(root, first.payload_ref) },",
  "}));",
].join("\n");

const RunnerReport = z.object({
  uid: z.number(),
  actors: z.array(z.string()),
  payloads: z.array(z.string()),
  paths: z.object({ entries: z.string(), head: z.string(), blob: z.string().nullable() }),
});

// Runs in the workload container. It tries to read and write the journal by
// the exact paths the runner used, then reads every file it can reach and
// looks for the canary. A control marker it writes itself must be found, so
// the scan cannot pass by reading nothing.
const WORKLOAD_PROBE = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  "const [canary, control, entriesPath, headPath, blobPath] = process.argv.slice(1);",
  "const attempt = (action) => { try { action(); return null; } catch (error) { return error.code || String(error); } };",
  "const report = {",
  "  readEntries: attempt(() => fs.readFileSync(entriesPath)),",
  "  readHead: attempt(() => fs.readFileSync(headPath)),",
  "  readBlob: attempt(() => fs.readFileSync(blobPath)),",
  '  listJournal: attempt(() => fs.readdirSync("/journal")),',
  '  appendEntries: attempt(() => fs.appendFileSync(entriesPath, "forged\\n")),',
  '  createJournal: attempt(() => fs.mkdirSync("/journal/tasks", { recursive: true })),',
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
  listJournal: z.string().nullable(),
  appendEntries: z.string().nullable(),
  createJournal: z.string().nullable(),
  files: z.number(),
  found: z.object({ canary: z.array(z.string()), control: z.array(z.string()) }),
});

async function runner(mode: "write" | "read", canary: string): Promise<z.output<typeof RunnerReport>> {
  const stdout = await docker([...compose, "run", "--rm", "--no-deps", "runner", "node", "--input-type=module", "-e", RUNNER_SCRIPT, mode, canary]);
  return parseAtBoundary("runner journal probe", RunnerReport, JSON.parse(stdout));
}

describe("journal-vol: written by the runner, unreachable from the workload (§3.4.1)", () => {
  const canary = `juno-canary-${randomBytes(16).toString("hex")}`;
  const control = `juno-control-${randomBytes(16).toString("hex")}`;
  let written: z.output<typeof RunnerReport>;
  let probe: z.output<typeof WorkloadReport>;
  let after: z.output<typeof RunnerReport>;

  beforeAll(async () => {
    await docker([...compose, "down", "--volumes", "--remove-orphans"]);
    written = await runner("write", canary);
    const { entries, head, blob } = written.paths;
    const stdout = await docker([...compose, "run", "--rm", "--no-deps", "workload", "-e", WORKLOAD_PROBE, canary, control, entries, head, blob ?? "/journal"]);
    probe = parseAtBoundary("workload journal probe", WorkloadReport, JSON.parse(stdout));
    after = await runner("read", canary);
  });

  afterAll(async () => {
    await docker([...compose, "down", "--volumes", "--remove-orphans"]);
  });

  // proves build plan Inc 2 "writer lives in juno-runner; storage on journal-vol": the runner, as non-root, writes and reads back a verified entry
  it("lets the runner write an entry and read it back verified", () => {
    expect(written.uid).not.toBe(0);
    expect(written.actors).toEqual([`probe-${canary}`]);
    expect(written.payloads).toEqual([`canary ${canary}`]);
    expect(pathWithin(written.paths.entries, "/journal")).toBe(true);
    expect(written.paths.blob).not.toBeNull();
  });

  // proves build plan Inc 2: the workload cannot read journal-vol — read attempts at the runner's exact paths fail
  it("fails every workload read of the journal", () => {
    expect(probe.readEntries).not.toBeNull();
    expect(probe.readHead).not.toBeNull();
    expect(probe.readBlob).not.toBeNull();
    expect(probe.listJournal).not.toBeNull();
  });

  // proves build plan Inc 2: the workload cannot write journal-vol
  it("fails every workload write to the journal", () => {
    expect(probe.appendEntries).not.toBeNull();
    expect(probe.createJournal).not.toBeNull();
  });

  // proves §3.4.1: the journal's content is nowhere in the workload's filesystem, under any path
  it("finds the journal's canary in no file the workload can read", () => {
    expect(probe.found.canary).toEqual([]);
  });

  // guards the scan against passing vacuously: it read many files and found a marker the workload itself wrote
  it("scans a real filesystem", () => {
    expect(probe.files).toBeGreaterThan(100);
    expect(probe.found.control).toEqual(["/tmp/juno-scan-control"]);
  });

  // proves §3.4.2 across containers: after the workload's attempts the journal is unchanged, still verifies, and outlives the container that wrote it
  it("leaves the journal unchanged and verifiable after the workload's attempts", () => {
    expect(after.actors).toEqual(written.actors);
    expect(after.payloads).toEqual(written.payloads);
  });
});

const ComposeConfig = z.object({
  services: z.record(
    z.string(),
    z.object({
      volumes: z.array(z.object({ source: z.string().optional(), target: z.string() })).optional(),
      environment: z.record(z.string(), z.string().nullable()).optional(),
    }),
  ),
});

describe("docker-compose.yml namespaces (§3.2, §3.4.1)", () => {
  let config: z.output<typeof ComposeConfig>;

  beforeAll(async () => {
    config = parseAtBoundary("compose config", ComposeConfig, JSON.parse(await docker([...compose, "config", "--format", "json"])));
  });

  // proves §3.4.1: the capability namespace that path selectors name is exactly where the workload sees the work volume
  it("mounts work-vol in the workload at the capability namespace root", () => {
    const workload = config.services["workload"]?.volumes ?? [];
    expect(workload.filter((volume) => volume.source === "work-vol").map((volume) => volume.target)).toEqual([WORK_NAMESPACE]);
  });

  // proves §3.2 "no selector may name journal storage": journal-vol is mounted nowhere a path selector can reach, in any service
  it("mounts journal-vol only outside the capability namespace", () => {
    for (const [service, definition] of Object.entries(config.services)) {
      for (const volume of definition.volumes ?? []) {
        if (volume.source === "journal-vol") {
          expect({ service, target: volume.target, overlaps: pathsOverlap(volume.target, WORK_NAMESPACE) }).toEqual({
            service,
            target: volume.target,
            overlaps: false,
          });
        }
      }
    }
  });

  // proves §3.4.1: the runner writes the journal exactly where journal-vol is mounted
  it("points the runner's journal directory at the journal-vol mount", () => {
    const runnerService = config.services["runner"];
    const target = runnerService?.volumes?.find((volume) => volume.source === "journal-vol")?.target;
    expect(target).toBeDefined();
    expect(runnerService?.environment?.["JUNO_JOURNAL_DIR"]).toBe(target);
  });
});
