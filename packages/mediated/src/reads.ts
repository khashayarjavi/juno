import { z } from "zod";
import { ResourceSelector, type Sensitivity, Sensitivity as SensitivitySchema, Integrity as IntegritySchema, Ref, maxSensitivity, pathWithin } from "../../contracts/src/index.js";
import { type PathResolver, type Workspace, rawOperandPath } from "../../enforcement/src/index.js";

/**
 * What anything a mode-C call reads is classified as (spec §4.3 V6-7, §1.5, §1.2, §2.7.1 C4; operator ruling of
 * 2026-11-07, DECISIONS.md D-162). One function, `classifyRead`, decides it for every read: a path, a tree, a URL, a
 * tool result, or something the tool table does not describe. It returns the highest sensitivity class the operator
 * declared for any source, unless a declared source POSITIVELY matches the resolved target. Nothing is ever classified
 * below that by default: a read JUNO cannot place is a read of the highest class.
 */

/** A URL source: exactly one origin (scheme, host and port, as the WHATWG URL parser writes it), e.g. `https://docs.example.com`. */
export const UrlSourceSelector = z.strictObject({
  kind: z.literal("url"),
  origin: z.string().refine((origin) => {
    try {
      const url = new URL(origin);
      return (url.protocol === "https:" || url.protocol === "http:") && url.origin === origin;
    } catch {
      return false;
    }
  }, "an origin is written exactly as the URL parser writes it: scheme://host[:port], with no path, user or trailing slash"),
});

/**
 * The public internet (D-164, autopilot ruling): an `http`/`https` URL on its default port, with no user name or password, whose host is a
 * DNS name of two labels or more under an alphabetic top-level label, and is not an IP address, `localhost`, or under a
 * suffix reserved for private or special use. It cannot tell a public name that leads to an intranet; see STATE.md.
 */
export const InternetSourceSelector = z.strictObject({ kind: z.literal("internet") });

/** The result of one named tool that JUNO's tool table does not hold (D-164: a supported tool's result is classified by what its call read, so admission refuses one naming it). */
export const ToolResultSourceSelector = z.strictObject({ kind: z.literal("tool_result"), tool: z.string().min(1).max(128) });

export const SourceSelector = z.union([ResourceSelector, UrlSourceSelector, InternetSourceSelector, ToolResultSourceSelector]);
export type SourceSelector = z.infer<typeof SourceSelector>;

/** One source the operator declares for a session, with its data class (§1.5; §4.3 V6-7). */
export const DeclaredSource = z.strictObject({ id: Ref, selector: SourceSelector, data_class: z.strictObject({ sensitivity: SensitivitySchema, integrity: IntegritySchema }) });
export type DeclaredSource = z.infer<typeof DeclaredSource>;

/**
 * One thing a call reads. `tree`: a path and everything under it (a file's tree is the file; every path a tool names is
 * read as a tree, D-164). `url`: a fetched page. `tool_result`: the result of a named tool. `unknown`: a read the tool table cannot describe.
 */
export type ReadTarget =
  | { readonly kind: "tree"; readonly path: string }
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "tool_result"; readonly tool: string }
  | { readonly kind: "unknown"; readonly why: string };

export type ReadContext = {
  readonly sources: readonly DeclaredSource[];
  readonly resolver: PathResolver;
  /** The workspace as the read gate lists it, never following a symlink (D-136, D-156). */
  readonly view: Workspace;
};

/** The highest class any declared source holds: what a read no source positively matches counts as (§1.5). */
export function highestDeclared(sources: readonly DeclaredSource[]): Sensitivity {
  return sources.reduce<Sensitivity>((high, source) => maxSensitivity(high, source.data_class.sensitivity), "public");
}

/** Symlinks a read may follow before it is read at the highest class (D-156). */
export const MAX_READ_LINKS = 64;
/** The lister's answers that mean "there is no tree here": a file, or a path that does not exist (D-156). */
const NO_TREE = /^(the workspace root is not a directory|cannot read the workspace root: (ENOENT|ENOTDIR))/;

/**
 * THE classification function (D-162). The highest class of what `targets` read: for each target, the class of the
 * declared sources that positively match its resolved form, or the highest declared class when none does.
 *
 * - `tree`: the raw path is resolved first (symlinks followed, then `..` as the file system takes it, §2.7.1 C4, D-113). A regular file with more than one link is the
 *   highest class (D-157). The tree's root must lie inside a declared path source (so nothing under it is in no source),
 *   and every source inside the tree adds its class. Every symlink inside a tree is followed as a
 *   tree of its own (D-156). A path that cannot be resolved or listed, or too many links, is the highest class.
 * - `url`: parsed; it is matched by a `url` source with exactly its origin, or by the `internet` source. A URL that does
 *   not parse, is not `http`/`https`, or carries a user name or password matches nothing.
 * - `tool_result`: matched by a `tool_result` source naming exactly that tool.
 * - `unknown`, and an empty list (a tool that declares no read is not trusted to read nothing): the highest class.
 */
