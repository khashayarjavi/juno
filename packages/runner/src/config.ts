import { z } from "zod";
import { AbsolutePath, parseAtBoundary } from "../../contracts/src/index.js";

const RunnerEnv = z.object({
  JUNO_JOURNAL_DIR: AbsolutePath,
  JUNO_WORK_DIR: AbsolutePath,
  /** The operator's public key (§3.2 C1, D-116, D-125). Without it no grant can be honoured. */
  JUNO_TRUST_ANCHOR: AbsolutePath.optional(),
});
// §3.4.1: that journal storage lies outside the capability namespace and apart from the work volume (D-026) is judged by
// the shared start-up check (startup.ts), as the kernel resolves both, not here (D-194).
export type RunnerConfig = {
  readonly journalDir: AbsolutePath;
  readonly workDir: AbsolutePath;
  readonly trustAnchor: AbsolutePath | null;
};

/** The process environment is a boundary: parse it before anything uses it. */
export function parseRunnerConfig(env: unknown): RunnerConfig {
  const parsed = parseAtBoundary("runner environment", RunnerEnv, env);
  return { journalDir: parsed.JUNO_JOURNAL_DIR, workDir: parsed.JUNO_WORK_DIR, trustAnchor: parsed.JUNO_TRUST_ANCHOR ?? null };
}
