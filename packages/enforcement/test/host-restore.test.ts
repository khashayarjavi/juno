import { chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore, DIR_MODE, FILE_MODE, HostPathResolver, HostReadView, NOT_READ, SealedWorkspace, listTree, openRoot, restoreRefusals, restoreTree, sameManifest, workspaceRefusals } from "../src/index.js";
import type { ManifestEntry, SealedLauncher } from "../src/index.js";
import { unsealedLauncher } from "./sealed.js";

// §2.2.2 (v0.6 A1): "A scope is reversible when a checkpoint of its full content is taken before the task's first effect
// on it and restoring that checkpoint is an operator action recorded in the journal." D-221: the restore of a hook
// session's host folder; D-228 (operator ruling of 2026-11-20): every copy and every restore runs in the sealed context,
// takes only files and folders, and writes fixed modes. Here the sealed program itself, on this machine's real file
// system (run without the container: the seal is proven by test/containers/sealed-copy.test.ts): it brings back the
// checkpoint's full content, never follows a link, never writes through a hard link, and refuses before changing
// anything when it could not finish.

const run = promisify(execFile);
let dir: string;
let work: string;
let store: CheckpointStore;
const sealed = (): SealedWorkspace => new SealedWorkspace(work, unsealedLauncher);
const uid = process.geteuid?.() ?? -1;

async function checkpoint(root = "/work/project"): Promise<readonly ManifestEntry[]> {
  const taken = await sealed().checkpoint(root);
  if (!taken.ok) throw new Error(taken.reason);
  for (const bytes of taken.snapshot.contents.values()) store.put(bytes);
  return taken.snapshot.manifest;
}

/** The restore's own steps, in this process, with the runner's judgement and identity replaceable (as a test needs). */
function restoreHere(manifest: readonly ManifestEntry[], options: { uid?: number; mayChange?: (folder: string) => boolean } = {}): { refusals: string[]; same: boolean } {
  const opened = openRoot(work, "/work/project");
  if (!opened.ok) throw new Error(opened.reason);
  try {
    const judge = options.mayChange === undefined ? {} : { mayChange: options.mayChange };
    const refusals = restoreRefusals(opened.fd, manifest, judge);
    if (refusals.length === 0) restoreTree(opened.fd, manifest, (hash) => store.get(hash), { uid: options.uid ?? uid });
    const after = listTree(opened.fd, judge);
    return { refusals, same: after.ok && sameManifest(after.manifest, manifest) };
  } finally {
    closeSync(opened.fd);
  }
}

/** The whole restore, through the sealed program. */
async function restore(manifest: readonly ManifestEntry[]): Promise<{ ok: boolean; changed?: boolean; reason?: string }> {
  return sealed().restore("/work/project", manifest, (hash) => store.get(hash));
}

