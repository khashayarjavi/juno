import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_CALLS_PER_TURN } from "../src/provider.js";
import type { Runner } from "../src/runner.js";
import { type Harness, harness, request, shellRun, turn } from "./helpers.js";

/**
 * §2.7.1 (v0.6 A4, v0.6.1 V6-9) and D-102: consecutive rejections park `rejection_limit` (overridable, §6.2). The count
 * resets when a call proceeds, when a call parks, and on resume; the limit is set per task at admission between 1 and
 * 10, default 3; a turn the runner cannot read counts as one rejection and never resets the count.
 */

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  h.cleanup();
});

let ids = 0;
/** A call to a capability nobody registered: a rejection (`unknown_capability`), nothing runs. */
const rejected = (): unknown => {
  ids += 1;
  return { id: `bad-${String(ids)}`, capability: "fs.nothing", arguments: {} };
};
/** A turn the runner cannot read (a provider refusal, as Groq returns it). */
const unreadable = { provider_error: "tool_use_failed", failed_generation: "" };
const down = (): never => {
  throw new Error("provider down");
};

const parks = (): Record<string, unknown>[] => h.entries().filter((entry) => entry.kind === "park").map(h.payload);
const results = (): number => h.entries().filter((entry) => entry.kind === "capability_result").length;
const admitted = (runner: Runner, overrides: Record<string, unknown> = {}): void => {
  const result = runner.admit(request(overrides));
  if (!result.admitted) throw new Error(`not admitted: ${JSON.stringify(result.failures)}`);
};

describe("§2.7.1 A4: the rejection limit", () => {
  // proves §2.7.1 A4 / §6.2: three consecutive rejections park rejection_limit, which is overridable; nothing ran
  it("parks rejection_limit at the third consecutive rejection, naming each one", async () => {
    const third = rejected() as { id: string };
    const after = shellRun(["notes.txt"]) as { id: string };
    const { runner, provider } = h.runner([turn([rejected()]), turn([rejected()]), turn([third, after])]);
    admitted(runner);
    expect(await runner.run("task-1")).toEqual({ task_id: "task-1", state: "parked", reason: "rejection_limit" });
    expect(provider.requests).toHaveLength(3);
    expect(results()).toBe(0);
    const [park] = parks();
    expect(park).toMatchObject({ reason: "rejection_limit", overridable: true, limit: 3, tool_call: third.id, not_acted_on: [after.id] });
    expect(park?.["rejections"]).toEqual([
      { kind: "call", seq: expect.any(Number) },
      { kind: "call", seq: expect.any(Number) },
      { kind: "call", seq: park?.["call_seq"] },
    ]);
  });

  // proves §2.7.1 A4: rejections in one turn count one by one, so three in a single turn park too
  it("counts each rejected call in a turn", async () => {
    const { runner } = h.runner([turn([rejected(), rejected(), rejected()])]);
    admitted(runner);
    expect((await runner.run("task-1")).reason).toBe("rejection_limit");
  });

  // proves §2.7.1 v0.6.1: two rejections then a proceeding call do not park, and the proceeding call resets the count
  it("resets the count when a call proceeds", async () => {
    const { runner } = h.runner([turn([rejected(), rejected()]), turn([shellRun(["notes.txt"])]), turn([rejected(), rejected()]), turn([])]);
    admitted(runner);
    expect((await runner.run("task-1")).state).toBe("complete_unverified");
    expect(parks()).toEqual([]);
    expect(results()).toBe(1);
  });

  // proves §2.7.1 v0.6.1: a park resets the count, and so does resume: after them the task needs the limit's worth again
  it("resets the count on a park and on resume", async () => {
    const { runner } = h.runner([turn([rejected(), rejected()]), down, turn([rejected(), rejected()]), turn([])]);
    admitted(runner);
    expect((await runner.run("task-1")).reason).toBe("routing_unavailable");
    expect((await runner.resume("task-1")).state).toBe("complete_unverified");
    expect(parks().map((park) => park["reason"])).toEqual(["routing_unavailable"]);
  });

  // proves §2.7.1 v0.6.1: the limit is honoured at both ends of its range, 1 and 10
  it("honours a limit of 1 and a limit of 10", async () => {
    const one = h.runner([turn([rejected()])]);
    admitted(one.runner, { rejection_limit: 1 });
    expect((await one.runner.run("task-1")).reason).toBe("rejection_limit");
    expect(parks()[0]).toMatchObject({ limit: 1 });

    h.cleanup();
    h = harness();
    const nine = Array.from({ length: 9 }, () => turn([rejected()]));
    const ten = h.runner([...nine, turn([])]);
    admitted(ten.runner, { rejection_limit: 10 });
    expect((await ten.runner.run("task-1")).state).toBe("complete_unverified");

    h.cleanup();
    h = harness();
    const tenth = h.runner([...Array.from({ length: 10 }, () => turn([rejected()])), turn([])]);
    admitted(tenth.runner, { rejection_limit: 10 });
    expect((await tenth.runner.run("task-1")).reason).toBe("rejection_limit");
    expect(parks()[0]).toMatchObject({ limit: 10 });
  });

  // proves §2.7.1 v0.6.1: admission refuses a limit outside 1 to 10, and records the default of 3 when none is given
  it("refuses a limit of 0 or 11 at admission, and defaults to 3", () => {
    const { runner } = h.runner([]);
    for (const limit of [0, 11, 2.5]) {
      const result = runner.admit(request({ id: `task-${String(limit)}`, rejection_limit: limit }));
      expect(result.admitted, String(limit)).toBe(false);
    }
    admitted(runner);
    const admission = h.entries("task-1").map(h.payload).find((body) => body["type"] === "admission");
    expect(admission).toMatchObject({ outcome: "admitted", rejection_limit: 3 });
  });
});

