import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TrajectoryEntry } from "../../contracts/src/index.js";
import { checkAnchors, encodeHead, entryHash, readPayload, readTrajectory, taskDigest, tornTail, verifyTrajectory } from "../../journal/src/index.js";
import { entriesFile, headFile } from "../../journal/src/layout.js";
import { GrantStore, type SessionLayer, type SessionLimits } from "../src/index.js";
import { MemoryAnchorSink, testAnchoring, testJournalKey } from "./anchoring.js";
import { openTestLayer } from "./layer.js";
import { TEST_ANCHOR, signed } from "./test-keys.js";

/**
 * Operator ruling D-206 item 1 (DECISIONS.md D-207): a torn final write is repaired at start, and only that.
 *
 * The power loss is simulated in the real journal writer: every file operation an append makes (open, write, flush,
 * rename) goes through a counter, and the append is run once for every operation it makes, with the power lost just
 * before that operation, and once more with only half of each write on disk. Whatever the writer left is then what the
 * next start finds.
 */

const fault = vi.hoisted(() => ({ armed: false, at: 0, count: 0, half: false, fired: false }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  class PowerLoss extends Error {
    override readonly name = "PowerLoss";
  }
  /** Counts one file operation; at the chosen one the power is lost before it happens. */
  const step = (): boolean => {
    if (!fault.armed) return false;
    fault.count += 1;
    return fault.count === fault.at;
  };
  const lose = (): never => {
    fault.armed = false;
    fault.fired = true;
    throw new PowerLoss("simulated power loss");
  };
  const wrapped = {
    ...real,
    openSync: ((...args: Parameters<typeof real.openSync>) => {
      if (step()) lose();
      return real.openSync(...args);
    }) as typeof real.openSync,
    writeSync: ((fd: number, data: Uint8Array, offset: number, length: number) => {
      if (step()) {
        // Half of the write reached the disk.
        if (fault.half) real.writeSync(fd, data, offset, Math.floor(length / 2));
        lose();
      }
      return real.writeSync(fd, data, offset, length);
    }) as typeof real.writeSync,
    fsyncSync: ((fd: number) => {
      if (step()) lose();
      real.fsyncSync(fd);
    }) as typeof real.fsyncSync,
    renameSync: ((from: string, to: string) => {
      if (step()) lose();
      real.renameSync(from, to);
    }) as typeof real.renameSync,
    // The repair's own steps (D-213): cutting the incomplete entry off, and removing its record of the repair.
    ftruncateSync: ((fd: number, length?: number) => {
      if (step()) lose();
      real.ftruncateSync(fd, length);
    }) as typeof real.ftruncateSync,
    rmSync: ((path: string, options?: Parameters<typeof real.rmSync>[1]) => {
      if (step()) lose();
      real.rmSync(path, options);
    }) as typeof real.rmSync,
  };
  return { ...wrapped, default: wrapped };
});

const PRINCIPAL = "operator";
const CLASS = { sensitivity: "internal" as const, integrity: "operator" as const };
const LIMITS: SessionLimits = { rejection_limit: 3, ttl: 3_600_000, budget: { tokens: 0, currency: 0, wall_clock_ms: 3_600_000, turns: 50 }, metered: ["turns", "wall_clock_ms"], clock: "from_admission" };
const TASK = { principal: PRINCIPAL, grants: ["g-open", "g-closed", "g-new"] };

function grant(id: string): Record<string, unknown> {
  return signed({ id, principal: PRINCIPAL, capability_selector: { capabilities: ["fs.read"] }, resource_scope: [{ kind: "path", prefix: "/work/project" }], data_class_bounds: { max_sensitivity: "secret", min_integrity: "untrusted" }, issuance: "preissued", issued_by: PRINCIPAL, issued_at: "2026-01-01T00:00:00Z", expires_at: "2099-01-01T00:00:00Z", max_invocations: null, attenuation_parent: null, revoked_at: null });
}

let dir: string;
let journal: string;
let sink: MemoryAnchorSink;
const journalKey = testJournalKey();

