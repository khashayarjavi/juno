import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_ANCHOR, TEST_OPERATOR_KEY } from "../../enforcement/test/test-keys.js";
import { JournalKeyError, anchorPath, checkAnchors, loadOrCreateJournalKey, taskDigest, verifyTrajectory } from "../../journal/src/index.js";
import type { CliIo } from "../src/grant-cli.js";
import { runJournalCli } from "../src/journal-cli.js";
import { RUNNER_RECORD, type Runner } from "../src/runner.js";
import { MemoryAnchorSink, testAnchoring } from "./anchor-sink.js";
import { type Harness, harness, request, shellRun, turn } from "./helpers.js";

/**
 * §3.4.1 anchored head (v0.6 C1, v0.6.1 V6-4; D-122), in the runner: the interval is recorded, the head is anchored
 * when a task starts, at each interval while it runs, and when it stops; a task whose head cannot be anchored does not
 * start or go on; the journal key is never the operator's key.
 */

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  h.cleanup();
});

const admitted = (runner: Runner, overrides: Record<string, unknown> = {}): void => {
  const result = runner.admit(request(overrides));
  if (!result.admitted) throw new Error(`not admitted: ${JSON.stringify(result.failures)}`);
};
const notes = (type: string, task = "task-1"): Record<string, unknown>[] => h.entries(task).filter((entry) => entry.kind === "note").map(h.payload).filter((body) => body["type"] === type);
const anchorsOf = async (task: string): Promise<unknown[]> => h.anchors.list(taskDigest(task));

describe("§3.4.1 C1: the runner anchors journal heads", () => {
  // proves §3.4.1: the interval is recorded in the journal, and the task's head is anchored at start and at stop
  it("records the interval and anchors at start and at stop; the chain agrees with every anchor", async () => {
    const { runner } = h.runner([turn([shellRun(["notes.txt"])]), turn([])]);
    admitted(runner);
    expect((await runner.run("task-1")).state).toBe("complete_unverified");
    expect(notes("anchoring")).toEqual([{ type: "anchoring", interval_ms: h.anchoring.intervalMs, journal_key: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) }]);
    const anchors = (await anchorsOf("task-1")) as { seq: number }[];
    expect(anchors.length).toBe(2);
    const last = h.entries().at(-1)?.seq;
    expect(anchors.map((anchor) => anchor.seq).at(-1)).toBe(last);
    expect(checkAnchors("task-1", verifyTrajectory(h.journal.root, "task-1"), anchors, h.anchoring.journalKey.publicKey)).toMatchObject({ ok: true, anchored_seq: last, unanchored: 0 });
    // The runner record (grant charges) is anchored too.
    expect((await anchorsOf(RUNNER_RECORD)).length).toBeGreaterThan(0);
  });

  // proves §3.4.1: while a task runs, an anchor is taken whenever the recorded interval has passed
  it("anchors at each interval while the task runs", async () => {
    const anchoring = { ...h.anchoring, intervalMs: 1_000 };
    const step = (calls: Parameters<typeof turn>[0]): (() => ReturnType<typeof turn>) => () => {
      h.now.value = new Date(h.now.value.getTime() + 1_500);
      return turn(calls);
    };
    const { runner } = h.runner([step([shellRun(["notes.txt"])]), step([shellRun(["notes.txt"])]), step([])], { anchoring });
    admitted(runner);
    await runner.run("task-1");
    // At start, before turns 2 and 3 (each 1.5 s after the last anchor), and at stop.
    expect((await anchorsOf("task-1")).length).toBe(4);
  });

  // proves §3.4.1: a task whose head cannot be copied off the host does not start; the failure is journalled
  it("does not start a task whose head cannot be anchored", async () => {
    h.anchors.unreachable = "destination unreachable";
    const { runner } = h.runner([turn([])]);
    admitted(runner);
    expect(await runner.run("task-1")).toEqual({ task_id: "task-1", state: "failed", reason: "anchor_unavailable" });
    expect(h.entries().some((entry) => entry.kind === "turn")).toBe(false);
    expect(notes("anchor_failed")[0]).toMatchObject({ reason: "destination unreachable" });
  });

  // proves §3.4.1: a running task stops when an interval's anchor cannot be taken
  it("fails a running task when an interval's anchor cannot be taken", async () => {
    const anchoring = { ...h.anchoring, intervalMs: 1_000 };
    const { runner } = h.runner(
      [
        () => {
          h.now.value = new Date(h.now.value.getTime() + 1_500);
          h.anchors.unreachable = "gone";
          return turn([shellRun(["notes.txt"])]);
        },
        turn([]),
      ],
      { anchoring },
    );
    admitted(runner);
    expect((await runner.run("task-1")).reason).toBe("anchor_unavailable");
    expect(h.entries().filter((entry) => entry.kind === "turn").length).toBe(1);
  });

  // proves §3.4.1 V6-4: the operator's key never serves as the journal key; the runner refuses to start with it
  it("refuses a journal key that is the operator's grant-signing key", () => {
    const anchoring = testAnchoring({ journalKey: { privateKey: TEST_OPERATOR_KEY, publicKey: TEST_ANCHOR } });
    expect(() => h.runner([], { anchoring })).toThrow(/operator's grant-signing key/);
  });

  // proves §3.4.1 V6-4: no runner module signs a grant or reads a private key; only the operator's CLI does
  it("gives no runner code path the operator key", () => {
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    for (const file of readdirSync(dir)) {
      if (file === "grant-cli.ts") continue;
      const source = readFileSync(join(dir, file), "utf8");
      expect(source, file).not.toMatch(/signGrant|createPrivateKey|PRIVATE KEY/);
    }
  });

  // proves §3.4.1: an anchor already at the destination for the same seq and head counts as taken (a restart)
  it("accepts an anchor already stored for the same head, and refuses to replace one for another head", async () => {
    const sink = new MemoryAnchorSink();
    const { runner } = h.runner([turn([])], { anchoring: { ...h.anchoring, sink } });
    admitted(runner);
    await runner.run("task-1");
    const stored = [...sink.stored.values()];
    expect(stored.length).toBeGreaterThan(0);
    const first = stored[0];
    if (first === undefined) throw new Error("no anchor");
    await expect(sink.append({ ...first, head: `sha256:${"0".repeat(64)}` })).rejects.toThrow(/already exists/);
    expect(sink.stored.get(anchorPath(first.task, first.seq))).toEqual(first);
  });
});

