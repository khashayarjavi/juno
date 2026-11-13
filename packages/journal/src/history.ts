import { existsSync } from "node:fs";
import { join } from "node:path";
import { executeOutbound } from "../../registry/src/index.js";

/**
 * The operator's check of an anchor clone's history (§3.4.1: "anyone can check that history was not rewritten"; D-204,
 * D-205, D-217). The services refuse, at every start, an anchor repository whose history ever removed or changed an
 * anchor file (`GitAnchorSink`); `juno journal check` applies the same rule to the fresh clone the operator makes, so
 * anchor files replaced by an ordinary commit cannot vouch for a forged journal. It lives here, beside the anchor
 * destination, because the runner package never runs a program.
 */

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

