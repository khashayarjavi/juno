import { z } from "zod";
import { AbsolutePath, WORK_NAMESPACE, parseAtBoundary, pathsOverlap } from "../../contracts/src/index.js";

const RunnerEnv = z
  .object({
    JUNO_JOURNAL_DIR: AbsolutePath,
    JUNO_WORK_DIR: AbsolutePath,
  })
  .superRefine((env, ctx) => {
    // §3.4.1: journal storage lies outside the capability namespace and apart from the work volume,
    // so no path selector can name it (DECISIONS.md D-026).
    if (pathsOverlap(env.JUNO_JOURNAL_DIR, WORK_NAMESPACE)) {
      ctx.addIssue({
        code: "custom",
        path: ["JUNO_JOURNAL_DIR"],
        message: `must lie outside the capability namespace ${WORK_NAMESPACE} (spec §3.4.1)`,
      });
    }
    if (pathsOverlap(env.JUNO_JOURNAL_DIR, env.JUNO_WORK_DIR)) {
      ctx.addIssue({
        code: "custom",
        path: ["JUNO_JOURNAL_DIR"],
        message: "must not contain, or lie inside, JUNO_WORK_DIR (spec §3.4.1)",
      });
    }
  });

export type RunnerConfig = {
  readonly journalDir: AbsolutePath;
  readonly workDir: AbsolutePath;
};

/** The process environment is a boundary: parse it before anything uses it. */
export function parseRunnerConfig(env: unknown): RunnerConfig {
  const parsed = parseAtBoundary("runner environment", RunnerEnv, env);
  return { journalDir: parsed.JUNO_JOURNAL_DIR, workDir: parsed.JUNO_WORK_DIR };
}
