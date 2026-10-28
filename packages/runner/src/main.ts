import { JournalWriter } from "../../journal/src/index.js";
import { parseRunnerConfig } from "./config.js";

// Increment 2: the runner parses its boundary input, opens the journal on the
// journal volume (creating its layout on first start), and exits cleanly.
// Admission and the turn loop arrive in Increment 5.
try {
  const config = parseRunnerConfig(process.env);
  const journal = JournalWriter.open(config.journalDir);
  process.stdout.write(`juno-runner: ready (journal=${journal.root}, work=${config.workDir})\n`);
} catch (error: unknown) {
  process.stderr.write(`juno-runner: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
