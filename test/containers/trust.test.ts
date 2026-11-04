import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// §3.2 (v0.6 C1), D-116: the runner, as the user it runs as in its image (1000), loads the operator's public key only
// from a file it cannot write in a directory it cannot write. The key is generated for this run and never committed.
// Every Docker call goes through execFile with an argv array; there is no shell.

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const composeFile = fileURLToPath(new URL("../../containers/docker-compose.yml", import.meta.url));
const project = "juno-verify-trust";
const compose = ["compose", "-f", composeFile, "-p", project];
const RUNNER_UID = 1000;

// Runs in the runner container: loads the anchor with the built runner code and reports the outcome.
const PROBE = [
  'const { loadTrustAnchor } = await import("/app/dist/runner/src/trust.js");',
  "try { const key = loadTrustAnchor(process.argv[1]); process.stdout.write(JSON.stringify({ ok: true, type: key.asymmetricKeyType })); }",
  "catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: String(error.message) })); }",
].join("\n");

const hostDir = mkdtempSync(join(tmpdir(), "juno-trust-"));
const pem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });

/**
 * Setup only, not under test: as root in a throwaway container from the runner image (the sealed runner service cannot
 * change owners), lay out each case's directory holding `operator.pub`, with the given owners and modes. The host
 * process may not be root (CI is not), so it never changes owners itself.
 */
const SETUP = [
  'const fs = require("node:fs");',
  "const cases = JSON.parse(process.argv[1]);",
  "for (const c of cases) {",
  '  const dir = "/h/" + c.name; fs.mkdirSync(dir); fs.copyFileSync("/h/source.pem", dir + "/operator.pub");',
  '  fs.chownSync(dir + "/operator.pub", c.file.uid, c.file.uid); fs.chmodSync(dir + "/operator.pub", c.file.mode);',
  "  fs.chownSync(dir, c.dir.uid, c.dir.uid); fs.chmodSync(dir, c.dir.mode);",
  "}",
].join("\n");
const CLEANUP = 'const fs = require("node:fs"); for (const name of fs.readdirSync("/h")) fs.rmSync("/h/" + name, { recursive: true, force: true });';
const CASES = [
  { name: "protected", dir: { uid: 0, mode: 0o755 }, file: { uid: 0, mode: 0o444 } },
  { name: "writable-file", dir: { uid: 0, mode: 0o755 }, file: { uid: RUNNER_UID, mode: 0o644 } },
  { name: "writable-dir", dir: { uid: RUNNER_UID, mode: 0o755 }, file: { uid: 0, mode: 0o444 } },
];

async function asRoot(script: string, ...args: string[]): Promise<void> {
  await run("docker", ["run", "--rm", "--user", "0", "--network", "none", "-v", [hostDir, "/h"].join(":"), "--entrypoint", "node", "juno-runner:local", "-e", script, ...args], { cwd: repoRoot });
}

async function load(dir: string): Promise<{ ok: boolean; type?: string; error?: string }> {
  const { stdout } = await run(
    "docker",
    [...compose, "run", "--rm", "--no-deps", "-v", [dir, "/anchor"].join(":"), "runner", "node", "--input-type=module", "-e", PROBE, "/anchor/operator.pub"],
    { cwd: repoRoot },
  );
  return JSON.parse(stdout) as { ok: boolean; type?: string; error?: string };
}

/** Starts the real runner (its image's own command) with the case's anchor configured; returns its exit and output. */
async function start(dir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("docker", [...compose, "run", "--rm", "--no-deps", "-e", "JUNO_TRUST_ANCHOR=/anchor/operator.pub", "-v", [dir, "/anchor"].join(":"), "runner"], { cwd: repoRoot });
    return { code: 0, stdout, stderr };
  } catch (error: unknown) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failed.code === "number" ? failed.code : -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

const outcomes = new Map<string, { ok: boolean; type?: string; error?: string }>();
const starts = new Map<string, { code: number; stdout: string; stderr: string }>();

beforeAll(async () => {
  chmodSync(hostDir, 0o755);
  writeFileSync(join(hostDir, "source.pem"), pem);
  await asRoot(SETUP, JSON.stringify(CASES));
  for (const { name } of CASES) {
    outcomes.set(name, await load(join(hostDir, name)));
    starts.set(name, await start(join(hostDir, name)));
  }
}, 300_000);

afterAll(async () => {
  await run("docker", [...compose, "down", "--volumes", "--remove-orphans"], { cwd: repoRoot });
  // The case directories belong to root and uid 1000: removed as root, then the empty host directory itself.
  await asRoot(CLEANUP).catch(() => undefined);
  rmSync(hostDir, { recursive: true, force: true });
});

describe("the trust anchor in the runner container (§3.2 C1, D-116)", () => {
  // proves §3.2 C1: the runner loads an anchor it cannot write, in a directory it cannot write
  it("loads a read-only anchor owned by another user", () => {
    expect(outcomes.get("protected")).toEqual({ ok: true, type: "ed25519" });
  });

  // proves §3.2 C1: the runner refuses an anchor it could write, or one in a directory where it could replace it
  it.each([["writable-file"], ["writable-dir"]])("refuses the %s anchor", (name) => {
    expect(outcomes.get(name)).toMatchObject({ ok: false, error: expect.stringContaining("not protected") });
  });

  // proves §3.2 C1 (D-125): the runner itself starts with a protected anchor and refuses to start with a writable one
  it("starts the runner only when its anchor is protected", () => {
    expect(starts.get("protected")).toMatchObject({ code: 0, stdout: expect.stringContaining("trust anchor: /anchor/operator.pub") });
    for (const name of ["writable-file", "writable-dir"]) {
      const outcome = starts.get(name);
      expect(outcome?.code, name).toBe(1);
      expect(outcome?.stderr, name).toContain("not protected");
      expect(outcome?.stdout, name).not.toContain("ready");
    }
  });
});
