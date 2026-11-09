import { systemHostIo } from "../../enforcement/src/index.js";
import { runRunnerMain } from "./runner-main.js";

// The runner process (entry point `runner.process` in entry-points.ts, D-194): the shared start-up check, then ready.
process.exitCode = runRunnerMain(process.env, { host: systemHostIo(), out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) });