const open = (): Promise<SessionLayer> => openTestLayer("hook", { journal, workspaces: [join(dir, "work")], anchoring: testAnchoring({ sink, journalKey }) });

/** A grant store as a restarted service builds it: the operator's grants, then the journal's counts and recoveries. */
function storeOn(layer: SessionLayer): GrantStore {
  const store = new GrantStore(TEST_ANCHOR);
  for (const id of TASK.grants) store.add(grant(id));
  layer.requireGrants(store);
  return store;
}

const refusedGrants = (store: GrantStore): Record<string, string> => Object.fromEntries(store.coverage(TASK, "fs.read", new Date("2026-06-01T00:00:00Z")).refused.map((item) => [item.grant, item.reason]));

function notes(id: string): Record<string, unknown>[] {
  return readTrajectory(journal, id).map((entry: TrajectoryEntry) => {
    const blob = readPayload(journal, entry.payload_ref);
    return blob.status === "present" ? (JSON.parse(new TextDecoder().decode(blob.bytes)) as Record<string, unknown>) : {};
  });
}

/**
 * A journal with a session open at the crash (it holds `g-open`), a session that had already closed (`g-closed`), and
 * everything anchored. (A grant an open session used in a call is covered through the real services, in
 * packages/runner/test/entry-points.test.ts part G.)
 */
async function seeded(): Promise<SessionLayer> {
  const layer = await open();
  const session = layer.admit("session-open", LIMITS, { dataClass: CLASS, actor: "test", payload: { admitted_at: "2026-05-01T00:00:00.000Z", task: { grants: ["g-open"] } } });
  session.record("note", CLASS, { type: "authorized", tool_use_id: "t-1" }, { actor: "test" });
  const closed = layer.admit("session-closed", LIMITS, { dataClass: CLASS, actor: "test", payload: { admitted_at: "2026-05-01T00:00:00.000Z", task: { grants: ["g-closed"] } } });
  closed.record("note", CLASS, { type: "state", to: "failed", reason: "ttl_expired" }, { actor: "test" });
  expect(await layer.anchorPending()).toEqual([]);
  return layer;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "juno-recovery-"));
  journal = join(dir, "journal");
  mkdirSync(join(dir, "work"));
  sink = new MemoryAnchorSink();
});

afterEach(() => {
  fault.armed = false;
  rmSync(dir, { recursive: true, force: true });
});

/** Runs `write` with the power lost before its `at`-th file operation. Answers whether the power was lost at all. */
function withPowerLossAt(at: number, half: boolean, write: () => void): boolean {
  Object.assign(fault, { armed: true, at, count: 0, half, fired: false });
  try {
    write();
  } catch (error: unknown) {
    if (!(error instanceof Error) || error.name !== "PowerLoss") throw error;
  } finally {
    fault.armed = false;
  }
  return fault.fired;
}

