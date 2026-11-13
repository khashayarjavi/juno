import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore, Workspace, execFileScript } from "../../enforcement/src/index.js";
import { type Adapter, FS_WRITE, type CapabilityCall, loadRegistryEntry, writerArgs } from "../../registry/src/index.js";
import { runCheckpointCli } from "../src/restore.js";
import { type Harness, PRINCIPAL, grant, harness, request, shellRun, turn } from "./helpers.js";

// §2.2.2 (v0.6, A1) in JUNO's own loop: untrusted content may choose what is written inside a reversible workspace,
// and nowhere else; the checkpoint is taken before the first effect and restoring it is an operator action in the
// journal (D-135 to D-138). The stand-in workload is this host's node over the harness's `work` directory, running
// the same writer and checkpoint scripts the workload runs.

const FS_WRITE_FILE = fileURLToPath(new URL("../../registry/definitions/fs.file.write.json", import.meta.url));

let h: Harness;
let work: string;

const hostWriter = (): Adapter => ({
  id: FS_WRITE,
  plan: (call: CapabilityCall) => ({ file: process.execPath, args: writerArgs("/work", work, String(call["path"]), String(call["content"])) }),
});

let ids = 0;
const write = (path: unknown, content: unknown = "written by the task\n"): unknown => {
  ids += 1;
  return { id: `write-${String(ids)}`, capability: "fs.file.write", arguments: { path, content } };
};

function runnerWith(steps: Parameters<Harness["runner"]>[0], checkpoints = true): ReturnType<Harness["runner"]>["runner"] {
  const options = checkpoints ? { checkpoints: { workspace: new Workspace(execFileScript(process.execPath, []), "/work", work), store: new CheckpointStore(join(h.dir, "checkpoints")) } } : {};
  return h.runner(steps, options).runner;
}

const notes = (): string => readFileSync(join(work, "project", "notes.txt"), "utf8");
const notesOf = (type: string, taskId = "task-1"): Record<string, unknown>[] =>
  h.entries(taskId).filter((entry) => entry.kind === "note").map(h.payload).filter((payload) => payload["type"] === type);

beforeEach(async () => {
  h = await harness();
  work = join(h.dir, "work");
  expect(h.registry.register(loadRegistryEntry(FS_WRITE_FILE), [hostWriter()])).toEqual({ registered: true, id: "fs.file.write" });
  h.grants.add(grant({ id: "grant-write", capability_selector: { capabilities: ["fs.file.write"] }, max_invocations: 10 }));
});

afterEach(() => {
  h.cleanup();
});

