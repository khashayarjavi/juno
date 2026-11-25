import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MANIFEST, buildRefusals, main, writeBuildManifest } from "../src/build-check.js";

// D-244 (operator's increment 1.5-ops, item 2): JUNO refuses cleanly, never crashes, on an incomplete copy. `make build`
// writes the build manifest last; `juno-build-check` refuses a copy that lacks it, lacks a file it names, or holds one
// other than as built, and says which.

let root: string;
const write = (path: string, text: string): void => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "juno-build-"));
  write("package.json", '{"type":"module"}\n');
  write("package-lock.json", JSON.stringify({ packages: { "": {}, "node_modules/zod": {}, "node_modules/vitest": { dev: true } } }));
  write("dist/runner/src/juno.js", "export {};\n");
  write("dist/runner/src/juno-build-check.js", "export {};\n");
  write("dist/mediated/definitions/tools.json", "{}\n");
  write("node_modules/zod/index.js", "export {};\n");
  write("node_modules/zod/v4/core.js", "export {};\n");
  write("node_modules/vitest/index.js", "export {};\n");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const said = (): { io: { out: (text: string) => void; err: (text: string) => void }; text: () => string } => {
  const lines: string[] = [];
  return { io: { out: (text) => lines.push(text), err: (text) => lines.push(text) }, text: () => lines.join("") };
};

describe("D-244: JUNO starts only from a finished build", () => {
  // proves D-244: the manifest names dist, package.json and the runtime dependencies (never development-only ones)
  it("names every file JUNO runs from, and passes a finished build", () => {
    expect(writeBuildManifest(root)).toBe(6);
    const manifest = JSON.parse(readFileSync(join(root, MANIFEST), "utf8")) as { version: number; files: Record<string, string> };
    expect(Object.keys(manifest.files)).toEqual(["dist/mediated/definitions/tools.json", "dist/runner/src/juno-build-check.js", "dist/runner/src/juno.js", "node_modules/zod/index.js", "node_modules/zod/v4/core.js", "package.json"]);
    expect(buildRefusals(root)).toEqual([]);
    const out = said();
    expect(main(out.io, root)).toBe(0);
    expect(out.text()).toContain("is complete");
  });

  // proves D-244: a copy still being built (no manifest yet) is refused, by name
  it("refuses a copy without the manifest", () => {
    const out = said();
    expect(main(out.io, root)).toBe(1);
    expect(out.text()).toContain(`juno-build-check: refused: JUNO will not start from an incomplete copy (D-244):\n  - ${join(root, MANIFEST)} is missing, so this copy of JUNO is not a finished build`);
    expect(out.text()).toContain('"Upgrading JUNO to a new commit"');
  });

  // proves D-244: a copy being removed or replaced (files gone, or a file cut short) is refused, naming the files
  it("refuses a copy with files missing or not as built, naming them", () => {
    writeBuildManifest(root);
    rmSync(join(root, "node_modules/zod/v4/core.js"));
    rmSync(join(root, "dist/runner/src/juno.js"));
    writeFileSync(join(root, "dist/mediated/definitions/tools.json"), "");
    expect(buildRefusals(root)).toEqual([
      `2 of the files JUNO was built with are missing from ${root}: dist/runner/src/juno.js, node_modules/zod/v4/core.js`,
      `1 of the files in ${root} are not as JUNO built them: dist/mediated/definitions/tools.json`,
    ]);
    const out = said();
    expect(main(out.io, root)).toBe(1);
    expect(out.text()).not.toMatch(/\bat \S+:\d+:\d+/);
  });

  // proves D-244: a manifest that is not JUNO's (unreadable, empty, or naming a path outside the copy) is refused
  it("refuses a manifest JUNO did not write", () => {
    for (const text of ["not json", "{}", JSON.stringify({ version: 1, files: {} }), JSON.stringify({ version: 1, files: { "../etc/passwd": "00" } }), JSON.stringify({ version: 1, files: { "/etc/passwd": "00" } })]) {
      write(MANIFEST, text);
      const refusals = buildRefusals(root);
      expect(refusals.length, text).toBe(1);
      expect(refusals[0], text).toMatch(/cannot be read|is not a build manifest JUNO wrote/);
    }
  });

  // proves D-244: anything but a file or a folder in what JUNO runs from stops the build itself
  it("refuses to write a manifest over a link", async () => {
    const { symlinkSync } = await import("node:fs");
    symlinkSync("/etc/passwd", join(root, "dist/runner/src/link.js"));
    expect(() => writeBuildManifest(root)).toThrow(/dist\/runner\/src\/link.js is neither a file nor a folder/);
  });
});
