import { z } from "zod";
import { parseAtBoundary } from "../../contracts/src/index.js";

const RunnerEnv = z.object({
  JUNO_JOURNAL_DIR: z.string().min(1),
  JUNO_WORK_DIR: z.string().min(1),
});

export type RunnerConfig = {
  readonly journalDir: string;
  readonly workDir: string;
};

/** The process environment is a boundary: parse it before anything uses it. */
export function parseRunnerConfig(env: unknown): RunnerConfig {
  const parsed = parseAtBoundary("runner environment", RunnerEnv, env);
  return { journalDir: parsed.JUNO_JOURNAL_DIR, workDir: parsed.JUNO_WORK_DIR };
}
