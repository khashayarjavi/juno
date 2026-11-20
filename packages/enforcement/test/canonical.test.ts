import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeOutbound } from "../../registry/src/index.js";
import { type CanonicalPaths, readResolverOutput, resolverArgs } from "../src/index.js";

/**
 * §2.7.1 "Data fields and scope" (v0.6 C4) and "Paths that do not exist yet" (v0.6.1 V6-2), D-113: the resolver
 * script, run by this host's node against a real directory tree standing for `/work`. The same script runs in the
 * workload (test/containers).
 */

let dir: string;
const resolve = async (paths: readonly string[]): Promise<CanonicalPaths> => {
  const result = await executeOutbound({ file: process.execPath, args: resolverArgs("/work", join(dir, "work"), paths) });
  return readResolverOutput(paths, result.stdout.toString("utf8"));
};
const canonical = async (path: string): Promise<string | null> => {
  const answer = (await resolve([path])).get(path);
  return answer?.ok === true ? answer.canonical : null;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "juno-canonical-"));
  mkdirSync(join(dir, "work/project/sub"), { recursive: true });
  mkdirSync(join(dir, "outside"));
  writeFileSync(join(dir, "work/project/sub/file.txt"), "x");
  // Names a program could read as options (D-112 hardening, D-120).
  writeFileSync(join(dir, "work/project/-c"), "c");
  writeFileSync(join(dir, "work/project/--help"), "help");
  symlinkSync("../../outside", join(dir, "work/project/escape"));
  symlinkSync("sub", join(dir, "work/project/inner"));
  symlinkSync("inner", join(dir, "work/project/chain"));
  symlinkSync("loop1", join(dir, "work/project/loop2"));
  symlinkSync("loop2", join(dir, "work/project/loop1"));
  symlinkSync("nowhere", join(dir, "work/project/dangling"));
  // A symlink then `..`: physically this is /work/project/sub/.. = /work/project, lexically it would be /work/project/x.
  symlinkSync("sub/file.txt", join(dir, "work/project/to-file"));
  // D-168: a link one level deeper, so `deep/..` is `sub` to the kernel and `project` to the text.
  mkdirSync(join(dir, "work/project/sub/deeper"));
  symlinkSync("sub/deeper", join(dir, "work/project/deep"));
  // D-157: a second name for a file outside the view, and its own link to it.
  writeFileSync(join(dir, "outside", "secret.txt"), "s");
  linkSync(join(dir, "outside", "secret.txt"), join(dir, "work/project/hard.txt"));
  symlinkSync("hard.txt", join(dir, "work/project/to-hard"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the canonical form of a path (§2.7.1 C4, D-113)", () => {
  // proves §2.7.1 C4: an existing path resolves to itself; a symlink chain that stays inside resolves to its target
  it("resolves existing paths and in-scope symlink chains", async () => {
    expect(await canonical("/work/project/sub/file.txt")).toBe("/work/project/sub/file.txt");
    expect(await canonical("/work/project/chain/file.txt")).toBe("/work/project/sub/file.txt");
  });

  // proves §2.7.1 C4 with D-112 hardening (D-120): every path follows a `--`, so files named -c and --help resolve as paths
  it("passes every path after a --, and resolves names that look like options", async () => {
    const args = resolverArgs("/work", "/host/work", ["/work/project/-c", "/work/project/--help"]);
    expect(args.slice(2, 4)).toEqual(["--", "/work"]);
    expect(args.indexOf("--")).toBeLessThan(args.indexOf("/work/project/-c"));
    expect(await canonical("/work/project/-c")).toBe("/work/project/-c");
    expect(await canonical("/work/project/--help")).toBe("/work/project/--help");
  });

  // proves §2.7.1 C4: a symlink pointing outside the view is not resolvable inside it, so it is outside every scope
  it("refuses a symlink that leaves the volume", async () => {
    expect(await canonical("/work/project/escape")).toBeNull();
    expect(await canonical("/work/project/escape/new.txt")).toBeNull();
  });

  // proves §2.7.1 C4: `..` is resolved physically, after the symlink it follows (never collapsed first)
  it("resolves .. after a symlink, as the kernel does", async () => {
    expect(await canonical("/work/project/inner/../sub/file.txt")).toBe("/work/project/sub/file.txt");
    expect(await canonical("/work/project/chain/..")).toBe("/work/project");
  });

  // proves §2.7.1 "cannot be resolved": a symlink loop has no canonical form
  it("refuses a symlink loop", async () => {
    const answer = (await resolve(["/work/project/loop1/x"])).get("/work/project/loop1/x");
    expect(answer).toMatchObject({ ok: false, reason: expect.stringContaining("ELOOP") });
  });

  // proves §2.7.1 V6-2: a path that does not exist yet resolves through its longest existing ancestor
  it("resolves a new path through its longest existing ancestor", async () => {
    expect(await canonical("/work/project/new.txt")).toBe("/work/project/new.txt");
    expect(await canonical("/work/project/inner/a/b/new.txt")).toBe("/work/project/sub/a/b/new.txt");
    expect(await canonical("/work/project/./new/./x")).toBe("/work/project/new/x");
  });

  // proves §2.7.1 V6-2: a missing remainder holding `..` or an empty component, or a dangling symlink, cannot be resolved
  it.each([["/work/project/missing/../sub"], ["/work/project/missing//x"], ["/work/project/missing/"], ["/work/project/dangling"], ["/work/project/dangling/x"]])(
    "refuses %s",
    async (path) => {
      expect(await canonical(path)).toBeNull();
    },
  );

  // proves D-113 fail-closed: a path outside the resolver's view, a relative path, or output it cannot read is unresolved
  it("answers every path, fail-closed", async () => {
    expect(await canonical("/etc/passwd")).toBeNull();
    expect(await canonical("relative/x")).toBeNull();
    expect(readResolverOutput(["/work/a"], "not json").get("/work/a")).toMatchObject({ ok: false });
    expect(readResolverOutput(["/work/a", "/work/b"], JSON.stringify([{ path: "/work/a", canonical: "/work/a" }])).get("/work/b")).toMatchObject({ ok: false });
    // D-221: the folders the resolving user could not change are carried through; anything else in them is unreadable.
    expect(readResolverOutput(["/work/a/x"], JSON.stringify([{ path: "/work/a/x", canonical: "/work/a/x", unwritable: ["/work/a"] }])).get("/work/a/x")).toEqual({ ok: true, canonical: "/work/a/x", unwritable: ["/work/a"] });
    expect(readResolverOutput(["/work/a/x"], JSON.stringify([{ path: "/work/a/x", canonical: "/work/a/x", unwritable: "/work/a" }])).get("/work/a/x")).toMatchObject({ ok: false });
  });
});

