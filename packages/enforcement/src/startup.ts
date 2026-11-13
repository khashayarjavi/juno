import { type Stats, accessSync, constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { WORK_NAMESPACE, pathsOverlap } from "../../contracts/src/index.js";
import { type VerifiedPin, knownHostsRefusals, parseAnchorPin } from "./anchor-pin.js";
import { type TrustAnchor, trustAnchorFromPem } from "./signature.js";

/**
 * THE start-up check (operator ruling D-193; DECISIONS.md D-194). Every command or entry point that starts a JUNO
 * service (the runner, the hook service, the gateway, and any future one) runs this one function before it opens
 * anything, through `SessionLayer.open` (session-layer.ts), which is the only way to obtain the journal and a session
 * layer. It answers with every refusal at once, or with the verified trust anchor. It replaces the per-entry copies that
 * D-116, D-148, D-173, D-191 and D-192 had each put in one entry point.
 *
 * It refuses:
 *   1. running as root (the services are the runner's, and the runner is not root: D-130, D-173, D-188);
 *   2. any path that is not absolute;
 *   3. JUNO's own state (the journal, grant and session files, keys, the trust anchor, checkpoint stores, sockets and any
 *      other state the entry names) inside or overlapping any workspace or source root, in either direction, as the
 *      kernel resolves both (a path that does not exist yet is judged at its nearest existing ancestor), or inside the
 *      capability namespace `/work` that grants can name (§3.2, §3.4.1; D-026, D-148, D-192);
 *   4. state that someone else could change: a file or folder that is a symbolic link, is owned by anyone but root or
 *      this process, or is writable by group or others; a folder holding it that is owned by anyone else, or writable by
 *      group or others without the sticky bit (they could replace the entry); for a socket, a folder writable by group
 *      or others at all (D-173, D-191);
 *   5. a trust anchor that is not verified: missing, a symbolic link, not a file, writable by this process or replaceable
 *      through its folder (D-116), writable by group or others, or not an Ed25519 public key (§3.2 C1);
 *   6. an anchor pin that is not verified (operator ruling D-206; D-208): the file that pins the anchor repository's
 *      address, its SSH host key and the journal folders that may anchor there. It and its folder must be owned by
 *      root and writable by no one else, its known-hosts file likewise and holding exactly the pinned key, and the journal this service was started on must be one it names.
 */

/** Which service is starting. A new service adds its name here, and to the entry-point registry (D-194). */
export const SERVICES = ["runner", "hook", "gateway"] as const;
export type ServiceName = (typeof SERVICES)[number];

/** One piece of JUNO's state an entry point names, other than the journal and the anchor. */
export type StateItem = {
  /** Plain words for refusals: "the session file", "the checkpoint store". */
  readonly what: string;
  readonly path: string;
  /**
   * `file`: must exist (a file JUNO reads); `dir`: a folder JUNO owns (may not exist yet); `socket`: the Unix socket JUNO
   * will listen on (its folder must exist); `path`: something JUNO protects but does not own or open (only the overlap
   * rule applies, e.g. Claude Code's root-owned settings files); `pin`: the anchor pin file (rule 6 above; at most one).
   */
  readonly kind: "file" | "dir" | "socket" | "path" | "pin";
};

export type StartupSpec = {
  readonly service: ServiceName;
  /** The journal's root folder; it may not exist yet (the layer creates it). */
  readonly journal: string;
  /**
   * Every host folder a tool call or a workload can reach: workspace roots and source roots. For a workload in a
   * container, the host paths of its volumes that the runner names (a named volume the runner never names on the host
   * is not one).
   */
  readonly workspaces: readonly string[];
  readonly state: readonly StateItem[];
  /** The operator's public key file, or null for a service that honours no grant. */
  readonly anchor: string | null;
};

/** How the check reads the host. The real process uses `systemHostIo()`. */
export type HostIo = {
  readonly uid: number;
  readonly lstat: (path: string) => Stats | null;
  readonly realpath: (path: string) => string;
  readonly readFile: (path: string) => string;
  /** Whether this process could write `path`. */
  readonly writable: (path: string) => boolean;
};

export function systemHostIo(): HostIo {
  return {
    uid: typeof process.geteuid === "function" ? process.geteuid() : -1,
    lstat: (path) => {
      try {
        return lstatSync(path);
      } catch {
        return null;
      }
    },
    realpath: (path) => realpathSync(path),
    readFile: (path) => readFileSync(path, "utf8"),
    writable: (path) => {
      try {
        accessSync(path, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export type StartupResult = { readonly ok: true; readonly anchor: TrustAnchor | null; readonly pin: VerifiedPin | null } | { readonly ok: false; readonly refusals: readonly string[] };

/** The shared start-up check: every refusal, or the verified anchor. Opens and changes nothing. */
export function startupCheck(spec: StartupSpec, host: HostIo): StartupResult {
  const refusals: string[] = [];
  if (!(SERVICES as readonly string[]).includes(spec.service)) refusals.push(`${String(spec.service)} is not a JUNO service the start-up check knows (D-194)`);
  // 1. Never root.
  if (host.uid === 0) refusals.push(`the ${spec.service} service must not run as root: JUNO's services are the runner's, and the runner is not root (D-130, D-173, D-194)`);
  const owned: { readonly what: string; readonly path: string; readonly kind: StateItem["kind"] | "journal" | "anchor" }[] = [
    { what: "the journal", path: spec.journal, kind: "journal" },
    ...spec.state,
    ...(spec.anchor === null ? [] : [{ what: "the trust anchor", path: spec.anchor, kind: "anchor" as const }]),
  ];
  // 2. Absolute paths only (a bare number given as a socket would be a TCP port: D-144).
  const relative = [...owned.map((item) => [item.what, item.path] as const), ...spec.workspaces.map((path) => ["the workspace", path] as const)].filter(([, path]) => !path.startsWith("/"));
  for (const [what, path] of relative) refusals.push(`${what} ${path} is not an absolute path`);
  if (relative.length > 0) return { ok: false, refusals };
  // 3. No state inside or overlapping a workspace or source, or inside the capability namespace.
  const roots = spec.workspaces.map((path) => ({ path, real: resolved(path, host) }));
  for (const item of owned) {
    // A socket's folder is state too: whoever can reach it could replace the socket (D-192).
    for (const path of item.kind === "socket" ? [item.path, dirname(item.path)] : [item.path]) {
      const real = resolved(path, host);
      const named = path === item.path ? `${item.what} ${item.path}` : `the folder ${path} of ${item.what} ${item.path}`;
      if (item.kind !== "anchor" && [...new Set([path, real])].some((candidate) => pathsOverlap(candidate, WORK_NAMESPACE))) refusals.push(`${named} lies in the capability namespace ${WORK_NAMESPACE}, which grants can name (§3.2, §3.4.1)`);
      for (const root of roots) {
        if (pathsOverlap(real, root.real) || pathsOverlap(path, root.path)) {
          refusals.push(`${named} is JUNO's own state and overlaps the workspace ${root.path}, so a tool call could reach it; move the workspace or the state (D-148, D-192, D-194)`);
        }
      }
    }
  }
  // 4. Nothing someone else could change.
  for (const item of owned) {
    if (item.kind === "path" || item.kind === "anchor" || item.kind === "pin") continue;
    refusals.push(...changeableRefusals(item.what, item.path, item.kind, host));
  }
  // 5. A verified anchor.
  let anchor: TrustAnchor | null = null;
  if (spec.anchor !== null) {
    const verified = verifyTrustAnchor(spec.anchor, host);
    if (verified.ok) anchor = verified.anchor;
    else refusals.push(...verified.refusals);
  }
  // 6. A verified anchor pin, naming this journal (D-206, D-208).
  let pin: VerifiedPin | null = null;
  const pins = spec.state.filter((item) => item.kind === "pin");
  if (pins.length > 1) refusals.push("more than one anchor pin was named; a service has one (D-208)");
  const named = pins[0];
  if (named !== undefined && pins.length === 1) {
    const verified = verifyAnchorPin(named.path, spec.journal, spec.workspaces, host);
    if (verified.ok) pin = verified.pin;
    else refusals.push(...verified.refusals);
  }
  return refusals.length > 0 ? { ok: false, refusals } : { ok: true, anchor, pin };
}

/**
 * Why a file is not root's own (operator ruling D-206 item 2; D-208): it and the folder holding it must be owned by
 * root (uid 0), and neither may be writable by group, others or this process. Unlike the trust anchor's rule (D-116), a
 * file this process owns is refused even when it is read-only: its owner could make it writable again, and the anchor
 * pin exists to be outside the runner's reach.
 */
export function rootOwnedRefusals(what: string, path: string, host: HostIo): string[] {
  if (!path.startsWith("/")) return [`${what} ${path} is not an absolute path`];
  if (pathsOverlap(path, WORK_NAMESPACE)) return [`${what} ${path} lies in the capability namespace ${WORK_NAMESPACE}, which grants can name (§3.2)`];
  const facts = host.lstat(path);
  if (facts === null) return [`${what} ${path} does not exist`];
  if (facts.isSymbolicLink()) return [`${what} ${path} is a symbolic link; name the file itself (D-208)`];
  if (!facts.isFile()) return [`${what} ${path} is not a file`];
  const refusals: string[] = [];
  const folder = dirname(path);
  const holder = host.lstat(folder);
  for (const [name, at, stats] of [[what, path, facts], [`the folder of ${what}`, folder, holder]] as const) {
    if (stats === null) refusals.push(`${name} ${at} does not exist`);
    else if (stats.uid !== 0) refusals.push(`${name} ${at} is owned by uid ${String(stats.uid)}, not root; it must be outside the runner's reach (D-206, D-208)`);
    else if ((stats.mode & 0o022) !== 0) refusals.push(`${name} ${at} is writable by group or others (mode ${(stats.mode & 0o7777).toString(8)}) (D-208)`);
    if (host.writable(at)) refusals.push(`${what} ${path} is not protected: this process can write ${at} (D-206, D-208)`);
  }
  return refusals;
}

/**
 * The anchor pin rule (operator ruling D-206 item 2; D-208), the one implementation the start-up check and
 * `juno hook check` use. The pin file, and the known-hosts file it names, must be root's own
 * (`rootOwnedRefusals`: the file and its folder owned by root, writable by no one else, not a symbolic link). The known-hosts file must hold exactly the pinned host key for the pinned host. The push
 * key is the runner's own file and is judged like any of JUNO's state. `journal` must be one of the journal folders
 * the pin names, as the kernel resolves both.
 */
export function verifyAnchorPin(path: string, journal: string, workspaces: readonly string[], host: HostIo): { readonly ok: true; readonly pin: VerifiedPin } | { readonly ok: false; readonly refusals: readonly string[] } {
  const refusals = rootOwnedRefusals("the anchor pin", path, host);
  if (refusals.length > 0) return { ok: false, refusals };
  let parsed: ReturnType<typeof parseAnchorPin>;
  try {
    parsed = parseAnchorPin(host.readFile(path));
  } catch (error: unknown) {
    return { ok: false, refusals: [`the anchor pin ${path} cannot be used: ${error instanceof Error ? error.message : String(error)} (D-208)`] };
  }
  if (parsed.transport === "ssh" && parsed.known_hosts !== null && parsed.push_key !== null && parsed.host_key_fingerprint !== null && parsed.host !== null) {
    const known = rootOwnedRefusals("the pinned known-hosts file", parsed.known_hosts, host);
    refusals.push(...known);
    if (known.length === 0) {
      try {
        refusals.push(...knownHostsRefusals(host.readFile(parsed.known_hosts), parsed.host, parsed.host_key_fingerprint).map((line) => `${line} (${parsed.known_hosts ?? ""}, D-208)`));
      } catch (error: unknown) {
        refusals.push(`the pinned known-hosts file ${parsed.known_hosts} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    refusals.push(...laterFileRefusals("the anchor push key", parsed.push_key, workspaces, host));
  } else if (parsed.transport === "local") {
    // A local repository is JUNO's own test stand-in: it is state, and must not be reachable from a workspace.
    for (const root of workspaces) {
      if (pathsOverlap(resolved(parsed.url, host), resolved(root, host)) || pathsOverlap(parsed.url, root)) refusals.push(`the pinned anchor repository ${parsed.url} overlaps the workspace ${root} (D-208)`);
    }
  }
  const real = resolved(journal, host);
  const entry = parsed.journals.find((candidate) => candidate.path === journal || resolved(candidate.path, host) === real);
  if (entry === undefined) refusals.push(`the journal ${journal} is not a journal folder the anchor pin ${path} names; only the operator, as root, adds one there (D-206, D-208)`);
  if (refusals.length > 0 || entry === undefined) return { ok: false, refusals };
  return {
    ok: true,
    pin: { path, url: parsed.url, branch: parsed.branch, transport: parsed.transport, host: parsed.host, fingerprint: parsed.host_key_fingerprint, knownHosts: parsed.known_hosts, pushKey: parsed.push_key, journals: parsed.journals, journal: entry },
  };
}

/**
 * The trust anchor rule (§3.2 C1, D-116, D-194), the one implementation every entry point uses: not in the capability
 * namespace; a file, not a symbolic link, owned by root or this process and writable by no group or other; neither it
 * nor its folder writable by this process (a runner that could replace the anchor could trust a key of its own); and an
 * Ed25519 public key.
 */
export function verifyTrustAnchor(path: string, host: HostIo): { readonly ok: true; readonly anchor: TrustAnchor } | { readonly ok: false; readonly refusals: readonly string[] } {
  if (!path.startsWith("/")) return { ok: false, refusals: [`the trust anchor ${path} is not an absolute path`] };
  if (pathsOverlap(path, WORK_NAMESPACE)) return { ok: false, refusals: [`the trust anchor ${path} lies in the capability namespace ${WORK_NAMESPACE}, which grants can name (§3.2)`] };
  const refusals: string[] = [];
  for (const target of [path, dirname(path)]) {
    if (host.writable(target)) refusals.push(`the trust anchor ${path} is not protected: this process can write ${target}; it must be read-only to the runner (§3.2, D-116)`);
  }
  refusals.push(...changeableRefusals("the trust anchor", path, "anchor", host));
  if (refusals.length > 0) return { ok: false, refusals };
  try {
    return { ok: true, anchor: trustAnchorFromPem(host.readFile(path)) };
  } catch (error: unknown) {
    return { ok: false, refusals: [`the trust anchor ${path} ${host.lstat(path) === null ? "cannot be read" : "is not an Ed25519 public key"}: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

/**
 * The start-up check's own rules for one file a running service is asked to read later (a session file handed to the
 * hook service, and the grant files it names; D-196): absolute, not inside or overlapping any of `workspaces` or the
 * capability namespace, and changeable by no one but root and this process. The same code `startupCheck` runs.
 */
export function laterFileRefusals(what: string, path: string, workspaces: readonly string[], host: HostIo): string[] {
  if (!path.startsWith("/")) return [`${what} ${path} is not an absolute path`];
  const refusals: string[] = [];
  const real = resolved(path, host);
  if ([path, real].some((candidate) => pathsOverlap(candidate, WORK_NAMESPACE))) refusals.push(`${what} ${path} lies in the capability namespace ${WORK_NAMESPACE}, which grants can name (§3.2, §3.4.1)`);
  for (const root of workspaces) {
    if (pathsOverlap(real, resolved(root, host)) || pathsOverlap(path, root)) refusals.push(`${what} ${path} is JUNO's own state and overlaps the workspace ${root}, so a tool call could reach it; move the workspace or the state (D-148, D-194)`);
  }
  refusals.push(...changeableRefusals(what, path, "file", host));
  return refusals;
}

/** Why someone other than root or this process could change `path` (empty: no one could). */
function changeableRefusals(what: string, path: string, kind: "file" | "dir" | "socket" | "journal" | "anchor", host: HostIo): string[] {
  const refusals: string[] = [];
  const mustExist = kind === "file" || kind === "anchor";
  const facts = kind === "socket" ? null : host.lstat(path);
  if (facts === null && mustExist) return [`${what} ${path} does not exist`];
  if (facts !== null) {
    if (facts.isSymbolicLink()) return [`${what} ${path} is a symbolic link; name the ${kind === "dir" || kind === "journal" ? "folder" : "file"} itself (D-194)`];
    if (mustExist && !facts.isFile()) return [`${what} ${path} is not a file`];
    if ((kind === "dir" || kind === "journal") && !facts.isDirectory()) return [`${what} ${path} is not a folder`];
    refusals.push(...ownerRefusals(what, path, facts, host));
  }
  // The folder that holds it: for a socket it must exist and be writable by no one else at all (D-173); otherwise the
  // nearest existing folder, which may be shared only with the sticky bit set (no one can replace another's entry).
  if (kind === "socket") return socketRefusals(what, path, host);
  let folder = dirname(path);
  let holder = host.lstat(folder);
  while (holder === null && folder !== "/") {
    folder = dirname(folder);
    holder = host.lstat(folder);
  }
  if (holder !== null) {
    // Restrictive (D-195): state that does not exist yet must not be left for a shared folder to hold: anyone who can
    // write there, sticky bit or not, could create it between this check and the moment JUNO opens it.
    if (facts === null && (holder.mode & 0o022) !== 0) refusals.push(`${what} ${path} does not exist yet, and the folder ${folder} that would hold it is writable by group or others, who could create it first (D-195)`);
    else if ((holder.mode & 0o022) !== 0 && (holder.mode & 0o1000) === 0) refusals.push(`the folder ${folder} holding ${what} ${path} is writable by group or others without the sticky bit, so they could replace it (D-194)`);
    else if (holder.uid !== 0 && holder.uid !== host.uid && (holder.mode & 0o1000) === 0) refusals.push(`the folder ${folder} holding ${what} ${path} is owned by uid ${String(holder.uid)}, neither root nor this process, who could replace it (D-194)`);
  }
  return refusals;
}

/** Why the socket at `path` could be replaced by someone else: its folder must exist, be root's or this process's, and be writable by no one else (D-173). */
export function socketRefusals(what: string, path: string, host: HostIo): string[] {
  if (!path.startsWith("/")) return [`${what} ${path} is not an absolute path`];
  const folder = dirname(path);
  const holder = host.lstat(folder);
  if (holder === null || !holder.isDirectory()) return [`the folder ${folder} of ${what} ${path} does not exist`];
  const refusals: string[] = [];
  if ((holder.mode & 0o022) !== 0) refusals.push(`the folder ${folder} of ${what} ${path} is writable by group or others, so the socket could be replaced (D-173)`);
  else refusals.push(...ownerRefusals(`the folder of ${what}`, folder, holder, host));
  return refusals;
}

function ownerRefusals(what: string, path: string, facts: Stats, host: HostIo): string[] {
  if (facts.uid !== 0 && facts.uid !== host.uid) return [`${what} ${path} is owned by uid ${String(facts.uid)}, neither root nor this process; its owner could change it (D-191, D-194)`];
  if ((facts.mode & 0o022) !== 0) return [`${what} ${path} is writable by group or others (mode ${(facts.mode & 0o7777).toString(8)}), who could change it (D-191, D-194)`];
  return [];
}

/** A path as the kernel resolves it; one that does not exist yet is judged at its nearest existing ancestor. */
function resolved(path: string, host: HostIo): string {
  let at = path;
  const rest: string[] = [];
  for (;;) {
    try {
      const base = host.realpath(at);
      return rest.length === 0 ? base : `${base === "/" ? "" : base}/${rest.join("/")}`;
    } catch {
      if (at === "/") return path;
      rest.unshift(at.slice(at.lastIndexOf("/") + 1));
      at = dirname(at);
    }
  }
}

export class StartupRefused extends Error {
  override readonly name = "StartupRefused";
  readonly refusals: readonly string[];

  constructor(service: string, refusals: readonly string[]) {
    super(`the ${service} service will not start:\n${refusals.map((line) => `  - ${line}`).join("\n")}`);
    this.refusals = refusals;
  }
}
