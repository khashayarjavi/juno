import { type KeyObject, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AbsolutePath, WORK_NAMESPACE, parseAtBoundary, pathsOverlap } from "../../contracts/src/index.js";
import { type Anchor, TaskDigest, anchorPath, encodeAnchor } from "./anchor.js";
import { executeOutbound } from "../../registry/src/index.js";

/**
 * Where anchors go, and the key that signs them (spec §3.4.1, v0.6 C1, v0.6.1 V6-4; DECISIONS.md D-122).
 *
 * A destination offers two operations: append an anchor, and list a task's anchors. It never replaces or deletes one:
 * an anchor at a task and seq already stored is refused. Every destination uses the same layout,
 * `<task digest>/<seq, 12 digits>.json` (`anchorPath`), so `juno journal check` reads any of them the same way.
 */

export interface AnchorSink {
  /** Appends one anchor. Throws `AnchorSinkError` when the destination refuses it or cannot be reached. */
  append(anchor: Anchor): Promise<void>;
  /** The stored anchors of a task (by its digest), as raw JSON values: the checker parses and verifies them. */
  list(task: string): Promise<unknown[]>;
}

export class AnchorSinkError extends Error {
  override readonly name: string = "AnchorSinkError";
}

/** The destination already holds an anchor at this task and seq; it is never replaced. */
export class AnchorExistsError extends AnchorSinkError {
  override readonly name = "AnchorExistsError";
}

export class JournalKeyError extends Error {
  override readonly name = "JournalKeyError";
}

/** The runner's journal key: it signs anchors only, and is never the operator's grant-signing key (§3.4.1 V6-4). */
export type JournalKey = { readonly privateKey: KeyObject; readonly publicKey: KeyObject };

const PRIVATE_FILE = "journal-key.pem";
const PUBLIC_FILE = "journal-key.pub.pem";

/**
 * Loads the runner's journal key from `dir`, creating it on first start (an Ed25519 pair; the private half mode 0600,
 * the directory 0700). The directory must lie outside the capability namespace and outside the journal, so no
 * selector can name it and nothing reading the journal finds it. The public half is written beside it for
 * `juno journal check`.
 */
export function loadOrCreateJournalKey(dir: string, options: { readonly journalRoot: string }): JournalKey {
  const path = parseAtBoundary("journal key directory", AbsolutePath, dir);
  if (pathsOverlap(path, WORK_NAMESPACE)) throw new JournalKeyError(`the journal key directory ${path} lies in the capability namespace ${WORK_NAMESPACE} (§3.2, §3.4.1)`);
  if (pathsOverlap(path, options.journalRoot)) throw new JournalKeyError(`the journal key directory ${path} overlaps the journal ${options.journalRoot} (§3.4.1)`);
  const privatePath = join(path, PRIVATE_FILE);
  if (!existsSync(privatePath)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const pair = generateKeyPairSync("ed25519");
    writeExclusive(privatePath, pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), 0o600);
    writeExclusive(join(path, PUBLIC_FILE), pair.publicKey.export({ type: "spki", format: "pem" }).toString(), 0o644);
  }
  const privateKey = createPrivateKey(readFileSync(privatePath, "utf8"));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new JournalKeyError("the journal key must be an Ed25519 key");
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