describe("hard links (D-157, operator ruling of 2026-11-07, amends D-156)", () => {
  // proves D-157: a regular file with a link count above 1 is reported as such, by name or through a symlink to it
  it("reports a regular file with more than one link, by name and through a symlink", async () => {
    expect((await resolve(["/work/project/hard.txt"])).get("/work/project/hard.txt")).toEqual({ ok: true, canonical: "/work/project/hard.txt", hardLinked: true });
    // Through a symlink it is also `redirected` (D-168): its canonical form is not its text.
    expect((await resolve(["/work/project/to-hard"])).get("/work/project/to-hard")).toEqual({ ok: true, canonical: "/work/project/hard.txt", hardLinked: true, redirected: true });
  });

  // proves D-157's positive control: an ordinary file, a directory (always more than one link) and a missing path are not
  it("does not report an ordinary file, a directory or a path that does not exist yet", async () => {
    const paths = ["/work/project/sub/file.txt", "/work/project/sub", "/work/project/new.txt"];
    const answers = await resolve(paths);
    for (const path of paths) expect(answers.get(path)).toEqual({ ok: true, canonical: path });
  });
});

describe("refuse cleverness (D-168, operator ruling 2 of 2026-11-08)", () => {
  // proves D-168: a path whose canonical form differs from its lexical normalization in any way is reported redirected:
  // a symlink by name, in a middle component, in a chain, and `..` after a symlink
  it.each([
    ["/work/project/inner", "/work/project/sub"],
    ["/work/project/inner/file.txt", "/work/project/sub/file.txt"],
    ["/work/project/chain/file.txt", "/work/project/sub/file.txt"],
    ["/work/project/to-file", "/work/project/sub/file.txt"],
    ["/work/project/deep/../file.txt", "/work/project/sub/file.txt"],
    ["/work/project/inner/a/b/new.txt", "/work/project/sub/a/b/new.txt"],
    ["/work/project/./inner//file.txt", "/work/project/sub/file.txt"],
  ])("reports %s as redirected", async (path, target) => {
    expect((await resolve([path])).get(path)).toEqual({ ok: true, canonical: target, redirected: true });
  });

  // proves D-168's positive control: plain paths, with `.`, `//`, a trailing slash on a directory, or `..` with no link
  // before it, are not redirected, so they keep their registered class
  it.each([
    ["/work/project/sub/file.txt", "/work/project/sub/file.txt"],
    ["/work/project/./sub//file.txt", "/work/project/sub/file.txt"],
    ["/work/project/sub/", "/work/project/sub"],
    ["/work/project//sub/./", "/work/project/sub"],
    ["/work/project/sub/../sub/file.txt", "/work/project/sub/file.txt"],
    ["/work/project/sub/new.txt", "/work/project/sub/new.txt"],
    // `..` after a link, where the kernel and the text agree on the place: nothing differs, so nothing is refused.
    ["/work/project/inner/../sub/file.txt", "/work/project/sub/file.txt"],
    ["/work/project/chain/..", "/work/project"],
  ])("does not report %s", async (path, target) => {
    expect((await resolve([path])).get(path)).toEqual({ ok: true, canonical: target });
  });
});
