#!/usr/local/bin/node
// Test-only stand-in for git in the anchor path (D-198, D-208), for containers whose image has no git (D-001: nothing
// is downloaded into an image). JUNO's GitAnchorSink runs `git init <dir>` and `git -C <repo> -c ... <command> ...`,
// always naming the pinned address itself (D-208). Here the pinned address is a folder standing for the destination:
//   - `ls-remote -- <address> <ref>` says whether the destination holds anything (and that a local clone holds no
//     commit, so this stand-in never compares a clone: the real git does, in packages/journal/test/git-sink.test.ts);
//   - `fetch`, then `reset`, and `pull`, copy every anchor file the destination holds into the repository;
//   - `add` and `commit` succeed (a commit is remembered, so there is something to push);
//   - `push -- <address> ...` copies every anchor file in the repository to the destination, append-only: an anchor
//     already there with other content fails the push, as the protected `juno-anchors` repository refuses a rewrite;
//   - `log` (the history check, D-204) prints nothing: this stand-in keeps no history and never removes an anchor.
// It protects nothing; the real destination is the operator's repository.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
let repo = null;
const rest = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "-C") repo = args[(index += 1)];
  else if (args[index] === "-c") index += 1;
  else rest.push(args[index]);
}
const command = rest[0];
const fail = (text, code = 2) => {
  process.stderr.write(`fake git: ${text}\n`);
  process.exit(code);
};
/** The first argument after `--`: the address a command names. */
const address = () => {
  const at = rest.indexOf("--");
  return at < 0 ? undefined : rest[at + 1];
};
const tasks = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => /^[0-9a-f]{64}$/.test(name)) : []);
/** Copies every anchor file from one folder to another; an anchor already there with other content is refused. */
const copyAnchors = (from, to) => {
  for (const task of tasks(from)) {
    mkdirSync(join(to, task), { recursive: true, mode: 0o755 });
    for (const file of readdirSync(join(from, task))) {
      const source = join(from, task, file);
      const target = join(to, task, file);
      if (existsSync(target)) {
        if (readFileSync(target, "utf8") !== readFileSync(source, "utf8")) fail(`the destination refuses to rewrite ${task}/${file}`, 1);
        continue;
      }
      copyFileSync(source, target);
    }
  }
};
const SHA = "1".repeat(40);

if (command === "init") {
  const dir = rest.at(-1);
  mkdirSync(join(dir, ".git"), { recursive: true, mode: 0o700 });
  process.exit(0);
}
if (repo === null) fail(`unsupported ${JSON.stringify(args)}`);
const remembered = join(repo, ".git", "juno-remote");
const committed = join(repo, ".git", "juno-committed");
switch (command) {
  case "ls-remote": {
    const target = address();
    // A local clone (it has a .git folder) is reported as holding no commit; the destination as holding the pinned
    // branch once any anchor is there.
    if (!existsSync(join(target, ".git")) && tasks(target).length > 0) process.stdout.write(`${SHA}\trefs/heads/main\n`);
    break;
  }
  case "fetch":
    writeFileSync(remembered, address());
    break;
  case "reset":
    copyAnchors(readFileSync(remembered, "utf8"), repo);
    writeFileSync(committed, "");
    break;
  case "pull":
    copyAnchors(address(), repo);
    writeFileSync(committed, "");
    break;
  case "rev-parse":
    if (rest.some((part) => part.startsWith("HEAD")) && !existsSync(committed)) process.exit(1);
    process.stdout.write(`${SHA}\n`);
    break;
  case "add":
  case "log":
    break;
  case "commit":
    writeFileSync(committed, "");
    break;
  case "push":
    mkdirSync(address(), { recursive: true, mode: 0o755 });
    copyAnchors(repo, address());
    break;
  default:
    fail(`unsupported ${JSON.stringify(args)}`);
}
process.exit(0);
