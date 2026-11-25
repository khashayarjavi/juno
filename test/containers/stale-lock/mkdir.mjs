// Container-test helper (D-243): makes <path>, mode 0700, as whatever user runs it. No shell.
import { mkdirSync } from "node:fs";
import process from "node:process";

mkdirSync(process.argv[2], { recursive: true, mode: 0o700 });
