import { checkAnchors, journalPublicKeyFromPem, readAnchorDirectory, taskDigest, verifyTrajectory } from "../../journal/src/index.js";
import { type CliIo, FILE_IO } from "./grant-cli.js";

/**
 * `juno journal check` (spec §3.4.1, v0.6 C1; DECISIONS.md D-122).
 *
 *   juno journal check --journal <journal dir> --anchors <anchor dir> --key <journal-key.pub.pem> <task id>
 *
 * Verifies the task's chain, then compares it with every anchor stored for it under `<anchor dir>` (a clone of
 * `juno-anchors`, or any copy in the same layout). Prints the result as JSON: exit 0 when the chain agrees with every
 * anchor (entries after the latest anchor are reported as unanchored, not as a rewrite), 1 when it does not, 2 on bad
 * usage. It only reads.
 */

const USAGE = "usage: juno journal check --journal <journal dir> --anchors <anchor dir> --key <journal-key.pub.pem> <task id>\n";

export function runJournalCli(args: readonly string[], io: CliIo = FILE_IO, readAnchors: (dir: string, task: string) => unknown[] = readAnchorDirectory): number {
  const [command, ...rest] = args;
  const options = new Map<string, string>();
  const positional: string[] = [];
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
    } else positional.push(arg);
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
    const result = checkAnchors(task, verifyTrajectory(journal, task), readAnchors(anchors, taskDigest(task)), publicKey);
    io.out(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  } catch (error: unknown) {
    io.err(`juno journal: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

