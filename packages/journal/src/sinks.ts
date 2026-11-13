import { type KeyObject, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AbsolutePath, WORK_NAMESPACE, parseAtBoundary, pathsOverlap } from "../../contracts/src/index.js";
import { type Anchor, TaskDigest, anchorPath, encodeAnchor } from "./anchor.js";
import { SSH_ENVIRONMENT } from "./anchor-ssh.js";
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
  /**
   * The stored anchors of several tasks, read from the destination once (a service's start-up check of its whole
   * journal, D-202). A destination that cannot be reached fails the whole listing.
   */
  listMany(tasks: readonly string[]): Promise<Map<string, unknown[]>>;
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

  async listMany(tasks: readonly string[]): Promise<Map<string, unknown[]>> {
    const listed = new Map<string, unknown[]>();
    for (const task of tasks) listed.set(task, await this.list(task));
    return listed;
  }
}

async function outbound(args: readonly string[], file = "docker", env?: Readonly<Record<string, string>>): Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer }> {
  try {
    return await executeOutbound({ file, args }, env === undefined ? {} : { env });
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

/** The anchor repository as the verified anchor pin names it (D-208); enforcement's `VerifiedPin` has these fields. */
export type PinnedRepository = {
  readonly url: string;
  readonly branch: string;
  readonly transport: "ssh" | "local";
  readonly knownHosts: string | null;
  readonly pushKey: string | null;
};

const ANCHOR_FILE = /^[0-9a-f]{64}\/[0-9]{12}\.json$/;

/** The executable git is given as `GIT_SSH` (anchor-ssh.ts): beside this module in the built code. */
export function defaultSshWrapper(): string {
  return fileURLToPath(new URL("./juno-anchor-ssh.js", import.meta.url));
}

/**
 * The real destination (§3.4.1 v0.6.1, D-094, D-098): the operator's public `juno-anchors` repository. Each anchor is
 * one new file, one commit, one push; the repository's protection refuses any push that rewrites or deletes history, so
 * nothing the host holds can replace an anchor already pushed. A file that already exists is refused here, before
 * anything is committed.
 *
 * Which repository that is, is not the host's to say (operator ruling D-206 item 2; D-208). Every command names the
 * pinned URL and branch itself, never a remote the local clone configures; git runs with an environment of its own, in
 * which no user or system git configuration is read, only the pinned transport is allowed, and SSH goes through
 * `juno-anchor-ssh` with the pinned host key and push key. The local clone is a cache and is never trusted:
 *   1. at the first use in a process (a service's start), a new, empty repository is made beside the clone and the
 *      pinned branch is fetched into it from the pinned URL;
 *   2. the clone the host holds is compared with what was fetched. A clone that is behind, or equal, agrees. A clone
 *      with commits the repository lacks agrees only if they do nothing but add anchor files on top of a commit the
 *      repository has (a push that failed before a restart); those anchors are then pushed. Anything else (another
 *      repository's history, a commit that changes or removes a file, an anchor that differs from the repository's)
 *      is a clone that disagrees with the repository, and the start is refused;
 *   3. the new repository then replaces the clone, so everything read afterwards is what the pinned repository holds,
 *      and nothing of the old clone's configuration, hooks or files remains.
 */
export class GitAnchorSink implements AnchorSink {
  readonly #clone: string;
  readonly #git: string;
  readonly #pin: PinnedRepository;
  readonly #env: Readonly<Record<string, string>>;
  /** The start's fetch and comparison, run once per process; a failed one is run again at the next use. */
  #started: Promise<void> | null = null;
  /** Whether the pinned branch exists in the repository. */
  #born = false;

  constructor(options: { readonly clone: string; readonly git?: string; readonly pin: PinnedRepository; readonly ssh?: { readonly wrapper?: string; readonly program?: string } }) {
    this.#clone = parseAtBoundary("anchor repository clone", AbsolutePath, options.clone);
    if (pathsOverlap(this.#clone, WORK_NAMESPACE)) throw new AnchorSinkError(`the anchor clone ${this.#clone} lies in the capability namespace ${WORK_NAMESPACE}`);
    this.#git = options.git ?? "git";
    const pin = options.pin as PinnedRepository | undefined;
    if (pin === undefined || pin === null || typeof pin.url !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(pin.branch) || pin.url.startsWith("-")) throw new AnchorSinkError("the anchor destination needs the pinned repository address and branch (D-208)");
    if (pin.transport === "ssh" && (pin.knownHosts === null || pin.pushKey === null)) throw new AnchorSinkError("an SSH anchor repository needs the pinned host key file and push key (D-208)");
    this.#pin = pin;
    // Git's whole environment (D-208): nothing of the runner's own (no GIT_* variable, no HOME configuration) reaches it.
    this.#env = {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: "/nonexistent",
      LC_ALL: "C",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: pin.transport === "ssh" ? "ssh:file" : "file",
      ...(pin.transport === "ssh"
        ? {
            GIT_SSH: options.ssh?.wrapper ?? defaultSshWrapper(),
            GIT_SSH_VARIANT: "ssh",
            [SSH_ENVIRONMENT.program]: options.ssh?.program ?? "/usr/bin/ssh",
            [SSH_ENVIRONMENT.knownHosts]: pin.knownHosts ?? "",
            [SSH_ENVIRONMENT.pushKey]: pin.pushKey ?? "",
          }
        : {}),
    };
  }

  #refspec(): string {
    return `HEAD:refs/heads/${this.#pin.branch}`;
  }

  async #try(repo: string, args: readonly string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const result = await outbound(["-C", repo, "-c", "user.name=juno-runner", "-c", "user.email=juno-runner@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], this.#git, this.#env);
    return { exitCode: result.exitCode, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") };
  }

  async #in(repo: string, args: readonly string[]): Promise<string> {
    const result = await this.#try(repo, args);
    if (result.exitCode !== 0) throw new AnchorSinkError(`git ${args[0] ?? ""} failed: ${result.stderr.trim()}`);
    return result.stdout;
  }

  #run(args: readonly string[]): Promise<string> {
    return this.#in(this.#clone, args);
  }

  /** The start's fetch and comparison (see the class comment), once per process. */
  #start(): Promise<void> {
    this.#started ??= this.#fetchAndCompare().catch((error: unknown) => {
      this.#started = null;
      throw error;
    });
    return this.#started;
  }

  async #fetchAndCompare(): Promise<void> {
    const parent = dirname(this.#clone);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    // A start that was cut off may have left its new repository behind; it was never used.
    for (const name of readdirSync(parent)) if (name.startsWith(`${basename(this.#clone)}.fetch-`)) rmSync(join(parent, name), { recursive: true, force: true });
    const fresh = `${this.#clone}.fetch-${randomBytes(8).toString("hex")}`;
    mkdirSync(fresh, { mode: 0o700 });
    try {
      const init = await outbound(["init", "--quiet", fresh], this.#git, this.#env);
      if (init.exitCode !== 0) throw new AnchorSinkError(`git init failed: ${init.stderr.toString("utf8").trim()}`);
      // 1. What the pinned repository holds.
      const listed = await this.#try(fresh, ["ls-remote", "--", this.#pin.url, `refs/heads/${this.#pin.branch}`]);
      if (listed.exitCode !== 0) throw new AnchorSinkError(`the pinned anchor repository could not be reached: ${listed.stderr.trim()}`);
      let remote: string | null = null;
      if (listed.stdout.trim() !== "") {
        await this.#in(fresh, ["fetch", "--quiet", "--no-tags", "--", this.#pin.url, `+refs/heads/${this.#pin.branch}:refs/juno/remote`]);
        remote = (await this.#in(fresh, ["rev-parse", "--verify", "refs/juno/remote^{commit}"])).trim();
        await this.#in(fresh, ["reset", "--hard", "--quiet", remote]);
      }
      // 2. The clone the host holds, compared with it.
      const replayed = await this.#compareCache(fresh, remote);
      if (replayed > 0) {
        await this.#in(fresh, ["commit", "--quiet", "-m", `anchors the local clone held and the repository lacked (${String(replayed)})`]);
        await this.#in(fresh, ["push", "--quiet", "--", this.#pin.url, this.#refspec()]);
        remote = (await this.#in(fresh, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
      }
      // 3. The fetched repository becomes the clone.
      rmSync(this.#clone, { recursive: true, force: true });
      renameSync(fresh, this.#clone);
      this.#born = remote !== null;
    } catch (error: unknown) {
      rmSync(fresh, { recursive: true, force: true });
      throw error;
    }
    await this.#appendOnly();
  }

  /**
   * Compares the clone the host holds with the repository as fetched into `fresh` (at `remote`, or null when the
   * pinned branch does not exist yet). Stages, in `fresh`, every anchor the clone holds in commits the repository
   * lacks, and answers how many; throws when the clone disagrees with the repository.
   */
  async #compareCache(fresh: string, remote: string | null): Promise<number> {
    let entries: string[];
    try {
      entries = readdirSync(this.#clone);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
      throw new AnchorSinkError(`the local anchor clone ${this.#clone} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (entries.length === 0) return 0;
    const disagrees = (why: string): AnchorSinkError => new AnchorSinkError(`the local anchor clone ${this.#clone} disagrees with the pinned repository: ${why}. Nothing was changed; keep the clone as evidence and tell the operator (D-206, D-208)`);
    const head = await this.#try(fresh, ["ls-remote", "--", this.#clone, "HEAD"]);
    if (head.exitCode !== 0) throw disagrees("it is not a git repository that can be read");
    if (head.stdout.trim() === "") return 0;
    const fetched = await this.#try(fresh, ["fetch", "--quiet", "--no-tags", "--", this.#clone, "+HEAD:refs/juno/cache"]);
    if (fetched.exitCode !== 0) throw disagrees("its history cannot be read");
    const local = (await this.#in(fresh, ["rev-parse", "--verify", "refs/juno/cache^{commit}"])).trim();
    if (local === remote) return 0;
    let base: string | null = null;
    if (remote !== null) {
      if ((await this.#try(fresh, ["merge-base", "--is-ancestor", local, remote])).exitCode === 0) return 0;
      const merge = await this.#try(fresh, ["merge-base", local, remote]);
      if (merge.exitCode !== 0 || merge.stdout.trim() === "") throw disagrees("it shares no history with the pinned repository, so it is a clone of something else");
      base = merge.stdout.trim();
    }
    // Commits the repository lacks may only add anchor files.
    const range = base === null ? [local] : [`${base}..${local}`];
    const changes = (await this.#in(fresh, ["log", "-m", "--no-renames", "--format=", "--name-status", ...range])).split("\n").map((line) => line.trim()).filter((line) => line !== "");
    const added = new Set<string>();
    for (const line of changes) {
      const [status, path, ...rest] = line.split("\t");
      if (status !== "A" || path === undefined || rest.length > 0 || !ANCHOR_FILE.test(path)) throw disagrees(`it holds a commit the repository lacks that does more than add an anchor (${line.replace(/\s+/g, " ")})`);
      added.add(path);
    }
    let staged = 0;
    for (const path of [...added].sort()) {
      const content = await this.#in(fresh, ["cat-file", "blob", `${local}:${path}`]);
      const target = join(fresh, path);
      if (existsSync(target)) {
        if (readFileSync(target, "utf8") !== content) throw disagrees(`it holds an anchor at ${path} that differs from the repository's`);
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeExclusive(target, content, 0o644);
      await this.#in(fresh, ["add", "--", path]);
      staged += 1;
    }
    return staged;
  }

  /** Brings the clone up to the pinned repository's branch, replaying its own unpushed anchors on top. */
  async #sync(): Promise<void> {
    if (!this.#born) {
      const listed = await this.#try(this.#clone, ["ls-remote", "--", this.#pin.url, `refs/heads/${this.#pin.branch}`]);
      if (listed.exitCode !== 0) throw new AnchorSinkError(`the pinned anchor repository could not be reached: ${listed.stderr.trim()}`);
      if (listed.stdout.trim() === "") return;
      this.#born = true;
    }
    await this.#run(["pull", "--rebase", "--quiet", "--no-tags", "--", this.#pin.url, this.#pin.branch]);
  }

  async append(anchor: Anchor): Promise<void> {
    await this.#start();
    await this.#sync();
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
   * Pushes to the pinned URL, never forcing. Another service of the same runner (the hook and the gateway each anchor,
   * D-198) may have pushed since this clone fetched; the destination then refuses the push as not a fast-forward. The
   * clone's own unpushed commits each add a new file, so they are replayed onto what the destination holds and pushed
   * again, up to three times (D-199). Nothing already pushed is rewritten: the destination refuses that whatever the
   * host holds.
   */
  async #push(): Promise<void> {
    // Nothing committed yet (an empty repository on its first start): nothing to push.
    if ((await this.#try(this.#clone, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).exitCode !== 0) return;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.#run(["push", "--quiet", "--", this.#pin.url, this.#refspec()]);
        this.#born = true;
        return;
      } catch (error: unknown) {
        if (attempt >= 3) throw error;
        await this.#sync();
      }
    }
  }

  /** What every listing does first: the start's comparison (once), then fetch, push what is pending, and read the history. */
  async #current(): Promise<void> {
    const first = this.#started === null;
    await this.#start();
    // D-198: an anchor committed in the clone but never pushed is not off the host. Push first, so what is listed is
    // what the destination holds; a push that fails fails the listing.
    await this.#sync();
    await this.#push();
    if (!first) await this.#appendOnly();
  }

  async list(task: string): Promise<unknown[]> {
    await this.#current();
    return readAnchorDirectory(this.#clone, task);
  }

  /** One fetch and one push, then every task is read from the clone, which now holds what the destination holds. */
  async listMany(tasks: readonly string[]): Promise<Map<string, unknown[]>> {
    await this.#current();
    return new Map(tasks.map((task) => [task, readAnchorDirectory(this.#clone, task)]));
  }

  /**
   * The destination's protection keeps every commit, but an ordinary commit can still remove or change an anchor file,
   * and the files are what is read (D-204). So the whole history is read too: anchors are only ever added, and a
   * history in which any commit (a merge included) deletes, changes or renames an anchor file is not a destination the
   * journal can be checked against. Rename detection is turned off (`--no-renames`), so a renamed anchor is listed as
   * what it is here, a file deleted under its own name (D-205); with it on, git lists only the new name.
   * Such a commit can never be taken back out of a protected history, so the refusal
   * stays until the operator acts. A history that cannot be read is refused the same way.
   */
  async #appendOnly(): Promise<void> {
    if ((await this.#try(this.#clone, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).exitCode !== 0) return;
    const result = await this.#try(this.#clone, ["log", "-m", "--no-renames", "--diff-filter=DMT", "--format=", "--name-only"]);
    if (result.exitCode !== 0) throw new AnchorSinkError(`the anchor repository's history could not be read: ${result.stderr.trim()}`);
    const touched = [...new Set(result.stdout.split("\n").map((line) => line.trim()).filter((line) => ANCHOR_FILE.test(line)))];
    if (touched.length > 0) {
      throw new AnchorSinkError(`the anchor repository's history removes or changes ${String(touched.length)} anchor file(s) (${touched[0] ?? ""}); anchors are only ever added, so this repository can no longer vouch for the journal (§3.4.1, D-204)`);
    }
  }
}
