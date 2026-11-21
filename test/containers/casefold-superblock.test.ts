import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

// D-241 ruling 1 (D-242): `juno hook check`, run as root, confirms that case folding is switched off for the whole
// file system holding the workspace, read from its ext4 superblock, and refuses otherwise in plain words. The ruling
// asks for the refusal to be tested against a real file system made with casefold on, in a container. The driver
// (casefold-superblock/driver.mjs) runs in one sealed container from the runner image: no network, every capability
// dropped, no new privileges, a read-only root and one scratch tmpfs. It makes the file systems with the image's own
// mkfs.ext4 and tune2fs, reads them with dumpe2fs, and judges them with JUNO's built reader and refusals. Every Docker
// call goes through execFile with an argv array; there is no shell.

const run = promisify(execFile);
const fixtures = fileURLToPath(new URL("./casefold-superblock", import.meta.url));

type Exit = { code: number; stdout: string; stderr: string };
type Read = { ok: true; blockDevice: unknown; folding: { ok: boolean; casefold?: boolean; encoding?: number } } | { ok: false; error: string };
type Results = {
  made: Record<"casefold" | "plain" | "later" | "laterTune", Exit>;
  features: Record<"casefold" | "plain" | "later", string | null>;
  read: Record<"casefold" | "plain" | "later", Read>;
  refusals: Record<"casefold" | "plain" | "later", string[]>;
  realTmpfs: string[];
};

let results: Results;

beforeAll(async () => {
  const { stdout } = await run(
    "docker",
    [
      "run", "--rm", "--user", "0", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only",
      "--mount", ["type=bind", ["source", fixtures].join("="), "target=/t", "readonly"].join(","),
      "--tmpfs", "/scratch:mode=0700,size=64m",
      "--entrypoint", "/usr/local/bin/node", "juno-runner:local", "/t/driver.mjs",
    ],
    { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
  );
  results = JSON.parse(stdout) as Results;
}, 180_000);

describe("D-242: juno hook check reads case folding from a real ext4 superblock (D-241 ruling 1)", () => {
  // proves the file systems are real and as described: mkfs.ext4 and tune2fs made them, dumpe2fs reads their features
  it("makes real ext4 file systems with and without the casefold feature", () => {
    for (const made of Object.values(results.made)) expect(made.code).toBe(0);
    expect(results.features.casefold).toMatch(/\bcasefold\b/);
    expect(results.features.later).toMatch(/\bcasefold\b/);
    expect(results.features.plain).toMatch(/^Filesystem features:\s+has_journal\b/);
    expect(results.features.plain).not.toMatch(/casefold/);
  });

  // proves D-241 ruling 1: JUNO's reader finds the feature where dumpe2fs does, and takes a regular file for no block device
  it("reads the casefold feature from the superblock as dumpe2fs does", () => {
    expect(results.read.casefold).toMatchObject({ ok: true, blockDevice: null, folding: { ok: true, casefold: true } });
    expect(results.read.later).toMatchObject({ ok: true, blockDevice: null, folding: { ok: true, casefold: true } });
    expect(results.read.plain).toMatchObject({ ok: true, blockDevice: null, folding: { ok: true, casefold: false, encoding: 0 } });
  });

  // proves D-241 ruling 1: the refusal juno hook check gives, in plain words, for a file system made with casefold on
  // or given it later by root; none for one without it
  it("refuses a workspace on a real ext4 with casefold on, and accepts one without it", () => {
    for (const name of ["casefold", "later"] as const) {
      expect(results.refusals[name]).toHaveLength(1);
      expect(results.refusals[name][0]).toMatch(/^the workspace \/srv\/juno-work is on an ext4 file system \(\/dev\/loop0, mounted at \/srv\/juno-work\) with ext4's case-folding feature switched on \(casefold in its superblock\), so a folder there can be made to ignore letter case; JUNO accepts only a file system made without that feature \(dumpe2fs -h \/dev\/loop0 must not list casefold\) \(D-242\)$/);
    }
    expect(results.refusals.plain).toEqual([]);
    expect(results.realTmpfs).toEqual([]);
  });
});
