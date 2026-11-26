import { probeContainerRuntime, runtimeRefusal, type ServiceName, systemHostIo } from "../../enforcement/src/index.js";
import { McpGateway } from "../../mediated/src/gateway.js";
import { runGatewayCli, systemGatewayCliIo } from "../../mediated/src/gateway-cli.js";
import { GatewayService } from "../../mediated/src/gateway-service.js";
import { HookService } from "../../mediated/src/hook-service.js";
import { HookAdmissionService } from "../../mediated/src/hook-admission.js";
import { runHookAdmitCli, runHookServeCli, systemHookServeIo } from "../../mediated/src/hook-serve.js";
import { runHookInstallCli } from "../../mediated/src/install.js";
import { MediatedSessions } from "../../mediated/src/session.js";
import { runGrantCli } from "./grant-cli.js";
import { runJournalCli } from "./journal-cli.js";
import { runCheckpointCli } from "./restore.js";
import { runRunnerMain } from "./runner-main.js";
import { Runner } from "./runner.js";

/**
 * THE registry of JUNO's entry points (operator ruling D-193; DECISIONS.md D-194): every `juno` command, every program
 * of its own, and every class other code constructs to start a service or admit a session. The `juno` command dispatches
 * only from it (juno.ts), and the entry-point test (test/evidence/entry-points.test.ts) enumerates it: every entry that
 * starts a service must refuse whatever the shared start-up check refuses, and every entry that admits a session must
 * admit it, pass its calls and journal through the shared session layer. The test also reads the source tree and fails
 * on any entry point, journal writer, service or session class this registry does not list.
 *
 * Adding a service or a session mode means adding it here; there is no other way in.
 */

export type EntryPoint = {
  /** A stable name, used by the test. */
  readonly id: string;
  /** `command`: a `juno` subcommand; `program`: an executable file of its own; `class`: constructed by other code. */
  readonly kind: "command" | "program" | "class";
  /** The repo-relative source file that defines it (for a program: its implementation). */
  readonly module: string;
  /** For a program: the executable file itself, which only calls the implementation. */
  readonly program?: string;
  /** For a command, its words (`["gateway", "serve"]`); for a program or class, its exported name. */
  readonly name: string | readonly string[];
  /** The service it starts or belongs to; null for one that starts none. */
  readonly service: ServiceName | null;
  /** Whether it admits sessions (and so passes their calls). */
  readonly admits: boolean;
  /** For an entry that starts no service: why, in plain words. */
  readonly why?: string;
  /** Whether it writes the journal other than through a session layer (an operator action recorded in it), and why. */
  readonly operatorJournalWrite?: string;
  /** What implements it: the function a command or program runs, or the class. */
  readonly implementation: unknown;
  /** For a command: how the `juno` command runs it with the real process's input and output. */
  readonly run?: (args: readonly string[]) => Promise<number>;
};

const out = (text: string): void => {
  process.stdout.write(text);
};
const err = (text: string): void => {
  process.stderr.write(text);
};

async function runtimeCheck(args: readonly string[]): Promise<number> {
  if (args[0] !== "check") {
    err(USAGE);
    return 2;
  }
  // D-149: the operator's check (STATE.md Part E) that the container runtime enforces the workload's limits.
  const runtime = await probeContainerRuntime();
  const refusal = runtimeRefusal(runtime);
  out(`${JSON.stringify({ ...runtime, enforces_limits: refusal === null, ...(refusal === null ? {} : { refusal }) }, null, 2)}\n`);
  return refusal === null ? 0 : 1;
}

