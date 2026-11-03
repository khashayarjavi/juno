import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CapabilityRegistry, WorkloadExecFileAdapter, canaryValue } from "../../packages/registry/src/index.js";

// Increment 3: shell.run through the conforming adapter, against the real
// workload container (§2.4, §18). Every Docker call goes through execFile
// with an argv array; there is no shell here either.

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const composeFile = fileURLToPath(new URL("../../containers/docker-compose.yml", import.meta.url));
const definitionFile = fileURLToPath(new URL("../../packages/registry/definitions/shell.run.json", import.meta.url));
const project = "juno-verify-registry";
const compose = ["compose", "-f", composeFile, "-p", project];
const CAT = "/usr/bin/cat";

async function docker(args: readonly string[]): Promise<string> {
  const { stdout } = await run("docker", args, { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

const tag = randomBytes(8).toString("hex");
// A directory under /work named by a canary, holding a marker file: the call's cwd.
const cwdCanary = "/work/" + canaryValue(tag, 0);
const argvCanaries = [canaryValue(tag, 1), canaryValue(tag, 2)];
const marker = "juno-marker-" + randomBytes(8).toString("hex");

const registry = new CapabilityRegistry();

beforeAll(async () => {
  await docker([...compose, "down", "--volumes", "--remove-orphans"]);
  const result = registry.register(JSON.parse(readFileSync(definitionFile, "utf8")), [
    new WorkloadExecFileAdapter({ composeFile, project, service: "workload" }),
  ]);
  if (!result.registered) throw new Error(`shell.run did not register: ${JSON.stringify(result.refusals)}`);
  // Set up the canary directory as the workload user, with node, outside the capability under test.
  const setup = 'const fs = require("node:fs"); fs.mkdirSync(process.argv[1]); fs.writeFileSync(process.argv[1] + "/marker", process.argv[2]);';
  await docker([...compose, "run", "--rm", "--no-deps", "-T", "workload", "-e", setup, cwdCanary, marker]);
});

afterAll(async () => {
  await docker([...compose, "down", "--volumes", "--remove-orphans"]);
});

describe("shell.run through the conforming adapter, in the workload container (§2.4)", () => {
  // proves §2.4 / build plan Inc 3: the canary survives intact — the program receives each canary as one whole argv element
  it("delivers each argv canary to the program as one discrete, byte-identical argv element", async () => {
    // cat prints its own command line: the argv exactly as execve received it, NUL-separated.
    const result = await registry.invoke("shell.run", { program: CAT, argv: ["/proc/self/cmdline", ...argvCanaries], cwd: cwdCanary });
    expect(result.stdout.toString("utf8").split("\0")).toEqual([CAT, "/proc/self/cmdline", ...argvCanaries, ""]);
    // The canaries name no files, so cat reports them missing; nothing in them was run.
    expect(result.exitCode).toBe(1);
  });

  // proves §2.4: the cwd canary arrives intact — the program runs in exactly that directory
  it("runs the program in the canary-named working directory", async () => {
    const result = await registry.invoke("shell.run", { program: CAT, argv: ["marker"], cwd: cwdCanary });
    expect({ exitCode: result.exitCode, stdout: result.stdout.toString("utf8") }).toEqual({ exitCode: 0, stdout: marker });
  });

  // proves §2.4: an empty argv arrives empty; the image's default command is not appended
  it("delivers an empty argv as no arguments", async () => {
    const result = await registry.invoke("shell.run", { program: CAT, argv: [], cwd: "/work" });
    expect({ exitCode: result.exitCode, stdout: result.stdout.toString("utf8") }).toEqual({ exitCode: 0, stdout: "" });
  });

  // proves build plan §1 for invocations: the program runs as the non-root workload user with no capabilities and the process limit
  it("runs the program under the workload's isolation settings", async () => {
    const status = (await registry.invoke("shell.run", { program: CAT, argv: ["/proc/self/status"], cwd: "/work" })).stdout.toString("utf8");
    expect(status).toMatch(/^Uid:\s+65532\s+65532\s+65532\s+65532$/m);
    expect(status).toMatch(/^CapEff:\s+0000000000000000$/m);
    // pids.max sits at a different path on cgroup v2 and v1; exactly one exists.
    const pids = await registry.invoke("shell.run", { program: CAT, argv: ["/sys/fs/cgroup/pids.max", "/sys/fs/cgroup/pids/pids.max"], cwd: "/work" });
    expect(pids.stdout.toString("utf8").trim()).toBe("128");
  });

  // proves D-067 / build plan §1: the discovery program runs in the workload, and neither it nor its libraries belong to the workload user
  it("runs ls in the workload, with ls and its libraries owned by root", async () => {
    const listing = await registry.invoke("shell.run", { program: "/usr/bin/ls", argv: ["-l", "-n", "--", "/usr/bin/ls", "/usr/bin/cat"], cwd: "/work" });
    expect(listing.exitCode).toBe(0);
    const owners = listing.stdout.toString("utf8").trim().split("\n").map((line) => line.split(/\s+/).slice(2, 4).join(":"));
    expect(owners).toEqual(["0:0", "0:0"]);
    const libraries = await registry.invoke("shell.run", { program: "/usr/bin/ls", argv: ["-l", "-n", "-R", "--", "/lib"], cwd: "/work" });
    const libLines = libraries.stdout.toString("utf8").split("\n").filter((line) => /lib(selinux|pcre2-8)\.so/.test(line));
    expect(libLines).toHaveLength(2);
    for (const line of libLines) expect(line.split(/\s+/).slice(2, 4)).toEqual(["0", "0"]);
  });

  // proves §3.4.4 B2 / D-112: the verifier's hashing program runs in the workload, owned by root, and prints NUL-terminated records with raw names
  it("runs sha256sum -z in the workload, owned by root", async () => {
    const owner = await registry.invoke("shell.run", { program: "/usr/bin/ls", argv: ["-l", "-n", "--", "/usr/bin/sha256sum"], cwd: "/work" });
    expect(owner.stdout.toString("utf8").trim().split(/\s+/).slice(2, 4)).toEqual(["0", "0"]);
    const hashed = await registry.invoke("shell.run", { program: "/usr/bin/sha256sum", argv: ["-z", "--", "/usr/bin/cat", "/work/does-not-exist"], cwd: "/work" });
    expect(hashed.exitCode).toBe(1);
    expect(hashed.stdout.toString("utf8")).toMatch(/^[0-9a-f]{64} {2}\/usr\/bin\/cat\0$/);
  });
});
