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
});