const read = (path: string): string => readFileSync(join(work, "project", path), "utf8");
const mode = (path: string): number => lstatSync(join(work, "project", path)).mode & 0o7777;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "juno-host-restore-"));
  work = join(dir, "work");
  store = new CheckpointStore(join(dir, "checkpoints"));
  mkdirSync(join(work, "project", "docs", "deep"), { recursive: true });
  writeFileSync(join(work, "project", "notes.txt"), "notes\n");
  writeFileSync(join(work, "project", "docs", "a.md"), "a\n");
  writeFileSync(join(work, "project", "docs", "deep", "b.md"), "b\n");
  chmodSync(join(work, "project", "docs", "deep", "b.md"), 0o640);
  mkdirSync(join(dir, "outside"));
  writeFileSync(join(dir, "outside", "secret.txt"), "outside\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("restoring a host-folder checkpoint (§2.2.2, D-221, D-228)", () => {
  // proves §2.2.2: the workspace's full content comes back: files created after the checkpoint are removed (a link
  // among them), changed files get their bytes back, deleted files and folders are put back; and D-228: every file is
  // written with the fixed mode and every folder the runner owns gets the fixed mode, whatever the checkpoint saw
  it("brings the folder back to the checkpoint's full content, with the fixed modes", async () => {
    const manifest = await checkpoint();
    expect(manifest.every((entry) => entry.mode === (entry.type === "file" ? FILE_MODE : DIR_MODE))).toBe(true);
    writeFileSync(join(work, "project", "created.txt"), "new\n");
    mkdirSync(join(work, "project", "new-folder", "inner"), { recursive: true });
    writeFileSync(join(work, "project", "new-folder", "inner", "x"), "x");
    writeFileSync(join(work, "project", "notes.txt"), "changed by Claude\n");
    chmodSync(join(work, "project", "notes.txt"), 0o755);
    rmSync(join(work, "project", "docs"), { recursive: true });
    symlinkSync("elsewhere", join(work, "project", "link"));
    expect(await restore(manifest)).toEqual({ ok: true });
    expect(existsSync(join(work, "project", "created.txt"))).toBe(false);
    expect(existsSync(join(work, "project", "new-folder"))).toBe(false);
    expect(existsSync(join(work, "project", "link"))).toBe(false);
    expect(read("notes.txt")).toBe("notes\n");
    expect(mode("notes.txt")).toBe(FILE_MODE);
    expect(read("docs/deep/b.md")).toBe("b\n");
    expect(mode("docs/deep/b.md")).toBe(FILE_MODE);
    expect(mode("docs/deep")).toBe(DIR_MODE);
  });

  // proves D-221: a folder the agent swapped for a link to somewhere else is removed as the link it is; nothing outside
  // the workspace is read, written or removed
  it("never follows a symbolic link out of the workspace", async () => {
    const manifest = await checkpoint();
    rmSync(join(work, "project", "docs"), { recursive: true });
    symlinkSync(join(dir, "outside"), join(work, "project", "docs"));
    expect(await restore(manifest)).toEqual({ ok: true });
    expect(lstatSync(join(work, "project", "docs")).isDirectory()).toBe(true);
    expect(readFileSync(join(dir, "outside", "secret.txt"), "utf8")).toBe("outside\n");
    expect(existsSync(join(dir, "outside", "a.md"))).toBe(false);
    expect(existsSync(join(dir, "outside", "deep"))).toBe(false);
  });

  // proves D-221 (as D-158): a file replaced by a hard link to a file elsewhere is replaced, never written through
  it("never writes through a hard link", async () => {
    const manifest = await checkpoint();
    rmSync(join(work, "project", "notes.txt"));
    linkSync(join(dir, "outside", "secret.txt"), join(work, "project", "notes.txt"));
    expect(await restore(manifest)).toEqual({ ok: true });
    expect(read("notes.txt")).toBe("notes\n");
    expect(readFileSync(join(dir, "outside", "secret.txt"), "utf8")).toBe("outside\n");
  });

  // proves D-221 "it refuses on any mismatch": when the runner could not change a folder, the restore refuses before
  // changing anything, and the folder is exactly as it was
  it("refuses, and changes nothing, when the runner could not change a folder", async () => {
    const manifest = await checkpoint();
    writeFileSync(join(work, "project", "created.txt"), "new\n");
    writeFileSync(join(work, "project", "notes.txt"), "changed\n");
    const deep = lstatSync(join(work, "project", "docs", "deep")).ino;
    const result = restoreHere(manifest, { mayChange: (folder) => lstatSync(`${folder}/.`).ino !== deep });
    expect(result.refusals).toEqual([expect.stringContaining('juno-runner cannot read, change and enter "docs/deep"')]);
    expect(result.same).toBe(false);
    expect(read("created.txt")).toBe("new\n");
    expect(read("notes.txt")).toBe("changed\n");
  });

  // proves D-228 "a restore writes fixed modes": a folder of another user's is kept as it is (its mode is not the
  // checkpoint's business, and the runner may not change it), while every file is written anew as the runner's own
  // with the fixed mode; a root whose mode differs no longer matters, since no mode is restored
  it("keeps a folder another user owns as it is, and writes every file anew with the fixed mode", async () => {
    const manifest = await checkpoint();
    chmodSync(join(work, "project", "docs"), 0o700);
    chmodSync(join(work, "project"), 0o700);
    // As if another user owned everything here: the restore may not change a mode, and replaces every file.
    expect(restoreHere(manifest, { uid: 4242 })).toEqual({ refusals: [], same: true });
    expect(mode("docs")).toBe(0o700);
    expect(mode("")).toBe(0o700);
    expect(mode("notes.txt")).toBe(FILE_MODE);
    expect(read("docs/a.md")).toBe("a\n");
  });

  // proves D-221, D-228: the workspace root is opened one component at a time, never through a link, and the service's
  // folder must be given as its real path, below folders only root and the runner could replace
  it("refuses a workspace root reached through a link, and a workspace another user could replace", () => {
    rmSync(join(work, "project"), { recursive: true });
    symlinkSync(join(dir, "outside"), join(work, "project"));
    expect(openRoot(work, "/work/project")).toMatchObject({ ok: false, reason: expect.stringContaining("without a symbolic link") });
    symlinkSync(work, join(dir, "work-link"));
    expect(workspaceRefusals(join(dir, "work-link"))).toEqual([expect.stringContaining("through a symbolic link")]);
    expect(workspaceRefusals(work)).toEqual([]);
    chmodSync(dir, 0o777);
    expect(workspaceRefusals(work)).toEqual([expect.stringContaining("writable by group or others without the sticky bit")]);
    chmodSync(dir, 0o1777);
    expect(workspaceRefusals(work)).toEqual([]);
    chmodSync(dir, 0o700);
    expect(workspaceRefusals(join(dir, "work with space"))).toEqual([expect.stringContaining("letters, digits")]);
  });

  // proves D-223 (review round 1 of PR #60, F1) with D-228: a set-user-ID, set-group-ID or sticky bit refuses the
  // checkpoint itself, and a manifest carrying one (as a checkpoint taken before D-228 could) is refused before anything
  // changes; the restore never leaves a runner-owned file or folder with such a bit
  it("refuses a checkpoint with a set-user-ID, set-group-ID or sticky bit, and never recreates one", async () => {
    const plainManifest = await checkpoint();
    for (const [path, bits, folder] of [["notes.txt", 0o4755, false], ["notes.txt", 0o2755, false], ["docs", 0o1777, true], ["docs", 0o2775, true]] as const) {
      chmodSync(join(work, "project", path), bits);
      const taken = await sealed().checkpoint("/work/project");
      expect(taken, `${path} ${bits.toString(8)}`).toMatchObject({ ok: false, reason: expect.stringContaining("set-user-ID, set-group-ID or sticky bit") });
      chmodSync(join(work, "project", path), folder ? 0o755 : 0o644);
      const forged = plainManifest.map((entry) => (entry.path === path ? { ...entry, mode: bits } : entry));
      writeFileSync(join(work, "project", "created.txt"), "new\n");
      rmSync(join(work, "project", "notes.txt"));
      expect(await restore(forged)).toMatchObject({ ok: false, changed: false, reason: expect.stringContaining("set-user-ID, set-group-ID or sticky bit") });
      expect(read("created.txt")).toBe("new\n");
      const opened = openRoot(work, "/work/project");
      if (!opened.ok) throw new Error(opened.reason);
      expect(() => restoreTree(opened.fd, forged, (hash) => store.get(hash))).toThrow(/sticky bit/);
      closeSync(opened.fd);
      expect(existsSync(join(work, "project", "notes.txt"))).toBe(false);
      writeFileSync(join(work, "project", "notes.txt"), "notes\n");
      chmodSync(join(work, "project", "notes.txt"), 0o644);
      rmSync(join(work, "project", "created.txt"));
    }
  });

  // proves D-225 (review round 3 of PR #60): a folder that carries a sticky (or set-user-ID, set-group-ID) bit as it
  // stands refuses the restore before anything changes, and a write below it is reported as one the restore could not undo
  it("refuses a folder with a sticky bit as it stands, changing nothing, and reports it on a write's path", async () => {
    const manifest = await checkpoint();
    mkdirSync(join(work, "project", "made"));
    writeFileSync(join(work, "project", "made", "a.txt"), "a\n");
    chmodSync(join(work, "project", "made"), 0o1775);
    writeFileSync(join(work, "project", "notes.txt"), "changed\n");
    expect(await restore(manifest)).toMatchObject({ ok: false, changed: false, reason: expect.stringContaining('"made" has a set-user-ID, set-group-ID or sticky bit (mode 1775)') });
    expect(read("notes.txt")).toBe("changed\n");
    expect(read("made/a.txt")).toBe("a\n");
    const resolved = (await new HostPathResolver(work).resolve(["/work/project/made/b.txt", "/work/project/docs/c.txt"]));
    expect(resolved.get("/work/project/made/b.txt")).toMatchObject({ ok: true, unwritable: ["/work/project/made"] });
    expect(resolved.get("/work/project/docs/c.txt")).not.toHaveProperty("unwritable");
  });

  // proves D-221: content is checked against its hash before the first change; a missing or altered blob changes nothing
  it("changes nothing when the checkpoint's content is missing", async () => {
    const manifest = await checkpoint();
    writeFileSync(join(work, "project", "created.txt"), "new\n");
    const opened = openRoot(work, "/work/project");
    if (!opened.ok) throw new Error(opened.reason);
    expect(() => restoreTree(opened.fd, manifest, () => Buffer.from("not the bytes"))).toThrow(/does not match its hash/);
    closeSync(opened.fd);
    expect(read("created.txt")).toBe("new\n");
    const empty = new CheckpointStore(join(dir, "empty-store"));
    expect(await sealed().restore("/work/project", manifest, (hash) => empty.get(hash))).toMatchObject({ ok: false, changed: false });
    expect(read("created.txt")).toBe("new\n");
  });

  // proves D-227 (review round 5 of PR #60) with D-228: a name swapped for a link to a file of the runner's own while it
  // is listed is never read: the listing fails or holds the Claude Code user's own bytes, never the runner's
  it("never reads a file of the runner's through a name swapped for a link while it is listed", async () => {
    writeFileSync(join(dir, "outside", "journal-key"), "RUNNER-SECRET-KEY");
    const racer = join(dir, "racer.mjs");
    writeFileSync(racer, [
      'import { renameSync, symlinkSync, writeFileSync } from "node:fs";',
      "const [project, secret, until] = process.argv.slice(2);",
      "while (Date.now() < Number(until)) {",
      '  symlinkSync(secret, project + "/.l"); renameSync(project + "/.l", project + "/x");',
      '  writeFileSync(project + "/.f", "agent"); renameSync(project + "/.f", project + "/x");',
      "}",
    ].join("\n"));
    const until = Date.now() + 3000;
    const done = new Promise((resolve) => execFile(process.execPath, [racer, join(work, "project"), join(dir, "outside", "journal-key"), String(until)], () => resolve(undefined)));
    let leaked = 0;
    let sawFile = 0;
    while (Date.now() < until - 200) {
      const opened = openRoot(work, "/work/project");
      if (!opened.ok) continue;
      const listed = listTree(opened.fd, { content: true });
      closeSync(opened.fd);
      if (!listed.ok) continue;
      if ([...listed.contents.values()].some((bytes) => bytes.toString() === "RUNNER-SECRET-KEY")) leaked += 1;
      if (listed.manifest.some((entry) => entry.path === "x" && entry.type === "file")) sawFile += 1;
    }
    await done;
    expect(leaked).toBe(0);
    // The race was exercised: some listings held x as the Claude Code user's own file.
    expect(sawFile).toBeGreaterThan(0);
  }, 20_000);
});

