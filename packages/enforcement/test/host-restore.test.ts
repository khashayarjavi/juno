import { chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore, HostPathResolver, Workspace, execFileScript, hostRestoreRefusals, openWorkspaceRoot, restoreHostTree, sameManifest } from "../src/index.js";
import type { ManifestEntry } from "../src/index.js";

// §2.2.2 (v0.6 A1): "A scope is reversible when a checkpoint of its full content is taken before the task's first effect
// on it and restoring that checkpoint is an operator action recorded in the journal." D-221: the restore of a hook
// session's host folder. Here the restore itself, on this machine's real file system: it brings back the checkpoint's
// full content (removing what was created after it, putting back what was changed or deleted), never follows a link,
// never writes through a hard link, and refuses before changing anything when it could not finish.

let dir: string;
let work: string;
let store: CheckpointStore;
const view = (): Workspace => new Workspace(execFileScript(process.execPath, []), "/work", work);
const uid = process.geteuid?.() ?? -1;

async function checkpoint(root = "/work/project"): Promise<readonly ManifestEntry[]> {
  const taken = await view().list(root, true);
  if (!taken.ok) throw new Error(taken.reason);
  for (const bytes of taken.snapshot.contents.values()) store.put(bytes);
  return taken.snapshot.manifest;
}

async function restore(manifest: readonly ManifestEntry[], options: { uid?: number; mayChange?: (folder: string) => boolean } = {}): Promise<{ refusals: string[]; same: boolean }> {
  const opened = openWorkspaceRoot(work, "/work/project");
  if (!opened.ok) throw new Error(opened.reason);
  try {
    const refusals = hostRestoreRefusals(opened.fd, manifest, options.uid ?? uid, options.mayChange);
    if (refusals.length === 0) restoreHostTree(opened.fd, manifest, (hash) => store.get(hash), options.uid ?? uid);
    const after = await view().list("/work/project", false);
    return { refusals, same: after.ok && sameManifest(after.snapshot.manifest, manifest) };
  } finally {
    closeSync(opened.fd);
  }
}

