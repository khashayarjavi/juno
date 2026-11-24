// Container-test helper (D-243): sends SIGKILL to <pid>, as whatever user runs it. The runner kills its own service the
// way WSL's teardown does: no stop, no clean-up, the journal's lock left behind. No shell.
import process from "node:process";

process.kill(Number(process.argv[2]), "SIGKILL");
