import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BoundaryError,
  Capability,
  ResourceSelector,
  type TrajectoryEntry,
  WORK_NAMESPACE,
  pathWithin,
} from "../../contracts/src/index.js";
import * as journalModule from "../src/index.js";
import {
  type EntryDraft,
  JournalIntegrityError,
  JournalLocationError,
  JournalWriter,
  canonicalJson,
  contentAddress,
  encodeEntry,
  entryHash,
  journalRoot,
  readPayload,
  readTrajectory,
  verifyChain,
  verifyTrajectory,
} from "../src/index.js";
import { blobFile, entriesFile, headFile } from "../src/layout.js";

const TASK = "task-1";
const OTHER_TASK = "task-2";

function note(actor = "runner"): EntryDraft {
  return {
    kind: "note",
    actor,
    provider: null,
    data_class: { sensitivity: "internal", integrity: "operator" },
    cost: { tokens_in: 0, tokens_out: 0, tokens_cached: 0, currency: 0, duration_ms: 0 },
  };
}

function capabilityCall(): EntryDraft {
  return {
    ...note("model"),
    kind: "capability_call",
    provider: "fake-provider",
    data_class: { sensitivity: "internal", integrity: "derived" },
    argument_provenance: [
      { argument: "program", class: "constant", integrity: "operator" },
      { argument: "argv[0]", class: "bound", integrity: "untrusted" },
    ],
    cost: { tokens_in: 120, tokens_out: 30, tokens_cached: 64, currency: 0.0042, duration_ms: 812 },
  };
}

const payload = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A clock that ticks one second per call, so timestamps are deterministic. */
function steppingClock(): () => Date {
  let tick = Date.parse("2026-10-28T09:00:00Z");
  return () => new Date((tick += 1000));
}

let root: string;

