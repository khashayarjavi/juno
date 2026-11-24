import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

// D-244 (operator's increment 1.5-ops, item 2): during an upgrade the service started by itself on a half-built
// /opt/juno and crashed. The hook service's unit now runs `juno-build-check` first. Against the real build in the runner
// image (`make build`, `make stage`): it passes, and it refuses, in plain words and without a stack trace, a copy without
// the manifest, one with files removed, and one with a file cut short. No shell.

const run = promisify(execFile);
const fixtures = fileURLToPath(new URL("./build-check", import.meta.url));
type Exit = { code: number; stdout: string; stderr: string };
let results: { real: Exit; unfinished: Exit; removed: Exit; cut: Exit };

beforeAll(async () => {
  const { stdout } = await run(
    "docker",
    [
      "run", "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--mount", ["type=bind", ["source", fixtures].join("="), "target=/r", "readonly"].join(","),
      "--tmpfs", "/tmp:mode=1777",
      "--entrypoint", "/usr/local/bin/node", "juno-runner:local", "/r/driver.mjs",
    ],
    { maxBuffer: 16 * 1024 * 1024, timeout: 180_000 },
  );
  results = JSON.parse(stdout) as typeof results;
});

describe("D-244: JUNO refuses to start from a copy that is not a finished build", () => {
  // proves D-244: `make build` writes a manifest the real build passes, staged dependencies included
  it("passes the image's real build", () => {
    expect(results.real).toEqual({ code: 0, stdout: "juno-build-check: this copy of JUNO at /app/ is complete: every file matches dist/build-manifest.json\n", stderr: "" });
  });

  // proves D-244: a copy cut as an upgrade cuts one is refused by name, exit 1, no stack trace
  it("refuses a copy without the manifest, with files removed, or with a file cut short", () => {
    expect(results.unfinished.code).toBe(1);
    expect(results.unfinished.stderr).toContain("/tmp/unfinished/dist/build-manifest.json is missing, so this copy of JUNO is not a finished build");
    expect(results.removed.code).toBe(1);
    expect(results.removed.stderr).toContain("2 of the files JUNO was built with are missing from /tmp/removed/: dist/enforcement/src/session-layer.js, node_modules/zod/package.json");
    expect(results.cut.code).toBe(1);
    expect(results.cut.stderr).toContain("1 of the files in /tmp/cut/ are not as JUNO built them: dist/mediated/src/hook-serve.js");
    for (const exit of [results.unfinished, results.removed, results.cut]) {
      expect(exit.stderr).toMatch(/^juno-build-check: refused: JUNO will not start from an incomplete copy \(D-244\):\n/);
      expect(exit.stderr).not.toMatch(/\n\s+at /);
    }
  });
});
