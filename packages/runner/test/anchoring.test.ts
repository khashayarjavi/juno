import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_ANCHOR, TEST_OPERATOR_KEY } from "../../enforcement/test/test-keys.js";
import { AnchorExistsError, JournalKeyError, anchorPath, checkAnchors, loadOrCreateJournalKey, taskDigest, verifyTrajectory } from "../../journal/src/index.js";
import type { CliIo } from "../src/grant-cli.js";
import { executeOutbound } from "../../registry/src/index.js";
import { runJournalCli } from "../src/journal-cli.js";
import { RUNNER_RECORD, type Runner } from "../src/runner.js";
import { MemoryAnchorSink } from "./anchor-sink.js";
import { type Harness, harness, request, shellRun, turn } from "./helpers.js";

/**
 * §3.4.1 anchored head (v0.6 C1, v0.6.1 V6-4; D-122), in the runner: the interval is recorded, the head is anchored
 * when a task starts, at each interval while it runs, and when it stops; a task whose head cannot be anchored does not
 * start or go on; the journal key is never the operator's key.
 */

let h: Harness;
beforeEach(async () => {
  h = await harness();
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
    h.cleanup();
    h = await harness(undefined, { anchoring: { intervalMs: 1_000 } });
    const step = (calls: Parameters<typeof turn>[0]): (() => ReturnType<typeof turn>) => () => {
      h.now.value = new Date(h.now.value.getTime() + 1_500);
      return turn(calls);
    };
    const { runner } = h.runner([step([shellRun(["notes.txt"])]), step([shellRun(["notes.txt"])]), step([])]);
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
    h.cleanup();
    h = await harness(undefined, { anchoring: { intervalMs: 1_000 } });
    const { runner } = h.runner([
      () => {
        h.now.value = new Date(h.now.value.getTime() + 1_500);
        h.anchors.unreachable = "gone";
        return turn([shellRun(["notes.txt"])]);
      },
      turn([]),
    ]);
    admitted(runner);
    expect((await runner.run("task-1")).reason).toBe("anchor_unavailable");
    expect(h.entries().filter((entry) => entry.kind === "turn").length).toBe(1);
  });

  // proves §3.4.1 V6-4: the operator's key never serves as the journal key; the runner refuses to start with it (its
  // grant store's key), and the shared layer refuses to open with it (the verified trust anchor; D-198)
  it("refuses a journal key that is the operator's grant-signing key", async () => {
    h.cleanup();
    h = await harness(undefined, { anchoring: { journalKey: { privateKey: TEST_OPERATOR_KEY, publicKey: TEST_ANCHOR } } });
    expect(() => h.runner([])).toThrow(/operator's grant-signing key/);
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

  // proves §3.4.1 (D-122): when the destination already holds the anchor for this seq (stored before a restart), the
  // runner counts it as taken only if it names the same head
  it("counts an anchor already stored for the same head as taken, and fails on one for another head", async () => {
    // A destination that, for the first anchor, says it already holds one: the anchor itself (same head), or a forged one.
    const preStored = (forge: boolean): MemoryAnchorSink => {
      const sink = new MemoryAnchorSink();
      const append = sink.append.bind(sink);
      let first = true;
      sink.append = async (anchor) => {
        if (first) {
          first = false;
          await append(forge ? { ...anchor, head: `sha256:${"0".repeat(64)}` } : anchor);
          throw new AnchorExistsError("an anchor at this seq already exists");
        }
        return append(anchor);
      };
      return sink;
    };
    h.cleanup();
    h = await harness(undefined, { anchoring: { sink: preStored(false) } });
    const { runner } = h.runner([turn([])]);
    admitted(runner);
    expect((await runner.run("task-1")).state).toBe("complete_unverified");
    expect(notes("anchor_failed")).toEqual([]);

    h.cleanup();
    h = await harness(undefined, { anchoring: { sink: preStored(true) } });
    const second = h.runner([turn([])]);
    admitted(second.runner);
    expect(await second.runner.run("task-1")).toEqual({ task_id: "task-1", state: "failed", reason: "anchor_unavailable" });
    expect(notes("anchor_failed")[0]?.["reason"]).toMatch(/holds a different anchor/);
  });
});

describe("the journal key (§3.4.1 V6-4, D-122)", () => {
  let dir: string;
  beforeEach(async () => {
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

/** The anchors as a clone of `juno-anchors` holds them: a git repository with one commit adding every anchor file (D-217). */
async function commitAnchors(dir: string): Promise<void> {
  const git = async (args: readonly string[]): Promise<void> => {
    const result = await executeOutbound({ file: "/usr/bin/git", args: ["-c", "user.name=o", "-c", "user.email=o@o", "-c", "init.defaultBranch=main", "-C", dir, ...args] });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8"));
  };
  await git(["init", "--quiet"]);
  await git(["add", "-A"]);
  await git(["commit", "--quiet", "-m", "anchors"]);
}

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
    await commitAnchors(anchorsDir);
    const pem = h.anchoring.journalKey.publicKey.export({ type: "spki", format: "pem" }).toString();
    const args = ["check", "--journal", h.journal.root, "--anchors", anchorsDir, "--key", "/keys/journal.pub.pem", "task-1"];
    const good = io({ "/keys/journal.pub.pem": pem });
    expect(await runJournalCli(args, good)).toBe(0);
    expect(JSON.parse(good.output.join(""))).toMatchObject({ ok: true, unanchored: 0, history: "checked" });
    // A wrong anchors folder finds no anchor: the check fails, it never passes on no evidence (D-126).
    const empty = io({ "/keys/journal.pub.pem": pem });
    expect(await runJournalCli(["check", "--journal", h.journal.root, "--anchors", join(h.dir, "no-such-folder"), "--key", "/keys/journal.pub.pem", "--no-history", "task-1"], empty)).toBe(1);
    expect(JSON.parse(empty.output.join(""))).toMatchObject({ ok: false, failure: { code: "no_anchor" } });
    // And without --no-history it is refused before anything is read: it is no clone whose history can be checked (D-217).
    const noClone = io({ "/keys/journal.pub.pem": pem });
    expect(await runJournalCli(["check", "--journal", h.journal.root, "--anchors", join(h.dir, "no-such-folder"), "--key", "/keys/journal.pub.pem", "task-1"], noClone)).toBe(1);
    expect(JSON.parse(noClone.output.join(""))).toMatchObject({ ok: false, history: "refused", failure: { code: "anchor_history" } });

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
    expect(await runJournalCli(args, bad)).toBe(1);
    expect(JSON.parse(bad.output.join(""))).toMatchObject({ ok: false, failure: { code: "rewritten" } });
  });

  // proves §3.4.1 with operator ruling D-214 item 2: the check the operator runs from the admin account, on a copy of
  // the journal root made with `cp -RP` (guide, Part G step 7), gives exactly the answer it gives on the original, for an
  // anchored chain and for a rewritten one alike; the copy can neither pass what the original fails nor the reverse
  it("gives the same result on a copied journal as on the original, passing and failing alike", async () => {
    const { runner } = h.runner([turn([shellRun(["notes.txt"])]), turn([])]);
    admitted(runner);
    await runner.run("task-1");
    const anchorsDir = join(h.dir, "anchors-clone");
    for (const anchor of (await anchorsOf("task-1")) as { task: string; seq: number }[]) {
      mkdirSync(join(anchorsDir, anchor.task), { recursive: true });
      writeFileSync(join(anchorsDir, anchorPath(anchor.task, anchor.seq)), JSON.stringify(anchor));
    }
    await commitAnchors(anchorsDir);
    const keyFile = join(h.dir, "journal-key.pub.pem");
    writeFileSync(keyFile, h.anchoring.journalKey.publicKey.export({ type: "spki", format: "pem" }).toString());
    const realIo = (): CliIo & { output: string[]; errors: string[] } => {
      const output: string[] = [];
      const errors: string[] = [];
      return { readFile: (path) => readFileSync(path, "utf8"), out: (text) => output.push(text), err: (text) => errors.push(text), output, errors };
    };
    const copyCount = { value: 0 };
    // The guide's copy, by the real cp: `cp -RP <journal> <admin folder>/journal` (no link followed, every file copied).
    const copyOf = async (): Promise<string> => {
      copyCount.value += 1;
      const target = join(h.dir, `admin-copy-${String(copyCount.value)}`);
      mkdirSync(target, { mode: 0o700 });
      // The journal folder by its path, as the operator names it (the harness's `root` is this process's own handle).
      const copied = await executeOutbound({ file: "/bin/cp", args: ["-RP", join(h.dir, "journal"), join(target, "journal")] });
      expect(copied.exitCode, copied.stderr.toString("utf8")).toBe(0);
      return join(target, "journal");
    };
    const both = async (): Promise<{ readonly original: { code: number; output: string }; readonly copy: { code: number; output: string } }> => {
      const copy = await copyOf();
      const run = async (journal: string): Promise<{ code: number; output: string }> => {
        const io = realIo();
        const code = await runJournalCli(["check", "--journal", journal, "--anchors", anchorsDir, "--key", keyFile, "task-1"], io);
        return { code, output: io.output.join("") + io.errors.join("") };
      };
      return { original: await run(join(h.dir, "journal")), copy: await run(copy) };
    };
    const honest = await both();
    expect(honest.original.code).toBe(0);
    expect(JSON.parse(honest.original.output)).toMatchObject({ ok: true, unanchored: 0, history: "checked" });
    expect(honest.copy).toEqual(honest.original);

    // A rewritten chain fails on the original and, identically, on its copy.
    const entriesPath = join(h.journal.root, "tasks", taskDigest("task-1"), "entries.jsonl");
    const lines = readFileSync(entriesPath, "utf8").trimEnd().split("\n");
    const journalModule = await import("../../journal/src/index.js");
    const forgedRoot = join(h.dir, "forged");
    const writer = journalModule.JournalWriter.open(forgedRoot);
    for (const [index, line] of lines.entries()) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const { seq: _seq, task_id: _task, payload_ref: _ref, hash_prev: _prev, timestamp: _time, ...draft } = entry;
      void [_seq, _task, _ref, _prev, _time];
      writer.append("task-1", draft as never, new TextEncoder().encode(index === 2 ? "forged" : `entry ${String(index)}`));
    }
    for (const file of ["entries.jsonl", "head.json"]) writeFileSync(join(h.journal.root, "tasks", taskDigest("task-1"), file), readFileSync(join(forgedRoot, "tasks", taskDigest("task-1"), file)));
    const rewritten = await both();
    expect(rewritten.original.code).toBe(1);
    expect(JSON.parse(rewritten.original.output)).toMatchObject({ ok: false, failure: { code: "rewritten" } });
    expect(rewritten.copy).toEqual(rewritten.original);

    // A cut chain (its last entry removed) fails on both, identically.
    const cut = readFileSync(entriesPath, "utf8").trimEnd().split("\n");
    writeFileSync(entriesPath, `${cut.slice(0, -1).join("\n")}\n`);
    const shortened = await both();
    expect(shortened.original.code).toBe(1);
    expect(shortened.copy).toEqual(shortened.original);
  });

  // proves §3.4.1 ("anyone can check that history was not rewritten") with D-204 and D-217, review round 1 of PR #54: the
  // reviewer's reproduction. Whoever controls the runner account holds the push key, the journal and the journal key; it
  // forges a journal with a new key and replaces the anchor file by an ordinary commit (the repository's protection
  // refuses only deletion of the branch and force pushes). The files then agree with the forgery, and a check of the files
  // alone passes it (shown with --no-history). The operator's check reads the history and refuses it.
  it("refuses a forged journal whose anchors were replaced by an ordinary commit, with the key swapped", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const journalModule = await import("../../journal/src/index.js");
    const draft = { kind: "note", actor: "runner", provider: null, data_class: { sensitivity: "internal", integrity: "operator" }, cost: { tokens_in: 0, tokens_out: 0, tokens_cached: 0, currency: 0, duration_ms: 0 } } as never;
    const build = (dir: string, words: readonly string[]): { root: string; anchor: unknown; last: number; keyFile: string } => {
      const key = generateKeyPairSync("ed25519");
      const root = join(dir, "journal");
      const writer = journalModule.JournalWriter.open(root);
      for (const word of words) writer.append("task-1", draft, new TextEncoder().encode(word));
      const chain = journalModule.verifyTrajectory(root, "task-1");
      if (!chain.ok) throw new Error("the built chain does not verify");
      const last = chain.entries.length - 1;
      const entry = chain.entries[last];
      if (entry === undefined) throw new Error("empty chain");
      const anchor = journalModule.anchorOf("task-1", { seq: last, hash: journalModule.entryHash(entry) }, new Date(), key.privateKey);
      const keyFile = join(dir, "key.pub.pem");
      writeFileSync(keyFile, key.publicKey.export({ type: "spki", format: "pem" }).toString());
      return { root, anchor, last, keyFile };
    };
    const git = async (dir: string, args: readonly string[]): Promise<void> => {
      const result = await executeOutbound({ file: "/usr/bin/git", args: ["-c", "user.name=o", "-c", "user.email=o@o", "-c", "init.defaultBranch=main", "-C", dir, ...args] });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8"));
    };
    const check = async (journal: string, anchors: string, keyFile: string, extra: readonly string[] = []): Promise<{ code: number; result: Record<string, unknown> }> => {
      const said: string[] = [];
      const code = await runJournalCli(["check", "--journal", journal, "--anchors", anchors, "--key", keyFile, ...extra, "task-1"], { readFile: (path) => readFileSync(path, "utf8"), out: (text) => said.push(text), err: (text) => said.push(text) });
      return { code, result: JSON.parse(said.join("")) as Record<string, unknown> };
    };
    const honest = build(join(h.dir, "honest"), ["a", "b", "c"]);
    // The pinned repository, as the operator's fresh clone shows it: the honest anchor, committed.
    const remote = join(h.dir, "anchors-remote");
    mkdirSync(join(remote, taskDigest("task-1")), { recursive: true });
    writeFileSync(join(remote, anchorPath(taskDigest("task-1"), honest.last)), journalModule.encodeAnchor(honest.anchor as never));
    await commitAnchors(remote);
    expect(await check(honest.root, remote, honest.keyFile)).toMatchObject({ code: 0, result: { ok: true, history: "checked" } });

    // The forgery, pushed as an ordinary commit that removes the honest anchor and adds the forged one.
    const forged = build(join(h.dir, "forged"), ["a", "FORGED", "c"]);
    for (const name of readdirSync(join(remote, taskDigest("task-1")))) rmSync(join(remote, taskDigest("task-1"), name));
    writeFileSync(join(remote, anchorPath(taskDigest("task-1"), forged.last)), journalModule.encodeAnchor(forged.anchor as never));
    await git(remote, ["add", "-A"]);
    await git(remote, ["commit", "--quiet", "-m", "an ordinary commit"]);
    const clone = join(h.dir, "admin-clone");
    const cloned = await executeOutbound({ file: "/usr/bin/git", args: ["clone", "--quiet", remote, clone] });
    expect(cloned.exitCode).toBe(0);
    // The files alone agree with the forgery: this is what the history check closes.
    expect(await check(forged.root, clone, forged.keyFile, ["--no-history"])).toMatchObject({ code: 0, result: { ok: true, history: "not_checked" } });
    // The operator's check refuses it.
    const refused = await check(forged.root, clone, forged.keyFile);
    expect(refused.code).toBe(1);
    expect(refused.result).toMatchObject({ ok: false, history: "refused", failure: { code: "anchor_history" } });
    expect(String((refused.result["failure"] as Record<string, unknown>)["reason"])).toMatch(/removes or changes 1 anchor file/);
    // And the swapped key alone, against the honest history, fails: residual 37 holds once the history is checked.
    const honestClone = join(h.dir, "honest-clone");
    await git(remote, ["reset", "--quiet", "--hard", "HEAD~1"]);
    expect((await executeOutbound({ file: "/usr/bin/git", args: ["clone", "--quiet", remote, honestClone] })).exitCode).toBe(0);
    expect((await check(honest.root, honestClone, forged.keyFile)).code).toBe(1);
  });

  // proves D-217 (with D-205): a renamed anchor file, a changed one, a shallow clone and a clone whose files differ from
  // its commit are each refused by the operator's check
  it("refuses a renamed or changed anchor, a shallow clone, and a clone changed after cloning", async () => {
    const { runner } = h.runner([turn([shellRun(["notes.txt"])]), turn([])]);
    admitted(runner);
    await runner.run("task-1");
    const pem = h.anchoring.journalKey.publicKey.export({ type: "spki", format: "pem" }).toString();
    const keyFile = join(h.dir, "key.pub.pem");
    writeFileSync(keyFile, pem);
    const git = async (dir: string, args: readonly string[]): Promise<string> => {
      const result = await executeOutbound({ file: "/usr/bin/git", args: ["-c", "user.name=o", "-c", "user.email=o@o", "-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always", "-C", dir, ...args] });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8"));
      return result.stdout.toString("utf8");
    };
    const anchors = (await anchorsOf("task-1")) as { task: string; seq: number }[];
    const fresh = (name: string): string => {
      const dir = join(h.dir, name);
      for (const anchor of anchors) {
        mkdirSync(join(dir, anchor.task), { recursive: true });
        writeFileSync(join(dir, anchorPath(anchor.task, anchor.seq)), JSON.stringify(anchor));
      }
      return dir;
    };
    const verdict = async (dir: string): Promise<Record<string, unknown>> => {
      const said: string[] = [];
      const code = await runJournalCli(["check", "--journal", join(h.dir, "journal"), "--anchors", dir, "--key", keyFile, "task-1"], { readFile: (path) => readFileSync(path, "utf8"), out: (text) => said.push(text), err: (text) => said.push(text) });
      return { code, ...(JSON.parse(said.join("")) as Record<string, unknown>) };
    };
    const first = anchors[0];
    if (first === undefined) throw new Error("no anchor");
    const firstPath = anchorPath(first.task, first.seq);

    const honest = fresh("honest");
    await commitAnchors(honest);
    expect(await verdict(honest)).toMatchObject({ code: 0, ok: true, history: "checked" });

    // A rename (moved aside, then put back as it was): the files agree, the history does not.
    const renamed = fresh("renamed");
    await commitAnchors(renamed);
    await git(renamed, ["mv", firstPath, `${firstPath}.old`]);
    await git(renamed, ["commit", "--quiet", "-m", "move"]);
    await git(renamed, ["mv", `${firstPath}.old`, firstPath]);
    await git(renamed, ["commit", "--quiet", "-m", "move back"]);
    expect(await verdict(renamed)).toMatchObject({ code: 1, ok: false, history: "refused", failure: { code: "anchor_history" } });

    // A change, then a change back.
    const changed = fresh("changed");
    await commitAnchors(changed);
    const original = readFileSync(join(changed, firstPath), "utf8");
    writeFileSync(join(changed, firstPath), "{}");
    await git(changed, ["commit", "--quiet", "-am", "change"]);
    writeFileSync(join(changed, firstPath), original);
    await git(changed, ["commit", "--quiet", "-am", "change back"]);
    expect(await verdict(changed)).toMatchObject({ code: 1, history: "refused", failure: { code: "anchor_history" } });

    // A shallow clone hides history: of an honest repository with two commits, so shallowness is the only fault.
    const deep = fresh("deep");
    await commitAnchors(deep);
    writeFileSync(join(deep, "README.md"), "anchors\n");
    await git(deep, ["add", "README.md"]);
    await git(deep, ["commit", "--quiet", "-m", "readme"]);
    const full = join(h.dir, "full");
    await git(h.dir, ["clone", "--quiet", "--no-local", deep, full]);
    expect(await verdict(full)).toMatchObject({ code: 0, ok: true, history: "checked" });
    const shallow = join(h.dir, "shallow");
    await git(h.dir, ["clone", "--quiet", "--no-local", "--depth", "1", deep, shallow]);
    expect((await git(shallow, ["rev-parse", "--is-shallow-repository"])).trim()).toBe("true");
    const shallowVerdict = await verdict(shallow);
    expect(shallowVerdict).toMatchObject({ code: 1, history: "refused", failure: { code: "anchor_history" } });
    expect(String((shallowVerdict["failure"] as Record<string, unknown>)["reason"])).toMatch(/shallow/);

    // Files changed after cloning are not what was committed.
    const edited = fresh("edited");
    await commitAnchors(edited);
    writeFileSync(join(edited, firstPath), "{}");
    const editedVerdict = await verdict(edited);
    expect(editedVerdict).toMatchObject({ code: 1, history: "refused", failure: { code: "anchor_history" } });
    expect(String((editedVerdict["failure"] as Record<string, unknown>)["reason"])).toMatch(/differ from its commit/);
  });

  // proves the CLI's contract: bad usage exits 2
  it("refuses bad usage", async () => {
    const bad = io({});
    expect(await runJournalCli(["check", "--journal", "/j"], bad)).toBe(2);
    expect(await runJournalCli(["verify"], bad)).toBe(2);
  });
});
