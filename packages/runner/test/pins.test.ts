import { describe, expect, it } from "vitest";
import { MAX_PIN_ENTRIES, changedPins, filesToHash, parseHashes, parseListing, pinRoots, pinsOf, readEscaped } from "../src/pins.js";

/**
 * §3.4.4 (v0.6 B2, v0.6.1 V6-1) with D-097 and D-112: the readings of the verifier's listing and hashes, and the
 * comparison that decides whether verification inputs changed. The listing fixture is real output of the workload
 * base image's GNU ls (coreutils 9.1), captured 2026-11-03, over names with a space, a backslash, a newline, a
 * non-ASCII byte pair, " -> ", ":" and a symlink.
 */
const LISTING = [
  "-rw-r--r-- 1 0 0    1 2026-11-03 18:22:04.745737401 +0000 /work/project/plain.txt",
  "",
  "/work/other:",
  "total 12",
  "drwxr-xr-x 2 0 0 4096 2026-11-03 18:25:27.754340843 +0000 .",
  "drwxr-xr-x 4 0 0 4096 2026-11-03 18:25:27.911884125 +0000 ..",
  "-rw-r--r-- 1 0 0    1 2026-11-03 18:25:27.754340843 +0000 keep.txt",
  "",
  "/work/project:",
  "total 40",
  "drwxr-xr-x 4 0 0 4096 2026-11-03 18:25:27.752617226 +0000 .",
  "drwxr-xr-x 4 0 0 4096 2026-11-03 18:25:27.911884125 +0000 ..",
  "-rw-r--r-- 1 0 0    1 2026-11-03 18:23:04.553553389 +0000 a\\ ->\\ b",
  "-rw-r--r-- 1 0 0    1 2026-11-03 18:23:04.553553389 +0000 back\\\\slash",
  "-rw-r--r-- 1 0 0    2 2026-11-03 18:25:27.754340843 +0000 caf\\303\\251",
  "drwxr-xr-x 2 0 0 4096 2026-11-03 18:22:04.748261858 +0000 dir:",
  "lrwxrwxrwx 1 0 0   11 2026-11-03 18:22:04.745737401 +0000 link -> /etc/passwd",
  "-rw-r--r-- 1 0 0    1 2026-11-03 18:22:04.745737401 +0000 new\\nline",
  "-rw-r--r-- 1 0 0    1 2026-11-03 18:22:04.745737401 +0000 plain.txt",
  "-rw-r--r-- 1 0 0    1 2026-11-03 18:22:04.745737401 +0000 sp\\ ace",
  "drwxr-xr-x 2 0 0 4096 2026-11-03 18:22:04.748261858 +0000 sub",
  "",
  "/work/project/dir\\::",
  "total 8",
  "drwxr-xr-x 2 0 0 4096 2026-11-03 18:22:04.748261858 +0000 .",
  "drwxr-xr-x 4 0 0 4096 2026-11-03 18:25:27.752617226 +0000 ..",
  "",
  "/work/project/sub:",
  "total 12",
  "drwxr-xr-x 2 0 0 4096 2026-11-03 18:22:04.748261858 +0000 .",
  "drwxr-xr-x 4 0 0 4096 2026-11-03 18:25:27.752617226 +0000 ..",
  "-rw-r--r-- 1 0 0    1 2026-11-03 18:22:04.748261858 +0000 x:y",
].join("\n") + "\n";

const ROOTS = ["/work/other", "/work/project", "/work/project/plain.txt"];

describe("reading the verifier's listing (D-112)", () => {
  // proves D-112: every path in the scope is read once, with its type, and names are decoded exactly
  it("reads every entry of a real escape-quoted listing, decoding each name", () => {
    const parsed = parseListing(LISTING, ROOTS);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect([...parsed.entries.keys()].sort()).toEqual(
      [
        "/work/other",
        "/work/other/keep.txt",
        "/work/project",
        "/work/project/a -> b",
        "/work/project/back\\slash",
        "/work/project/caf\u00e9",
        "/work/project/dir:",
        "/work/project/link",
        "/work/project/new\nline",
        "/work/project/plain.txt",
        "/work/project/sp ace",
        "/work/project/sub",
        "/work/project/sub/x:y",
      ].sort(),
    );
    expect(parsed.entries.get("/work/project/link")).toEqual({ type: "symlink", mode: "lrwxrwxrwx", size: "11", target: "/etc/passwd" });
    expect(parsed.entries.get("/work/project/a -> b")).toMatchObject({ type: "file", target: null });
    expect(parsed.entries.get("/work/project/dir:")).toMatchObject({ type: "directory" });
  });

  // proves D-112 fail-closed: a root the listing does not show, a line of the wrong shape, or an undecodable name is not a listing
  it.each([
    ["a missing root", LISTING, [...ROOTS, "/work/missing"]],
    ["a line of another shape", LISTING.replace("total 12", "garbage here"), ROOTS],
    ["a name that is not UTF-8", LISTING.replace("caf\\303\\251", "caf\\303"), ROOTS],
    ["an unknown escape", LISTING.replace("sp\\ ace", "sp\\qace"), ROOTS],
    ["a header that is not absolute", LISTING.replace("/work/project/sub:", "work/project/sub:"), ROOTS],
  ])("refuses %s", (_name, text, roots) => {
    expect(parseListing(text, roots).ok).toBe(false);
  });

  // proves D-112: more entries than the bound is not a listing (the task fails; the check is never skipped)
  it("refuses more entries than the bound", () => {
    const line = "-rw-r--r-- 1 0 0 1 2026-11-03 18:22:04.745737401 +0000 f";
    const many = ["/work/x:", "total 0", "drwxr-xr-x 2 0 0 4096 2026-11-03 18:22:04.748261858 +0000 .", ...Array.from({ length: MAX_PIN_ENTRIES + 1 }, (_e, i) => `${line}${String(i)}`)].join("\n");
    expect(parseListing(many, ["/work/x"])).toMatchObject({ ok: false, reason: expect.stringContaining("more than") });
  });

  // proves D-112: escape decoding stops at the first raw space, so " -> " is never part of a name
  it("decodes escapes and stops at a raw space", () => {
    expect(readEscaped("a\\ b\\\\c\\n\\303\\251 -> t")).toEqual({ name: "a b\\c\n\u00e9", rest: " -> t" });
  });
});