describe("the journal key (§3.4.1 V6-4, D-122)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "juno-journal-key-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // proves §3.4.1 V6-4: the runner's journal key is created once, private to the runner, and the same on every start
  it("is created on first start, mode 0600, and reloaded unchanged", () => {
    const keyDir = join(dir, "keys");
    const first = loadOrCreateJournalKey(keyDir, { journalRoot: join(dir, "journal") });
    expect(statSync(join(keyDir, "journal-key.pem")).mode & 0o777).toBe(0o600);
    expect(statSync(keyDir).mode & 0o777).toBe(0o700);
    const again = loadOrCreateJournalKey(keyDir, { journalRoot: join(dir, "journal") });
    expect(again.publicKey.export({ type: "spki", format: "pem" })).toEqual(first.publicKey.export({ type: "spki", format: "pem" }));
    expect(readFileSync(join(keyDir, "journal-key.pub.pem"), "utf8")).toContain("PUBLIC KEY");
  });

  // proves §3.2 / §3.4.1: the journal key lives outside the capability namespace and outside the journal
  it("refuses a key directory in the capability namespace or inside the journal", () => {
    expect(() => loadOrCreateJournalKey("/work/keys", { journalRoot: join(dir, "journal") })).toThrow(JournalKeyError);
    expect(() => loadOrCreateJournalKey(join(dir, "journal", "keys"), { journalRoot: join(dir, "journal") })).toThrow(JournalKeyError);
  });
});

describe("juno journal check (§3.4.1, D-122)", () => {
  const io = (files: Record<string, string>): CliIo & { output: string[]; errors: string[] } => {
    const output: string[] = [];
    const errors: string[] = [];
    return { readFile: (path) => files[path] ?? "", out: (text) => output.push(text), err: (text) => errors.push(text), output, errors };
  };

  // proves §3.4.1: the operator's check passes on an anchored chain and reports a rewrite against the copied anchors
  it("passes an anchored chain and fails a rewritten one", async () => {
    const { runner } = h.runner([turn([shellRun(["notes.txt"])]), turn([])]);
    admitted(runner);
    await runner.run("task-1");
    // The anchors as the operator's clone of `juno-anchors` holds them.
    const anchorsDir = join(h.dir, "anchors-clone");
    for (const anchor of (await anchorsOf("task-1")) as { task: string; seq: number }[]) {
      mkdirSync(join(anchorsDir, anchor.task), { recursive: true });
      writeFileSync(join(anchorsDir, anchorPath(anchor.task, anchor.seq)), JSON.stringify(anchor));
    }
    const pem = h.anchoring.journalKey.publicKey.export({ type: "spki", format: "pem" }).toString();
    const args = ["check", "--journal", h.journal.root, "--anchors", anchorsDir, "--key", "/keys/journal.pub.pem", "task-1"];
    const good = io({ "/keys/journal.pub.pem": pem });
    expect(runJournalCli(args, good)).toBe(0);
    expect(JSON.parse(good.output.join(""))).toMatchObject({ ok: true, unanchored: 0 });

    // A wholesale rewrite: the same task's chain rebuilt with one payload changed and every hash recomputed.
    const entriesPath = join(h.journal.root, "tasks", taskDigest("task-1"), "entries.jsonl");
    const lines = readFileSync(entriesPath, "utf8").trimEnd().split("\n");
    const forged = await import("../../journal/src/index.js");
    const forgedRoot = join(h.dir, "forged");
    const writer = forged.JournalWriter.open(forgedRoot);
    for (const [index, line] of lines.entries()) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const { seq: _seq, task_id: _task, payload_ref: _ref, hash_prev: _prev, timestamp: _time, ...draft } = entry;
      void [_seq, _task, _ref, _prev, _time];
      writer.append("task-1", draft as never, new TextEncoder().encode(index === 2 ? "forged" : `entry ${String(index)}`));
    }
    for (const file of ["entries.jsonl", "head.json"]) writeFileSync(join(h.journal.root, "tasks", taskDigest("task-1"), file), readFileSync(join(forgedRoot, "tasks", taskDigest("task-1"), file)));
    expect(verifyTrajectory(h.journal.root, "task-1").ok).toBe(true);
    const bad = io({ "/keys/journal.pub.pem": pem });
    expect(runJournalCli(args, bad)).toBe(1);
    expect(JSON.parse(bad.output.join(""))).toMatchObject({ ok: false, failure: { code: "rewritten" } });
  });

  // proves the CLI's contract: bad usage exits 2
  it("refuses bad usage", () => {
    const bad = io({});
    expect(runJournalCli(["check", "--journal", "/j"], bad)).toBe(2);
    expect(runJournalCli(["verify"], bad)).toBe(2);
  });
});
