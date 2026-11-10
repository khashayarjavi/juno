import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runner } from "../src/runner.js";
import { type Harness, OPERATOR_CRITERION, harness, request, shellRun, turn, writeWork } from "./helpers.js";

/**
 * §3.4.4 (v0.6 B2, v0.6.1 V6-1) with D-097 and D-112, in the turn loop: the verifier pins the verification scope before
 * the first turn and compares at closure. Declared outputs are never pinned; anything else that changed, appeared or
 * vanished makes `verified` impossible; a hash that cannot be computed counts as changed.
 */

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(() => {
  h.cleanup();
});

const notes = (type: string): Record<string, unknown>[] => h.entries().filter((entry) => entry.kind === "note").map(h.payload).filter((body) => body["type"] === type);
const withCriterion = (statement: Record<string, unknown> = {}): Record<string, unknown> => ({
  criterion: { ...OPERATOR_CRITERION, statement: { ...OPERATOR_CRITERION.statement, ...statement } },
  verification: "command_exit",
});
const admitted = (runner: Runner, overrides: Record<string, unknown>): void => {
  const result = runner.admit(request(overrides));
  if (!result.admitted) throw new Error(`not admitted: ${JSON.stringify(result.failures)}`);
};
/** A first turn that changes `/work` as `files` says (the task's effect, as the workload would show it), then claims done. */
const changing = (files: Record<string, string>): Parameters<Harness["runner"]>[0] => [
  () => {
    writeWork(files);
    return turn([shellRun(["notes.txt"])]);
  },
  turn([]),
];

