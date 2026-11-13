#!/usr/bin/env node
import { main } from "./anchor-ssh.js";

// The `juno-anchor-ssh` executable entry point: git's GIT_SSH for the pinned anchor repository (D-208).
process.exitCode = await main(process.argv.slice(2), process.env, (text) => process.stderr.write(text));