describe("§2.7.1 A4 with D-102: a turn the runner cannot read", () => {
  // proves D-102: three unreadable turns in a row park rejection_limit instead of burning the turn budget
  it("parks rejection_limit after three unreadable turns", async () => {
    const { runner, provider } = h.runner([unreadable, unreadable, unreadable, turn([])]);
    admitted(runner);
    expect(await runner.run("task-1")).toMatchObject({ state: "parked", reason: "rejection_limit" });
    expect(provider.requests).toHaveLength(3);
    expect(parks()[0]?.["rejections"]).toEqual([
      { kind: "unreadable_turn", seq: expect.any(Number) },
      { kind: "unreadable_turn", seq: expect.any(Number) },
      { kind: "unreadable_turn", seq: expect.any(Number) },
    ]);
  });

  // proves D-102: an unreadable turn does not reset the count; it adds one to rejected calls around it
  it("counts an unreadable turn together with rejected calls, never resetting", async () => {
    const { runner } = h.runner([turn([rejected()]), unreadable, turn([rejected()]), turn([])]);
    admitted(runner);
    expect((await runner.run("task-1")).reason).toBe("rejection_limit");
    expect(parks()[0]?.["rejections"]).toEqual([
      { kind: "call", seq: expect.any(Number) },
      { kind: "unreadable_turn", seq: expect.any(Number) },
      { kind: "call", seq: expect.any(Number) },
    ]);
  });

  // proves D-102 with §2.7.1: an unreadable turn counts as one rejection however many calls it held, and a later proceeding call still resets
  it("counts one unreadable turn as one rejection, and a proceeding call still resets", async () => {
    // More calls than one turn may hold: the runner cannot read the turn, so its calls are never judged one by one.
    const tooMany = turn(Array.from({ length: MAX_CALLS_PER_TURN + 1 }, () => rejected()));
    const { runner } = h.runner([tooMany, unreadable, turn([shellRun(["notes.txt"])]), unreadable, unreadable, turn([])]);
    admitted(runner);
    expect((await runner.run("task-1")).state).toBe("complete_unverified");
    expect(parks()).toEqual([]);
    expect(h.entries().filter((entry) => entry.kind === "capability_call")).toHaveLength(1);
  });
});
