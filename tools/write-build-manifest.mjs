// `make build`'s last step (DECISIONS.md D-244): writes dist/build-manifest.json for the build in the current folder,
// with the very code `juno-build-check` reads it with. No shell.
import process from "node:process";
import { writeBuildManifest } from "../dist/runner/src/build-check.js";

const count = writeBuildManifest(process.cwd());
process.stdout.write(`build manifest: ${String(count)} files\n`);
