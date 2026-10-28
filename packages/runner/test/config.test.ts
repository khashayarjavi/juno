import { describe, expect, it } from "vitest";
import { BoundaryError } from "../../contracts/src/index.js";
import { parseRunnerConfig } from "../src/config.js";

describe("parseRunnerConfig", () => {
  // proves build plan Increment 0: the runner parses its environment at the boundary
  it("parses a complete environment", () => {
    expect(parseRunnerConfig({ JUNO_JOURNAL_DIR: "/journal", JUNO_WORK_DIR: "/work", OTHER: "x" })).toEqual({
      journalDir: "/journal",
      workDir: "/work",
    });
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

  // proves §3.4.1: the runner refuses to start with journal storage anywhere a selector could name
  it.each([
    [{ JUNO_JOURNAL_DIR: "/work", JUNO_WORK_DIR: "/data" }],
    [{ JUNO_JOURNAL_DIR: "/work/journal", JUNO_WORK_DIR: "/work" }],
    [{ JUNO_JOURNAL_DIR: "/", JUNO_WORK_DIR: "/work" }],
    [{ JUNO_JOURNAL_DIR: "/srv", JUNO_WORK_DIR: "/srv/work" }],
    [{ JUNO_JOURNAL_DIR: "/srv/work/journal", JUNO_WORK_DIR: "/srv/work" }],
    [{ JUNO_JOURNAL_DIR: "/srv/journal", JUNO_WORK_DIR: "/srv/journal" }],
  ])("rejects journal storage overlapping the capability namespace or the work volume: %j", (env) => {
    expect(() => parseRunnerConfig(env)).toThrow(BoundaryError);
  });
});
