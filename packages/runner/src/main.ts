import { parseRunnerConfig } from "./config.js";

// Increment 0: the runner only proves it starts, parses its boundary input,
// and exits cleanly. Admission and the turn loop arrive in Increment 5.
try {
  const config = parseRunnerConfig(process.env);
  process.stdout.write(`juno-runner: ready (journal=${config.journalDir}, work=${config.workDir})\n`);
} catch (error: unknown) {
  process.stderr.write(`juno-runner: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