describe("a write with an untrusted target, in JUNO's own loop (§2.2.2)", () => {
  // proves §2.2.2 write row with the reversible workspace: a synthesized path inside a checkpointed scope proceeds,
  // and the checkpoint was journalled before the task's first turn
  it("writes inside a reversible workspace, after a checkpoint taken before the first turn", async () => {
    const runner = runnerWith([turn([write("/work/project/notes.txt", "injected notes\n")]), turn()]);
    expect(runner.admit(request({ grants: ["grant-1", "grant-write"], reversible_workspaces: ["/work/project"] }))).toMatchObject({ admitted: true });
    expect(await runner.run("task-1")).toMatchObject({ state: "complete_unverified" });
    expect(notes()).toBe("injected notes\n");
    const kinds = h.entries().map((entry) => (entry.kind === "note" ? String(h.payload(entry)["type"]) : entry.kind));
    expect(kinds.indexOf("checkpoint")).toBeGreaterThan(-1);
    expect(kinds.indexOf("checkpoint")).toBeLessThan(kinds.indexOf("turn"));
    expect(notesOf("checkpoint")[0]).toMatchObject({ root: "/work/project", checkpoint: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  // proves §2.2.2 write row: the same path in a scope with no checkpoint is irreversible, so it parks integrity_floor,
  // nothing is written, and the park is not overridable (§8.3)
  it("parks the same write integrity_floor when the scope has no checkpoint, and writes nothing", async () => {
    const runner = runnerWith([turn([write("/work/project/notes.txt", "injected notes\n")])]);
    expect(runner.admit(request({ grants: ["grant-1", "grant-write"] }))).toMatchObject({ admitted: true });
    expect(await runner.run("task-1")).toMatchObject({ state: "parked", reason: "integrity_floor" });
    expect(notes()).toBe("notes\n");
    const park = h.entries().find((entry) => entry.kind === "park");
    expect(park === undefined ? null : h.payload(park)).toMatchObject({ overridable: false, detail: { effects: [{ refused: [{ argument: "path", judged_as: "irreversible" }] }] } });
    await expect(runner.resume("task-1", { grants: ["grant-write"] })).rejects.toThrow(/not overridable/);
  });

  // proves §2.2.2 "A write outside a reversible workspace is irreversible": inside the grant, outside the checkpointed root, it parks
  it("parks a write inside the grant but outside the reversible workspace", async () => {
    const runner = runnerWith([turn([write("/work/project/notes.txt", "changed\n")])]);
    expect(runner.admit(request({ grants: ["grant-1", "grant-write"], reversible_workspaces: ["/work/project/protected"] }))).toMatchObject({ admitted: true });
    expect(await runner.run("task-1")).toMatchObject({ state: "parked", reason: "integrity_floor" });
    expect(notes()).toBe("notes\n");
  });
});

describe("checkpoint and restore (§2.2.2 reversible workspace; D-136, D-138)", () => {
  // proves §2.2.2: after a write, restoring the checkpoint brings back the exact prior content, and both the checkpoint
  // and the restore are in the journal, the restore with the operator as its actor
  it("restores the exact prior content and journals the restore", async () => {
    const runner = runnerWith([turn([write("/work/project/notes.txt", "injected notes\n"), write("/work/project/new.txt", "added\n")]), turn()]);
    runner.admit(request({ grants: ["grant-1", "grant-write"], reversible_workspaces: ["/work/project"] }));
    await runner.run("task-1");
    expect(existsSync(join(work, "project", "new.txt"))).toBe(true);
    const checkpoint = String(notesOf("checkpoint")[0]?.["checkpoint"]);
    expect(await runner.restoreCheckpoint("task-1", checkpoint, PRINCIPAL)).toEqual({ ok: true, root: "/work/project" });
    expect(notes()).toBe("notes\n");
    expect(existsSync(join(work, "project", "new.txt"))).toBe(false);
    const restore = h.entries().find((entry) => entry.kind === "note" && h.payload(entry)["type"] === "checkpoint_restore");
    expect(restore?.actor).toBe(PRINCIPAL);
    expect(restore === undefined ? null : h.payload(restore)).toMatchObject({ checkpoint, outcome: "restored", principal: PRINCIPAL });
  });

  // proves §2.2.2 "an operator action": only the task's principal restores, and only a checkpoint the journal holds
  it("refuses a restore by anyone but the principal, and of a checkpoint the task does not have", async () => {
    const runner = runnerWith([turn()]);
    runner.admit(request({ grants: ["grant-1", "grant-write"], reversible_workspaces: ["/work/project"] }));
    await runner.run("task-1");
    const checkpoint = String(notesOf("checkpoint")[0]?.["checkpoint"]);
    expect(await runner.restoreCheckpoint("task-1", checkpoint, "someone-else")).toMatchObject({ ok: false });
    expect(await runner.restoreCheckpoint("task-1", "0".repeat(64), PRINCIPAL)).toMatchObject({ ok: false, reason: expect.stringContaining("no checkpoint") });
  });

  // proves D-136: with no checkpoint store, a task naming a reversible workspace fails before its first turn
  it("fails a task before its first turn when its workspace cannot be checkpointed", async () => {
    const runner = runnerWith([turn([write("/work/project/notes.txt")])], false);
    runner.admit(request({ grants: ["grant-1", "grant-write"], reversible_workspaces: ["/work/project"] }));
    expect(await runner.run("task-1")).toMatchObject({ state: "failed", reason: "checkpoint_unavailable" });
    expect(h.entries().some((entry) => entry.kind === "turn")).toBe(false);
    expect(notes()).toBe("notes\n");
  });

  // proves D-136: admission refuses a reversible workspace no grant reaches, the whole namespace, and overlapping ones
  it("refuses reversible workspaces outside every grant, the whole namespace, or overlapping", () => {
    const runner = runnerWith([]);
    const refused = (workspaces: readonly string[], id: string): unknown => runner.admit(request({ id, grants: ["grant-1", "grant-write"], reversible_workspaces: workspaces }));
    expect(refused(["/work/elsewhere"], "t-a")).toMatchObject({ admitted: false, failures: [{ check: "D-136" }] });
    expect(refused(["/work"], "t-b")).toMatchObject({ admitted: false });
    expect(refused(["/work/project", "/work/project/sub"], "t-c")).toMatchObject({ admitted: false, failures: [{ check: "D-136" }] });
  });

  // proves §2.2.2 read row (unchanged): an untrusted operand of a read proceeds with no reversible workspace
  it("leaves reads alone", async () => {
    const runner = runnerWith([turn([shellRun(["notes.txt"])]), turn()]);
    runner.admit(request());
    expect(await runner.run("task-1")).toMatchObject({ state: "complete_unverified" });
  });
});

describe("juno checkpoint restore (D-138)", () => {
  const io = (): { out: string[]; err: string[]; io: Parameters<typeof runCheckpointCli>[1] } => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { readFile: () => "", out: (text) => out.push(text), err: (text) => err.push(text) } };
  };
  const hostWorkspace = (): Workspace => new Workspace(execFileScript(process.execPath, []), "/work", work);

  // proves §2.2.2 "restoring that checkpoint is an operator action recorded in the journal", through the operator's command;
  // it refuses while a runner holds the journal (a task may be running), and refuses bad usage
  it("restores from the command line only when no runner holds the journal", async () => {
    const runner = runnerWith([turn([write("/work/project/notes.txt", "injected notes\n")]), turn()]);
    runner.admit(request({ grants: ["grant-1", "grant-write"], reversible_workspaces: ["/work/project"] }));
    await runner.run("task-1");
    const checkpoint = String(notesOf("checkpoint")[0]?.["checkpoint"]);
    const args = ["restore", "--journal", h.journal.root, "--checkpoints", join(h.dir, "checkpoints"), "--compose", "/repo/containers/docker-compose.yml", "--project", "juno-test", "--principal", PRINCIPAL, "task-1", checkpoint];
    const held = io();
    expect(await runCheckpointCli(args, held.io, hostWorkspace)).toBe(1);
    expect(held.err.join("")).toMatch(/runner/i);
    expect(notes()).toBe("injected notes\n");
    runner.close();
    const done = io();
    expect(await runCheckpointCli(args, done.io, hostWorkspace)).toBe(0);
    expect(JSON.parse(done.out.join(""))).toEqual({ ok: true, root: "/work/project" });
    expect(notes()).toBe("notes\n");
    expect(notesOf("checkpoint_restore")).toMatchObject([{ outcome: "restored", principal: PRINCIPAL }]);
    const bad = io();
    expect(await runCheckpointCli(["restore", "task-1"], bad.io, hostWorkspace)).toBe(2);
  });
});

describe("the runner refuses a runtime that would ignore the workload's limits (D-131, D-149)", () => {
  // proves D-131's Increment 4 directive: given cgroup driver none, the runner does not start
  it("does not start on cgroup driver none", () => {
    expect(() => h.runner([], { containerRuntime: { cgroupDriver: "none", cgroupVersion: "1", rootless: true } })).toThrow(/will not start.*cgroup driver "none"/);
  });
});
