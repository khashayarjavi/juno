import { JournalWriter } from "../../journal/src/index.js";
import { parseRunnerConfig } from "./config.js";
import { loadTrustAnchor } from "./trust.js";

// The runner's start-up: it parses its boundary input, loads the trust anchor (§3.2 C1, D-116, D-125) and refuses to
// start when it could write the anchor or its directory, then opens the journal on the journal volume (creating its
// layout on first start), and exits cleanly. Without a configured anchor it holds no key to check grants against, so
// no grant can exist for it; it says so. Admission and the turn loop run through the `Runner` class (D-065).
try {
  const config = parseRunnerConfig(process.env);
  const anchor = config.trustAnchor === null ? null : loadTrustAnchor(config.trustAnchor);
  const journal = JournalWriter.open(config.journalDir);
  const trust = anchor === null ? "trust anchor: none, so no grant can be honoured" : `trust anchor: ${String(config.trustAnchor)}`;
  process.stdout.write(`juno-runner: ready (journal=${journal.root}, work=${config.workDir}, ${trust})\n`);
} catch (error: unknown) {
  process.stderr.write(`juno-runner: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