const read = (path: string): string => readFileSync(join(work, "project", path), "utf8");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "juno-host-restore-"));
  work = join(dir, "work");
  store = new CheckpointStore(join(dir, "checkpoints"));
  mkdirSync(join(work, "project", "docs", "deep"), { recursive: true });
  writeFileSync(join(work, "project", "notes.txt"), "notes\n");
  writeFileSync(join(work, "project", "docs", "a.md"), "a\n");
  writeFileSync(join(work, "project", "docs", "deep", "b.md"), "b\n");
  chmodSync(join(work, "project", "docs", "deep", "b.md"), 0o640);
  symlinkSync("notes.txt", join(work, "project", "link"));
  mkdirSync(join(dir, "outside"));
  writeFileSync(join(dir, "outside", "secret.txt"), "outside\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("restoring a host-folder checkpoint (§2.2.2, D-221)", () => {
  // proves §2.2.2: the workspace's full content comes back: files created after the checkpoint are removed, changed
  // files get their bytes and modes back, deleted files and folders are put back, links get their targets back
  it("brings the folder back to the checkpoint's full content", async () => {
    const manifest = await checkpoint();
    const notesMode = lstatSync(join(work, "project", "notes.txt")).mode & 0o7777;
    writeFileSync(join(work, "project", "created.txt"), "new\n");
    mkdirSync(join(work, "project", "new-folder", "inner"), { recursive: true });
    writeFileSync(join(work, "project", "new-folder", "inner", "x"), "x");
    writeFileSync(join(work, "project", "notes.txt"), "changed by Claude\n");
    chmodSync(join(work, "project", "notes.txt"), 0o600);
    rmSync(join(work, "project", "docs"), { recursive: true });
    rmSync(join(work, "project", "link"));
    symlinkSync("elsewhere", join(work, "project", "link"));
    const result = await restore(manifest);
    expect(result).toEqual({ refusals: [], same: true });
    expect(existsSync(join(work, "project", "created.txt"))).toBe(false);
    expect(existsSync(join(work, "project", "new-folder"))).toBe(false);
    expect(read("notes.txt")).toBe("notes\n");
    expect(lstatSync(join(work, "project", "notes.txt")).mode & 0o7777).toBe(notesMode);
    expect(read("docs/deep/b.md")).toBe("b\n");
    expect(lstatSync(join(work, "project", "docs", "deep", "b.md")).mode & 0o777).toBe(0o640);
    expect(readlinkSync(join(work, "project", "link"))).toBe("notes.txt");
  });

  // proves D-221: a folder the agent swapped for a link to somewhere else is removed as the link it is; nothing outside
  // the workspace is read, written or removed
  it("never follows a symbolic link out of the workspace", async () => {
    const manifest = await checkpoint();
    rmSync(join(work, "project", "docs"), { recursive: true });
    symlinkSync(join(dir, "outside"), join(work, "project", "docs"));
    expect(await restore(manifest)).toEqual({ refusals: [], same: true });
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
    expect(await restore(manifest)).toEqual({ refusals: [], same: true });
    expect(read("notes.txt")).toBe("notes\n");
    expect(readFileSync(join(dir, "outside", "secret.txt"), "utf8")).toBe("outside\n");
  });

  // proves D-221 "it refuses on any mismatch": when the runner could not change a folder, the restore refuses before
  // changing anything, and the folder is exactly as it was
  it("refuses, and changes nothing, when the runner could not change a folder", async () => {
    const manifest = await checkpoint();
    writeFileSync(join(work, "project", "created.txt"), "new\n");
    writeFileSync(join(work, "project", "notes.txt"), "changed\n");
    const deep = join(work, "project", "docs", "deep");
    const result = await restore(manifest, { mayChange: (folder) => readlinkSync(folder) !== deep });
    expect(result.refusals).toEqual([expect.stringContaining('juno-runner cannot read, change and enter "docs/deep"')]);
    expect(result.same).toBe(false);
    expect(read("created.txt")).toBe("new\n");
    expect(read("notes.txt")).toBe("changed\n");
  });

  // proves D-221: a folder whose mode differs and that the runner does not own is removed and made again with the
  // checkpoint's mode; the workspace root, which cannot be made again, is refused instead
  it("replaces a folder another user owns whose mode differs, and refuses such a root", async () => {
    const manifest = await checkpoint();
    chmodSync(join(work, "project", "docs"), 0o700);
    // As if another user owned everything here: the restore may not change a mode, only replace the folder.
    expect(await restore(manifest, { uid: 4242 })).toEqual({ refusals: [], same: true });
    chmodSync(join(work, "project"), 0o700);
    const refused = await restore(manifest, { uid: 4242 });
    expect(refused.refusals).toEqual([expect.stringContaining("only its owner can change it")]);
  });

  // proves D-221: the workspace root is opened one component at a time, never through a link, and the service's folder
  // must be given as its real path
  it("refuses a workspace root reached through a link", () => {
    rmSync(join(work, "project"), { recursive: true });
    symlinkSync(join(dir, "outside"), join(work, "project"));
    expect(openWorkspaceRoot(work, "/work/project")).toMatchObject({ ok: false, reason: expect.stringContaining("without a symbolic link") });
    symlinkSync(work, join(dir, "work-link"));
    expect(openWorkspaceRoot(join(dir, "work-link"), "/work")).toMatchObject({ ok: false, reason: expect.stringContaining("through a symbolic link") });
  });

  // proves D-223 (review round 1 of PR #60, F1): a checkpoint holding a set-user-ID, set-group-ID or sticky bit is
  // refused before anything changes, and the restore never leaves a runner-owned file or folder with such a bit
  it("refuses a checkpoint with a set-user-ID, set-group-ID or sticky bit, and never recreates one", async () => {
    for (const [path, mode, folder] of [["notes.txt", 0o4755, false], ["notes.txt", 0o2755, false], ["docs", 0o1777, true], ["docs", 0o2775, true]] as const) {
      chmodSync(join(work, "project", path), mode);
      const manifest = await checkpoint();
      chmodSync(join(work, "project", path), folder ? 0o755 : 0o644);
      writeFileSync(join(work, "project", "created.txt"), "new\n");
      rmSync(join(work, "project", "notes.txt"));
      const result = await restore(manifest);
      expect(result.refusals, `${path} ${mode.toString(8)}`).toEqual([expect.stringContaining("set-user-ID, set-group-ID or sticky bit")]);
      expect(read("created.txt")).toBe("new\n");
      const opened = openWorkspaceRoot(work, "/work/project");
      if (!opened.ok) throw new Error(opened.reason);
      expect(() => restoreHostTree(opened.fd, manifest, (hash) => store.get(hash))).toThrow(/sticky bit/);
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
    const result = await restore(manifest);
    expect(result.refusals).toEqual([expect.stringContaining('"made" has a set-user-ID, set-group-ID or sticky bit (mode 1775)')]);
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
    const opened = openWorkspaceRoot(work, "/work/project");
    if (!opened.ok) throw new Error(opened.reason);
    expect(() => restoreHostTree(opened.fd, manifest, () => Buffer.from("not the bytes"))).toThrow(/does not match its hash/);
    closeSync(opened.fd);
    expect(read("created.txt")).toBe("new\n");
  });
});
