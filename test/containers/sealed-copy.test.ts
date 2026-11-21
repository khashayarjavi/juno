import { execFile } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore, DIR_MODE, FILE_MODE, type ManifestEntry, type SealedLauncher, SealedWorkspace, dockerSealedLauncher, probeContainerRuntime, removeEntry, runProgram, sealedDockerArgs } from "../../packages/enforcement/src/index.js";

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
/** Where the restore kept the folder as it stood (D-234): beside it, under a name that says so. */
const KEPT = expect.stringMatching(/^\/work\/project\.juno-undone-\d{8}T\d{6}Z-[0-9a-f]{8}$/);
const host = (kept: unknown): string => join(work, String(kept).slice("/work/".length));
/** Removes the kept folders (one may be deeper than node's own recursive removal reaches), as the restore's own removal does. */
function removeKept(): void {
  const base = openSync(work, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  for (const name of readdirSync(work)) if (name.includes(".juno-undone-")) removeEntry(base, name);
  closeSync(base);
}

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

  // proves D-228 against round 3's trap (D-225), with D-234's undo: a sticky folder made after the checkpoint inside the
  // session's folder goes aside with it, untouched (its file kept, its bit never recreated), and the folder comes back;
  // the same trap one folder up (a sticky bit on the folder holding the session's, where the kernel would let the
  // runner rename only what it owns) refuses the sealed restore before anything changes
  it("round 3's sticky folder goes aside whole; a sticky folder holding it refuses, changing nothing", async () => {
    const manifest = await checkpoint();
    mkdirSync(join(work, "project", "sticky"));
    writeFileSync(join(work, "project", "sticky", "own.txt"), "own\n");
    chmodSync(join(work, "project", "sticky"), 0o1777);
    writeFileSync(join(work, "project", "notes.txt"), "changed\n");
    chmodSync(work, 0o1755);
    try {
      expect(await sealed().restore("/work/project", manifest, (hash) => store.get(hash))).toMatchObject({ ok: false, changed: false, reason: expect.stringContaining("the workspace root has a set-user-ID, set-group-ID or sticky bit") });
      expect(readFileSync(join(work, "project", "notes.txt"), "utf8")).toBe("changed\n");
    } finally {
      chmodSync(work, 0o755);
    }
    const outcome = await sealed().restore("/work/project", manifest, (hash) => store.get(hash));
    expect(outcome).toEqual({ ok: true, kept: KEPT });
    expect(readFileSync(join(work, "project", "notes.txt"), "utf8")).toBe("notes\n");
    expect(existsSync(join(work, "project", "sticky"))).toBe(false);
    expect(readFileSync(join(host(outcome.ok ? outcome.kept : ""), "sticky", "own.txt"), "utf8")).toBe("own\n");
    expect(lstatSync(join(host(outcome.ok ? outcome.kept : ""), "sticky")).mode & 0o7777).toBe(0o1777);
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
    expect(await sealed().restore("/work/project", manifest, (hash) => store.get(hash))).toEqual({ ok: true, kept: KEPT });
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

  // proves D-231 (review round 7 on PR #61) against the real runtime: a file named in Latin-1 made after the checkpoint
  // (the reviewer's reproduction) is removed by the sealed restore, which brings the changed file back
  it("restores past a name that is not valid UTF-8", async () => {
    const manifest = await checkpoint();
    writeFileSync(join(work, "project", "notes.txt"), "changed\n");
    const resume = Buffer.concat([Buffer.from(`${join(work, "project")}/`), Buffer.from([0x52, 0xe9, 0x73, 0x75, 0x6d, 0xe9, 0x2e, 0x74, 0x78, 0x74])]);
    writeFileSync(resume, "unzipped\n");
    expect(await sealed().restore("/work/project", manifest, (hash) => store.get(hash))).toEqual({ ok: true, kept: KEPT });
    expect(readFileSync(join(work, "project", "notes.txt"), "utf8")).toBe("notes\n");
    expect(existsSync(resume)).toBe(false);
  }, 60_000);

  // proves D-232 (review round 8 on PR #61) against the real runtime, the reviewer's reproduction, with D-234's undo:
  // an 8,000-level folder made after the checkpoint (its full path longer than the kernel's path limit, which a
  // root-run daemon's AppArmor profile refuses to look up: CI run 44765378891) is undone: the folder moves aside whole,
  // the changed file comes back, and nothing below the folder is ever looked up
  it("restores past a folder thousands of levels deep", async () => {
    const manifest = await checkpoint();
    writeFileSync(join(work, "project", "notes.txt"), "changed\n");
    let fd = openSync(join(work, "project"), constants.O_RDONLY | constants.O_DIRECTORY);
    for (let level = 0; level < 8000; level += 1) {
      mkdirSync(`/proc/self/fd/${String(fd)}/d`);
      const next = openSync(`/proc/self/fd/${String(fd)}/d`, constants.O_RDONLY | constants.O_DIRECTORY);
      closeSync(fd);
      fd = next;
    }
    closeSync(fd);
    expect(await sealed().check("/work/project", manifest)).toEqual([]);
    const outcome = await sealed().restore("/work/project", manifest, (hash) => store.get(hash));
    expect(outcome).toEqual({ ok: true, kept: KEPT });
    expect(readFileSync(join(work, "project", "notes.txt"), "utf8")).toBe("notes\n");
    expect(existsSync(join(work, "project", "d"))).toBe(false);
    expect(lstatSync(join(host(outcome.ok ? outcome.kept : ""), "d")).isDirectory()).toBe(true);
    removeKept();
  }, 120_000);

  // proves operator ruling 2 of D-234 against the real runtime, review round 9's reproduction: a workspace grown to
  // 200,000 entries after the checkpoint (200 folders of 1,000 files, as an npm install makes) is judged undoable and
  // undone by the sealed context within its limits (512 MB, 180 s), the folder made again from the checkpoint alone
  it("judges and undoes a workspace grown to 200,000 entries", async () => {
    const manifest = await checkpoint();
    writeFileSync(join(work, "project", "notes.txt"), "changed\n");
    for (let folder = 0; folder < 200; folder += 1) {
      const path = join(work, "project", "node_modules", `p${String(folder)}`);
      mkdirSync(path, { recursive: true });
      for (let file = 0; file < 1000; file += 1) writeFileSync(join(path, `f${String(file)}.js`), "");
    }
    expect(await sealed().check("/work/project", manifest)).toEqual([]);
    const outcome = await sealed().restore("/work/project", manifest, (hash) => store.get(hash));
    expect(outcome).toEqual({ ok: true, kept: KEPT });
    expect(readFileSync(join(work, "project", "notes.txt"), "utf8")).toBe("notes\n");
    expect(lstatSync(join(work, "project")).mode & 0o7777).toBe(DIR_MODE);
    expect(existsSync(join(work, "project", "node_modules"))).toBe(false);
    expect(readdirSync(join(host(outcome.ok ? outcome.kept : ""), "node_modules"))).toHaveLength(200);
    removeKept();
  }, 300_000);

  // proves D-231: a sealed container that outlives its limit is killed, and the run is answered as one with no answer
  // (so a restore is journalled failed and a checkpoint refused); nothing is left running
  it("kills a sealed container that runs past its limit", async () => {
    const started = Date.now();
    const stuck = dockerSealedLauncher({ rootless, timeoutMs: 3000, program: "await new Promise(() => setInterval(() => undefined, 1000));" });
    const identity = statSync(work, { bigint: true });
    const result = await stuck({ op: "restore", workspace: work, root: "/work/project", dev: String(identity.dev), ino: String(identity.ino), input: "{}" });
    expect(result).toMatchObject({ exitCode: null, stdout: "", stderr: expect.stringContaining("was killed") });
    expect(Date.now() - started).toBeLessThan(60_000);
    const running = await runProgram("docker", ["ps", "-q", "--filter", "name=juno-sealed-"], null, 30_000);
    expect(running.stdout.trim()).toBe("");
    expect(await new SealedWorkspace(work, stuck).restore("/work/project", await checkpoint(), (hash) => store.get(hash))).toMatchObject({ ok: false, changed: true });
  }, 120_000);

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
