import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkAnchors, journalPublicKeyFromPem, readAnchorDirectory, taskDigest, verifyTrajectory } from "../../journal/src/index.js";
import { executeOutbound } from "../../registry/src/index.js";
import { type CliIo, FILE_IO } from "./grant-cli.js";

/**
 * `juno journal check` (spec §3.4.1, v0.6 C1; DECISIONS.md D-122, D-217).
 *
 *   juno journal check --journal <journal dir> --anchors <anchor clone> --key <journal-key.pub.pem> [--no-history] <task id>
 *
 * Verifies the task's chain, then compares it with every anchor stored for it under `<anchor clone>` (a fresh clone of
 * `juno-anchors`). Prints the result as JSON: exit 0 when the chain agrees with every anchor (entries after the latest
 * anchor are reported as unanchored, not as a rewrite), 1 when it does not, 2 on bad usage. It only reads.
 *
 * The anchors are only as good as their history (§3.4.1: "anyone can check that history was not rewritten"; D-204). An
 * ordinary commit by whoever holds the push key can replace anchor files, which the repository's protection does not
 * refuse; with the journal and its key replaced to match, the files alone would agree. So, as the services do at every
 * start (D-204, D-205), the check refuses unless `<anchor clone>` is a full, unmodified git clone whose history never
 * deleted, changed, renamed or retyped an anchor file (D-217, review round 1 of PR #54). `--no-history` checks a plain
 * copy instead and says so in the result (`"history": "not_checked"`); it is not the operator's check.
 */

const USAGE = "usage: juno journal check --journal <journal dir> --anchors <anchor clone> --key <journal-key.pub.pem> [--no-history] <task id>\n";

/** Anchor files, as the anchor repository lays them out (`<task digest>/<seq>.json`). */
const ANCHOR_FILE = /^[0-9a-f]{64}\/[0-9]{12}\.json$/;

/** The git program: root's own (guide, Part E step 3 checks it). */
export const HISTORY_GIT = "/usr/bin/git";

/** Git with none of the caller's environment and no user or system settings (the check runs under `env -i`). */
const GIT_ENV: Readonly<Record<string, string>> = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", PATH: "/usr/bin:/bin" };

export type HistoryVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Judges the anchor clone's history (D-217). Refuses a folder that is not a git repository, a shallow clone (its history
 * is not all there), a clone whose files differ from its commit (what is read must be what was committed), and a
 * history in which any commit, merges included, deleted, changed or retyped an anchor file; a rename is read as the
 * deletion it is (`--no-renames`, D-205).
 */
export async function anchorHistoryVerdict(dir: string, git = HISTORY_GIT): Promise<HistoryVerdict> {
  if (!existsSync(join(dir, ".git"))) return { ok: false, reason: `${dir} is not a git clone of the anchor repository, so its history cannot be checked; clone juno-anchors from GitHub (or pass --no-history for a plain copy, which is not the operator's check)` };
  const run = async (args: readonly string[]): Promise<{ readonly ok: boolean; readonly out: string; readonly err: string }> => {
    try {
      const result = await executeOutbound({ file: git, args: ["-C", dir, ...args] }, { env: GIT_ENV, timeoutMs: 120_000 });
      return { ok: result.exitCode === 0, out: result.stdout.toString("utf8"), err: result.stderr.toString("utf8").trim() };
    } catch (error: unknown) {
      return { ok: false, out: "", err: error instanceof Error ? error.message : String(error) };
    }
  };
  const shallow = await run(["rev-parse", "--is-shallow-repository"]);
  if (!shallow.ok) return { ok: false, reason: `the anchor clone's history could not be read: ${shallow.err}` };
  if (shallow.out.trim() !== "false") return { ok: false, reason: "the anchor clone is shallow: its history is not all there; clone it without --depth" };
  const status = await run(["status", "--porcelain", "--untracked-files=all", "--ignored=no"]);
  if (!status.ok) return { ok: false, reason: `the anchor clone's files could not be compared with its commit: ${status.err}` };
  if (status.out.trim() !== "") return { ok: false, reason: `the anchor clone's files differ from its commit (${status.out.trim().split("\n")[0] ?? ""}); clone it afresh` };
  const head = await run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!head.ok) return { ok: false, reason: "the anchor clone holds no commit" };
  const log = await run(["log", "-m", "--no-renames", "--diff-filter=DMT", "--format=", "--name-only"]);
  if (!log.ok) return { ok: false, reason: `the anchor repository's history could not be read: ${log.err}` };
  const touched = [...new Set(log.out.split("\n").map((line) => line.trim()).filter((line) => ANCHOR_FILE.test(line)))];
  if (touched.length > 0) return { ok: false, reason: `the anchor repository's history removes or changes ${String(touched.length)} anchor file(s) (${touched[0] ?? ""}); anchors are only ever added, so this repository can no longer vouch for the journal (§3.4.1, D-204)` };
  return { ok: true };
}

export async function runJournalCli(args: readonly string[], io: CliIo = FILE_IO, readAnchors: (dir: string, task: string) => unknown[] = readAnchorDirectory, git = HISTORY_GIT): Promise<number> {
  const [command, ...rest] = args;
  const options = new Map<string, string>();
  const positional: string[] = [];
  let noHistory = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    if (arg === "--journal" || arg === "--anchors" || arg === "--key") {
      const value = rest[index + 1];
      if (value === undefined || options.has(arg)) {
        io.err(USAGE);
        return 2;
      }
      options.set(arg, value);
      index += 1;
    } else if (arg === "--no-history" && !noHistory) noHistory = true;
    else positional.push(arg);
  }
  const journal = options.get("--journal");
  const anchors = options.get("--anchors");
  const key = options.get("--key");
  const [task, ...extra] = positional;
  if (command !== "check" || journal === undefined || anchors === undefined || key === undefined || task === undefined || extra.length > 0) {
    io.err(USAGE);
    return 2;
  }
  try {
    const publicKey = journalPublicKeyFromPem(io.readFile(key));
    if (!noHistory) {
      const history = await anchorHistoryVerdict(anchors, git);
      if (!history.ok) {
        io.out(`${JSON.stringify({ ok: false, history: "refused", failure: { code: "anchor_history", reason: history.reason } }, null, 2)}\n`);
        return 1;
      }
    }
    const result = checkAnchors(task, verifyTrajectory(journal, task), readAnchors(anchors, taskDigest(task)), publicKey);
    io.out(`${JSON.stringify({ ...result, history: noHistory ? "not_checked" : "checked" }, null, 2)}\n`);
    return result.ok ? 0 : 1;
  } catch (error: unknown) {
    io.err(`juno journal: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
