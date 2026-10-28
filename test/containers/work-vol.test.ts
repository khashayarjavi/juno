import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { WORK_NAMESPACE, parseAtBoundary } from "../../packages/contracts/src/index.js";

// Increment 3: work-vol belongs to the workload user, whichever container
// mounts a new volume first (DECISIONS.md D-031). Every Docker call goes
// through execFile with an argv array (§2.4).

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const composeFile = fileURLToPath(new URL("../../containers/docker-compose.yml", import.meta.url));
const WORKLOAD_UID = 65532;

async function docker(args: readonly string[]): Promise<string> {
  const { stdout } = await run("docker", args, { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

// Reports who owns the work volume's root and whether this process can create a file in it.
const PROBE = [
  'const fs = require("node:fs");',
  "const root = process.argv[1];",
  "const stat = fs.statSync(root);",
  "let writeError = null;",
  'try { fs.writeFileSync(root + "/probe-" + process.getuid(), "x"); } catch (error) { writeError = error.code || String(error); }',
  "process.stdout.write(JSON.stringify({ uid: process.getuid(), owner: stat.uid, group: stat.gid, mode: stat.mode & 0o777, writeError }));",
].join("\n");

const Report = z.object({ uid: z.number(), owner: z.number(), group: z.number(), mode: z.number(), writeError: z.string().nullable() });

async function probe(project: string, service: "runner" | "workload"): Promise<z.output<typeof Report>> {
  const compose = ["compose", "-f", composeFile, "-p", project];
  const command = service === "runner" ? ["node", "-e", PROBE, WORK_NAMESPACE] : ["-e", PROBE, WORK_NAMESPACE];
  return parseAtBoundary("work-vol probe", Report, JSON.parse(await docker([...compose, "run", "--rm", "--no-deps", "-T", service, ...command])));
}

const projects = ["juno-verify-workvol-runner-first", "juno-verify-workvol-workload-first"];

afterAll(async () => {
  for (const project of projects) await docker(["compose", "-f", composeFile, "-p", project, "down", "--volumes", "--remove-orphans"]);
});

describe("work-vol ownership (build plan §1, D-031)", () => {
  // proves build plan §1 "work-vol (rw)" for the non-root workload: a new volume first mounted by the runner is still the workload's
  it("gives a new volume to the workload user when the runner mounts it first", async () => {
    const [project] = projects as [string, string];
    const fromRunner = await probe(project, "runner");
    const fromWorkload = await probe(project, "workload");
    expect(fromRunner).toMatchObject({ owner: WORKLOAD_UID, group: WORKLOAD_UID, mode: 0o755 });
    expect(fromWorkload).toEqual({ uid: WORKLOAD_UID, owner: WORKLOAD_UID, group: WORKLOAD_UID, mode: 0o755, writeError: null });
  });

  // proves build plan §1 "work-vol (rw)": the same holds when the workload mounts a new volume first
  it("gives a new volume to the workload user when the workload mounts it first", async () => {
    const [, project] = projects as [string, string];
    const fromWorkload = await probe(project, "workload");
    expect(fromWorkload).toEqual({ uid: WORKLOAD_UID, owner: WORKLOAD_UID, group: WORKLOAD_UID, mode: 0o755, writeError: null });
  });

  // records D-031: the runner reads the work volume but cannot write it
  it("does not let the runner write the work volume", async () => {
    const [project] = projects as [string, string];
    const fromRunner = await probe(project, "runner");
    expect(fromRunner.uid).not.toBe(WORKLOAD_UID);
    expect(fromRunner.writeError).toBe("EACCES");
  });
});
