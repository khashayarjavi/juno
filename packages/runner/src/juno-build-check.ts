import { main } from "./build-check.js";

// The `juno-build-check` program (D-244): the hook service's unit runs it before JUNO itself. Node's own modules only.
process.exitCode = main();
