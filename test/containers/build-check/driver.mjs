// The build-check test's driver (D-244), as the runner image's own user in a sealed container (no network, no
// capability). It runs `juno-build-check` on the image's real build (/app, made by `make build` and `make stage`), then
// on copies of it cut as an upgrade cuts one: the manifest not written yet, a module gone, a file cut short. Prints one
// JSON object. No shell.
import { execFile } from "node:child_process";
import { cpSync, rmSync, truncateSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const check = (root) => new Promise((resolve) => {
  const program = join(root, "dist", "runner", "src", "juno-build-check.js");
  execFile("/usr/local/bin/node", [program], { timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : -1, stdout, stderr }));
});
const copy = (name) => {
  const root = `/tmp/${name}`;
  cpSync("/app", root, { recursive: true });
  return root;
};
const results = { real: await check("/app") };
const unfinished = copy("unfinished");
rmSync(`${unfinished}/dist/build-manifest.json`);
results.unfinished = await check(unfinished);
const removed = copy("removed");
rmSync(`${removed}/dist/enforcement/src/session-layer.js`);
rmSync(`${removed}/node_modules/zod/package.json`);
results.removed = await check(removed);
const cut = copy("cut");
truncateSync(`${cut}/dist/mediated/src/hook-serve.js`, 10);
results.cut = await check(cut);
process.stdout.write(`${JSON.stringify(results)}\n`);
