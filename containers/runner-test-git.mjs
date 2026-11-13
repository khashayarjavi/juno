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
//   - `init --template= <dir>` writes the configuration the real git writes, which JUNO compares before every command
//     in that repository (D-213);
//   - a commit's id here is a digest of the anchor files held, so the repository and the destination name the same id
//     exactly when they hold the same anchors: JUNO's read-back (`ls-remote` with no repository, then `rev-parse`,
//     `cat-file` and `ls-tree` in the clone; D-213) is answered from the files really held.
// It is root's own file in the runner image (/opt/juno-test/git), where the image's test pin names it (D-211, D-213).
// It protects nothing; the real destination is the operator's repository.
import { createHash } from "node:crypto";
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
const tasks = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => /^[0-9a-f]{64}$/.test(name)).sort() : []);
/** Every anchor file a folder holds, as `task/file`, sorted. */
const anchors = (dir) => tasks(dir).flatMap((task) => readdirSync(join(dir, task)).filter((file) => /^[0-9]{12}\.json$/.test(file)).sort().map((file) => `${task}/${file}`));
/** The id of the "commit" a folder is at: a digest of every anchor it holds. */
const commitOf = (dir) => {
  const hash = createHash("sha1");
  for (const path of anchors(dir)) hash.update(`${path}\0`).update(readFileSync(join(dir, path))).update("\0");
  return hash.digest("hex");
};
/** The id git gives a file's bytes. */
const blobOf = (bytes) => createHash("sha1").update(`blob ${String(bytes.length)}\0`).update(bytes).digest("hex");
/** Copies every anchor file from one folder to another; an anchor already there with other content is refused. */
const copyAnchors = (from, to) => {
  for (const path of anchors(from)) {
    const source = join(from, path);
    const target = join(to, path);
    mkdirSync(join(to, path.slice(0, 64)), { recursive: true, mode: 0o755 });
    if (existsSync(target)) {
      if (readFileSync(target, "utf8") !== readFileSync(source, "utf8")) fail(`the destination refuses to rewrite ${path}`, 1);
      continue;
    }
    copyFileSync(source, target);
  }
};
/** What a destination's pinned branch is at: nothing until it holds an anchor. A local clone (it has a .git folder) is reported as holding no commit. */
const lsRemote = () => {
  const target = address();
  if (!existsSync(join(target, ".git")) && anchors(target).length > 0) process.stdout.write(`${commitOf(target)}\trefs/heads/main\n`);
};

if (command === "init") {
  const dir = rest.at(-1);
  mkdirSync(join(dir, ".git"), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n");
  process.exit(0);
}
if (repo === null) {
  // With no repository, only the question JUNO asks of the pinned address itself.
  if (command !== "ls-remote") fail(`unsupported ${JSON.stringify(args)}`);
  lsRemote();
  process.exit(0);
}
const remembered = join(repo, ".git", "juno-remote");
const committed = join(repo, ".git", "juno-committed");
switch (command) {
  case "ls-remote":
    lsRemote();
    break;
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
    if (rest.some((part) => part.startsWith("refs/juno/remote"))) process.stdout.write(`${commitOf(readFileSync(remembered, "utf8"))}\n`);
    else if (!existsSync(committed)) process.exit(1);
    else process.stdout.write(`${commitOf(repo)}\n`);
    break;
  case "cat-file": {
    // `cat-file blob <commit>:<path>`: the file as the repository holds it.
    const path = rest.at(-1).slice(rest.at(-1).indexOf(":") + 1);
    if (!existsSync(join(repo, path))) fail(`no such file ${path}`, 128);
    process.stdout.write(readFileSync(join(repo, path)));
    break;
  }
  case "ls-tree":
    for (const path of anchors(repo)) process.stdout.write(`100644 blob ${blobOf(readFileSync(join(repo, path)))}\t${path}\n`);
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