export const ENTRY_POINTS: readonly EntryPoint[] = [
  // `juno` commands.
  { id: "grant", kind: "command", module: "packages/runner/src/grant-cli.ts", name: ["grant"], service: null, admits: false, why: "signs or verifies a grant file; opens no journal, serves nothing, admits no session", implementation: runGrantCli, run: (args) => runGrantCli(args) },
  { id: "journal", kind: "command", module: "packages/runner/src/journal-cli.ts", name: ["journal"], service: null, admits: false, why: "reads and verifies a journal, and summarises a verified one (report); writes nothing", implementation: runJournalCli, run: (args) => runJournalCli(args) },
  {
    id: "checkpoint",
    kind: "command",
    module: "packages/runner/src/restore.ts",
    name: ["checkpoint"],
    service: null,
    admits: false,
    why: "the operator lists a task's checkpoints, or restores one while no runner or service writes the journal (it holds the journal's lock; the host form runs as the runner, never root); serves nothing, admits no session",
    operatorJournalWrite: "§2.2.2: restoring a checkpoint is an operator action recorded in the journal, with the operator as actor (D-138, D-221)",
    implementation: runCheckpointCli,
    run: (args) => runCheckpointCli(args),
  },
  { id: "runtime", kind: "command", module: "packages/runner/src/entry-points.ts", name: ["runtime"], service: null, admits: false, why: "reports whether the container runtime enforces the workload's limits (D-149)", implementation: runtimeCheck, run: runtimeCheck },
  { id: "hook", kind: "command", module: "packages/mediated/src/install.ts", name: ["hook"], service: null, admits: false, why: "installs or checks Claude Code's root-owned managed settings (D-143, D-173, D-190); serves nothing, admits no session", implementation: runHookInstallCli, run: (args) => runHookInstallCli(args, out, err) },
  { id: "hook.serve", kind: "command", module: "packages/mediated/src/hook-serve.ts", name: ["hook", "serve"], service: "hook", admits: true, implementation: runHookServeCli, run: (args) => runHookServeCli(args.slice(1), systemHookServeIo()) },
  { id: "hook.admit", kind: "command", module: "packages/mediated/src/hook-serve.ts", name: ["hook", "admit"], service: null, admits: false, why: "asks the running hook service, over its runner-only socket, to admit a session file; the service reads the file and admits it through its shared session layer (D-196)", implementation: runHookAdmitCli, run: (args) => runHookAdmitCli(args.slice(1), { out, err }) },
  { id: "gateway.serve", kind: "command", module: "packages/mediated/src/gateway-cli.ts", name: ["gateway"], service: "gateway", admits: true, implementation: runGatewayCli, run: (args) => runGatewayCli(args, systemGatewayCliIo()) },
  // Programs of their own.
  { id: "runner.process", kind: "program", module: "packages/runner/src/runner-main.ts", program: "packages/runner/src/main.ts", name: "runRunnerMain", service: "runner", admits: false, implementation: runRunnerMain },
  { id: "juno", kind: "program", module: "packages/runner/src/entry-points.ts", program: "packages/runner/src/juno.ts", name: "dispatch", service: null, admits: false, why: "the `juno` command: it runs only the commands in this registry", implementation: dispatch },
  { id: "juno-build-check", kind: "program", module: "packages/runner/src/build-check.ts", program: "packages/runner/src/juno-build-check.ts", name: "main", service: null, admits: false, why: "checks that this copy of JUNO is a finished build before the hook service's unit starts JUNO itself; reads files only, holds no state (D-244)", implementation: null },
  { id: "juno-hook", kind: "program", module: "packages/mediated/src/hook-client.ts", program: "packages/mediated/src/juno-hook.ts", name: "main", service: null, admits: false, why: "Claude Code's hook client: relays one hook call to the hook service's socket and fails closed; holds no state (D-142)", implementation: null },
  { id: "juno-mcp", kind: "program", module: "packages/mediated/src/mcp-shim.ts", program: "packages/mediated/src/juno-mcp.ts", name: "main", service: null, admits: false, why: "Claude Code's MCP shim: relays lines to the gateway's socket and fails closed; holds no state (D-188)", implementation: null },
  { id: "juno-anchor-ssh", kind: "program", module: "packages/journal/src/anchor-ssh.ts", program: "packages/journal/src/juno-anchor-ssh.ts", name: "main", service: null, admits: false, why: "git's SSH program for the pinned anchor repository: runs ssh with the pinned host key and push key and nothing of the runner's own SSH settings; holds no state (D-208)", implementation: null },
  // Classes that start a service or admit sessions.
  { id: "class.Runner", kind: "class", module: "packages/runner/src/runner.ts", name: "Runner", service: "runner", admits: true, implementation: Runner },
  { id: "class.MediatedSessions", kind: "class", module: "packages/mediated/src/session.ts", name: "MediatedSessions", service: "hook", admits: true, implementation: MediatedSessions },
  { id: "class.HookAdmissionService", kind: "class", module: "packages/mediated/src/hook-admission.ts", name: "HookAdmissionService", service: "hook", admits: true, implementation: HookAdmissionService },
  { id: "class.HookService", kind: "class", module: "packages/mediated/src/hook-service.ts", name: "HookService", service: "hook", admits: false, implementation: HookService },
  { id: "class.McpGateway", kind: "class", module: "packages/mediated/src/gateway.ts", name: "McpGateway", service: "gateway", admits: true, implementation: McpGateway },
  { id: "class.GatewayService", kind: "class", module: "packages/mediated/src/gateway-service.ts", name: "GatewayService", service: "gateway", admits: false, implementation: GatewayService },
];

const USAGE = "usage: juno grant sign|verify ... | juno journal check|report ... | juno checkpoint restore ... | juno hook install ... | juno hook check ... | juno hook serve ... | juno hook admit ... | juno gateway serve ... | juno runtime check\n";

/** The `juno` command: runs the registered command its first word names, or prints the usage (exit 2). */
export async function dispatch(argv: readonly string[]): Promise<number> {
  // The registered command whose words begin the arguments, the longest first (`hook serve` before `hook`).
  const matches = ENTRY_POINTS.filter((candidate): candidate is EntryPoint & { name: readonly string[] } => candidate.kind === "command" && Array.isArray(candidate.name) && candidate.name.every((part, index) => argv[index] === part));
  const entry = matches.sort((a, b) => b.name.length - a.name.length)[0];
  if (entry?.run === undefined) {
    err(USAGE);
    return 2;
  }
  return entry.run(argv.slice(1));
}

/** The host as the real process sees it, for the programs (re-exported so juno.ts imports this registry only). */
export { systemHostIo };
