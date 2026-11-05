import { runGrantCli } from "./grant-cli.js";
import { runJournalCli } from "./journal-cli.js";
import { runCheckpointCli } from "./restore.js";

/**
 * The `juno` command (DECISIONS.md D-117): `node dist/runner/src/juno.js <command> ...`. Slice 1.5 Increment 2 adds
 * `grant sign` and `grant verify` (D-117) and `journal check` (D-122); Increment 3 adds `checkpoint restore` (D-138).
 */
const [command, ...args] = process.argv.slice(2);
if (command === "grant") process.exitCode = await runGrantCli(args);
else if (command === "journal") process.exitCode = runJournalCli(args);
else if (command === "checkpoint") process.exitCode = await runCheckpointCli(args);
else {
  process.stderr.write("usage: juno grant sign|verify ... | juno journal check ... | juno checkpoint restore ...\n");
  process.exitCode = 2;
}
