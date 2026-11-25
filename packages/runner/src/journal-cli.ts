import { anchorHistoryVerdict, checkAnchors, HISTORY_GIT, journalPublicKeyFromPem, displayLine, junoProgramText, operatorText, readAnchorDirectory, taskDigest, verifyTrajectory } from "../../journal/src/index.js";
import { type CliIo, FILE_IO } from "./grant-cli.js";
import { journalReport, reportJson, reportText } from "./journal-report.js";

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
 *
 *   juno journal report --journal <journal dir> --anchors <anchor clone> --key <journal-key.pub.pem> [--no-history] [--json]
 *
 * A read-only summary of the whole journal for the operator's weekly review (D-254; `journal-report.ts`). It runs the
 * same history check, then verifies every record against the anchors before it reports anything, and refuses an
 * unverified journal (exit 1). Plain text, or JSON with `--json`.
 */

const USAGE = `usage: ${junoProgramText()} journal check --journal <journal dir> --anchors <anchor clone> --key <journal-key.pub.pem> [--no-history] <task id>\n       ${junoProgramText()} journal report --journal <journal dir> --anchors <anchor clone> --key <journal-key.pub.pem> [--no-history] [--json]\n`;

export async function runJournalCli(args: readonly string[], io: CliIo = FILE_IO, readAnchors: (dir: string, task: string) => unknown[] = readAnchorDirectory, git = HISTORY_GIT): Promise<number> {
  const [command, ...rest] = args;
  const options = new Map<string, string>();
  const positional: string[] = [];
  let noHistory = false;
  let json = false;
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
    else if (arg === "--json" && command === "report" && !json) json = true;
    else if (arg.startsWith("--")) {
      // An option this command does not take (or one given twice) is bad usage, never a task id (D-254).
      io.err(USAGE);
      return 2;
    } else positional.push(arg);
  }
  const journal = options.get("--journal");
  const anchors = options.get("--anchors");
  const key = options.get("--key");
  const [task, ...extra] = positional;
  if (command === "report" && journal !== undefined && anchors !== undefined && key !== undefined && positional.length === 0) return report(io, journal, anchors, key, noHistory, json, readAnchors, git);
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
    // D-250: printed as every refusal line is (D-249).
    io.err(`juno journal: ${displayLine(operatorText(error instanceof Error ? error.message : String(error)))}\n`);
    return 1;
  }
}

/** `juno journal report` (D-254): the history check, then the verified summary; an unverified journal is refused. */
async function report(io: CliIo, journal: string, anchors: string, key: string, noHistory: boolean, json: boolean, readAnchors: (dir: string, task: string) => unknown[], git: string): Promise<number> {
  try {
    const publicKey = journalPublicKeyFromPem(io.readFile(key));
    if (!noHistory) {
      const history = await anchorHistoryVerdict(anchors, git);
      if (!history.ok) {
        const refused = { ok: false as const, refused: `the anchor clone's history cannot be trusted: ${history.reason}; nothing is reported for a journal that does not verify (D-217)` };
        io.out(json ? reportJson(refused) : printed(reportText(refused)));
        return 1;
      }
    }
    const result = journalReport(journal, (digest) => readAnchors(anchors, digest), publicKey, noHistory ? "not_checked" : "checked");
    io.out(json ? reportJson(result) : printed(reportText(result)));
    return result.ok ? 0 : 1;
  } catch (error: unknown) {
    io.err(`juno journal: ${displayLine(operatorText(error instanceof Error ? error.message : String(error)))}\n`);
    return 1;
  }
}

/** Each line as every refusal line is printed (D-249): nothing in it a terminal acts on. */
function printed(text: string): string {
  return text.split("\n").map(displayLine).join("\n");
}
