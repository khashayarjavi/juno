import { GitAnchorSink, loadOrCreateJournalKey } from "../../journal/src/index.js";
import { PINNED_SSH, type VerifiedPin } from "./anchor-pin.js";
import type { Anchoring } from "./session-layer.js";
import type { StateItem } from "./startup.js";

/**
 * Where a service's anchors go and the key that signs them, as the operator configures every JUNO service the same way
 * (§3.4.1; DECISIONS.md D-198). The journal key folder and the clone of `juno-anchors` are JUNO's state: the shared
 * start-up check judges both before anything is opened, and only then is the key loaded (created on first start).
 */

export type AnchoringConfig = {
  /** The folder holding the runner's journal key (created 0700 on first start). */
  readonly journalKeyDir: string;
  /** The runner's own clone of the operator's public `juno-anchors` repository. */
  readonly anchorClone: string;
  /** At most this long passes between anchors (§3.4.1); recorded in every session's journal. */
  readonly intervalMs: number;
  /**
   * The anchor pin (operator ruling D-206 item 2; D-208): the file the runner cannot change that names the anchor
   * repository, its SSH host key, the git program, and the journal folders that may anchor there. The git program is
   * named only there (operator ruling D-211 item 1; D-213): no setting of the service names it.
   */
  readonly pin: string;
};

/** D-208: the anchor pin's place unless the operator names another; root's folder, beside the trust anchor. */
export const DEFAULT_ANCHOR_PIN = "/etc/juno/anchors.json";


/** D-198 (autopilot ruling): one minute unless the operator names another interval; the tighter bound on rewritable history. */
export const DEFAULT_ANCHOR_INTERVAL_MS = 60_000;

/**
 * The state the start-up check judges for anchoring. The git program is not among it: the anchor pin names it, and the
 * pin's own rule judges it (root's own file; D-211, D-213).
 */
export function anchoringState(config: AnchoringConfig): StateItem[] {
  return [
    { what: "the journal key folder", path: config.journalKeyDir, kind: "dir" },
    { what: "the anchor repository clone", path: config.anchorClone, kind: "dir" },
    { what: "the anchor pin", path: config.pin, kind: "pin" },
  ];
}

/** Reads `--anchor-interval <seconds>`: a whole number from 1 to 3600. Answers null when it is not one. */
export function parseAnchorInterval(text: string | undefined): number | null {
  if (text === undefined) return DEFAULT_ANCHOR_INTERVAL_MS;
  if (!/^[1-9][0-9]{0,3}$/.test(text)) return null;
  const seconds = Number(text);
  return seconds <= 3600 ? seconds * 1000 : null;
}

/** Opens anchoring for a layer, after its start-up check passed (passed to `SessionLayer.open` as a factory). */
export function gitAnchoring(config: AnchoringConfig, journalRoot: string, pin: VerifiedPin | null): Anchoring {
  // D-208: no pin, no destination. The start-up check verified the pin this service named; a service that named none
  // has nowhere it may anchor, and does not start.
  if (pin === null) throw new Error("no anchor pin was verified, so there is no anchor repository this service may use (D-206, D-208)");
  return { sink: new GitAnchorSink({ clone: config.anchorClone, pin, ssh: { program: PINNED_SSH } }), journalKey: loadOrCreateJournalKey(config.journalKeyDir, { journalRoot }), intervalMs: config.intervalMs };
}
