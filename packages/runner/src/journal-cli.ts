import { anchorHistoryVerdict, checkAnchors, HISTORY_GIT, journalPublicKeyFromPem, junoProgramText, readAnchorDirectory, taskDigest, verifyTrajectory } from "../../journal/src/index.js";
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

const USAGE = `usage: ${junoProgramText()} journal check --journal <journal dir> --anchors <anchor clone> --key <journal-key.pub.pem> [--no-history] <task id>\n`;

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
