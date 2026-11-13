import { type Anchoring, type HostIo, SessionLayer, StartupRefused, type StartupSpec, anchoringState, gitAnchoring } from "../../enforcement/src/index.js";
import { type RunnerConfig, parseRunnerConfig } from "./config.js";

/**
 * The runner process's start-up (`node dist/runner/src/main.js`; DECISIONS.md D-065, D-116, D-125, D-194): it parses
 * its boundary input, then opens its shared session layer through THE shared start-up check (never root; the journal
 * outside the work volume and the capability namespace; nothing anyone else could change; a verified trust anchor),
 * which creates the journal's layout on first start, verifies the journal against its off-host anchors (D-201), and exits cleanly. Without a configured anchor it holds no key to
 * check grants against, so no grant can exist for it; it says so. Admission and the turn loop run through the `Runner`
 * class on that layer (D-065).
 */

export type RunnerMainIo = {
  readonly host: HostIo;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Tests only: the anchoring to use in place of the configured journal key and clone (both are still judged). */
  readonly anchoring?: Anchoring;
};

/** What the runner asks the shared start-up check to judge (D-194). */
export function runnerStartupSpec(config: RunnerConfig): StartupSpec {
  return { service: "runner", journal: config.journalDir, workspaces: [config.workDir], state: anchoringState(config.anchoring, { pushes: false }), anchor: config.trustAnchor };
}

/** Returns the exit code: 0 ready, 1 refused. */
export async function runRunnerMain(env: unknown, io: RunnerMainIo): Promise<number> {
  let config: RunnerConfig;
  try {
    config = parseRunnerConfig(env);
  } catch (error: unknown) {
    io.err(`juno-runner: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  let layer: SessionLayer;
  try {
    layer = await SessionLayer.open(runnerStartupSpec(config), { host: io.host, anchoring: io.anchoring ?? ((root, pin) => gitAnchoring(config.anchoring, root, pin)) });
  } catch (error: unknown) {
    io.err(`juno-runner: ${error instanceof StartupRefused ? error.message : error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const trust = layer.anchor === null ? "trust anchor: none, so no grant can be honoured" : `trust anchor: ${String(config.trustAnchor)}`;
  io.out(`juno-runner: ready (journal=${layer.root}, work=${config.workDir}, ${trust})\n`);
  return 0;
}
