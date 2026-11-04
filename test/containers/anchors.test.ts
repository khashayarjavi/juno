import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { AnchorExistsError, ContainerAnchorSink, anchorOf, anchorSignatureValid, taskDigest } from "../../packages/journal/src/index.js";

// §3.4.1 (v0.6.1 V6-4; DECISIONS.md D-122): in tests the off-host destination is "a separate container exposing an
// append-only interface and holding its own volume". This proves the stand-in: it appends and lists, refuses to
// replace an anchor and has no delete; only it mounts its volume; it runs with the workload's seal. Every Docker call
// is execFile with an argv array.

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const composeFile = fileURLToPath(new URL("../../containers/docker-compose.yml", import.meta.url));
const project = "juno-verify-anchors";
const compose = ["compose", "-f", composeFile, "-p", project];
const key = generateKeyPairSync("ed25519");
const sink = new ContainerAnchorSink({ composeFile, project, service: "anchors" });
const TASK = "task-anchored";

async function docker(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("docker", args, { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error: unknown) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failed.code === "number" ? failed.code : -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

beforeAll(async () => {
  await docker([...compose, "--profile", "anchors", "down", "--volumes", "--remove-orphans"]);
});
afterAll(async () => {
  await docker([...compose, "--profile", "anchors", "down", "--volumes", "--remove-orphans"]);
});

describe("the append-only anchor store (§3.4.1, D-122)", () => {
  // proves §3.4.1: anchors appended to the separate container are listed back exactly, with valid signatures
  it("appends and lists anchors", async () => {
    const first = anchorOf(TASK, { seq: 3, hash: `sha256:${"a".repeat(64)}` }, new Date("2026-11-04T10:00:00Z"), key.privateKey);
    const second = anchorOf(TASK, { seq: 9, hash: `sha256:${"b".repeat(64)}` }, new Date("2026-11-04T10:01:00Z"), key.privateKey);
    await sink.append(first);
    await sink.append(second);
    const listed = await sink.list(taskDigest(TASK));
    expect(listed).toEqual([first, second]);
    expect(listed.every((anchor) => anchorSignatureValid(anchor as typeof first, key.publicKey))).toBe(true);
  });

  // proves §3.4.1 V6-4: an anchor already written is never overwritten, even by a validly signed one (a stolen key)
  it("refuses to overwrite an anchor", async () => {
    const replacement = anchorOf(TASK, { seq: 3, hash: `sha256:${"c".repeat(64)}` }, new Date(), key.privateKey);
    await expect(sink.append(replacement)).rejects.toBeInstanceOf(AnchorExistsError);
    expect(((await sink.list(taskDigest(TASK))) as { head: string }[])[0]?.head).toBe(`sha256:${"a".repeat(64)}`);
  });

  // proves §3.4.1: the store has no delete (or any other) operation, and a delete leaves every anchor in place
  it("has no delete operation", async () => {
    const attempt = await docker([...compose, "run", "--rm", "--no-deps", "-T", "anchors", "delete", taskDigest(TASK), "000000000003"]);
    expect(attempt.code).not.toBe(0);
    expect(attempt.stderr).toContain("only append and list exist");
    expect((await sink.list(taskDigest(TASK))).length).toBe(2);
  });

  // proves §3.4.1: the store's volume is its own; the workload neither mounts it nor can reach it
  it("keeps its volume to itself", async () => {
    const config = z
      .object({ services: z.record(z.string(), z.object({ volumes: z.array(z.object({ source: z.string().optional(), target: z.string() })).optional(), network_mode: z.string().optional(), cap_drop: z.array(z.string()).optional(), user: z.string().optional() })) })
      .parse(JSON.parse((await docker([...compose, "--profile", "anchors", "config", "--format", "json"])).stdout));
    const mounting = Object.entries(config.services).filter(([, service]) => (service.volumes ?? []).some((volume) => volume.source === "anchors-vol")).map(([name]) => name);
    expect(mounting).toEqual(["anchors"]);
    const anchors = config.services["anchors"];
    expect(anchors?.network_mode).toBe("none");
    expect(anchors?.cap_drop).toEqual(["ALL"]);
    expect(anchors?.user).toBe("65533:65533");
    const probe = await docker([...compose, "run", "--rm", "--no-deps", "-T", "workload", "-e", 'const fs = require("node:fs"); process.stdout.write(String(fs.existsSync("/anchors")));']);
    expect(probe.stdout).toBe("false");
  });
});
