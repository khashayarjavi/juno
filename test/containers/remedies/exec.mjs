// Container-test helper (D-247): run through as-user.mjs, runs one command given as an argument vector (the remedy a
// refusal gives, exactly as the operator would type it), and relays its output and exit code. No shell.
import { execFile } from "node:child_process";
import process from "node:process";

const [program, ...args] = process.argv.slice(2);
execFile(program, args, { maxBuffer: 16 * 1024 * 1024, timeout: 90_000 }, (error, stdout, stderr) => {
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : 127;
});
