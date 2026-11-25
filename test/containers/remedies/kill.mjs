// Container-test helper (D-247): SIGKILL to <pid>, as the user that runs it (the runner kills its own service, as WSL's
// teardown does: no stop, the lock and the sockets are left). No shell.
import process from "node:process";

process.kill(Number(process.argv[2]), "SIGKILL");
