import { runGrantCli } from "./grant-cli.js";

/**
 * The `juno` command (DECISIONS.md D-117): `node dist/runner/src/juno.js <command> ...`. Slice 1.5 Increment 2 adds
 * `grant sign` and `grant verify`; `journal check` follows with the anchored head.
 */
const [command, ...args] = process.argv.slice(2);
if (command === "grant") process.exitCode = runGrantCli(args);
else {
  process.stderr.write("usage: juno grant sign|verify ...\n");
  process.exitCode = 2;
}
