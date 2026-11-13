import { z } from "zod";
import { AbsolutePath, parseAtBoundary } from "../../contracts/src/index.js";

const RunnerEnv = z.object({
  JUNO_JOURNAL_DIR: AbsolutePath,
  JUNO_WORK_DIR: AbsolutePath,
  /** The operator's public key (§3.2 C1, D-116, D-125). Without it no grant can be honoured. */
  JUNO_TRUST_ANCHOR: AbsolutePath.optional(),
  /** §3.4.1 (D-198): the runner's journal key folder and its clone of `juno-anchors`; every service anchors its journal. */
  JUNO_JOURNAL_KEY_DIR: AbsolutePath,
  JUNO_ANCHOR_CLONE: AbsolutePath,
  /** Seconds between anchors, 1 to 3600; one minute when absent (D-198). */
  /** The git program that pushes anchors (absolute; `/usr/bin/git` when absent). */
  JUNO_GIT: AbsolutePath.optional(),
  /** The anchor pin (D-208): the root-owned file naming the anchor repository; `/etc/juno/anchors.json` when absent. */
  JUNO_ANCHOR_PIN: AbsolutePath.optional(),
  JUNO_ANCHOR_INTERVAL_SECONDS: z.string().regex(/^[1-9][0-9]{0,3}$/).refine((text) => Number(text) <= 3600, "at most 3600 seconds").optional(),
});
// §3.4.1: that journal storage lies outside the capability namespace and apart from the work volume (D-026) is judged by
// the shared start-up check (startup.ts), as the kernel resolves both, not here (D-194).
export type RunnerConfig = {
  readonly journalDir: AbsolutePath;
  readonly workDir: AbsolutePath;
  readonly trustAnchor: AbsolutePath | null;
  readonly anchoring: { readonly journalKeyDir: AbsolutePath; readonly anchorClone: AbsolutePath; readonly intervalMs: number; readonly git: AbsolutePath; readonly pin: AbsolutePath };
};

/** The process environment is a boundary: parse it before anything uses it. */
export function parseRunnerConfig(env: unknown): RunnerConfig {
  const parsed = parseAtBoundary("runner environment", RunnerEnv, env);
  return {
    journalDir: parsed.JUNO_JOURNAL_DIR,
    workDir: parsed.JUNO_WORK_DIR,
    trustAnchor: parsed.JUNO_TRUST_ANCHOR ?? null,
    anchoring: { journalKeyDir: parsed.JUNO_JOURNAL_KEY_DIR, anchorClone: parsed.JUNO_ANCHOR_CLONE, intervalMs: parsed.JUNO_ANCHOR_INTERVAL_SECONDS === undefined ? 60_000 : Number(parsed.JUNO_ANCHOR_INTERVAL_SECONDS) * 1000, git: parsed.JUNO_GIT ?? AbsolutePath.parse("/usr/bin/git"), pin: parsed.JUNO_ANCHOR_PIN ?? AbsolutePath.parse("/etc/juno/anchors.json") },
  };
}
