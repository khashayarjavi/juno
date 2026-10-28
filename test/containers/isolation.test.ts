import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { parseAtBoundary } from "../../packages/contracts/src/index.js";

// Runs after `make containers` has built both images. Every Docker call goes
// through execFile with an argv array; there is no shell here either (§2.4).

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const composeFile = fileURLToPath(new URL("../../containers/docker-compose.yml", import.meta.url));
// A separate project name, so the checks never touch a developer's own stack.
const project = "juno-verify";
const compose = ["compose", "-f", composeFile, "-p", project];
const WORKLOAD_IMAGE = "juno-workload:local";

async function docker(args: string[]): Promise<string> {
  const { stdout } = await run("docker", args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function dockerFails(args: string[]): Promise<boolean> {
  try {
    await run("docker", args, { cwd: repoRoot });
    return false;
  } catch {
    return true;
  }
}

/** Lists every path in a tar archive (ustar, with GNU and pax long names). */
function tarEntryNames(archive: Buffer): string[] {
  const names: string[] = [];
  let offset = 0;
  let longName: string | undefined;
  const text = (start: number, length: number): string => {
    const raw = archive.subarray(start, start + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
  };
  while (offset + 512 <= archive.length) {
    if (archive.subarray(offset, offset + 512).every((byte) => byte === 0)) break;
    const size = parseInt(text(offset + 124, 12).trim() || "0", 8);
    const type = text(offset + 156, 1);
    const body = archive.subarray(offset + 512, offset + 512 + size);
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0+$/, "");
    } else if (type === "x") {
      const match = /\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      if (match?.[1] !== undefined) longName = match[1];
    } else if (type !== "g") {
      const prefix = text(offset + 345, 155);
      const name = text(offset, 100);
      names.push(longName ?? (prefix ? `${prefix}/${name}` : name));
      longName = undefined;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

const SHELLS = new Set(["sh", "bash", "dash", "ash", "zsh", "ksh", "mksh", "csh", "tcsh", "fish", "busybox", "toybox"]);

describe("juno-workload image", () => {
  let entries: string[] = [];

  beforeAll(async () => {
    const id = (await docker(["create", WORKLOAD_IMAGE])).trim();
    try {
      const { stdout } = await run("docker", ["export", id], {
        encoding: "buffer",
        maxBuffer: 1024 * 1024 * 1024,
      });
      entries = tarEntryNames(stdout);
    } finally {
      await docker(["rm", id]);
    }
  });

  // guards the next test against passing vacuously on an unreadable archive
  it("exports a readable filesystem containing the node runtime", () => {
    expect(entries.length).toBeGreaterThan(100);
    expect(entries.some((name) => name.replace(/^\.?\//, "") === "nodejs/bin/node")).toBe(true);
  });

  // proves build plan §1 / §2.4: no shell exists in the workload image
  it("contains no shell binary anywhere in its filesystem", () => {
    const shells = entries.filter((name) => SHELLS.has(name.split("/").pop() ?? ""));
    expect(shells).toEqual([]);
  });

  // proves build plan §1 / §2.4: a shell cannot be started even when asked for directly
  it.each(["/bin/sh", "/bin/bash", "/usr/bin/sh", "/bin/busybox"])("cannot start %s", async (shell) => {
    expect(await dockerFails(["run", "--rm", "--network", "none", "--entrypoint", shell, WORKLOAD_IMAGE, "-c", "true"])).toBe(
      true,
    );
  });

  // proves build plan §1: the image's default user is not root
  it("defaults to a non-root user", async () => {
    const user = (await docker(["image", "inspect", "--format", "{{.Config.User}}", WORKLOAD_IMAGE])).trim();
    expect(user).not.toBe("");
    expect(user.split(":")[0]).not.toMatch(/^(0|root)$/);
  });
});

const ProbeReport = z.object({
  uid: z.number(),
  gid: z.number(),
  capEff: z.string(),
  capBnd: z.string(),
  capPrm: z.string(),
  noNewPrivs: z.string(),
  interfaces: z.array(z.string()),
  connectError: z.string().nullable(),
  journalVisible: z.boolean(),
});

// Executed by node inside the workload container, as a constant argv element.
const PROBE = [
  'const fs = require("node:fs");',
  'const os = require("node:os");',
  'const net = require("node:net");',
  'const status = fs.readFileSync("/proc/self/status", "utf8");',
  'const field = (k) => (status.match(new RegExp("^" + k + ":\\\\s*(\\\\S+)", "m")) || [])[1] || "";',
  "const report = {",
  "  uid: process.getuid(), gid: process.getgid(),",
  '  capEff: field("CapEff"), capBnd: field("CapBnd"), capPrm: field("CapPrm"),',
  '  noNewPrivs: field("NoNewPrivs"),',
  "  interfaces: Object.keys(os.networkInterfaces()),",
  '  journalVisible: fs.existsSync("/journal"),',
  "};",
  'const socket = net.connect({ host: "1.1.1.1", port: 443, timeout: 3000 });',
  'const done = (err) => { report.connectError = err; socket.destroy(); process.stdout.write(JSON.stringify(report)); };',
  'socket.on("connect", () => done(null));',
  'socket.on("timeout", () => done("timeout"));',
  'socket.on("error", (e) => done(e.code || String(e)));',
].join("\n");

describe("juno-workload as run by docker-compose.yml", () => {
  let report: z.output<typeof ProbeReport>;

  beforeAll(async () => {
    const stdout = await docker([...compose, "run", "--rm", "--no-deps", "workload", "-e", PROBE]);
    report = parseAtBoundary("workload probe", ProbeReport, JSON.parse(stdout));
  });

  afterAll(async () => {
    await docker([...compose, "down", "--volumes", "--remove-orphans"]);
  });

  // proves build plan §1: the workload runs as non-root
  it("runs as a non-root user", () => {
    expect(report.uid).not.toBe(0);
    expect(report.gid).not.toBe(0);
  });

  // proves build plan §1: all Linux capabilities are dropped
  it("holds no Linux capabilities", () => {
    expect(report.capEff).toBe("0000000000000000");
    expect(report.capPrm).toBe("0000000000000000");
    expect(report.capBnd).toBe("0000000000000000");
    expect(report.noNewPrivs).toBe("1");
  });

  // proves §2.2.1 / build plan §1: the workload has no network at all in Slice 1
  it("has no network interface but loopback, and cannot open an outbound connection", () => {
    expect(report.interfaces).toEqual(["lo"]);
    expect(report.connectError).not.toBeNull();
  });

  // proves §3.4.1: the journal volume is not mounted into the workload
  it("cannot see the journal mount point", () => {
    expect(report.journalVisible).toBe(false);
  });
});

const ComposeConfig = z.object({
  services: z.record(
    z.string(),
    z.object({
      volumes: z.array(z.object({ source: z.string().optional(), target: z.string() })).optional(),
      network_mode: z.string().optional(),
      cap_drop: z.array(z.string()).optional(),
    }),
  ),
});

describe("docker-compose.yml topology", () => {
  let config: z.output<typeof ComposeConfig>;

  beforeAll(async () => {
    config = parseAtBoundary("compose config", ComposeConfig, JSON.parse(await docker([...compose, "config", "--format", "json"])));
  });

  // proves §3.4.1: only the runner mounts journal-vol; the workload never does
  it("mounts journal-vol into the runner and not into the workload", () => {
    const sources = (service: string) => (config.services[service]?.volumes ?? []).map((volume) => volume.source);
    expect(sources("runner")).toContain("journal-vol");
    expect(sources("workload")).not.toContain("journal-vol");
    expect(sources("workload")).toContain("work-vol");
  });

  // proves build plan §1: the workload's isolation is declared, not left to defaults
  it("declares no network and drops all capabilities for the workload", () => {
    expect(config.services["workload"]?.network_mode).toBe("none");
    expect(config.services["workload"]?.cap_drop).toEqual(["ALL"]);
  });
});

const PsEntry = z.object({ Service: z.string(), State: z.string(), ExitCode: z.number() });

describe("docker compose up", () => {
  // proves build plan Increment 0: the two-container stack runs and exits cleanly
  it("starts both services and both exit with code 0", async () => {
    const upProject = `${project}-up`;
    const upCompose = ["compose", "-f", composeFile, "-p", upProject];
    try {
      await docker([...upCompose, "up", "--abort-on-container-failure"]);
      const lines = (await docker([...upCompose, "ps", "--all", "--format", "json"]))
        .split("\n")
        .filter((line) => line.trim() !== "");
      const entries = lines.map((line) => parseAtBoundary("compose ps", PsEntry, JSON.parse(line)));
      expect(entries.map((entry) => entry.Service).sort()).toEqual(["runner", "workload"]);
      for (const entry of entries) {
        expect({ service: entry.Service, state: entry.State, exitCode: entry.ExitCode }).toEqual({
          service: entry.Service,
          state: "exited",
          exitCode: 0,
        });
      }
      const logs = await docker([...upCompose, "logs", "runner"]);
      expect(logs).toContain("juno-runner: ready");
    } finally {
      await docker([...upCompose, "down", "--volumes", "--remove-orphans"]);
    }
  });
});
