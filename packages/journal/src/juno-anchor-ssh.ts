#!/usr/bin/env node
import { main } from "./anchor-ssh.js";

// The `juno-anchor-ssh` executable entry point: git's GIT_SSH for the pinned anchor repository (D-208).
// It exits as soon as ssh has: git's input may still be open, and must not keep this process waiting (D-208).
process.exit(await main(process.argv.slice(2), process.env, (text) => process.stderr.write(text)));
