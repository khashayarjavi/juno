import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { explainTask } from "../src/explain.js";
import type { Runner } from "../src/runner.js";
import { type Harness, grant, harness, request, shellRun, turn } from "./helpers.js";

/**
 * §8.2 (v0.6, A2), §6.2: a `scope_violation` caused by an `untrusted` value is not overridden. The park records
 * `overridable: false` and `remedy: "grant"`; a plain resume is refused; resuming after a grant covering the parked
 * value is added succeeds. A value of operator integrity outside scope stays overridable (D-109).
 */

let h: Harness;
beforeEach(() => {
  h = harness();
  // The task's own grant reaches only the inbox, so notes.txt in the project is outside its scope.
  h.grants.add(grant({ id: "grant-inbox", resource_scope: [{ kind: "path", prefix: "/work/project/inbox" }] }));
});
afterEach(() => {
  h.cleanup();
});

const parks = (): Record<string, unknown>[] => h.entries().filter((entry) => entry.kind === "park").map(h.payload);
const results = (): number => h.entries().filter((entry) => entry.kind === "capability_result").length;
const admitted = (runner: Runner, overrides: Record<string, unknown> = {}): void => {
  const result = runner.admit(request({ grants: ["grant-inbox"], ...overrides }));
  if (!result.admitted) throw new Error(`not admitted: ${JSON.stringify(result.failures)}`);
};

describe("§8.2 A2: no override of an untrusted scope violation", () => {
  // proves §8.2 A2 / §6.2: an untrusted out-of-scope value parks scope_violation with overridable false and remedy grant
  it("records the park as not overridable, remedy a grant, naming the untrusted value", async () => {
    const { runner } = h.runner([turn([shellRun(["notes.txt"])])]);
    admitted(runner);
    expect((await runner.run("task-1")).reason).toBe("scope_violation");
    expect(parks()[0]).toMatchObject({ reason: "scope_violation", overridable: false, remedy: "grant", capability: "shell.run", detail: { untrusted: ["argv[0]"] } });
    expect(explainTask(h.journal.root, "task-1")).toMatch(/PARKED "scope_violation" \(not overridable; remedy: a grant covering the value\)/);
  });

  // proves §8.2 A2: a plain resume is refused, and so is a resume adding a grant that does not cover the value
  it("refuses a plain resume and a resume with a grant that does not cover the value", async () => {
    h.grants.add(grant({ id: "grant-other", resource_scope: [{ kind: "path", prefix: "/work/project/elsewhere" }] }));
    const { runner } = h.runner([turn([shellRun(["notes.txt"])]), turn([])]);
    admitted(runner);
    await runner.run("task-1");
    await expect(runner.resume("task-1")).rejects.toThrow(/not overridden \(§8\.2\).*\/work\/project\/notes\.txt/);
    await expect(runner.resume("task-1", { grants: ["grant-other"] })).rejects.toThrow(/§8\.2/);
    expect(runner.task("task-1")?.state).toBe("parked");
    expect(runner.task("task-1")?.grants).toEqual(["grant-inbox"]);
    expect(h.entries().filter((entry) => entry.kind === "resume")).toHaveLength(0);
    expect(results()).toBe(0);
  });

  // proves §8.2 A2: resuming after a covering grant is added succeeds, and the retried call then runs under that grant
  it("resumes once a grant covering the value is added", async () => {
    const { runner } = h.runner([turn([shellRun(["notes.txt"])]), turn([shellRun(["notes.txt"])]), turn([])]);
    admitted(runner);
    await runner.run("task-1");
    expect((await runner.resume("task-1", { grants: ["grant-1"] })).state).toBe("complete_unverified");
    expect(results()).toBe(1);
  });

  // proves §8.2 A2 (D-109): with any untrusted out-of-scope value the rule applies, even beside an operator value
  it("applies when any out-of-scope value is untrusted", async () => {
    const { runner } = h.runner([turn([shellRun([{ slot: "notes" }, "more.txt"])])]);
    admitted(runner, { constants: { cat: { value: "/usr/bin/cat" }, project: { value: "/work/project" }, notes: { value: "/work/project/notes.txt" } } });
    await runner.run("task-1");
    expect(parks()[0]).toMatchObject({ overridable: false, remedy: "grant", detail: { untrusted: ["argv[1]"] } });
  });

  // proves §8.2 A2 (D-109): a relative operand is read against cwd, so an untrusted cwd makes an operator operand's violation untrusted
  it("counts an untrusted cwd as causing a relative operand's violation", async () => {
    const { runner } = h.runner([turn([shellRun([{ slot: "name" }], { slot: "cat" }, "/work/project")])]);
    admitted(runner, { constants: { cat: { value: "/usr/bin/cat" }, name: { value: "notes.txt" } } });
    await runner.run("task-1");
    expect(parks()[0]).toMatchObject({ reason: "scope_violation", overridable: false, remedy: "grant" });
    expect((parks()[0]?.["detail"] as { untrusted: string[] }).untrusted).toEqual(expect.arrayContaining(["argv[0]", "cwd"]));
  });

  // proves §6.2 / §8.2: an out-of-scope value of operator integrity is overridable, and a plain resume works
  it("keeps an operator-integrity scope violation overridable", async () => {
    const { runner } = h.runner([turn([shellRun([{ slot: "notes" }])]), turn([])]);
    admitted(runner, { constants: { cat: { value: "/usr/bin/cat" }, project: { value: "/work/project" }, notes: { value: "/work/project/notes.txt" } } });
    expect((await runner.run("task-1")).reason).toBe("scope_violation");
    const [park] = parks();
    expect(park).toMatchObject({ overridable: true, detail: { untrusted: [] } });
    expect(park).not.toHaveProperty("remedy");
    expect((await runner.resume("task-1")).state).toBe("complete_unverified");
  });
});
