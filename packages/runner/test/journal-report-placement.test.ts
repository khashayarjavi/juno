import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENTRY_KINDS, type TrajectoryEntry } from "../../contracts/src/index.js";
import { ENTRY_PLACEMENT, replaySession } from "../../enforcement/src/index.js";

// Operator ruling 2 of 2026-11-26 on PR #70 (DECISIONS.md D-266): every kind of journal entry and every note type JUNO
// writes is either counted by `juno journal report` (through THE replay, `replaySession`) or named in its "not counted"
// list (`ENTRY_PLACEMENT`). The note types are read from JUNO's own source, so a type added later fails this test until
// it is placed; and each place is checked against what the replay does with such an entry, so "counted" and "not
// counted" are true of the code, not only of the table.

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * `type: "<x>"` literals in JUNO's source that are not journal payload types, each pinned to the files it appears in:
 * the same word in any other file must be placed (or pinned here, with a reason).
 */
const NOT_JOURNAL: Readonly<Record<string, { readonly files: readonly string[]; readonly why: string }>> = {
  string: { files: ["packages/runner/src/groq.ts"], why: "a JSON Schema type in the provider's tool definitions" },
  object: { files: ["packages/runner/src/groq.ts"], why: "a JSON Schema type" },
  function: { files: ["packages/runner/src/groq.ts"], why: "the provider's tool kind" },
  number: { files: ["packages/runner/src/groq.ts"], why: "a JSON Schema type" },
  integer: { files: ["packages/runner/src/groq.ts"], why: "a JSON Schema type" },
  boolean: { files: ["packages/runner/src/groq.ts"], why: "a JSON Schema type" },
  array: { files: ["packages/runner/src/groq.ts"], why: "a JSON Schema type" },
  directory: { files: ["packages/enforcement/src/checkpoint.ts", "packages/enforcement/src/host-restore.ts"], why: "a checkpoint manifest entry's type" },
  file: { files: ["packages/enforcement/src/checkpoint.ts", "packages/enforcement/src/host-restore.ts"], why: "a checkpoint manifest entry's type" },
  symlink: { files: ["packages/enforcement/src/checkpoint.ts", "packages/enforcement/src/host-restore.ts"], why: "a checkpoint manifest entry's type" },
  pkcs8: { files: ["packages/journal/src/sinks.ts"], why: "a private key's export format" },
  spki: { files: ["packages/enforcement/src/session-layer.ts", "packages/journal/src/sinks.ts"], why: "a public key's export format" },
  text: { files: ["packages/mediated/src/gateway.ts"], why: "an MCP content item's type" },
  stdio: { files: ["packages/mediated/src/install.ts"], why: "an MCP server's transport in Claude Code's settings" },
  command: { files: ["packages/mediated/src/install.ts"], why: "a Claude Code hook's type in its settings" },
  recovery_pending: { files: ["packages/journal/src/repair.ts"], why: "the unfinished-repair file beside the journal, not a journal entry (D-213)" },
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

/** Every `type: "<x>"` literal in every package's source, with the files it appears in. */
function typeLiterals(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const pkg of readdirSync(join(ROOT, "packages"))) {
    let files: string[];
    try {
      files = sources(join(ROOT, "packages", pkg, "src"));
    } catch {
      continue;
    }
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(/\btype: "([A-Za-z0-9_]+)"/g)) {
        const name = match[1] ?? "";
        const set = found.get(name) ?? new Set<string>();
        set.add(relative(ROOT, file));
        found.set(name, set);
      }
    }
  }
  return found;
}

let seq = 0;
function entry(kind: TrajectoryEntry["kind"], payload: Record<string, unknown>): { entry: TrajectoryEntry; payload: unknown } {
  seq += 1;
  return { entry: { seq, kind, task_id: "session-x", timestamp: new Date(0).toISOString() } as unknown as TrajectoryEntry, payload };
}

