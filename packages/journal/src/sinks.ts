import { type KeyObject, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
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

/**
 * The pinned repository could not be shown to hold what was just written, or the destination's own files were changed
 * under the running service (operator ruling D-211 item 1; D-213). Nothing this run anchors can then be taken as off
 * the host, so the session layer stops every session, not only the one whose anchor failed.
 */
export class AnchorReadBackError extends AnchorSinkError {
  override readonly name = "AnchorReadBackError";
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

async function outbound(args: readonly string[], file = "docker", env?: Readonly<Record<string, string>>, timeoutMs?: number, cwd?: string): Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer }> {
  try {
    return await executeOutbound({ file, args }, { ...(env === undefined ? {} : { env }), ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(cwd === undefined ? {} : { cwd }) });
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
  /** The git program, by its absolute path. The pin is the only place that names it (operator ruling D-211 item 1; D-213). */
  readonly git: string;
};

const ANCHOR_FILE = /^[0-9a-f]{64}\/[0-9]{12}\.json$/;

/**
 * How long one git command may run (review round 6 on PR #51, note 3; D-209): a server that never answers refuses the
 * start, as an unreachable one does, instead of holding it for ever. Two minutes covers a slow fetch of a large history.
 */
export const GIT_TIMEOUT_MS = 120_000;

/** The executable git is given as `GIT_SSH` (anchor-ssh.ts): beside this module in the built code. */
export function defaultSshWrapper(): string {
  return fileURLToPath(new URL("./juno-anchor-ssh.js", import.meta.url));
}

/**
 * A `GIT_DIR` that is no repository. A git command that needs none (`ls-remote`) then runs with no repository at
 * all, wherever they are started: no repository's configuration is read, not even one in the folder they start in
 * (shown with the real git in git-sink.test.ts; D-213).
 */
const NO_REPOSITORY = "/nonexistent/juno-no-repository";

/** The only settings a repository JUNO has just made may hold: what `git init` itself writes, and nothing that names a place or a program. */
const OWN_CONFIG_KEYS: ReadonlySet<string> = new Set(["repositoryformatversion", "filemode", "bare", "logallrefupdates", "ignorecase", "precomposeunicode", "symlinks"]);

/** Why a repository's configuration is not one `git init` alone wrote (null: it is). */
function foreignConfig(text: string): string | null {
  let section: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("[")) {
      if (line !== "[core]") return `it has a section ${line}`;
      section = line;
      continue;
    }
    const match = /^([A-Za-z]+) = (true|false|[0-9]+)$/.exec(line);
    if (section === null || match === null || !OWN_CONFIG_KEYS.has((match[1] ?? "").toLowerCase())) return `it has the line ${JSON.stringify(line)}`;
  }
  return null;
}

/** The object id git gives a file's bytes, in the repository's hash (40 hex digits: SHA-1; 64: SHA-256). */
function blobId(bytes: Buffer, length: number): string {
  return createHash(length === 64 ? "sha256" : "sha1").update(`blob ${String(bytes.length)}\0`, "utf8").update(bytes).digest("hex");
}

