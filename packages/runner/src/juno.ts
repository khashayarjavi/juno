import { runGrantCli } from "./grant-cli.js";
import { runJournalCli } from "./journal-cli.js";

/**
 * The `juno` command (DECISIONS.md D-117): `node dist/runner/src/juno.js <command> ...`. Slice 1.5 Increment 2 adds
 * `grant sign` and `grant verify` (D-117) and `journal check` (D-122).
 */
const [command, ...args] = process.argv.slice(2);
if (command === "grant") process.exitCode = await runGrantCli(args);
else if (command === "journal") process.exitCode = runJournalCli(args);
else {
  process.stderr.write("usage: juno grant sign|verify ... | juno journal check ...\n");
  process.exitCode = 2;
}