describe("D-206 item 1: a torn final write is dropped at start, recorded, and exhausts the grants of every open session", () => {
  // proves D-206 item 1 with §3.4.1, §3.4.2 and §3.2: whatever point of an append the power is lost at, the service
  // starts again; when the last entry was left incomplete it is dropped, a `recovered_truncation` entry records it, every
  // grant the open session holds or used is exhausted (a session already closed keeps its grant), and a later restart
  // still knows all of it from the journal alone
  for (const scenario of ["an entry of an open session", "the first entry of a new session"] as const) {
    it(`a power loss at every point of appending ${scenario}`, async () => {
      const seen = new Set<string>();
      for (const half of [false, true]) {
        for (let at = 1; at < 200; at += 1) {
          rmSync(journal, { recursive: true, force: true });
          sink = new MemoryAnchorSink();
          const layer = await seeded();
          const before = { open: readTrajectory(journal, "session-open").length };
          const lost = withPowerLossAt(at, half, () => {
            if (scenario === "an entry of an open session") layer.session("session-open")?.record("note", CLASS, { type: "authorized", tool_use_id: "t-2" }, { actor: "test" });
            else layer.admit("session-new", LIMITS, { dataClass: CLASS, actor: "test", payload: { admitted_at: "2026-05-02T00:00:00.000Z", task: { grants: ["g-new"] } } });
          });
          if (!lost) {
            // The append finished before operation `at`: every point has been tried.
            expect(at).toBeGreaterThan(8);
            break;
          }
          // The machine comes back: the service starts on what the disk holds.
          const restarted = await open();
          const recovery = restarted.recovery;
          seen.add(recovery === null ? "nothing torn" : recovery.how);
          const store = storeOn(restarted);
          if (recovery === null) {
            // Nothing incomplete was left (the power went before the entry's line, or after its head record): no grant is touched.
            expect(refusedGrants(store)).toEqual({});
          } else {
            expect(recovery.open_sessions).toContain("session-open");
            expect(recovery.open_sessions).not.toContain("session-closed");
            expect(recovery.exhausted_grants).toContain("g-open");
            expect(refusedGrants(store)).toMatchObject({ "g-open": "exhausted" });
            expect(refusedGrants(store)["g-closed"]).toBeUndefined();
            // The journal's own record holds the recovery; the record that lost the entry says so too.
            const own = notes(restarted.journalRecord).filter((note) => note["type"] === "recovered_truncation");
            expect(own).toHaveLength(1);
            expect(own[0]).toMatchObject({ how: recovery.how, exhausted_grants: recovery.exhausted_grants, open_sessions: recovery.open_sessions });
            if (recovery.record === "session-open") {
              expect(recovery.kept_entries).toBe(before.open);
              expect(notes("session-open").at(-1)).toMatchObject({ type: "recovered_truncation", kept_entries: before.open });
            }
          }
          // Every record verifies again, and agrees with every anchor held off the host.
          for (const id of [restarted.journalRecord, "session-open", "session-closed"]) {
            const check = checkAnchors(id, verifyTrajectory(journal, id), await sink.list(taskDigest(id)), journalKey.publicKey);
            expect(check, `${id} at operation ${String(at)}`).toMatchObject({ ok: true });
          }
          // A second restart repairs nothing more, and still knows which grants are exhausted.
          expect(await restarted.close()).toEqual([]);
          const again = await open();
          expect(again.recovery).toBeNull();
          expect(Object.keys(refusedGrants(storeOn(again))).sort()).toEqual(Object.keys(refusedGrants(store)).sort());
        }
      }
      // The simulation reached a cut-short line, an entry whose head record was never written, and a clean stop.
      expect([...seen].sort()).toEqual(["nothing torn", "partial_line", "unheaded_entry"]);
    }, 120_000);
  }

  // proves D-206 item 1: a grant the operator signs afterwards (a new id) is not exhausted
  it("a newly signed grant is usable after the recovery", async () => {
    const layer = await seeded();
    appendFileSync(entriesFile(journal as never, "session-open"), '{"cut":"sho');
    void layer;
    const restarted = await open();
    expect(restarted.recovery).toMatchObject({ how: "partial_line", record: "session-open" });
    const store = storeOn(restarted);
    expect(refusedGrants(store)).toEqual({ "g-open": "exhausted" });
    expect(store.coverage(TASK, "fs.read", new Date("2026-06-01T00:00:00Z")).covering.map((item) => item.id)).toEqual(["g-closed", "g-new"]);
  });
});