/**
 * The real destination (§3.4.1 v0.6.1, D-094, D-098): the operator's public `juno-anchors` repository. Each anchor is
 * one new file, one commit, one push; the repository's protection refuses any push that rewrites or deletes history, so
 * nothing the host holds can replace an anchor already pushed. A file that already exists is refused here, before
 * anything is committed.
 *
 * Which repository that is, and which git program reaches it, is not the host's to say (operator rulings D-206 item 2
 * and D-211 item 1; D-208, D-213). The program is the one the root-owned pin names. Every command names the pinned URL
 * and branch itself, never a remote the local clone configures; git runs with an environment of its own, in which no
 * user or system git configuration is read, only the pinned transport is allowed, and SSH goes through `juno-anchor-ssh`
 * with the pinned host key and push key. The local clone is a cache and is never trusted:
 *   1. at the first use in a process (a service's start), a new, empty repository is made beside the clone and the
 *      pinned branch is fetched into it from the pinned URL;
 *   2. the clone the host holds is compared with what was fetched. A clone that is behind, or equal, agrees. A clone
 *      with commits the repository lacks agrees only if they do nothing but add anchor files on top of a commit the
 *      repository has (a push that failed before a restart); those anchors are then pushed. Anything else (another
 *      repository's history, a commit that changes or removes a file, an anchor that differs from the repository's)
 *      is a clone that disagrees with the repository, and the start is refused;
 *   3. the new repository then replaces the clone, so everything read afterwards is what the pinned repository holds,
 *      and nothing of the old clone's configuration, hooks or files remains.
 *
 * The repository JUNO works in has no say either (round 7 finding F2; D-213):
 *   4. its own configuration must stay exactly what JUNO's `git init` wrote (a `[core]` section of git's own
 *      housekeeping values). It is compared before every command that runs in it; any other content, a `url.*.insteadOf`
 *      or `core.sshCommand` for instance, ends the command with `AnchorReadBackError` before git reads it;
 *   5. every anchor is read back from the pinned repository after it is pushed, and every listing is confirmed the same
 *      way: `git ls-remote` for the pinned URL, run with no repository at all (so no repository's configuration can
 *      redirect it), must name the very commit the clone is at. A commit id fixes every file in it, so the anchors then
 *      read are the ones the pinned repository holds; each file read is also checked against that commit's own record of
 *      it. If the pinned repository cannot be shown to hold the anchor, the append fails with `AnchorReadBackError`.
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
  /** How long one git command may run before it is ended and counted as a failure (review round 6, note 3). */
  readonly #timeoutMs: number;
  /** Per repository JUNO made: the configuration its own `git init` wrote, which must not change (D-213). */
  readonly #configs = new Map<string, string>();

  constructor(options: { readonly clone: string; readonly pin: PinnedRepository; readonly ssh?: { readonly wrapper?: string; readonly program?: string }; readonly timeoutMs?: number }) {
    this.#clone = parseAtBoundary("anchor repository clone", AbsolutePath, options.clone);
    if (pathsOverlap(this.#clone, WORK_NAMESPACE)) throw new AnchorSinkError(`the anchor clone ${this.#clone} lies in the capability namespace ${WORK_NAMESPACE}`);
    const pin = options.pin as PinnedRepository | undefined;
    if (pin === undefined || pin === null || typeof pin.url !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(pin.branch) || pin.url.startsWith("-")) throw new AnchorSinkError("the anchor destination needs the pinned repository address and branch (D-208)");
    if (pin.transport === "ssh" && (pin.knownHosts === null || pin.pushKey === null)) throw new AnchorSinkError("an SSH anchor repository needs the pinned host key file and push key (D-208)");
    // D-211 item 1: the git program comes from the pin and from nowhere else; it is never looked up on PATH.
    if (typeof pin.git !== "string" || !AbsolutePath.safeParse(pin.git).success) throw new AnchorSinkError("the anchor destination needs the git program the anchor pin names, as an absolute path (D-211, D-213)");
    this.#git = pin.git;
    this.#pin = pin;
    this.#timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) throw new AnchorSinkError("the git time limit must be a positive whole number of milliseconds");
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

  /**
   * Before any command runs in a repository JUNO made: its configuration is still what JUNO's `git init` wrote (D-213).
   * A repository this process did not make (the clone before the start replaced it) is never run in.
   */
  #unchanged(repo: string): void {
    const expected = this.#configs.get(repo);
    if (expected === undefined) throw new AnchorReadBackError(`no git command runs in ${repo}: it is not a repository this service made (D-213)`);
    let now: string | null;
    try {
      now = readFileSync(join(repo, ".git", "config"), "utf8");
    } catch {
      now = null;
    }
    if (now !== expected) throw new AnchorReadBackError(`the git settings of the anchor clone ${repo} were changed while the service ran; anchoring reads no settings but its own, so nothing more is anchored through it (D-211, D-213)`);
  }

  async #try(repo: string, args: readonly string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    this.#unchanged(repo);
    const result = await outbound(["-C", repo, "-c", "user.name=juno-runner", "-c", "user.email=juno-runner@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], this.#git, this.#env, this.#timeoutMs);
    // A git command ended by the time limit has no exit code: it is a failure, and says why.
    const stderr = result.exitCode === null ? `git did not finish within ${String(this.#timeoutMs / 1000)} s (the pinned anchor repository did not answer)` : result.stderr.toString("utf8");
    return { exitCode: result.exitCode, stdout: result.stdout.toString("utf8"), stderr };
  }

  async #in(repo: string, args: readonly string[]): Promise<string> {
    const result = await this.#try(repo, args);
    if (result.exitCode !== 0) throw new AnchorSinkError(`git ${args[0] ?? ""} failed: ${result.stderr.trim()}`);
    return result.stdout;
  }

  #run(args: readonly string[]): Promise<string> {
    return this.#in(this.#clone, args);
  }

  /** A git command that needs no repository, run with none: no repository's configuration is read (D-213). */
  #bare(args: readonly string[]): Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer }> {
    return outbound(args, this.#git, { ...this.#env, GIT_DIR: NO_REPOSITORY }, this.#timeoutMs, "/");
  }

  /**
   * The commit the pinned repository's branch is at, asked of the pinned URL with no repository at all, so nothing the
   * host's clone holds can answer in its place (D-211 item 1; D-213). Null when the branch does not exist yet.
   */
  async #pinnedHead(): Promise<string | null> {
    const ref = `refs/heads/${this.#pin.branch}`;
    const result = await this.#bare(["ls-remote", "--", this.#pin.url, ref]);
    if (result.exitCode !== 0) {
      const why = result.exitCode === null ? `git did not finish within ${String(this.#timeoutMs / 1000)} s` : result.stderr.toString("utf8").trim();
      throw new AnchorSinkError(`the pinned anchor repository could not be reached: ${why}`);
    }
    const lines = result.stdout.toString("utf8").split("\n").filter((line) => line !== "");
    if (lines.length === 0) return null;
    const match = /^([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(lines[0] ?? "");
    if (lines.length !== 1 || match === null || match[2] !== ref) throw new AnchorSinkError("the pinned anchor repository's answer was not one line naming the pinned branch");
    return match[1] ?? null;
  }

  /** Makes a new, empty repository and keeps what its configuration is, which must be git's own housekeeping only. */
  async #init(repo: string): Promise<void> {
    // `git init <folder>` makes the repository in the new, empty folder it is given and reads no repository's
    // configuration; it is started outside every folder (`/`). (`GIT_DIR` cannot be set here: init would make the repository there.)
    const init = await outbound(["init", "--quiet", "--template=", repo], this.#git, this.#env, this.#timeoutMs, "/");
    if (init.exitCode !== 0) throw new AnchorSinkError(`git init failed: ${init.stderr.toString("utf8").trim()}`);
    const config = readFileSync(join(repo, ".git", "config"), "utf8");
    const foreign = foreignConfig(config);
    if (foreign !== null) throw new AnchorReadBackError(`the repository git just made at ${repo} does not hold git's own settings only: ${foreign} (D-213)`);
    this.#configs.set(repo, config);
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
      await this.#init(fresh);
      // 1. What the pinned repository holds, asked with no repository's configuration in play.
      let remote = await this.#pinnedHead();
      if (remote !== null) {
        await this.#in(fresh, ["fetch", "--quiet", "--no-tags", "--", this.#pin.url, `+refs/heads/${this.#pin.branch}:refs/juno/remote`]);
        const fetched = (await this.#in(fresh, ["rev-parse", "--verify", "refs/juno/remote^{commit}"])).trim();
        // The branch may have moved between the two (another service anchoring): then what was fetched is what counts,
        // and it is confirmed against the pinned repository once more below.
        remote = fetched;
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
      this.#configs.set(this.#clone, this.#configs.get(fresh) ?? "");
      this.#configs.delete(fresh);
      this.#born = remote !== null;
    } catch (error: unknown) {
      this.#configs.delete(fresh);
      rmSync(fresh, { recursive: true, force: true });
      throw error;
    }
    await this.#confirmed();
    await this.#appendOnly();
  }

  /**
   * Compares the clone the host holds with the repository as fetched into `fresh` (at `remote`, or null when the
   * pinned branch does not exist yet). Stages, in `fresh`, every anchor the clone holds in commits the repository
   * lacks, and answers how many; throws when the clone disagrees with the repository. The clone is only ever read as
   * data, from inside `fresh`: no command runs in it, so its own configuration is never read.
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
      if ((await this.#pinnedHead()) === null) return;
      this.#born = true;
    }
    await this.#run(["pull", "--rebase", "--quiet", "--no-tags", "--", this.#pin.url, this.#pin.branch]);
  }

  async append(anchor: Anchor): Promise<void> {
    await this.#start();
    await this.#sync();
    const relative = anchorPath(anchor.task, anchor.seq);
    const path = join(this.#clone, relative);
    const text = encodeAnchor(anchor);
    mkdirSync(join(this.#clone, anchor.task), { recursive: true });
    try {
      writeExclusive(path, text, 0o644);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new AnchorExistsError("an anchor at this seq already exists; anchors are never replaced");
      throw error;
    }
    await this.#run(["add", "--", relative]);
    await this.#run(["commit", "--quiet", "-m", `anchor ${relative}`, "--", relative]);
    await this.#push();
    // D-211 item 1: the anchor is read back from the pinned repository; until it is, it is not off the host.
    let head: string | null;
    let held: string;
    try {
      head = await this.#confirmed();
      held = head === null ? "" : await this.#in(this.#clone, ["cat-file", "blob", `${head}:${relative}`]);
    } catch (error: unknown) {
      if (error instanceof AnchorReadBackError) throw error;
      throw new AnchorReadBackError(`the anchor ${relative} was pushed, but could not be read back from the pinned repository: ${error instanceof Error ? error.message : String(error)} (D-211, D-213)`);
    }
    if (held !== text) throw new AnchorReadBackError(`the anchor ${relative} was pushed, but the pinned repository does not hold it as written (D-211, D-213)`);
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
        if (attempt >= 3 || error instanceof AnchorReadBackError) throw error;
        await this.#sync();
      }
    }
  }

  /**
   * The read-back (operator ruling D-211 item 1; D-213). Answers the commit the clone is at once the pinned repository,
   * asked with no repository's configuration in play (`#pinnedHead`), names that very commit for the pinned branch;
   * null when neither holds anything yet. Another service of the same runner may have pushed in between, so the clone
   * is brought up to the repository and asked again, up to three times. A clone that still is not where the pinned
   * repository is has not been shown to be off the host: `AnchorReadBackError`.
   */
  async #confirmed(): Promise<string | null> {
    for (let attempt = 1; ; attempt += 1) {
      const pinned = await this.#pinnedHead();
      const local = await this.#try(this.#clone, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
      const here = local.exitCode === 0 ? local.stdout.trim() : null;
      if (pinned === here) return here;
      if (attempt >= 3) throw new AnchorReadBackError(`the pinned anchor repository's branch is at ${pinned ?? "nothing"}, and the local clone at ${here ?? "nothing"}, after pushing: what was pushed did not reach the pinned repository (D-211, D-213)`);
      if (pinned !== null) this.#born = true;
      await this.#sync();
      await this.#push();
    }
  }

  /** What every listing does first: the start's comparison (once), then fetch, push what is pending, read back, and read the history. */
  async #current(): Promise<string | null> {
    const first = this.#started === null;
    await this.#start();
    // D-198: an anchor committed in the clone but never pushed is not off the host. Push first, so what is listed is
    // what the destination holds; a push that fails fails the listing.
    await this.#sync();
    await this.#push();
    const head = await this.#confirmed();
    if (!first) await this.#appendOnly();
    return head;
  }

  /**
   * The anchors of `tasks` as the confirmed commit `head` records them. The commit's own list of files is read
   * (`git ls-tree`), and each anchor file in the clone must be the very bytes that list names; a file changed, added or
   * removed in the clone's folder is therefore never read as an anchor (D-213).
   */
  async #read(head: string | null, tasks: readonly string[]): Promise<Map<string, unknown[]>> {
    const listed = new Map<string, unknown[]>(tasks.map((task) => [TaskDigest.parse(task), []]));
    if (head === null) return listed;
    const tree = await this.#in(this.#clone, ["ls-tree", "-r", "--full-tree", head]);
    const files: { readonly task: string; readonly path: string; readonly id: string }[] = [];
    for (const line of tree.split("\n")) {
      const match = /^100644 blob ([0-9a-f]{40}|[0-9a-f]{64})\t([0-9a-f]{64})\/([0-9]{12}\.json)$/.exec(line);
      if (match === null || !listed.has(match[2] ?? "")) continue;
      files.push({ task: match[2] ?? "", path: `${match[2] ?? ""}/${match[3] ?? ""}`, id: match[1] ?? "" });
    }
    for (const file of files.sort((a, b) => (a.path < b.path ? -1 : 1))) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(this.#clone, file.path));
      } catch {
        throw new AnchorReadBackError(`the anchor ${file.path} is in the pinned repository but not in the local clone's folder: the clone was changed under the service (D-213)`);
      }
      if (blobId(bytes, file.id.length) !== file.id) throw new AnchorReadBackError(`the anchor ${file.path} in the local clone's folder is not the one the pinned repository holds: the clone was changed under the service (D-213)`);
      listed.get(file.task)?.push(JSON.parse(bytes.toString("utf8")) as unknown);
    }
    return listed;
  }

  async list(task: string): Promise<unknown[]> {
    const digest = TaskDigest.parse(task);
    return (await this.#read(await this.#current(), [digest])).get(digest) ?? [];
  }

  /** One fetch, one push and one read-back; then every task is read from the commit the pinned repository confirmed. */
  async listMany(tasks: readonly string[]): Promise<Map<string, unknown[]>> {
    return this.#read(await this.#current(), tasks);
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
