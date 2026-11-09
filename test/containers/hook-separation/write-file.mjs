// Container-test helper (plan Increment 6): run through as-user.mjs, writes <path> with <text>, mode 0600, as that
// user; the operator writes their session and grant files as the runner. No shell.
import { writeFileSync } from "node:fs";
import process from "node:process";

const [path, text] = process.argv.slice(2);
writeFileSync(path, text, { mode: 0o600 });
