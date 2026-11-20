import { execFile } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore, FILE_MODE, type ManifestEntry, type SealedLauncher, SealedWorkspace, dockerSealedLauncher, probeContainerRuntime, runProgram, sealedDockerArgs } from "../../packages/enforcement/src/index.js";

// Operator ruling of 2026-11-20 on PR #60 (DECISIONS.md D-228), against the real container runtime (the root-run
// daemon in `make verify`, the runner's rootless one in `make verify-rootless`): every checkpoint copy and every restore
// of a hook workspace runs in a context that can reach nothing the Claude Code user cannot reach. Here, with the exact
// `docker run` arguments JUNO uses (`sealedDockerArgs`):
//   - the context cannot open the runner's journal key even when handed its exact path, directly or through a link
//     planted in the workspace; it has no capability, no new privileges, no network, a read-only image, and one mount;
//   - the traps of review rounds 1, 3, 4 and 5 of PR #60 (D-223, D-225, D-226, D-227), planted against the sealed
//     context, are refused or harmless;
//   - a folder put in the workspace's place before the mount is refused before anything is read or changed.
// No shell.

let dir: string;
let work: string;
let state: string;
let key: string;
let store: CheckpointStore;
let launcher: SealedLauncher;
let rootless: boolean;
const SECRET = "RUNNER-JOURNAL-KEY-SECRET";
const sealed = (): SealedWorkspace => new SealedWorkspace(work, launcher);

beforeAll(async () => {
  rootless = (await probeContainerRuntime()).rootless;
  launcher = dockerSealedLauncher({ rootless });
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "juno-sealed-"));
  work = join(dir, "work");
  // The runner's own state, beside the workspace on the same file system, as on the operator's machine.
  state = join(dir, "runner-state");
  mkdirSync(join(state, "journal-key"), { recursive: true, mode: 0o700 });
  key = join(state, "journal-key", "key");
  writeFileSync(key, SECRET, { mode: 0o600 });
  store = new CheckpointStore(join(state, "checkpoints"));
  mkdirSync(join(work, "project", "docs"), { recursive: true });
  writeFileSync(join(work, "project", "notes.txt"), "notes\n");
  writeFileSync(join(work, "project", "docs", "a.md"), "a\n");
});

