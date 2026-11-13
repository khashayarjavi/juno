import { describe, expect, it } from "vitest";
import { BoundaryError } from "../../contracts/src/index.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ordinaryHost } from "../../enforcement/test/layer.js";
import { testAnchoring } from "../../enforcement/test/anchoring.js";
import { parseRunnerConfig } from "../src/config.js";
import { runRunnerMain } from "../src/runner-main.js";

/** §3.4.1 (D-198): every service anchors, so the runner's environment names its journal key folder and anchor clone. */
const ANCHORING = { JUNO_JOURNAL_KEY_DIR: "/var/lib/juno-runner/journal-key", JUNO_ANCHOR_CLONE: "/var/lib/juno-runner/juno-anchors" };

describe("parseRunnerConfig", () => {
  // proves build plan Increment 0: the runner parses its environment at the boundary
  it("parses a complete environment", () => {
    expect(parseRunnerConfig({ JUNO_JOURNAL_DIR: "/journal", JUNO_WORK_DIR: "/work", OTHER: "x", ...ANCHORING })).toEqual({
      journalDir: "/journal",
      workDir: "/work",
      trustAnchor: null,
      anchoring: { journalKeyDir: "/var/lib/juno-runner/journal-key", anchorClone: "/var/lib/juno-runner/juno-anchors", intervalMs: 60_000, pin: "/etc/juno/anchors.json" },
    });
  });

  // proves §3.4.1 (D-198): the runner's environment must name where its anchors go and its journal key; the interval is
  // a whole number of seconds from 1 to 3600
  it("requires the journal key folder and the anchor clone, and reads the interval", () => {
    expect(() => parseRunnerConfig({ JUNO_JOURNAL_DIR: "/journal", JUNO_WORK_DIR: "/work" })).toThrow(BoundaryError);
    expect(() => parseRunnerConfig({ JUNO_JOURNAL_DIR: "/journal", JUNO_WORK_DIR: "/work", JUNO_JOURNAL_KEY_DIR: "/k" })).toThrow(BoundaryError);
    expect(() => parseRunnerConfig({ JUNO_JOURNAL_DIR: "/journal", JUNO_WORK_DIR: "/work", JUNO_ANCHOR_CLONE: "/c" })).toThrow(BoundaryError);
    expect(parseRunnerConfig({ JUNO_JOURNAL_DIR: "/journal", JUNO_WORK_DIR: "/work", ...ANCHORING, JUNO_ANCHOR_INTERVAL_SECONDS: "300" }).anchoring.intervalMs).toBe(300_000);
    for (const bad of ["0", "3601", "1.5", "-1", "60s"]) expect(() => parseRunnerConfig({ JUNO_JOURNAL_DIR: "/journal", JUNO_WORK_DIR: "/work", ...ANCHORING, JUNO_ANCHOR_INTERVAL_SECONDS: bad })).toThrow(BoundaryError);
  });

  // proves §3.2 C1 (D-125): the trust anchor's path is read when given, and must be absolute
  it("reads the trust anchor's path", () => {
    expect(parseRunnerConfig({ JUNO_JOURNAL_DIR: "/journal", JUNO_WORK_DIR: "/work", JUNO_TRUST_ANCHOR: "/etc/juno/operator.pub", ...ANCHORING }).trustAnchor).toBe("/etc/juno/operator.pub");
    expect(() => parseRunnerConfig({ JUNO_JOURNAL_DIR: "/journal", JUNO_WORK_DIR: "/work", JUNO_TRUST_ANCHOR: "operator.pub", ...ANCHORING })).toThrow();
  });

  // proves §0.2 D8 (fail closed): missing or empty settings stop the runner
  it.each([
    [{ JUNO_WORK_DIR: "/work" }],
    [{ JUNO_JOURNAL_DIR: "/journal" }],
    [{ JUNO_JOURNAL_DIR: "", JUNO_WORK_DIR: "/work" }],
    [{}],
  ])("rejects %j", (env) => {
    expect(() => parseRunnerConfig(env)).toThrow(BoundaryError);
  });

  // proves §3.3 canonical form / §0.2 D8: both directories must be absolute and normalised
  it.each([
    [{ JUNO_JOURNAL_DIR: "journal", JUNO_WORK_DIR: "/work" }],
    [{ JUNO_JOURNAL_DIR: "/journal/", JUNO_WORK_DIR: "/work" }],
    [{ JUNO_JOURNAL_DIR: "/journal", JUNO_WORK_DIR: "/work/../work" }],
  ])("rejects the non-canonical directories %j", (env) => {
    expect(() => parseRunnerConfig({ ...ANCHORING, ...env })).toThrow(BoundaryError);
  });

  // proves §3.4.1: the runner refuses to start with journal storage anywhere a selector could name. (D-194: the refusal is
  // the shared start-up check's, which the runner process runs before it opens anything; nothing is created.)
  it.each([
    [{ JUNO_JOURNAL_DIR: "/work", JUNO_WORK_DIR: "/data" }],
    [{ JUNO_JOURNAL_DIR: "/work/journal", JUNO_WORK_DIR: "/work" }],
    [{ JUNO_JOURNAL_DIR: "/", JUNO_WORK_DIR: "/work" }],
    [{ JUNO_JOURNAL_DIR: "/srv", JUNO_WORK_DIR: "/srv/work" }],
    [{ JUNO_JOURNAL_DIR: "/srv/work/journal", JUNO_WORK_DIR: "/srv/work" }],
    [{ JUNO_JOURNAL_DIR: "/srv/journal", JUNO_WORK_DIR: "/srv/journal" }],
  ])("rejects journal storage overlapping the capability namespace or the work volume: %j", async (env) => {
    const said: string[] = [];
    expect(await runRunnerMain({ ...ANCHORING, ...env }, { host: ordinaryHost(), anchoring: testAnchoring(), out: (text) => said.push(text), err: (text) => said.push(text) })).toBe(1);
    expect(said.join("")).toMatch(/capability namespace|overlaps the workspace/);
    expect(existsSync(join(env.JUNO_JOURNAL_DIR, "tasks"))).toBe(false);
  });
});
