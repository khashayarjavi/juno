// Container-test helper (D-221): run through as-user.mjs, with <umask> (octal) and a JSON list of file operations,
// performed in order as that user; prints one JSON line of each operation's outcome. No shell.
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";

const [mask, json] = process.argv.slice(2);
process.umask(parseInt(mask, 8));
const outcomes = [];
for (const step of JSON.parse(json)) {
  try {
    if (step.op === "mkdir") mkdirSync(step.path, { recursive: true });
    else if (step.op === "write") writeFileSync(step.path, step.text);
    else if (step.op === "chmod") chmodSync(step.path, parseInt(step.mode, 8));
    else if (step.op === "rm") rmSync(step.path, { recursive: true });
    else throw new Error(`unknown operation ${String(step.op)}`);
    outcomes.push({ done: true });
  } catch (error) {
    outcomes.push({ done: false, code: error.code ?? String(error) });
  }
}
process.stdout.write(`${JSON.stringify(outcomes)}\n`);