afterAll(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

async function checkpoint(): Promise<readonly ManifestEntry[]> {
  const taken = await sealed().checkpoint("/work/project");
  if (!taken.ok) throw new Error(taken.reason);
  for (const bytes of taken.snapshot.contents.values()) store.put(bytes);
  return taken.snapshot.manifest;
}

/** Runs `program` in the sealed context exactly as JUNO runs its own, for `op` (so with that op's mount). */
async function probe(op: "checkpoint" | "restore", program: string): Promise<Record<string, unknown>> {
  const identity = statSync(work, { bigint: true });
  const args = sealedDockerArgs({ op, workspace: work, root: "/work/project", dev: String(identity.dev), ino: String(identity.ino), input: null }, { rootless }, program);
  const result = await runProgram("docker", args, null, 120_000);
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

const PROBE = String.raw`
import fs from "node:fs"; import net from "node:net"; import process from "node:process";
const attempt = (fn) => { try { const value = fn(); return { value: String(value) }; } catch (error) { return { code: error.code ?? String(error) }; } };
const out = {
  key: attempt(() => fs.readFileSync(KEY_PATH, "utf8")),
  state: attempt(() => fs.readdirSync(STATE_PATH).join(",")),
  linked: attempt(() => fs.readFileSync("/work/project/planted-link", "utf8")),
  viaRoot: attempt(() => fs.readFileSync("/proc/1/root" + KEY_PATH, "utf8")),
  status: fs.readFileSync("/proc/self/status", "utf8").split("\n").filter((line) => /^(CapEff|CapPrm|CapBnd|NoNewPrivs)/.test(line)),
  mounts: fs.readFileSync("/proc/self/mountinfo", "utf8"),
  writeImage: attempt(() => fs.writeFileSync("/etc/juno-probe", "x")),
  writeWork: attempt(() => { fs.writeFileSync("/work/probe-written", "x"); fs.unlinkSync("/work/probe-written"); return "written"; }),
};
out.network = await new Promise((resolve) => { const socket = net.connect({ host: "1.1.1.1", port: 53, timeout: 3000 }); socket.on("connect", () => { socket.destroy(); resolve("connected"); }); socket.on("error", (error) => resolve(error.code)); socket.on("timeout", () => { socket.destroy(); resolve("timeout"); }); });
process.stdout.write(JSON.stringify(out));
`;

describe("the sealed copy context can reach nothing of the runner's (D-228)", () => {
  // proves the operator's ruling item 1: "a test that the copy context cannot open the runner's journal key even if
  // handed its exact path" — not directly, not through a link planted in the workspace, not through /proc; with no
  // capability, no new privileges, no network, a read-only image, and the workspace as its one mount
  it("cannot open the runner's journal key even when handed its exact path", async () => {
    symlinkSync(key, join(work, "project", "planted-link"));
    for (const op of ["checkpoint", "restore"] as const) {
      const program = PROBE.replaceAll("KEY_PATH", JSON.stringify(key)).replaceAll("STATE_PATH", JSON.stringify(state));
      const seen = await probe(op, program);
      const text = JSON.stringify(seen);
      expect(text, op).not.toContain(SECRET);
      expect(seen["key"], op).toEqual({ code: "ENOENT" });
      expect(seen["state"], op).toEqual({ code: "ENOENT" });
      expect(seen["linked"], op).toEqual({ code: "ENOENT" });
      expect((seen["viaRoot"] as { code?: string }).code, op).toBeDefined();
      expect(seen["status"], op).toEqual(expect.arrayContaining(["CapEff:\t0000000000000000", "CapPrm:\t0000000000000000", "CapBnd:\t0000000000000000", "NoNewPrivs:\t1"]));
      expect(seen["network"], op).not.toBe("connected");
      expect(seen["writeImage"], op).toEqual({ code: "EROFS" });
      // The copy's mount is read-only; the restore's is the one place it can write.
      expect(seen["writeWork"], op).toEqual(op === "checkpoint" ? { code: "EROFS" } : { value: "written" });
      // The runner's state is in no mount: only the workspace is bound in.
      const mounts = String(seen["mounts"]).split("\n").filter((line) => line.includes(" /work "));
      expect(mounts, op).toHaveLength(1);
      expect(String(seen["mounts"]), op).not.toContain("runner-state");
    }
    expect(readFileSync(key, "utf8")).toBe(SECRET);
  }, 120_000);

  // proves D-228 item 2 against round 5's trap (D-227): a name swapped between the Claude Code user's file and a link to
  // the runner's journal key while the sealed context copies it never puts the key into a checkpoint: the copy refuses
  // the link or holds the user's own bytes, and the key's path does not even exist where the copy runs
  it("round 5's swapped link never puts the runner's key into a checkpoint", async () => {
    const racer = join(dir, "racer.mjs");
    writeFileSync(racer, [
      'import { renameSync, symlinkSync, writeFileSync } from "node:fs";',
      "const [project, secret, until] = process.argv.slice(2);",
      "while (Date.now() < Number(until)) {",
      '  symlinkSync(secret, project + "/.l"); renameSync(project + "/.l", project + "/x");',
      '  writeFileSync(project + "/.f", "agent"); renameSync(project + "/.f", project + "/x");',
      "}",
    ].join("\n"));
    const until = Date.now() + 6000;
    const done = new Promise((resolve) => execFile(process.execPath, [racer, join(work, "project"), key, String(until)], () => resolve(undefined)));
    let leaked = 0;
    let outcomes = 0;
    while (Date.now() < until - 500) {
      const taken = await sealed().checkpoint("/work/project");
      outcomes += 1;
      if (taken.ok && [...taken.snapshot.contents.values()].some((bytes) => bytes.toString().includes(SECRET))) leaked += 1;
      if (!taken.ok) expect(taken.reason).toMatch(/symbolic link|changed while it was listed/);
    }
    await done;
    expect(leaked).toBe(0);
    expect(outcomes).toBeGreaterThan(0);
  }, 60_000);

  // proves D-228 item 2 against round 1's trap (D-223): a set-user-ID copy of a program in the workspace refuses the
  // checkpoint, and a manifest carrying the bit is refused by the sealed restore with nothing changed or created
  it("round 1's set-user-ID program is never taken and never recreated", async () => {
    const manifest = await checkpoint();
    writeFileSync(join(work, "project", "tool"), "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(join(work, "project", "tool"), 0o4755);
    expect(await sealed().checkpoint("/work/project")).toMatchObject({ ok: false, reason: expect.stringContaining('"tool" has a set-user-ID') });
    rmSync(join(work, "project", "tool"));
    const notes = manifest.find((entry) => entry.path === "notes.txt");
    const forged: ManifestEntry[] = [...manifest, { path: "tool", type: "file", mode: 0o4755, sha256: notes?.type === "file" ? notes.sha256 : "" }];
    expect(await sealed().restore("/work/project", forged, (hash) => store.get(hash))).toMatchObject({ ok: false, changed: false, reason: expect.stringContaining("set-user-ID") });
    expect(existsSync(join(work, "project", "tool"))).toBe(false);
  }, 60_000);

  // proves D-228 against round 3's trap (D-225): a sticky folder set after the checkpoint refuses the sealed restore
  // before anything changes
  it("round 3's sticky folder refuses the restore, changing nothing", async () => {
    const manifest = await checkpoint();
    mkdirSync(join(work, "project", "sticky"));
    writeFileSync(join(work, "project", "sticky", "own.txt"), "own\n");
    chmodSync(join(work, "project", "sticky"), 0o1777);
    writeFileSync(join(work, "project", "notes.txt"), "changed\n");
    expect(await sealed().restore("/work/project", manifest, (hash) => store.get(hash))).toMatchObject({ ok: false, changed: false, reason: expect.stringContaining('"sticky" has a set-user-ID, set-group-ID or sticky bit') });
    expect(readFileSync(join(work, "project", "notes.txt"), "utf8")).toBe("changed\n");
    expect(readFileSync(join(work, "project", "sticky", "own.txt"), "utf8")).toBe("own\n");
  }, 60_000);

  // proves D-228 against round 4's trap (D-226): links planted to send a change elsewhere (a folder swapped for a link
  // to the runner's state, a file for a link to its key) are removed as the links they are; the runner's state is
  // untouched, and the restored workspace holds the checkpoint's files with the fixed mode, never the key
  it("round 4's planted links send nothing elsewhere", async () => {
    const manifest = await checkpoint();
    rmSync(join(work, "project", "docs"), { recursive: true });
    symlinkSync(state, join(work, "project", "docs"));
    rmSync(join(work, "project", "notes.txt"));
    symlinkSync(key, join(work, "project", "notes.txt"));
    const before = readdirSync(state).sort();
    expect(await sealed().restore("/work/project", manifest, (hash) => store.get(hash))).toEqual({ ok: true });
    expect(lstatSync(join(work, "project", "docs")).isDirectory()).toBe(true);
    expect(readFileSync(join(work, "project", "docs", "a.md"), "utf8")).toBe("a\n");
    expect(readFileSync(join(work, "project", "notes.txt"), "utf8")).toBe("notes\n");
    expect(lstatSync(join(work, "project", "notes.txt")).mode & 0o7777).toBe(FILE_MODE);
    expect(readdirSync(state).sort()).toEqual(before);
    expect(readFileSync(key, "utf8")).toBe(SECRET);
    expect(existsSync(join(state, "a.md"))).toBe(false);
    // And a link in the workspace at admission refuses the checkpoint itself.
    symlinkSync(key, join(work, "project", "planted"));
    expect(await sealed().checkpoint("/work/project")).toMatchObject({ ok: false, reason: expect.stringContaining('"planted" is a symbolic link') });
  }, 60_000);

  // proves D-228: a folder put in the workspace's place before the container mounts it is refused by the sealed program
  // before it reads or changes anything
  it("refuses a folder put in the workspace's place before the mount", async () => {
    const manifest = await checkpoint();
    mkdirSync(join(dir, "decoy", "project"), { recursive: true });
    writeFileSync(join(dir, "decoy", "project", "keep.txt"), "decoy\n");
    const swapping: SealedLauncher = async (request) => {
      renameSync(work, join(dir, "real"));
      renameSync(join(dir, "decoy"), work);
      try {
        return await launcher(request);
      } finally {
        renameSync(work, join(dir, "decoy"));
        renameSync(join(dir, "real"), work);
      }
    };
    const swapped = new SealedWorkspace(work, swapping);
    expect(await swapped.checkpoint("/work/project")).toMatchObject({ ok: false, reason: expect.stringContaining("not the one JUNO opened") });
    expect(await swapped.restore("/work/project", manifest, (hash) => store.get(hash))).toMatchObject({ ok: false, changed: false, reason: expect.stringContaining("not the one JUNO opened") });
    expect(readdirSync(join(dir, "decoy", "project"))).toEqual(["keep.txt"]);
  }, 60_000);
});
