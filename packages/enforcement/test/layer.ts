import { accessSync, constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import type { JournalWriterOptions } from "../../journal/src/index.js";
import { type Anchoring, type HostIo, type ServiceName, SessionLayer, type StateItem } from "../src/index.js";
import { testAnchoring } from "./anchoring.js";

/**
 * Test support for the shared start-up check and session layer (D-194). Unit tests run as whatever user runs the suite:
 * an ordinary user in CI, root in a cloud session. The check refuses root, so here the host is read as it is, except
 * that root is seen as an ordinary uid (4242), for whom what may be written is worked out from the mode bits. Files the
 * test made are then root's, which the check accepts as it accepts the operator's root-owned files.
 *
 * The anchor pin must be root's own (D-208), and a test cannot make a root-owned file as an ordinary user, nor a file of
 * an ordinary user's as root. So two folder names decide the owner the host reports, whoever runs the suite: anything
 * under a folder named `root-owned` is root's (and this process cannot write it); anything under `runner-owned` is this
 * process's own. Mode bits are always the real ones.
 */
const ROOT_OWNED = /\/root-owned(\/|$)/;
const RUNNER_OWNED = /\/runner-owned(\/|$)/;
export function ordinaryHost(): HostIo {
  const real = typeof process.geteuid === "function" ? process.geteuid() : 1000;
  const uid = real === 0 ? 4242 : real;
  const lstat = (path: string): ReturnType<HostIo["lstat"]> => {
    try {
      const facts = lstatSync(path);
      const owner = ROOT_OWNED.test(path) ? 0 : RUNNER_OWNED.test(path) ? uid : null;
      if (owner === null) return facts;
      // The same facts, with the owner the folder's name stands for.
      return Object.assign(Object.create(Object.getPrototypeOf(facts) as object) as typeof facts, facts, { uid: owner });
    } catch {
      return null;
    }
  };
  return {
    uid,
    lstat,
    realpath: (path) => realpathSync(path),
    readFile: (path) => readFileSync(path, "utf8"),
    writable: (path) => {
      if (ROOT_OWNED.test(path)) return ((lstat(path)?.mode ?? 0) & 0o002) !== 0;
      if (real !== 0 && !RUNNER_OWNED.test(path)) {
        try {
          accessSync(path, constants.W_OK);
          return true;
        } catch {
          return false;
        }
      }
      const facts = lstat(path);
      if (facts === null) return false;
      return facts.uid === uid ? (facts.mode & 0o200) !== 0 : (facts.mode & 0o002) !== 0;
    },
  };
}

/**
 * Opens a layer for `service` through the real start-up check, as an ordinary user. Every layer anchors (D-198): unless
 * the test gives its own, an in-memory destination and a fresh journal key with a long interval.
 */
export function openTestLayer(
  service: ServiceName,
  options: {
    readonly journal: string;
    readonly workspaces: readonly string[];
    readonly state?: readonly StateItem[];
    readonly anchor?: string | null;
    readonly clock?: () => Date;
    readonly journalOptions?: JournalWriterOptions;
    readonly anchoring?: Anchoring;
  },
): Promise<SessionLayer> {
  return SessionLayer.open(
    { service, journal: options.journal, workspaces: options.workspaces, state: options.state ?? [], anchor: options.anchor ?? null },
    { host: ordinaryHost(), anchoring: options.anchoring ?? testAnchoring(), ...(options.clock === undefined ? {} : { clock: options.clock }), ...(options.journalOptions === undefined ? {} : { journal: options.journalOptions }) },
  );
}
