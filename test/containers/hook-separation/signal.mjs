// Container-test helper (D-198): sends SIGTERM to <pid>, as whatever user runs it (the runner stops its own service;
// root in the test holds no CAP_KILL).
import process from "node:process";

process.kill(Number(process.argv[2]), "SIGTERM");
