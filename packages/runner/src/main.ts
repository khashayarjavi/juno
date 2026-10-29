import { JournalWriter } from "../../journal/src/index.js";
import { parseRunnerConfig } from "./config.js";
import { acquireRunnerLock } from "./lock.js";

// The runner container's entrypoint. It parses its boundary input, opens the
// journal on the journal volume (creating its layout on first start), and
// takes the journal volume's runner lock: a second runner on the same volume
// refuses to start (DECISIONS.md D-025, D-064). It then reports ready and
// exits. How the containerised runner reaches Docker to run tasks is the open
// operator decision D-065.
try {
  const config = parseRunnerConfig(process.env);
  const journal = JournalWriter.open(config.journalDir);
  const lock = await acquireRunnerLock(journal.root);
  process.stdout.write(`juno-runner: ready (journal=${journal.root}, work=${config.workDir})\n`);
  await lock.release();
} catch (error: unknown) {
  process.stderr.write(`juno-runner: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
