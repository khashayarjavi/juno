import { describe, expect, it } from "vitest";
import { BoundaryError } from "../../contracts/src/index.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ordinaryHost } from "../../enforcement/test/layer.js";
import { parseRunnerConfig } from "../src/config.js";
import { runRunnerMain } from "../src/runner-main.js";

describe("parseRunnerConfig", () => {
  // proves build plan Increment 0: the runner parses its environment at the boundary
  it("parses a complete environment", () => {
    expect(parseRunnerConfig({ JUNO_JOURNAL_DIR: "/journal", JUNO_WORK_DIR: "/work", OTHER: "x" })).toEqual({
      journalDir: "/journal",
      workDir: "/work",
      trustAnchor: null,
    });
  });

  // proves §3.2 C1 (D-125): the trust anchor's path is read when given, and must be absolute
  it("reads the trust anchor's path", () => {
    expect(parseRunnerConfig({ JUNO_JOURNAL_DIR: "/journal", JUNO_WORK_DIR: "/work", JUNO_TRUST_ANCHOR: "/etc/juno/operator.pub" }).trustAnchor).toBe("/etc/juno/operator.pub");
    expect(() => parseRunnerConfig({ JUNO_JOURNAL_DIR: "/journal", JUNO_WORK_DIR: "/work", JUNO_TRUST_ANCHOR: "operator.pub" })).toThrow();
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
    expect(() => parseRunnerConfig(env)).toThrow(BoundaryError);
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
  ])("rejects journal storage overlapping the capability namespace or the work volume: %j", (env) => {
    const said: string[] = [];
    expect(runRunnerMain(env, { host: ordinaryHost(), out: (text) => said.push(text), err: (text) => said.push(text) })).toBe(1);
    expect(said.join("")).toMatch(/capability namespace|overlaps the workspace/);
    expect(existsSync(join(env.JUNO_JOURNAL_DIR, "tasks"))).toBe(false);
  });
});
