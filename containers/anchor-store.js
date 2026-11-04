// The append-only anchor store (spec §3.4.1, v0.6.1 V6-4; DECISIONS.md D-122): the test stand-in for the off-host
// destination. It runs as this image's fixed entrypoint, in its own container, over its own volume (/anchors), with no
// network. It offers two operations and nothing else:
//
//   append <task digest> <seq, 12 digits> <anchor JSON>   creates <task>/<seq>.json; refused if it already exists
//   list <task digest>                                    prints a JSON array of the task's anchors, in seq order
//
// There is no overwrite and no delete: a file is created exclusively and never opened for writing again.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = "/anchors";
const TASK = /^[0-9a-f]{64}$/;
const SEQ = /^[0-9]{12}$/;
const MAX_ANCHOR_BYTES = 4096;

function refuse(code, message) {
  process.stderr.write(`refused: ${message}\n`);
  process.exit(code);
}

const [operation, task, seq, text, ...rest] = process.argv.slice(2);
if (typeof task !== "string" || !TASK.test(task)) refuse(2, "the task digest is not 64 lowercase hex digits");

if (operation === "append") {
  if (typeof seq !== "string" || !SEQ.test(seq) || typeof text !== "string" || rest.length > 0) refuse(2, "usage: append <task> <seq> <anchor>");
  if (Buffer.byteLength(text, "utf8") > MAX_ANCHOR_BYTES) refuse(2, "the anchor is too large");
  try {
    JSON.parse(text);
  } catch {
    refuse(2, "the anchor is not JSON");
  }
  const dir = path.join(ROOT, task);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = fs.openSync(path.join(dir, `${seq}.json`), "wx", 0o400);
  } catch (error) {
    if (error && error.code === "EEXIST") refuse(3, "an anchor at this seq already exists; anchors are never replaced");
    throw error;
  }
  fs.writeSync(fd, text);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  process.stdout.write("appended\n");
} else if (operation === "list") {
  if (seq !== undefined) refuse(2, "usage: list <task>");
  const dir = path.join(ROOT, task);
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => /^[0-9]{12}\.json$/.test(name)).sort() : [];
  process.stdout.write(JSON.stringify(names.map((name) => fs.readFileSync(path.join(dir, name), "utf8"))));
} else {
  refuse(2, `unknown operation ${JSON.stringify(operation)}; only append and list exist`);
}
