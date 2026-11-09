// Test-only stand-in for git in the anchor path (D-198), for containers whose image has no git (D-001: nothing is
// downloaded into an image). JUNO's GitAnchorSink runs `git -C <clone> -c ... -c ... <command> ...`. Here `pull`, `add`
// and `commit` succeed and do nothing; `push` copies every anchor file in the clone to the stand-in destination
// (`<clone>.remote`), append-only: an anchor already there with other content fails the push, as the protected
// `juno-anchors` repository refuses a rewrite. It protects nothing; the real destination is the operator's repository.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
let clone = null;
const rest = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "-C") clone = args[(index += 1)];
  else if (args[index] === "-c") index += 1;
  else rest.push(args[index]);
}
const command = rest[0];
if (clone === null || !["pull", "add", "commit", "push"].includes(command)) {
  process.stderr.write(`fake git: unsupported ${JSON.stringify(args)}\n`);
  process.exit(2);
}
if (command === "push" && existsSync(clone)) {
  const remote = `${clone}.remote`;
  for (const task of readdirSync(clone)) {
    if (!/^[0-9a-f]{64}$/.test(task)) continue;
    mkdirSync(join(remote, task), { recursive: true, mode: 0o755 });
    for (const file of readdirSync(join(clone, task))) {
      const from = join(clone, task, file);
      const to = join(remote, task, file);
      if (existsSync(to)) {
        if (readFileSync(to, "utf8") !== readFileSync(from, "utf8")) {
          process.stderr.write(`fake git: the destination refuses to rewrite ${task}/${file}\n`);
          process.exit(1);
        }
        continue;
      }
      copyFileSync(from, to);
    }
  }
}
process.exit(0);