describe("JUNO takes only files and folders from a workspace (operator ruling 2 of 2026-11-20, D-228)", () => {
  // proves D-228 item 2: a symbolic link, a FIFO, a socket or a second name (hard link) anywhere in the workspace refuses
  // the checkpoint, so the workspace is not reversible
  it("refuses a checkpoint of a workspace holding a link, a FIFO, a socket or a hard link", async () => {
    const entry = join(work, "project", "docs", "entry");
    const plant: [string, () => Promise<() => void>][] = [
      ["symbolic link", () => { symlinkSync("notes.txt", entry); return Promise.resolve(() => rmSync(entry)); }],
      ["FIFO", async () => { await run("mkfifo", [entry]); return () => rmSync(entry); }],
      // The server stays open while the checkpoint runs: node removes its socket file when it closes.
      ["socket", () => new Promise((resolve) => { const server = createServer(); server.listen(entry, () => resolve(() => server.close())); })],
      ["names (a hard link)", () => { linkSync(join(work, "project", "notes.txt"), entry); return Promise.resolve(() => rmSync(entry)); }],
    ];
    for (const [what, make] of plant) {
      const cleanUp = await make();
      expect(await sealed().checkpoint("/work/project"), what).toMatchObject({ ok: false, reason: expect.stringContaining(what) });
      cleanUp();
    }
    expect((await sealed().checkpoint("/work/project")).ok).toBe(true);
  });

  // proves D-228: a manifest that is not one the sealed context wrote (a link entry, a mode other than the fixed ones)
  // is refused before anything changes
  it("refuses to restore a manifest that is not the sealed form", async () => {
    const manifest = await checkpoint();
    writeFileSync(join(work, "project", "created.txt"), "new\n");
    for (const forged of [[...manifest, { path: "l", type: "symlink", mode: 0o777, target: "/etc" }], manifest.map((entry) => (entry.type === "file" ? { ...entry, mode: 0o644 } : entry))] as ManifestEntry[][]) {
      expect(await restore(forged)).toMatchObject({ ok: false, changed: false });
      expect(read("created.txt")).toBe("new\n");
    }
  });

  // proves D-228: the sealed program reads or changes nothing when the folder it is given is not the one JUNO opened
  // (another folder put in the workspace's place before the mount)
  it("refuses a folder put in the workspace's place, reading and changing nothing", async () => {
    const manifest = await checkpoint();
    mkdirSync(join(dir, "decoy", "project"), { recursive: true });
    writeFileSync(join(dir, "decoy", "project", "keep.txt"), "decoy\n");
    const swapping: SealedLauncher = async (request) => {
      renameSync(work, join(dir, "real"));
      renameSync(join(dir, "decoy"), work);
      try {
        return await unsealedLauncher(request);
      } finally {
        renameSync(work, join(dir, "decoy"));
        renameSync(join(dir, "real"), work);
      }
    };
    const swapped = new SealedWorkspace(work, swapping);
    expect(await swapped.checkpoint("/work/project")).toMatchObject({ ok: false, reason: expect.stringContaining("not the one JUNO opened") });
    expect(await swapped.restore("/work/project", manifest, (hash) => store.get(hash))).toMatchObject({ ok: false, changed: false, reason: expect.stringContaining("not the one JUNO opened") });
    expect(readFileSync(join(dir, "decoy", "project", "keep.txt"), "utf8")).toBe("decoy\n");
    expect(existsSync(join(dir, "decoy", "project", "notes.txt"))).toBe(false);
  });

  // proves D-230 (review round 6 on PR #61): a restore run that ends without its program's own answer (killed part way,
  // as an out-of-memory kill or a dying daemon would) is never reported as "nothing was changed": it may have changed
  // the folder, so it is a failure, which the restore command journals as `failed`
  it("never reports a restore cut off part way as one that changed nothing", async () => {
    const manifest = await checkpoint();
    writeFileSync(join(work, "project", "created.txt"), "new\n");
    const cutOff: SealedLauncher = async (request) => {
      const result = await unsealedLauncher(request);
      // The program ran and changed the folder; its answer never arrived.
      return { exitCode: 137, stdout: result.stdout.slice(0, 7), stderr: "" };
    };
    const outcome = await new SealedWorkspace(work, cutOff).restore("/work/project", manifest, (hash) => store.get(hash));
    expect(outcome).toMatchObject({ ok: false, changed: true });
    expect(outcome.ok ? "" : outcome.reason).not.toContain("nothing was changed");
    const silent: SealedLauncher = () => Promise.resolve({ exitCode: 137, stdout: "", stderr: "" });
    expect(await new SealedWorkspace(work, silent).restore("/work/project", manifest, (hash) => store.get(hash))).toMatchObject({ ok: false, changed: true });
    // Refusals before the context starts, and the program's own refusals before any change, still say so.
    expect(await new SealedWorkspace(join(dir, "missing"), unsealedLauncher).restore("/work/project", manifest, (hash) => store.get(hash))).toMatchObject({ ok: false, changed: false });
  });

  // proves D-231 (review round 7 on PR #61): a name that is not valid UTF-8 is acted on as the bytes it is. A checkpoint
  // refuses one with a true reason (JUNO records only names it can record exactly); one made after the checkpoint (an
  // archive unpacked by a tool, say) is removed by the restore like anything else the checkpoint lacks, so it never
  // makes the undo impossible while writes beside it proceed
  it("removes a name that is not valid UTF-8 made after the checkpoint, and refuses a checkpoint holding one", async () => {
    const latin1 = (folder: string, name: number[]): Buffer => Buffer.concat([Buffer.from(`${join(work, "project", folder)}/`), Buffer.from(name)]);
    const resume = [0x52, 0xe9, 0x73, 0x75, 0x6d, 0xe9, 0x2e, 0x74, 0x78, 0x74];
    const manifest = await checkpoint();
    writeFileSync(join(work, "project", "notes.txt"), "changed by Claude\n");
    writeFileSync(latin1("", resume), "made by an unzip\n");
    mkdirSync(latin1("docs", [0x44, 0xe9, 0x6a, 0xe0]));
    writeFileSync(Buffer.concat([latin1("docs", [0x44, 0xe9, 0x6a, 0xe0]), Buffer.from("/inner.txt")]), "inner\n");
    expect(await restore(manifest)).toEqual({ ok: true });
    expect(read("notes.txt")).toBe("notes\n");
    expect(existsSync(latin1("", resume))).toBe(false);
    expect(existsSync(latin1("docs", [0x44, 0xe9, 0x6a, 0xe0]))).toBe(false);
    writeFileSync(latin1("docs", resume), "x");
    expect(await sealed().checkpoint("/work/project")).toMatchObject({ ok: false, reason: expect.stringContaining('"docs" holds a name that is not valid UTF-8 (<bytes 52e973756de92e747874>)') });
  });

  // proves D-231: the read view keeps a checkpoint's byte bound, counted from the files' sizes without opening them: a
  // larger tree is not listed, so a read of it counts at the highest class
  it("the read view refuses a tree larger than a checkpoint's bound, without reading it", async () => {
    writeFileSync(join(work, "project", "big.bin"), "");
    truncateSync(join(work, "project", "big.bin"), 9 * 1024 * 1024);
    chmodSync(join(work, "project", "big.bin"), 0o000);
    expect(await new HostReadView(work).list("/work/project", false)).toMatchObject({ ok: false, reason: expect.stringContaining("holds more than") });
  });

  // proves D-228: the read view lists names, kinds and link targets for classifying a read, and never opens a file
  it("the read view never reads a file's bytes", async () => {
    symlinkSync("notes.txt", join(work, "project", "link"));
    chmodSync(join(work, "project", "notes.txt"), 0o000);
    const view = new HostReadView(work);
    expect(await view.list("/work/project", true)).toMatchObject({ ok: false, reason: expect.stringContaining("never reads") });
    const listed = await view.list("/work/project", false);
    if (!listed.ok) throw new Error(listed.reason);
    expect(listed.snapshot.manifest).toContainEqual({ path: "link", type: "symlink", mode: expect.any(Number), target: "notes.txt" });
    expect(listed.snapshot.manifest).toContainEqual({ path: "notes.txt", type: "file", mode: 0, sha256: NOT_READ });
    expect(listed.snapshot.contents.size).toBe(0);
    expect(await view.list("/work/project/notes.txt", false)).toMatchObject({ ok: false, reason: "the workspace root is not a directory (a symlink is refused)" });
    expect(await view.list("/work/project/missing", false)).toMatchObject({ ok: false, reason: "cannot read the workspace root: ENOENT" });
  });
});
