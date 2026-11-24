// Container-test helper (D-243): removes <path>, as whatever user runs it: the remedy a refusal names. No shell.
import { rmSync } from "node:fs";
import process from "node:process";

rmSync(process.argv[2]);