/** A minimal entry of each counted place, as JUNO writes it. */
const COUNTED_EXAMPLES: Readonly<Record<string, () => { entry: TrajectoryEntry; payload: unknown }>> = {
  capability_call: () => entry("capability_call", { capability: "cc.read", grant: "g", verdict: { outcome: "proceed" } }),
  park: () => entry("park", { reason: "integrity_floor" }),
  capability_result: () => entry("capability_result", { call_seq: null, tool_use_id: "t", tool: "Read", outcome: "succeeded", without_authorized_call: true }),
  "note:admission": () => entry("note", { type: "admission", outcome: "rejected", mode: "hook" }),
  "note:rejection": () => entry("note", { type: "rejection", tool: "mcp__x", reason: "r" }),
  "note:result_missing": () => entry("note", { type: "result_missing", calls: [{ tool_use_id: "t", call_seq: 1 }] }),
  "note:state": () => entry("note", { type: "state", to: "failed", reason: "ttl_expired" }),
  "note:stopped": () => entry("note", { type: "stopped", reason: "anchor_unavailable" }),
  "note:gateway_call": () => entry("note", { type: "gateway_call", tool: "mcp__juno__x", tool_use_id: "t", reads: "internal" }),
  "note:authorized": () => entry("note", { type: "authorized", call_seq: 1, tool_use_id: "t", reads: "internal" }),
  "note:updated_input": () => entry("note", { type: "updated_input", call_seq: 1, tool_use_id: "t", command: "/usr/bin/cat 'x'", reads: "internal" }),
};

describe("every entry JUNO writes is placed in the report (D-266, operator ruling 2)", () => {
  // proves ruling 2: each kind of journal entry (§3.4.2's kinds) is counted or named as not counted
  it("places every entry kind", () => {
    for (const kind of ENTRY_KINDS) {
      if (kind === "note") continue;
      expect(ENTRY_PLACEMENT[kind], kind).toBeDefined();
    }
  });

  // proves ruling 2: each note type any of JUNO's code writes is counted or named as not counted; a new one fails here
  it("places every note type JUNO's source writes", () => {
    const unplaced: string[] = [];
    for (const [name, files] of typeLiterals()) {
      if (ENTRY_PLACEMENT[`note:${name}`] !== undefined) continue;
      const pinned = NOT_JOURNAL[name];
      const elsewhere = [...files].filter((file) => !(pinned?.files ?? []).includes(file));
      if (elsewhere.length > 0) unplaced.push(`${name} (${elsewhere.join(", ")})`);
    }
    expect(unplaced).toEqual([]);
    // The table names no note type JUNO's source never writes.
    const written = typeLiterals();
    const stale = Object.keys(ENTRY_PLACEMENT).filter((key) => key.startsWith("note:") && !written.has(key.slice("note:".length)));
    expect(stale).toEqual([]);
  });

  // proves ruling 1 with ruling 2: what the table says is what the replay does. A counted entry is judged (as a call,
  // an end, a result, an admission or a call waiting for its result); a not-counted one is judged as nothing
  it("counts exactly the entries the table says it counts", () => {
    for (const [key, place] of Object.entries(ENTRY_PLACEMENT)) {
      const example = "counted" in place ? COUNTED_EXAMPLES[key]?.() : key.startsWith("note:") ? entry("note", { type: key.slice("note:".length), reason: "x", to: "failed" }) : entry(key as TrajectoryEntry["kind"], { reason: "x", grant: "g", verdict: { outcome: "proceed" } });
      expect(example, `an example of ${key}`).toBeDefined();
      if (example === undefined) continue;
      const replay = replaySession([example]);
      const judged = replay.judged[0];
      expect(judged?.placement, key).toBe(key);
      const something = judged !== undefined && (judged.call !== null || judged.end !== null || judged.result !== null || judged.grant_use !== null || replay.admission.kind !== "not_recorded" || replay.pending.size > 0);
      expect(something, key).toBe("counted" in place);
    }
  });

  // proves the report's fail-closed side: an entry of a type the table does not hold has no place, and the report refuses
  it("gives no place to a note type the table does not hold", () => {
    const replay = replaySession([entry("note", { type: "a_type_juno_does_not_write" }), entry("note", {})]);
    expect(replay.judged.map((judged) => judged.placement)).toEqual([null, null]);
  });
});