describe("D-206 item 1: any other verification or anchor failure still refuses the start, and nothing is dropped", () => {
  const cutLastLine = (id: string): void => {
    const file = entriesFile(journal as never, id);
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.slice(0, -10));
  };
  const untouched = async (arrange: () => void, why: RegExp): Promise<void> => {
    await seeded();
    arrange();
    const file = entriesFile(journal as never, "session-open");
    const before = readFileSync(file);
    await expect(open()).rejects.toThrow(why);
    expect(readFileSync(file).equals(before)).toBe(true);
  };

  // proves D-206 item 1 with §3.4.1: someone cuts an anchored entry short and winds the head record back, so that it
  // looks like a torn write; what is left does not match the anchors, so nothing is dropped and the start is refused
  it("refuses when the incomplete entry is one an anchor already names", async () => {
    await untouched(() => {
      const entries = readTrajectory(journal, "session-open");
      const previous = entries.at(-2);
      if (previous === undefined) throw new Error("no earlier entry");
      cutLastLine("session-open");
      writeFileSync(headFile(journal as never, "session-open"), encodeHead({ task_id: "session-open", seq: previous.seq, hash: entryHash(previous) }));
      expect(tornTail(journal, taskDigest("session-open"))).toMatchObject({ how: "partial_line" });
    }, /disagrees with its off-host anchors: .*entries were removed/);
  });

  // proves D-206 item 1 with D-027: an entry cut short while the head record still names it is a cut, not a torn write
  it("refuses a cut entry that the head record still names", async () => {
    await untouched(() => cutLastLine("session-open"), /does not verify: incomplete_entry/);
  });

  // proves D-206 item 1 with §3.4.2: an entry before the incomplete one was changed
  it("refuses when an earlier entry does not verify", async () => {
    await untouched(() => {
      const file = entriesFile(journal as never, "session-open");
      writeFileSync(file, `${readFileSync(file, "utf8").replace('"actor":"test"', '"actor":"else"')}{"cut":"sho`);
    }, /does not verify/);
  });

  // proves D-206 item 1: one interrupted write leaves one incomplete entry; two records cut short are not that
  it("refuses when two records end in an incomplete entry", async () => {
    await untouched(() => {
      appendFileSync(entriesFile(journal as never, "session-open"), '{"cut":"sho');
      appendFileSync(entriesFile(journal as never, "session-closed"), '{"cut":"sho');
    }, /does not verify: incomplete_entry.*a second record ends in an incomplete entry/);
  });

  // proves D-206 item 1 with §3.4.2: a complete last line that is not the next entry of the chain is not a torn write
  it("refuses a complete last line that does not continue the chain", async () => {
    await untouched(() => appendFileSync(entriesFile(journal as never, "session-open"), '{"not":"an entry"}\n'), /does not verify/);
    expect(tornTail(journal, taskDigest("session-open"))).toBeNull();
  });

  // proves D-206 item 1 with D-027: a head record that names anything but the entry before the last is a cut, not a torn write
  it("refuses a head record that is two entries behind", async () => {
    await untouched(() => {
      writeFileSync(headFile(journal as never, "session-open"), readFileSync(headFile(journal as never, "session-open"), "utf8").replace(/"seq":[0-9]+/, '"seq":0'));
    }, /does not verify/);
  });
});

/**
 * Operator ruling D-211 item 1 (review round 7 finding F4; DECISIONS.md D-213): the repair is atomic. The machine comes
 * back after the first power loss (a cut-short line in an open session's record), and the power is lost again at every
 * file operation of the start that repairs it, one run per operation, until a start runs to its end. After each, the
 * service starts with the power on: the grant of the session open at the first crash is exhausted, the repair is recorded
 * once in the journal's own record, nothing of its own record is left behind, and every record verifies against its
 * anchors.
 */
/** The first power loss's cut-short line, as the repair records what it dropped. */
const FIRST_CUT = '{"cut":"sho';
const FIRST_CUT_SHA256 = createHash("sha256").update(FIRST_CUT, "utf8").digest("hex");

/**
 * The first torn write is recorded exactly once in the journal's own record, exhausting g-open. A power loss while the
 * repair wrote its own note into the session's record tears that note: it is a torn write of its own, repaired and
 * recorded by the next start. Any such further record must be of exactly that (a dropped `recovered_truncation` note)
 * and exhaust the same grants.
 */
function expectRepairRecorded(layer: SessionLayer, when: string): void {
  const repairs = notes(layer.journalRecord).filter((note) => note["type"] === "recovered_truncation");
  const first = repairs.filter((note) => note["dropped_sha256"] === FIRST_CUT_SHA256);
  expect(first, when).toHaveLength(1);
  expect(first[0], when).toMatchObject({ record: "session-open", dropped_bytes: Buffer.byteLength(FIRST_CUT), open_sessions: ["session-open"] });
  expect(first[0]?.["exhausted_grants"], when).toContain("g-open");
  for (const other of repairs.filter((note) => note["dropped_sha256"] !== FIRST_CUT_SHA256)) {
    expect(other, when).toMatchObject({ exhausted_grants: first[0]?.["exhausted_grants"] });
    expect([layer.journalRecord, "session-open"], when).toContain(other["record"]);
  }
}