beforeEach(() => {
  // The OS temp directory is outside the capability namespace, as a journal root must be.
  root = mkdtempSync(join(tmpdir(), "juno-journal-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeChain(length: number, taskId = TASK): { writer: JournalWriter; entries: TrajectoryEntry[] } {
  const writer = JournalWriter.open(root, { clock: steppingClock() });
  const entries: TrajectoryEntry[] = [];
  for (let index = 0; index < length; index += 1) {
    entries.push(writer.append(taskId, index % 2 === 0 ? note() : capabilityCall(), payload(`payload ${String(index)} of ${taskId}`)));
  }
  return { writer, entries };
}

const stored = (taskId = TASK): { entriesText: string; headText: string } => ({
  entriesText: readFileSync(entriesFile(journalRoot(root), taskId), "utf8"),
  headText: readFileSync(headFile(journalRoot(root), taskId), "utf8"),
});

/** Stored chains of several lengths, captured once, for the pure property tests. */
function capturedChains(): { length: number; entriesText: string; headText: string }[] {
  const chains = [1, 2, 3, 5].map((length) => {
    rmSync(root, { recursive: true, force: true });
    writeChain(length);
    return { length, ...stored() };
  });
  return chains;
}

describe("appending (§3.4.2)", () => {
  // proves §3.4.2: entries are hash-chained — seq is monotonic from 0, the first hash_prev is null, each links to the one before
  it("chains each entry to the hash of the one before it", () => {
    const { entries } = writeChain(4);
    expect(entries.map((entry) => entry.seq)).toEqual([0, 1, 2, 3]);
    expect(entries[0]?.hash_prev).toBeNull();
    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1];
      expect(previous).toBeDefined();
      if (previous !== undefined) {
        expect(entries[index]?.hash_prev).toBe(entryHash(previous));
      }
    }
    expect(verifyTrajectory(root, TASK)).toMatchObject({ ok: true, head: { seq: 3 } });
  });

  // proves §3.4.2: the trajectory is readable while the task runs, after every append
  it("returns every entry written so far after each append", () => {
    const writer = JournalWriter.open(root, { clock: steppingClock() });
    for (let index = 0; index < 5; index += 1) {
      const written = writer.append(TASK, note(), payload(String(index)));
      const read = readTrajectory(root, TASK);
      expect(read).toHaveLength(index + 1);
      expect(read.at(-1)).toEqual(written);
    }
  });

  // proves §3.4.2 / D-022: the journal records only entries the contract accepts, and a refusal writes nothing
  it.each<[string, EntryDraft]>([
    ["a capability_call without argument_provenance", { ...note(), kind: "capability_call" }],
    ["a note carrying argument_provenance", { ...capabilityCall(), kind: "note" }],
    ["an unknown key", { ...note(), extra: true } as EntryDraft],
    ["an unknown kind", { ...note(), kind: "rewrite" } as unknown as EntryDraft],
  ])("refuses %s and leaves the journal unchanged", (_name, draft) => {
    const { writer } = writeChain(2);
    const before = stored();
    expect(() => writer.append(TASK, draft, payload("refused"))).toThrow(BoundaryError);
    expect(stored()).toEqual(before);
    expect(readPayload(root, contentAddress(payload("refused")))).toEqual({ status: "missing" });
  });

  // proves §3.4.1: the writer, not the caller, fixes seq, task_id, payload_ref, hash_prev and timestamp
  it("ignores chain fields smuggled into a draft", () => {
    const writer = JournalWriter.open(root, { clock: steppingClock() });
    const smuggled = { ...note(), seq: 41, task_id: OTHER_TASK, hash_prev: contentAddress("forged"), payload_ref: contentAddress("other"), timestamp: "2000-01-01T00:00:00Z" };
    const entry = writer.append(TASK, smuggled as EntryDraft, payload("real"));
    expect(entry).toMatchObject({ seq: 0, task_id: TASK, hash_prev: null, payload_ref: contentAddress(payload("real")), timestamp: "2026-10-28T09:00:01.000Z" });
    expect(readTrajectory(root, TASK)).toEqual([entry]);
  });

  // proves §0.2 D8 / §3.4.2: nothing is appended onto a chain that no longer verifies
  it("refuses to append to a tampered chain", () => {
    const { writer } = writeChain(3);
    const { entriesText } = stored();
    writeFileSync(entriesFile(journalRoot(root), TASK), entriesText.replace('"actor":"runner"', '"actor":"intruder"'));
    const tampered = stored();
    expect(() => writer.append(TASK, note(), payload("after tamper"))).toThrow(JournalIntegrityError);
    expect(stored()).toEqual(tampered);
    expect(() => JournalWriter.open(root).append(TASK, note(), payload("fresh writer"))).toThrow(JournalIntegrityError);
  });

  // proves §3.4.2 seq "monotonic within task": each task has its own chain, and one task's entries cannot pass as another's
  it("keeps one chain per task and rejects an entry moved between them", () => {
    const writer = JournalWriter.open(root, { clock: steppingClock() });
    for (let index = 0; index < 3; index += 1) {
      writer.append(TASK, note(), payload(`a${String(index)}`));
      writer.append(OTHER_TASK, note(), payload(`b${String(index)}`));
    }
    expect(readTrajectory(root, TASK).map((entry) => [entry.task_id, entry.seq])).toEqual([[TASK, 0], [TASK, 1], [TASK, 2]]);
    expect(readTrajectory(root, OTHER_TASK).map((entry) => [entry.task_id, entry.seq])).toEqual([[OTHER_TASK, 0], [OTHER_TASK, 1], [OTHER_TASK, 2]]);

    const mine = stored(TASK);
    const theirs = stored(OTHER_TASK);
    const theirLast = theirs.entriesText.split("\n")[2] ?? "";
    const spliced = `${mine.entriesText}${theirLast}\n`;
    expect(verifyChain(TASK, spliced, mine.headText)).toMatchObject({ ok: false, failure: { code: "wrong_task", line: 4 } });
  });
});

describe("chain verification (§3.4.2)", () => {
  // proves build plan Inc 2 "a tampered entry fails chain verification": changing any single byte of the stored entries is detected
  it("fails when any byte of any entry is changed", () => {
    for (const chain of capturedChains()) {
      expect(verifyChain(TASK, chain.entriesText, chain.headText).ok).toBe(true);
      const bytes = Buffer.from(chain.entriesText, "utf8");
      fc.assert(
        fc.property(fc.nat({ max: bytes.length - 1 }), fc.integer({ min: 1, max: 255 }), (position, delta) => {
          const mutated = Buffer.from(bytes);
          mutated[position] = ((mutated[position] ?? 0) + delta) % 256;
          expect(verifyChain(TASK, mutated.toString("latin1"), chain.headText).ok).toBe(false);
        }),
        { numRuns: 300 },
      );
    }
  });

  // proves §3.4.2: a well-formed, canonical rewrite of any field of any entry is still detected
  it.each<[string, (entry: Record<string, unknown>) => void]>([
    ["actor", (entry) => (entry["actor"] = "someone-else")],
    [
      "kind",
      (entry) => {
        // stays schema-valid: a note becomes a gate; a capability_call becomes a note and loses its provenance
        if (entry["kind"] === "note") {
          entry["kind"] = "gate";
        } else {
          entry["kind"] = "note";
          delete entry["argument_provenance"];
        }
      },
    ],
    ["data_class.integrity", (entry) => (entry["data_class"] = { sensitivity: "internal", integrity: "attested" })],
    ["data_class.sensitivity", (entry) => (entry["data_class"] = { sensitivity: "public", integrity: "operator" })],
    ["payload_ref", (entry) => (entry["payload_ref"] = contentAddress("a different payload"))],
    ["cost", (entry) => (entry["cost"] = { tokens_in: 1, tokens_out: 0, tokens_cached: 0, currency: 0, duration_ms: 0 })],
    ["timestamp", (entry) => (entry["timestamp"] = "2026-10-27T09:00:00.000Z")],
    ["provider", (entry) => (entry["provider"] = "another-provider")],
  ])("fails when %s is rewritten in canonical form", (_field, rewrite) => {
    writeChain(3);
    const { entriesText, headText } = stored();
    for (const target of [0, 1, 2]) {
      const lines = entriesText.slice(0, -1).split("\n");
      const entry = JSON.parse(lines[target] ?? "") as Record<string, unknown>;
      rewrite(entry);
      lines[target] = canonicalJson(entry);
      const verdict = verifyChain(TASK, `${lines.join("\n")}\n`, headText);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.failure.code).toBe(target === 2 ? "head_mismatch" : "broken_link");
      }
    }
  });

  // proves build plan Inc 2 "a truncated chain fails verification": cutting the stored entries at any byte is detected
  it("fails when the entries are cut at any point", () => {
    for (const chain of capturedChains()) {
      for (let cut = 0; cut < chain.entriesText.length; cut += 1) {
        expect(verifyChain(TASK, chain.entriesText.slice(0, cut), chain.headText).ok).toBe(false);
      }
    }
  });

  // proves §3.4.2: removing whole entries from the end, the start or the middle is detected, each with its reason
  it("names the failure when whole entries are removed", () => {
    writeChain(4);
    const { entriesText, headText } = stored();
    const lines = entriesText.slice(0, -1).split("\n");
    const text = (kept: string[]): string => (kept.length === 0 ? "" : `${kept.join("\n")}\n`);
    expect(verifyChain(TASK, text(lines.slice(0, 3)), headText)).toMatchObject({ ok: false, failure: { code: "head_mismatch" } });
    expect(verifyChain(TASK, text(lines.slice(1)), headText)).toMatchObject({ ok: false, failure: { code: "sequence_break", line: 1 } });
    expect(verifyChain(TASK, text([lines[0] ?? "", lines[2] ?? "", lines[3] ?? ""]), headText)).toMatchObject({
      ok: false,
      failure: { code: "sequence_break", line: 2 },
    });
    expect(verifyChain(TASK, "", headText)).toMatchObject({ ok: false, failure: { code: "unexpected_head" } });
    expect(verifyChain(TASK, entriesText, null)).toMatchObject({ ok: false, failure: { code: "head_missing" } });
  });

  // proves §3.4.2: on disk, a truncated journal is refused by the read interface rather than returned short
  it("refuses to read a journal whose tail was removed or whose head was deleted", () => {
    writeChain(3);
    const { entriesText } = stored();
    const file = entriesFile(journalRoot(root), TASK);
    writeFileSync(file, `${entriesText.split("\n").slice(0, 2).join("\n")}\n`);
    expect(() => readTrajectory(root, TASK)).toThrow(JournalIntegrityError);
    writeFileSync(file, entriesText);
    expect(readTrajectory(root, TASK)).toHaveLength(3);
    unlinkSync(headFile(journalRoot(root), TASK));
    expect(() => readTrajectory(root, TASK)).toThrow(JournalIntegrityError);
  });

  // proves build plan Inc 2 "detect reordering": every reordering of the entries is detected
  it("fails under any reordering of the entries", () => {
    const chain = capturedChains().find((candidate) => candidate.length === 5);
    expect(chain).toBeDefined();
    if (chain === undefined) return;
    const lines = chain.entriesText.slice(0, -1).split("\n");
    fc.assert(
      fc.property(fc.shuffledSubarray(lines.map((_, index) => index), { minLength: lines.length, maxLength: lines.length }), (order) => {
        fc.pre(order.some((value, index) => value !== index));
        const reordered = `${order.map((index) => lines[index]).join("\n")}\n`;
        expect(verifyChain(TASK, reordered, chain.headText).ok).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  // proves §3.4.2: the head record is part of what is verified — any change to it is detected
  it("fails when the head record is changed", () => {
    writeChain(3);
    const { entriesText, headText } = stored();
    const head = JSON.parse(headText) as Record<string, unknown>;
    for (const forged of [
      { ...head, seq: 1 },
      { ...head, seq: 3 },
      { ...head, hash: contentAddress("forged") },
      { ...head, task_id: OTHER_TASK },
    ]) {
      expect(verifyChain(TASK, entriesText, `${canonicalJson(forged)}\n`)).toMatchObject({ ok: false, failure: { code: "head_mismatch" } });
    }
    expect(verifyChain(TASK, entriesText, headText.trimEnd())).toMatchObject({ ok: false, failure: { code: "head_malformed" } });
    expect(verifyChain(TASK, entriesText, "{}\n")).toMatchObject({ ok: false, failure: { code: "head_malformed" } });
  });

  // proves §3.4.2: a chain cannot be lengthened with an entry the journal did not write
  it("fails when an entry is appended without the head moving", () => {
    const { entries } = writeChain(2);
    const { entriesText, headText } = stored();
    const last = entries.at(-1);
    expect(last).toBeDefined();
    if (last === undefined) return;
    const forged: TrajectoryEntry = { ...last, seq: 2, hash_prev: entryHash(last), actor: "intruder" };
    expect(verifyChain(TASK, `${entriesText}${encodeEntry(forged)}`, headText)).toMatchObject({ ok: false, failure: { code: "head_mismatch" } });
  });

  // proves §3.4.2: a line that parses but was not written in canonical form is detected, even if it says the same thing
  it("fails on a non-canonical but equivalent line", () => {
    writeChain(1);
    const { entriesText, headText } = stored();
    const spaced = `${JSON.stringify(JSON.parse(entriesText) as unknown, null, 1).replace(/\n/g, "")}\n`;
    expect(spaced).not.toBe(entriesText);
    expect(verifyChain(TASK, spaced, headText)).toMatchObject({ ok: false, failure: { code: "non_canonical_entry" } });
  });

  // proves §3.4.2: a task that has never been written to has an empty, valid trajectory
  it("treats a task with no journal files as an empty trajectory", () => {
    JournalWriter.open(root);
    expect(verifyTrajectory(root, TASK)).toEqual({ ok: true, entries: [], head: null });
    expect(readTrajectory(root, TASK)).toEqual([]);
  });
});

describe("payloads (D-025: the chain covers each payload's digest, never its bytes)", () => {
  // proves §3.4.2 payload_ref "content-addressed": the entry names its payload by digest, and the bytes are stored under it
  it("stores the payload under its content address", () => {
    const { entries } = writeChain(2);
    const first = entries[0];
    expect(first?.payload_ref).toBe(contentAddress(payload(`payload 0 of ${TASK}`)));
    if (first === undefined) return;
    const read = readPayload(root, first.payload_ref);
    expect(read.status).toBe("present");
    if (read.status === "present") {
      expect(new TextDecoder().decode(read.bytes)).toBe(`payload 0 of ${TASK}`);
    }
  });

  // proves D-025: deleting a blob leaves the chain verifiable, and the reader is told the payload is missing
  it("still verifies after a payload blob is deleted", () => {
    const { entries } = writeChain(3);
    const target = entries[1];
    expect(target).toBeDefined();
    if (target === undefined) return;
    unlinkSync(blobFile(journalRoot(root), target.payload_ref));
    expect(verifyTrajectory(root, TASK).ok).toBe(true);
    expect(readTrajectory(root, TASK)).toEqual(entries);
    expect(readPayload(root, target.payload_ref)).toEqual({ status: "missing" });
    expect(readPayload(root, entries[0]?.payload_ref).status).toBe("present");
  });

  // proves D-025 and §3.4.2: a blob whose bytes were changed is never returned, and the chain is unaffected
  it("reports a changed blob as corrupt and never returns its bytes", () => {
    const { entries } = writeChain(2);
    const target = entries[0];
    if (target === undefined) throw new Error("no entry");
    writeFileSync(blobFile(journalRoot(root), target.payload_ref), "rewritten payload");
    expect(readPayload(root, target.payload_ref)).toEqual({ status: "corrupt" });
    expect(verifyTrajectory(root, TASK).ok).toBe(true);
  });

  // proves D-025: the chain commits to the payload through its digest — a different payload gives a different entry hash
  it("gives different payloads different entry hashes", () => {
    const writerA = JournalWriter.open(join(root, "a"), { clock: steppingClock() });
    const writerB = JournalWriter.open(join(root, "b"), { clock: steppingClock() });
    const a = writerA.append(TASK, note(), payload("one"));
    const b = writerB.append(TASK, note(), payload("two"));
    expect({ ...a, payload_ref: b.payload_ref }).toEqual(b);
    expect(entryHash(a)).not.toBe(entryHash(b));
  });
});

describe("journal location (§3.2, §3.4.1: no selector may name journal storage)", () => {
  // proves §3.4.1: the journal cannot be opened, read or written anywhere a selector could name
  it.each(["/work", "/work/journal", "/work/repo/.juno", "/", "journal", "/journal/../work", ""])("refuses the journal root %j", (bad) => {
    expect(() => JournalWriter.open(bad)).toThrow(bad.startsWith("/") && !bad.includes("..") ? JournalLocationError : BoundaryError);
    expect(() => readTrajectory(bad, TASK)).toThrow();
    expect(() => verifyTrajectory(bad, TASK)).toThrow();
    expect(() => readPayload(bad, contentAddress("x"))).toThrow();
  });

  // proves §3.2 "structurally impossible": for every journal root the journal accepts and every path selector the
  // Grant schema accepts, neither contains the other — so no selector reaches journal storage, by construction
  it("accepts no journal root that any path selector can reach", () => {
    const segment = fc.constantFrom("work", "journal", "repo", "tasks", "blobs", "work-x", "w");
    const path = fc.array(segment, { minLength: 0, maxLength: 4 }).map((segments) => `/${segments.join("/")}`);
    let pairs = 0;
    fc.assert(
      fc.property(path, path, (rootCandidate, prefixCandidate) => {
        let accepted: string;
        try {
          accepted = journalRoot(rootCandidate);
        } catch {
          return;
        }
        const selector = ResourceSelector.safeParse({ kind: "path", prefix: prefixCandidate });
        if (!selector.success || selector.data.kind !== "path") return;
        pairs += 1;
        expect(pathWithin(accepted, selector.data.prefix)).toBe(false);
        expect(pathWithin(selector.data.prefix, accepted)).toBe(false);
      }),
      { numRuns: 5000 },
    );
    // guards against a vacuous pass: many accepted (root, selector) pairs were actually compared
    expect(pairs).toBeGreaterThan(100);
    expect(journalRoot("/journal")).toBe("/journal");
    expect(pathWithin(WORK_NAMESPACE, "/journal")).toBe(false);
  });

  // proves §3.4.1: the read interface is plain functions — nothing the journal exports is a Capability
  it("exports nothing that is a Capability", () => {
    const exports = Object.entries(journalModule);
    expect(exports.length).toBeGreaterThan(5);
    for (const [name, value] of exports) {
      expect({ name, isCapability: Capability.safeParse(value).success }).toEqual({ name, isCapability: false });
    }
    expect([readTrajectory, verifyTrajectory, readPayload].every((reader) => typeof reader === "function")).toBe(true);
  });
});
