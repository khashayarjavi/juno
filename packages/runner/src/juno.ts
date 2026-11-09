import { runGrantCli } from "./grant-cli.js";
import { runJournalCli } from "./journal-cli.js";
import { runHookInstallCli } from "../../mediated/src/install.js";
import { probeContainerRuntime, runtimeRefusal } from "../../enforcement/src/index.js";
import { runCheckpointCli } from "./restore.js";
import { runGatewayCli, systemGatewayCliIo } from "../../mediated/src/gateway-cli.js";
import { loadTrustAnchor } from "./trust.js";

/**
 * The `juno` command (DECISIONS.md D-117): `node dist/runner/src/juno.js <command> ...`. Slice 1.5 Increment 2 adds
 * `grant sign` and `grant verify` (D-117) and `journal check` (D-122); Increment 3 adds `checkpoint restore` (D-138); Slice 1.5 Increment 5 adds `gateway serve` (D-191).
 */
const [command, ...args] = process.argv.slice(2);
if (command === "grant") process.exitCode = await runGrantCli(args);
else if (command === "journal") process.exitCode = runJournalCli(args);
else if (command === "checkpoint") process.exitCode = await runCheckpointCli(args);
else if (command === "runtime" && args[0] === "check") {
  // D-149: the operator's check (STATE.md Part E) that the container runtime enforces the workload's limits.
  const runtime = await probeContainerRuntime();
  const refusal = runtimeRefusal(runtime);
  process.stdout.write(`${JSON.stringify({ ...runtime, enforces_limits: refusal === null, ...(refusal === null ? {} : { refusal }) }, null, 2)}\n`);
  process.exitCode = refusal === null ? 0 : 1;
} else if (command === "hook") process.exitCode = await runHookInstallCli(args, (text) => process.stdout.write(text), (text) => process.stderr.write(text));
// Slice 1.5 Increment 5 (D-191): the MCP gateway, served by the runner on its socket.
else if (command === "gateway") process.exitCode = await runGatewayCli(args, systemGatewayCliIo(loadTrustAnchor));
else {
  process.stderr.write("usage: juno grant sign|verify ... | juno journal check ... | juno checkpoint restore ... | juno hook install ... | juno hook check ... | juno gateway serve ... | juno runtime check\n");
  process.exitCode = 2;
}