describe("D-211 item 1: a second power loss at any step of the repair leaves the grants exhausted", () => {
  for (const half of [false, true]) {
    // proves D-211 item 1 (§3.4.1, §3.2): the repair's record is durable before the incomplete entry is removed
    it(`power lost at every operation of the repairing start${half ? ", half of each write on disk" : ""}`, async () => {
      const reached = new Set<string>();
      let at = 1;
      for (; at < 1000; at += 1) {
        rmSync(journal, { recursive: true, force: true });
        sink = new MemoryAnchorSink();
        await seeded();
        // The first power loss: a cut-short line in the open session's record.
        appendFileSync(entriesFile(journal as never, "session-open"), FIRST_CUT);
        // The second, at operation `at` of the start that repairs it.
        Object.assign(fault, { armed: true, at, count: 0, half, fired: false });
        try {
          await open();
        } catch (error: unknown) {
          if (!(error instanceof Error) || !/simulated power loss/.test(error.message)) throw error;
        } finally {
          fault.armed = false;
        }
        if (!fault.fired) break;
        reached.add(existsSync(join(journal, "recovery-pending.json")) ? "record of the repair on disk" : "no record of the repair on disk");
        // The power stays on now.
        const third = await open();
        expect(third.recovery === null ? "nothing repaired by this start" : "repaired", `operation ${String(at)}`).toBeDefined();
        expect(refusedGrants(storeOn(third)), `operation ${String(at)}`).toMatchObject({ "g-open": "exhausted" });
        expect(refusedGrants(storeOn(third))["g-closed"], `operation ${String(at)}`).toBeUndefined();
        expectRepairRecorded(third, `operation ${String(at)}`);
        expect(existsSync(join(journal, "recovery-pending.json")), `operation ${String(at)}`).toBe(false);
        for (const id of [third.journalRecord, "session-open", "session-closed"]) {
          const check = checkAnchors(id, verifyTrajectory(journal, id), await sink.list(taskDigest(id)), journalKey.publicKey);
          expect(check, `${id} at operation ${String(at)}`).toMatchObject({ ok: true });
        }
        expect(await third.close()).toEqual([]);
        // And once more: still exhausted, nothing more to repair.
        const fourth = await open();
        expect(fourth.recovery).toBeNull();
        expect(refusedGrants(storeOn(fourth))).toMatchObject({ "g-open": "exhausted" });
        await fourth.close();
      }
      // Every operation of the repairing start was tried, and the run reached both sides of the record's writing.
      expect(at).toBeGreaterThan(10);
      expect([...reached].sort()).toEqual(["no record of the repair on disk", "record of the repair on disk"]);
    }, 600_000);
  }

  // proves D-211 item 1: power lost again and again, each time at the first operation not yet survived, never loses the exhaustion
  it("power lost at successive operations of successive repairing starts", async () => {
    await seeded();
    appendFileSync(entriesFile(journal as never, "session-open"), FIRST_CUT);
    let survived = 0;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      Object.assign(fault, { armed: true, at: survived + 1, count: 0, half: attempt % 2 === 1, fired: false });
      let finished: SessionLayer | null = null;
      try {
        finished = await open();
      } catch (error: unknown) {
        if (!(error instanceof Error) || !/simulated power loss/.test(error.message)) throw error;
      } finally {
        fault.armed = false;
      }
      if (finished !== null) {
        await finished.close();
        break;
      }
      survived += 1;
    }
    const last = await open();
    expect(refusedGrants(storeOn(last))).toMatchObject({ "g-open": "exhausted" });
    expectRepairRecorded(last, "after the last start");
    expect(existsSync(join(journal, "recovery-pending.json"))).toBe(false);
    await last.close();
  }, 600_000);
});
