import { type HostIo, SessionLayer, StartupRefused, type StartupSpec } from "../../enforcement/src/index.js";
import { type RunnerConfig, parseRunnerConfig } from "./config.js";

/**
 * The runner process's start-up (`node dist/runner/src/main.js`; DECISIONS.md D-065, D-116, D-125, D-194): it parses
 * its boundary input, then opens its shared session layer through THE shared start-up check (never root; the journal
 * outside the work volume and the capability namespace; nothing anyone else could change; a verified trust anchor),
 * which creates the journal's layout on first start, and exits cleanly. Without a configured anchor it holds no key to
 * check grants against, so no grant can exist for it; it says so. Admission and the turn loop run through the `Runner`
 * class on that layer (D-065).
 */

export type RunnerMainIo = { readonly host: HostIo; readonly out: (text: string) => void; readonly err: (text: string) => void };

/** What the runner asks the shared start-up check to judge (D-194). */
export function runnerStartupSpec(config: RunnerConfig): StartupSpec {
  return { service: "runner", journal: config.journalDir, workspaces: [config.workDir], state: [], anchor: config.trustAnchor };
}

/** Returns the exit code: 0 ready, 1 refused. */
export function runRunnerMain(env: unknown, io: RunnerMainIo): number {
  let config: RunnerConfig;
  try {
    config = parseRunnerConfig(env);
  } catch (error: unknown) {
    io.err(`juno-runner: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  let layer: SessionLayer;
  try {
    layer = SessionLayer.open(runnerStartupSpec(config), { host: io.host });
  } catch (error: unknown) {
    io.err(`juno-runner: ${error instanceof StartupRefused ? error.message : error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const trust = layer.anchor === null ? "trust anchor: none, so no grant can be honoured" : `trust anchor: ${String(config.trustAnchor)}`;
  io.out(`juno-runner: ready (journal=${layer.root}, work=${config.workDir}, ${trust})\n`);
  return 0;
}