describe("§3.4.4 B2: verification inputs are pinned at admission", () => {
  // proves §3.4.4 / §5.1: the pins are taken before the first turn and record each pinned file's hash
  it("records the pins before the first turn", async () => {
    const { runner } = h.runner([turn([])]);
    admitted(runner, withCriterion());
    expect((await runner.run("task-1")).state).toBe("verified");
    const firstTurn = h.entries().find((entry) => entry.kind === "turn")?.seq ?? -1;
    const baseline = h.entries().find((entry) => entry.kind === "note" && h.payload(entry)["type"] === "verification_pins");
    expect(baseline?.seq).toBeLessThan(firstTurn);
    const pins = h.payload(baseline as NonNullable<typeof baseline>)["pins"] as Record<string, { type: string; sha256: string | null }>;
    expect(pins["/work/project/notes.txt"]).toMatchObject({ type: "file", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(pins["/work/project/protected"]).toMatchObject({ type: "directory", sha256: null });
  });

  // proves §3.4.4 V6-1: a declared output the task creates or changes does not prevent verified
  it("lets the task create and change declared outputs", async () => {
    writeWork({ "/work/project/report.txt": "draft\n" });
    const { runner } = h.runner(changing({ "/work/project/report.txt": "final report\n", "/work/project/out/a.txt": "a\n" }));
    admitted(runner, withCriterion({ outputs: ["/work/project/report.txt", "/work/project/out"] }));
    expect((await runner.run("task-1")).state).toBe("verified");
    expect(notes("verification").at(-1)).toMatchObject({ result: "pass", inputs: "unchanged", changed_paths: [] });
  });

  // proves §3.4.4 with D-097: a new file that is not a declared output makes verified impossible ("the agent added a test that passes")
  it("fails verification when the task adds a file that is not an output", async () => {
    const { runner } = h.runner(changing({ "/work/project/tests/extra.test": "passes\n" }));
    admitted(runner, withCriterion());
    expect((await runner.run("task-1")).reason).toBe("verification_fail");
    expect(notes("verification").at(-1)).toMatchObject({ result: "fail", exit_code: 0, inputs: "changed", protected_paths: "unchanged" });
    expect(notes("verification").at(-1)?.["changed_paths"]).toEqual(["/work/project/tests", "/work/project/tests/extra.test"]);
    expect(notes("closure")).toEqual([]);
  });

  // proves §3.4.4 V6-1: a verification input absent at admission is pinned as absent, so a task that creates it cannot close verified
  it("fails verification when the task creates a declared input that was absent", async () => {
    const { runner } = h.runner(changing({ "/work/project/fixture.json": "{}\n" }));
    admitted(runner, withCriterion({ verification_inputs: ["/work/project/fixture.json"] }));
    expect((await runner.run("task-1")).reason).toBe("verification_fail");
    expect(notes("verification").at(-1)?.["changed_paths"]).toEqual(["/work/project/fixture.json"]);
  });

  // proves §3.4.4 B2: an input changed at the same size makes verified impossible, and the path is recorded
  it("fails verification when an input changed at the same size", async () => {
    const { runner } = h.runner(changing({ "/work/project/notes.txt": "NOTES\n" }));
    admitted(runner, withCriterion());
    expect((await runner.run("task-1")).reason).toBe("verification_fail");
    expect(notes("verification").at(-1)?.["changed_paths"]).toEqual(["/work/project/notes.txt"]);
  });

  // proves §3.4.4: a hash that cannot be computed counts as changed
  it("fails verification when an input's hash cannot be computed", async () => {
    writeWork({ "/work/project/unhashable.txt": "x\n" });
    const { runner } = h.runner([turn([])]);
    admitted(runner, withCriterion());
    expect((await runner.run("task-1")).reason).toBe("verification_fail");
    expect(notes("verification").at(-1)?.["changed_paths"]).toEqual(["/work/project/unhashable.txt"]);
  });

  // proves §3.4.4 with D-112: admission refuses outputs or inputs outside the verification scope, and an output that overlaps a protected path or an input
  it("refuses outputs and inputs it could not pin honestly", () => {
    const { runner } = h.runner([]);
    for (const [index, statement] of [
      { outputs: ["/work/elsewhere/report.txt"] },
      { verification_inputs: ["/work/elsewhere/test.js"] },
      { outputs: ["/work/project/protected/new.txt"] },
      { outputs: ["/work/project/out"], verification_inputs: ["/work/project/out/expected.txt"] },
    ].entries()) {
      const result = runner.admit(request({ id: `task-${String(index)}`, ...withCriterion(statement) }));
      expect(result.admitted, JSON.stringify(statement)).toBe(false);
      expect(result.admitted ? [] : result.failures.map((failure) => failure.check)).toContain("D-112");
    }
  });
});

describe("review fixes (D-114)", () => {
  // proves §3.4.4 ("a file the method reads that is in neither set is treated as an input") with D-114: a file the
  // criterion's command names outside its cwd is pinned, so a task that rewrites it cannot close verified
  it("pins a file the criterion reads outside its cwd", async () => {
    writeWork({ "/work/project/data/expected.txt": "expected\n", "/work/project/sub/readme.txt": "sub\n" });
    const { runner } = h.runner(changing({ "/work/project/data/expected.txt": "EXPECTED\n" }));
    admitted(runner, withCriterion({ command: { capability: "shell.run", arguments: { program: "/usr/bin/cat", argv: ["/work/project/data/expected.txt"], cwd: "/work/project/sub" } } }));
    expect((await runner.run("task-1")).reason).toBe("verification_fail");
    expect(notes("verification").at(-1)?.["changed_paths"]).toEqual(["/work/project/data/expected.txt"]);
  });

  // proves §8.2 (A2) on the verifier's own calls (D-109, D-114): when the closure's hashing names an untrusted path that
  // now leaves the scope, the park is not overridable, its remedy is a grant, and a plain resume is refused
  it("records the verifier's untrusted scope violation as remedy-grant, refusing a plain resume", async () => {
    const { runner } = h.runner([
      () => {
        // The task replaces an input with a symlink leading out of the volume.
        rmSync(join(h.dir, "work/project/notes.txt"));
        symlinkSync("/etc/hostname", join(h.dir, "work/project/notes.txt"));
        return turn([]);
      },
    ]);
    admitted(runner, withCriterion());
    expect((await runner.run("task-1")).reason).toBe("scope_violation");
    const park = h.entries().filter((entry) => entry.kind === "park").map(h.payload).at(-1);
    expect(park).toMatchObject({ reason: "scope_violation", overridable: false, remedy: "grant", phase: "pin_check", capability: "shell.run" });
    await expect(runner.resume("task-1")).rejects.toThrow(/§8\.2/);
    // Once the path resolves again inside a grant the task holds, the parked path is covered and the resume is taken (D-114).
    rmSync(join(h.dir, "work/project/notes.txt"));
    writeWork({ "/work/project/notes.txt": "notes\n" });
    await expect(runner.resume("task-1")).resolves.toMatchObject({ task_id: "task-1" });
  });
});
