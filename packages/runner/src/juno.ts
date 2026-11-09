import { dispatch } from "./entry-points.js";

/**
 * The `juno` command (DECISIONS.md D-117, D-194): `node dist/runner/src/juno.js <command> ...`. It runs only the commands
 * in the entry-point registry (entry-points.ts), which the entry-point test enumerates.
 */
process.exitCode = await dispatch(process.argv.slice(2));