describe("pinning and comparing (§3.4.4, D-097, D-112)", () => {
  const parsed = parseListing(LISTING, ROOTS);
  if (!parsed.ok) throw new Error(parsed.reason);
  const files = filesToHash(parsed.entries, []);
  const hashes = new Map(files.map((path) => [path, "a".repeat(64)]));
  const baseline = pinsOf(parsed.entries, hashes, []);

  // proves §3.4.4: every regular file is hashed, never a symlink (whose target may lie outside the scope)
  it("hashes regular files only", () => {
    expect(files).not.toContain("/work/project/link");
    expect(files).toContain("/work/project/new\nline");
    expect(files).not.toContain("/work/project/sub");
  });

  // proves §3.4.4: unchanged pins compare equal
  it("finds nothing changed when nothing changed", () => {
    expect(changedPins(baseline, pinsOf(parsed.entries, hashes, []))).toEqual([]);
  });

  // proves §3.4.4 B2: a file rewritten with the same size changes its hash, and that is a change (Slice 1's listing comparison could miss it)
  it("finds a content change of the same size", () => {
    const after = new Map(hashes);
    after.set("/work/project/plain.txt", "b".repeat(64));
    expect(changedPins(baseline, pinsOf(parsed.entries, after, []))).toEqual(["/work/project/plain.txt"]);
  });

  // proves §3.4.4: a hash that cannot be computed counts as changed, on either side
  it("counts a missing hash as changed", () => {
    const after = new Map(hashes);
    after.delete("/work/project/sp ace");
    expect(changedPins(baseline, pinsOf(parsed.entries, after, []))).toEqual(["/work/project/sp ace"]);
  });

  // proves §3.4.4 with D-097: a new file that is not a declared output, a removed file, a retargeted symlink and a mode change are changes
  it("finds added, removed, retargeted and re-moded paths", () => {
    const entries = new Map(parsed.entries);
    entries.set("/work/project/new-test.txt", { type: "file", mode: "-rw-r--r--", size: "1", target: null });
    entries.delete("/work/project/sub/x:y");
    entries.set("/work/project/link", { type: "symlink", mode: "lrwxrwxrwx", size: "4", target: "/tmp" });
    entries.set("/work/project/plain.txt", { type: "file", mode: "-rwxr-xr-x", size: "1", target: null });
    const after = pinsOf(entries, new Map([...hashes, ["/work/project/new-test.txt", "c".repeat(64)]]), []);
    expect(changedPins(baseline, after)).toEqual(["/work/project/link", "/work/project/new-test.txt", "/work/project/plain.txt", "/work/project/sub/x:y"]);
  });

  // proves §3.4.4 V6-1: a declared output is never pinned, so creating or changing it is not a change; its directory's size is not compared
  it("ignores declared outputs, and a directory's size", () => {
    const outputs = ["/work/project/report.txt"];
    const before = pinsOf(parsed.entries, hashes, outputs);
    const entries = new Map(parsed.entries);
    entries.set("/work/project/report.txt", { type: "file", mode: "-rw-r--r--", size: "9", target: null });
    entries.set("/work/project", { type: "directory", mode: "drwxr-xr-x", size: "8192", target: null });
    expect(changedPins(before, pinsOf(entries, hashes, outputs))).toEqual([]);
    expect(filesToHash(entries, outputs)).not.toContain("/work/project/report.txt");
  });
});

describe("roots and hashes (D-112)", () => {
  // proves D-112: a root inside another is listed once, through its parent
  it("drops a root inside another", () => {
    expect(pinRoots(["/work/project/protected", "/work/project", "/work/project"])).toEqual(["/work/project"]);
    expect(pinRoots(["/work/a", "/work/ab"])).toEqual(["/work/a", "/work/ab"]);
  });

  // proves D-112: sha256sum -z records are read with raw names; anything else gives no hash
  it("reads sha256sum -z output with raw names", () => {
    const hash = "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d";
    const parsed = parseHashes(`${hash}  /w/new\nline\0${hash}  /w/sp ace\0garbage\0`);
    expect([...parsed.entries()]).toEqual([
      ["/w/new\nline", hash],
      ["/w/sp ace", hash],
    ]);
  });
});
