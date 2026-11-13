import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderRequest } from "../src/provider.js";
import type { Runner } from "../src/runner.js";
import { type Harness, grant, harness, request, shellRun, turn } from "./helpers.js";

/**
 * §11.1 (v0.6 A3, v0.6.1 V6-8): each park records, for every value that caused it, its provenance class, its
 * integrity, and the journal entry it came from. A `bound` value names the referenced entry; a `synthesized` value
 * names no source (invariant 7: no contents are compared) and lists instead the untrusted entries in the model's
 * context since the last operator input, as "possible sources" (D-110).
 */

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(() => {
  h.cleanup();
});

const parks = (): Record<string, unknown>[] => h.entries().filter((entry) => entry.kind === "park").map(h.payload);
const resultSeqs = (): number[] => h.entries().filter((entry) => entry.kind === "capability_result").map((entry) => entry.seq);
const admitted = (runner: Runner, overrides: Record<string, unknown> = {}): void => {
  const result = runner.admit(request(overrides));
  if (!result.admitted) throw new Error(`not admitted: ${JSON.stringify(result.failures)}`);
};
/** The seq of the first capability result the model was shown, read from the request it got. */
const shownResult = (req: ProviderRequest): number => {
  const item = req.context.findLast((entry) => entry.role === "tool")?.content as Record<string, unknown> | undefined;
  return Number(item?.["result_seq"]);
};

describe("§11.1 A3: the source of every value that caused a park", () => {
  // proves §11.1 V6-8 / invariant 7: a synthesized program lists the untrusted content read since the last operator input as possible sources
  it("lists possible sources for a synthesized value", async () => {
    const { runner } = h.runner([turn([shellRun(["notes.txt"])]), turn([shellRun(["x"], "/usr/bin/cat")])]);
    admitted(runner);
    expect((await runner.run("task-1")).reason).toBe("integrity_floor");
    const [read] = resultSeqs();
    expect(parks()[0]?.["sources"]).toEqual([
      {
        argument: "program",
        class: "synthesized",
        integrity: "untrusted",
        source: { kind: "possible_sources", since_operator_input: expect.any(Number), entries: [{ entry: read, context_entry: expect.any(Number), role: "tool" }] },
      },
    ]);
  });

  // proves §11.1 A3: a bound value names the entry it was bound to, and the binding_resolution entry that recorded it
  it("names the referenced entry for a bound value", async () => {
    const { runner } = h.runner([turn([shellRun(["notes.txt"])]), (req: ProviderRequest) => turn([shellRun(["x"], { ref: `\${${String(shownResult(req))}.stdout_lines[0]}` })])]);
    admitted(runner);
    expect((await runner.run("task-1")).reason).toBe("integrity_floor");
    const [read] = resultSeqs();
    // The bound value is not an enum member, so there is no surface and argv[0] is promoted too (§2.3.1 rule 5): both caused the park.
    expect(parks()[0]?.["sources"]).toEqual([
      { argument: "program", class: "bound", integrity: "untrusted", source: { kind: "entry", entry: read, binding_entry: expect.any(Number) } },
      { argument: "argv[0]", class: "synthesized", integrity: "untrusted", source: { kind: "possible_sources", since_operator_input: expect.any(Number), entries: [{ entry: read, context_entry: expect.any(Number), role: "tool" }] } },
    ]);
  });

  // proves §11.1 A3: a constant names the admission entry and its slot
  it("names the admission entry for a constant", async () => {
    h.grants.add(grant({ id: "grant-inbox", resource_scope: [{ kind: "path", prefix: "/work/project/inbox" }] }));
    const { runner } = h.runner([turn([shellRun([{ slot: "notes" }])])]);
    admitted(runner, { grants: ["grant-inbox"], constants: { cat: { value: "/usr/bin/cat" }, project: { value: "/work/project/inbox" }, notes: { value: "/work/project/notes.txt" } } });
    expect((await runner.run("task-1")).reason).toBe("scope_violation");
    const admission = h.entries()[0]?.seq;
    expect(parks()[0]?.["sources"]).toEqual([{ argument: "argv[0]", class: "constant", integrity: "operator", source: { kind: "admission", entry: admission, slot: "notes" } }]);
  });

  // proves §11.1 V6-8: with no untrusted content read yet, a synthesized value has no possible source to list, and operator content is never listed
  it("lists no possible source when nothing untrusted was read", async () => {
    h.grants.add(grant({ id: "grant-inbox", resource_scope: [{ kind: "path", prefix: "/work/project/inbox" }] }));
    const { runner } = h.runner([turn([shellRun(["../notes.txt"])])]);
    admitted(runner, { grants: ["grant-inbox"], constants: { cat: { value: "/usr/bin/cat" }, project: { value: "/work/project/inbox" } } });
    expect((await runner.run("task-1")).reason).toBe("scope_violation");
    expect(parks()[0]?.["sources"]).toEqual([
      { argument: "argv[0]", class: "synthesized", integrity: "untrusted", source: { kind: "possible_sources", since_operator_input: expect.any(Number), entries: [] } },
    ]);
  });

  // proves §11.1: a park no value caused (awaiting_grant) names no source
  it("names no source for a park no value caused", async () => {
    const { runner } = h.runner([turn([shellRun(["notes.txt"])])]);
    admitted(runner, { grants: [] });
    expect((await runner.run("task-1")).reason).toBe("awaiting_grant");
    expect(parks()[0]?.["sources"]).toEqual([]);
  });
});
