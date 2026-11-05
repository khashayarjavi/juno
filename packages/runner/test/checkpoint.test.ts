import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore, MAX_CHECKPOINT_ENTRIES, Workspace, checkpointId, execFileScript, sameManifest } from "../src/checkpoint.js";

// §2.2.2 (v0.6, A1) "Reversible workspace": a checkpoint of the scope's full content, and a restore that brings it
// back (D-136). These run the same operator-fixed scripts the workload runs, by this host's node over a directory
// standing for /work; the real workload is covered by the container tests.

let dir: string;
let work: string;
let workspace: Workspace;
let store: CheckpointStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "juno-checkpoint-"));
  work = join(dir, "work");
  mkdirSync(join(work, "project", "src"), { recursive: true });
  writeFileSync(join(work, "project", "notes.txt"), "the original notes\n");
  writeFileSync(join(work, "project", "src", "main.txt"), Buffer.from([0, 1, 2, 255]));
  symlinkSync("notes.txt", join(work, "project", "link"));
  writeFileSync(join(work, "outside.txt"), "not in the workspace\n");
  workspace = new Workspace(execFileScript(process.execPath, []), "/work", work);
  store = new CheckpointStore(join(dir, "checkpoints"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function checkpoint(root = "/work/project"): Promise<{ id: string; manifest: Parameters<typeof checkpointId>[1] }> {
  const taken = await workspace.list(root, true);
  if (!taken.ok) throw new Error(taken.reason);
  for (const bytes of taken.snapshot.contents.values()) store.put(bytes);
  return { id: checkpointId(root, taken.snapshot.manifest), manifest: taken.snapshot.manifest };
}

describe("checkpoint of a reversible workspace (§2.2.2, D-136)", () => {
  // proves §2.2.2: the checkpoint holds the scope's full content: every path, type, mode, hash and symlink target
  it("lists every entry, records a symlink as a symlink, and stores every file's bytes", async () => {
    const { manifest } = await checkpoint();
    expect(manifest.map((entry) => [entry.path, entry.type])).toEqual([
      ["", "directory"],
      ["link", "symlink"],
      ["notes.txt", "file"],
      ["src", "directory"],
      ["src/main.txt", "file"],
    ]);
    expect(manifest.find((entry) => entry.path === "link")).toMatchObject({ target: "notes.txt" });
    for (const entry of manifest) if (entry.type === "file") expect(store.get(entry.sha256).length).toBeGreaterThan(0);
    expect(manifest.some((entry) => entry.path.includes("outside"))).toBe(false);
  });

  // proves §2.2.2 with §2.7.1 C4: a workspace root that is a symlink is refused, never followed
  it("refuses a root that is a symlink", async () => {
    symlinkSync(join(work, "project"), join(work, "alias"));
    expect(await workspace.list("/work/alias", true)).toMatchObject({ ok: false, reason: expect.stringContaining("symlink is refused") });
  });

  // proves D-136: a workspace larger than the bound is not checkpointed (never a partial copy)
  it("refuses a workspace with more entries than the bound", async () => {
    mkdirSync(join(work, "big"));
    for (let index = 0; index <= MAX_CHECKPOINT_ENTRIES; index += 1) writeFileSync(join(work, "big", `f${String(index)}`), "");
    expect(await workspace.list("/work/big", true)).toMatchObject({ ok: false, reason: expect.stringContaining("more than") });
  });

  // proves D-136: the checkpoint's id is fixed by its content, so the same content gives the same id and any change another
  it("names a checkpoint by its content", async () => {
    const first = await checkpoint();
    expect((await checkpoint()).id).toBe(first.id);
    writeFileSync(join(work, "project", "notes.txt"), "changed\n");
    expect((await checkpoint()).id).not.toBe(first.id);
  });

  // proves D-136: the store keeps bytes under their hash and refuses bytes that no longer match it
  it("refuses stored content that does not match its hash", async () => {
    const { manifest } = await checkpoint();
    const file = manifest.find((entry) => entry.type === "file");
    if (file?.type !== "file") throw new Error("no file");
    chmodSync(join(dir, "checkpoints", file.sha256), 0o600);
    writeFileSync(join(dir, "checkpoints", file.sha256), "tampered");
    expect(() => store.get(file.sha256)).toThrow(/does not match its hash/);
  });
});

describe("restoring a checkpoint brings back the exact prior content (§2.2.2, D-136)", () => {
  // proves §2.2.2 reversible workspace: after writes, removals, additions and a planted symlink, a restore brings back
  // the exact prior content, byte for byte, and touches nothing outside the workspace
  it("restores every file byte for byte, removes what was added, and leaves the outside alone", async () => {
    const { manifest } = await checkpoint();
    writeFileSync(join(work, "project", "notes.txt"), "overwritten by the task\n");
    rmSync(join(work, "project", "src", "main.txt"));
    writeFileSync(join(work, "project", "added.txt"), "added by the task\n");
    rmSync(join(work, "project", "src"), { recursive: true });
    symlinkSync("/work/outside.txt", join(work, "project", "src"));
    const restored = await workspace.restore("/work/project", manifest, (hash) => store.get(hash));
    expect(restored).toEqual({ ok: true });
    expect(readFileSync(join(work, "project", "notes.txt"), "utf8")).toBe("the original notes\n");
    expect([...readFileSync(join(work, "project", "src", "main.txt"))]).toEqual([0, 1, 2, 255]);
    expect(lstatSync(join(work, "project", "src")).isDirectory()).toBe(true);
    expect(readlinkSync(join(work, "project", "link"))).toBe("notes.txt");
    expect(existsSync(join(work, "project", "added.txt"))).toBe(false);
    expect(readFileSync(join(work, "outside.txt"), "utf8")).toBe("not in the workspace\n");
    const after = await workspace.list("/work/project", false);
    expect(after.ok && sameManifest(after.snapshot.manifest, manifest)).toBe(true);
  });

  // proves D-136: a restore whose stored content was tampered with does not write it
  it("refuses content that does not match the manifest's hash", async () => {
    const { manifest } = await checkpoint();
    const restored = await workspace.restore("/work/project", manifest, () => Buffer.from("not the original"));
    expect(restored).toMatchObject({ ok: false, reason: expect.stringContaining("does not match its hash") });
  });
});