export async function classifyRead(targets: readonly ReadTarget[], context: ReadContext): Promise<Sensitivity> {
  const highest = highestDeclared(context.sources);
  if (targets.length === 0) return highest;
  let reads: Sensitivity = "public";
  const queue: string[] = [];
  for (const target of targets) {
    switch (target.kind) {
      case "tree":
        queue.push(target.path);
        break;
      case "url": {
        const matched = matchUrl(target.url, context.sources);
        if (matched === null) return highest;
        reads = maxSensitivity(reads, matched);
        break;
      }
      case "tool_result": {
        const matching = context.sources.filter((source) => source.selector.kind === "tool_result" && source.selector.tool === target.tool);
        if (matching.length === 0) return highest;
        for (const source of matching) reads = maxSensitivity(reads, source.data_class.sensitivity);
        break;
      }
      case "unknown":
        return highest;
    }
  }
  const seen = new Set<string>();
  let links = 0;
  for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
    // The raw path goes to the resolver as written: `..` is resolved by the file system after the symlinks before it,
    // as the program will (D-113), never collapsed as text first (D-166, PR #40 review round 6).
    const raw = rawOperandPath("/", item);
    if (raw !== "/work" && !raw.startsWith("/work/")) return highest;
    const answer = (await context.resolver.resolve([raw])).get(raw);
    if (answer === undefined || !answer.ok) return highest;
    // D-157: a regular file with more than one link is the same file as a path in any source, or none.
    if (answer.hardLinked === true) return highest;
    const canonical = answer.canonical;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    let contained = false;
    for (const source of context.sources) {
      if (source.selector.kind !== "path") continue;
      if (pathWithin(canonical, source.selector.prefix)) {
        contained = true;
        reads = maxSensitivity(reads, source.data_class.sensitivity);
      } else if (pathWithin(source.selector.prefix, canonical)) {
        reads = maxSensitivity(reads, source.data_class.sensitivity);
      }
    }
    // Positive match only: a tree's root that no declared path source contains is read at the highest class.
    if (!contained) return highest;
    // The links inside the tree: listed without following any, then each judged as its own target's tree.
    const listed = await context.view.list(canonical, false);
    if (!listed.ok) {
      if (NO_TREE.test(listed.reason)) continue;
      return highest;
    }
    if (listed.snapshot.hardLinks.length > 0) return highest;
    for (const entry of listed.snapshot.manifest) {
      if (entry.type !== "symlink") continue;
      links += 1;
      if (links > MAX_READ_LINKS) return highest;
      queue.push(`${canonical}/${entry.path}`);
    }
  }
  return reads;
}

/** Top-level labels and suffixes reserved for private or special use; never "the public internet" (D-164, restrictive). */
const PRIVATE_SUFFIXES: readonly string[] = ["localhost", "local", "internal", "intranet", "corp", "home", "lan", "private", "localdomain", "home.arpa", "arpa", "test", "example", "invalid", "onion", "alt"];

/** The class of the sources that positively match a URL, or null when none does. */
function matchUrl(raw: string, sources: readonly DeclaredSource[]): Sensitivity | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") return null;
  let matched: Sensitivity | null = null;
  for (const source of sources) {
    const selector = source.selector;
    const hit = (selector.kind === "url" && selector.origin === url.origin) || (selector.kind === "internet" && isPublicInternet(url));
    if (hit) matched = maxSensitivity(matched ?? "public", source.data_class.sensitivity);
  }
  return matched;
}

/** Whether a parsed http(s) URL is on the public internet as D-164 reads it (restrictive: anything doubtful is not). */
export function isPublicInternet(url: URL): boolean {
  if (url.port !== "") return false;
  const host = url.hostname.toLowerCase();
  // An IPv6 literal is bracketed; the URL parser writes every IPv4 spelling (hex, octal, short forms) as dotted decimal.
  if (host.startsWith("[") || /^[0-9.]+$/.test(host)) return false;
  const labels = host.replace(/\.$/, "").split(".");
  if (labels.length < 2 || labels.some((label) => label === "")) return false;
  const top = labels[labels.length - 1] ?? "";
  if (!/^[a-z]{2,63}$/.test(top) && !/^xn--[a-z0-9-]{1,59}$/.test(top)) return false;
  const name = labels.join(".");
  return !PRIVATE_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}