function writeExclusive(path: string, text: string, mode: number): void {
  const fd = openSync(path, "wx", mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Whether two keys are the same public key. */
export function sameKey(a: KeyObject, b: KeyObject): boolean {
  const der = (key: KeyObject): Buffer => (key.type === "private" ? createPublicKey(key) : key).export({ type: "spki", format: "der" });
  return der(a).equals(der(b));
}

const ContainerTarget = z.strictObject({ composeFile: AbsolutePath, project: z.string().min(1), service: z.string().min(1) });

/**
 * The test stand-in for the off-host destination (§3.4.1: "a separate container exposing an append-only interface and
 * holding its own volume"): the `anchors` service, whose fixed entrypoint offers append and list only
 * (containers/anchor-store.mjs). Reached by `docker compose run` with an argv array; no shell.
 */
export class ContainerAnchorSink implements AnchorSink {
  readonly #target: z.infer<typeof ContainerTarget>;

  constructor(target: { readonly composeFile: string; readonly project: string; readonly service: string }) {
    this.#target = parseAtBoundary("anchor container", ContainerTarget, target);
  }

  #args(operation: readonly string[]): string[] {
    const { composeFile, project, service } = this.#target;
    return ["compose", "-f", composeFile, "-p", project, "run", "--rm", "--no-deps", "-T", service, ...operation];
  }

  async append(anchor: Anchor): Promise<void> {
    const [task, file] = anchorPath(anchor.task, anchor.seq).split("/") as [string, string];
    const result = await outbound(this.#args(["append", task, file.slice(0, -".json".length), encodeAnchor(anchor).trimEnd()]));
    if (result.exitCode === 3) throw new AnchorExistsError(`the anchor store refused the anchor: ${result.stderr.toString("utf8").trim()}`);
    if (result.exitCode !== 0) throw new AnchorSinkError(`the anchor store refused the anchor: ${result.stderr.toString("utf8").trim()}`);
  }

  async list(task: string): Promise<unknown[]> {
    const result = await outbound(this.#args(["list", TaskDigest.parse(task)]));
    if (result.exitCode !== 0) throw new AnchorSinkError(`the anchor store did not list: ${result.stderr.toString("utf8").trim()}`);
    return parseList(result.stdout.toString("utf8"));
  }
}

async function outbound(args: readonly string[], file = "docker"): Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer }> {
  try {
    return await executeOutbound({ file, args });
  } catch (error: unknown) {
    throw new AnchorSinkError(`the anchor destination could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseList(text: string): unknown[] {
  const raw = z.array(z.string()).parse(JSON.parse(text));
  return raw.map((item) => JSON.parse(item) as unknown);
}

/** Reads anchors stored in the common layout under a directory (a clone of `juno-anchors`, or a copy of the store). */
export function readAnchorDirectory(dir: string, task: string): unknown[] {
  const taskDir = join(dir, TaskDigest.parse(task));
  if (!existsSync(taskDir)) return [];
  return readdirSync(taskDir)
    .filter((name) => /^[0-9]{12}\.json$/.test(name))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(taskDir, name), "utf8")) as unknown);
}

/**
 * The real destination (§3.4.1 v0.6.1, D-094, D-098): the operator's public `juno-anchors` repository, through a local
 * clone the runner alone uses (outside the capability namespace and the journal). Each anchor is one new file, one
 * commit, one push; the repository's protection refuses any push that rewrites or deletes history, so nothing the
 * host holds can replace an anchor already pushed. The push credential is git's own: the runner's deploy key for that
 * repository alone (docs/operator-setup.md Part D, D-199); the runner never reads it. A file that already exists is refused here, before
 * anything is committed.
 */
export class GitAnchorSink implements AnchorSink {
  readonly #clone: string;
  readonly #git: string;

  constructor(options: { readonly clone: string; readonly git?: string }) {
    this.#clone = parseAtBoundary("anchor repository clone", AbsolutePath, options.clone);
    if (pathsOverlap(this.#clone, WORK_NAMESPACE)) throw new AnchorSinkError(`the anchor clone ${this.#clone} lies in the capability namespace ${WORK_NAMESPACE}`);
    this.#git = options.git ?? "git";
  }

  async #run(args: readonly string[]): Promise<void> {
    const result = await outbound(["-C", this.#clone, "-c", "user.name=juno-runner", "-c", "user.email=juno-runner@localhost", ...args], this.#git);
    if (result.exitCode !== 0) throw new AnchorSinkError(`git ${args[0] ?? ""} failed: ${result.stderr.toString("utf8").trim()}`);
  }

  async append(anchor: Anchor): Promise<void> {
    await this.#run(["pull", "--rebase", "--quiet"]);
    const relative = anchorPath(anchor.task, anchor.seq);
    const path = join(this.#clone, relative);
    mkdirSync(join(this.#clone, anchor.task), { recursive: true });
    try {
      writeExclusive(path, encodeAnchor(anchor), 0o644);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new AnchorExistsError("an anchor at this seq already exists; anchors are never replaced");
      throw error;
    }
    await this.#run(["add", "--", relative]);
    await this.#run(["commit", "--quiet", "-m", `anchor ${relative}`, "--", relative]);
    await this.#push();
  }

  /**
   * Pushes, never forcing. Another service of the same runner (the hook and the gateway each anchor, D-198) may have
   * pushed since this clone pulled; the destination then refuses the push as not a fast-forward. The clone's own
   * unpushed commits each add a new file, so they are replayed onto what the destination holds and pushed again, up to
   * three times (D-199). Nothing already pushed is rewritten: the destination refuses that whatever the host holds.
   */
  async #push(): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.#run(["push", "--quiet"]);
        return;
      } catch (error: unknown) {
        if (attempt >= 3) throw error;
        await this.#run(["pull", "--rebase", "--quiet"]);
      }
    }
  }

  async list(task: string): Promise<unknown[]> {
    // D-198: an anchor committed in the clone but never pushed (a push that failed before a restart) is not off the
    // host. Push first, so what is listed is what the destination holds; a push that fails fails the listing.
    await this.#run(["pull", "--rebase", "--quiet"]);
    await this.#push();
    return readAnchorDirectory(this.#clone, task);
  }
}
