import { main } from "./hook-client.js";

// The `juno-hook` executable entry point (D-142): any failure that escapes `main` is a block too.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`JUNO blocked this call: juno-hook failed (${error instanceof Error ? error.message : String(error)})\n`);
    process.exitCode = 2;
  },
);
