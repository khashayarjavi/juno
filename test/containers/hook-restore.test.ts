import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

// §2.2.2 (v0.6 A1): "A scope is reversible when a checkpoint of its full content is taken before the task's first effect
// on it and restoring that checkpoint is an operator action recorded in the journal." D-221 (operator's increment
// 1.5-field, item 1): hook mode's host folder is restored by `juno checkpoint restore --workspace`, run by the operator
// as the runner, once the service is stopped. End to end, in one sealed container from the runner image (no network),
// against the kernel: the real `juno hook serve` as the runner (uid 1000), the real hook client as the Claude Code user
// (uid 1001), that user's own changes to the folder, the real restore as root, as the Claude Code user and as the
// runner, and the real service started again on the same journal (hook-restore/driver.mjs). No shell.

const run = promisify(execFile);
const fixtures = fileURLToPath(new URL("./hook-restore", import.meta.url));
const helpers = fileURLToPath(new URL("./hook-separation", import.meta.url));

type Exit = { code: number; stdout: string; stderr: string };
type Results = {
  started: boolean;
  startText: string;
  admit: Exit;
  writeNew: Exit;
  writeNewResult: Exit;
  agentChanges: { done: boolean }[];
  newFolderMode: string;
  lockOut: { done: boolean }[];
  writeLocked: Exit;
  lockRead: { done: boolean }[];
  writeUnreadable: Exit;
  unlockRead: { done: boolean }[];
  restoreWhileServing: Exit;
  stopped: Exit;
  list: Exit;
  before: string[];
  asRoot: Exit;
  asAgent: Exit;
  locked: Exit;
  afterLocked: string[];
  unlock: { done: boolean }[];
  restored: Exit;
  after: string[];
  journal: { kind: string; actor: string; type: string | null; outcome: string | null; reason: string | null }[];
  restarted: boolean;
  restartText: string;
  restartStopped?: Exit;
};

let results: Results;

beforeAll(async () => {
  const { stdout } = await run(
    "docker",
    [
      "run", "--rm", "--user", "0", "--network", "none",
      "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "FSETID", "--cap-add", "DAC_READ_SEARCH",
      "--security-opt", "no-new-privileges:true",
      "--mount", ["type=bind", ["source", fixtures].join("="), "target=/r", "readonly"].join(","),
      "--mount", ["type=bind", ["source", helpers].join("="), "target=/h", "readonly"].join(","),
      // The workspace: a tmpfs, a case-sensitive Linux file system (D-178) that keeps access lists.
      "--tmpfs", "/srv/work:mode=0755",
      "--entrypoint", "/usr/local/bin/node", "juno-runner:local", "/r/driver.mjs",
    ],
    { maxBuffer: 16 * 1024 * 1024, timeout: 300_000 },
  );
  results = JSON.parse(stdout) as Results;
}, 360_000);

const BEFORE = ["notes.txt=notes", "sub/", "sub/keep.txt=keep"];

describe("restoring a hook session's host folder, end to end against the real hook service (§2.2.2, D-221)", () => {
  // proves §2.2.2's write row in hook mode: a write inside the checkpointed workspace proceeds (no decision from JUNO),
  // and the guide's access list keeps what the Claude Code user makes changeable by the runner, whatever its umask
  it("admits the session with its checkpoint and lets a write inside the reversible workspace proceed", () => {
    expect(results.started, results.startText).toBe(true);
    expect(results.admit).toMatchObject({ code: 0, stdout: expect.stringContaining(`admitted session-`) });
    expect(results.writeNew).toMatchObject({ code: 0, stdout: "" });
    expect(results.writeNewResult.code).toBe(0);
    expect(results.agentChanges.every((step) => step.done)).toBe(true);
    // umask 022, yet the folder the Claude Code user made is group-writable: the mask the access list sets.
    expect(results.newFolderMode).toBe("775");
  });

  // proves D-221: a write below a folder the runner could no longer change is not reversible, so it parks
  // (integrity_floor, which no one can override, §8.3), against the kernel's own access check
  it("parks a write the restore could not undo", () => {
    expect(results.lockOut.every((step) => step.done)).toBe(true);
    expect(JSON.parse(results.writeLocked.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("integrity_floor") } });
    // D-223 (F2): a folder the runner may change and enter but not read parks too: the restore needs all three.
    expect(results.lockRead.every((step) => step.done)).toBe(true);
    expect(results.unlockRead.every((step) => step.done)).toBe(true);
    expect(JSON.parse(results.writeUnreadable.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("integrity_floor") } });
  });

  // proves D-221 "it requires the service stopped": while the service runs, the restore is refused
  it("refuses to restore while the service runs", () => {
    expect(results.restoreWhileServing).toMatchObject({ code: 1, stderr: expect.stringContaining("its service is running") });
    expect(results.stopped.code).toBe(0);
  });

  // proves D-221 "the operator runs it, as juno-runner" and "it refuses on any mismatch": root is refused, the Claude
  // Code user is refused (it cannot even see the journal), and a folder the runner cannot change refuses the whole
  // restore before anything changes
  it("refuses root, the Claude Code user, and a folder it could not change, changing nothing", () => {
    expect(results.list).toMatchObject({ code: 0 });
    expect(JSON.parse(results.list.stdout)).toMatchObject({ checkpoints: [{ root: "/work/project", workspace: "/srv/work" }] });
    expect(results.asRoot).toMatchObject({ code: 1, stderr: expect.stringContaining("never as root") });
    expect(results.asAgent).toMatchObject({ code: 1, stderr: expect.stringContaining("refused, nothing was changed") });
    expect(results.locked.code).toBe(1);
    expect(JSON.parse(results.locked.stdout)).toMatchObject({ ok: false, reason: expect.stringContaining('juno-runner cannot read, change and enter "locked"') });
    expect(results.afterLocked).toEqual(results.before);
    expect(results.before).not.toEqual(BEFORE);
  });

  // proves §2.2.2's reversible workspace in hook mode: the restore brings back the checkpoint's full content (the files
  // made after it removed, the changed file and the deleted one put back) and is journalled with the operator as actor
  it("restores the folder's full content and records it in the journal", () => {
    expect(results.unlock.every((step) => step.done)).toBe(true);
    expect(results.restored.code, results.restored.stderr + results.restored.stdout).toBe(0);
    expect(JSON.parse(results.restored.stdout)).toEqual({ ok: true, root: "/work/project" });
    expect(results.after).toEqual(BEFORE);
    const restores = results.journal.filter((entry) => entry.type === "checkpoint_restore");
    expect(restores).toEqual([
      expect.objectContaining({ actor: "alireza", outcome: "refused", reason: expect.stringContaining("nothing was changed") }),
      expect.objectContaining({ actor: "alireza", outcome: "restored" }),
    ]);
    expect(results.journal.findIndex((entry) => entry.type === "checkpoint")).toBeLessThan(results.journal.findIndex((entry) => entry.kind === "capability_call" || entry.type === "authorized"));
  });

  // proves D-221 with D-201: the service starts again on the journal the restore wrote to, and the session goes on
  it("starts the service again on the same journal", () => {
    expect(results.restarted, results.restartText).toBe(true);
    expect(results.restartText).toContain("go on from the journal");
    expect(results.restartStopped?.code).toBe(0);
  });
});
