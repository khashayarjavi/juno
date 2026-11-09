import { z } from "zod";
import { type AbsolutePath, type DataClass, DataClass as DataClassSchema } from "../../contracts/src/index.js";
import { CheckpointStore as Store, type CheckpointStore, ManifestEntry, type Workspace, checkpointId, sameManifest, workloadWorkspace } from "../../enforcement/src/index.js";
import { type EntryDraft, JournalWriter as Writer, canonicalJson, readPayload, readTrajectory } from "../../journal/src/index.js";
import { type CliIo, FILE_IO } from "./grant-cli.js";
import { acquireRunnerLock } from "./lock.js";

/**
 * Restoring a reversible workspace (spec §2.2.2, v0.6 A1: "restoring that checkpoint is an operator action recorded in
 * the journal"; DECISIONS.md D-136, D-138).
 *
 * The operator names the task and the checkpoint. The checkpoint's manifest is read from the task's own verified
 * journal, never from anything the task wrote. Its bytes come from the checkpoint store, each checked against its hash.
 * The manifest is written back where the effects run, the workspace is listed again and compared with the manifest,
 * and a `checkpoint_restore` note, with the operator as its actor, records the outcome. Nothing else runs meanwhile:
 * the CLI holds the journal's runner lock, and the runner refuses while the task is its active one.
 */

const AdmissionNote = z.object({ type: z.literal("admission"), task: z.object({ principal: z.string() }) });
const CheckpointNote = z.object({ type: z.literal("checkpoint"), root: z.string(), checkpoint: z.string(), manifest: z.array(ManifestEntry) });

export type RestoreOutcome = { readonly ok: true; readonly root: string } | { readonly ok: false; readonly reason: string };

const encoder = new TextEncoder();

/**
 * Where the restore is read from and recorded: the runner's shared session layer (D-194) when the runner restores, or
 * the operator's journal handle when `juno checkpoint restore` does.
 */
export type JournalAccess = {
  readonly root: string;
  append(taskId: string, kind: EntryDraft["kind"], dataClass: DataClass, payload: unknown, options: { readonly actor: string }): number;
};

/** `juno checkpoint restore`'s journal handle: an operator action recorded in the journal (§2.2.2), not a service. */
export function operatorJournal(writer: Writer): JournalAccess {
  return {
    root: writer.root,
    append: (taskId, kind, dataClass, payload, options) =>
      writer.append(taskId, { kind, actor: options.actor, provider: null, data_class: dataClass, cost: { tokens_in: 0, tokens_out: 0, tokens_cached: 0, currency: 0, duration_ms: 0 } }, encoder.encode(canonicalJson(payload))).seq,
  };
}

function payloadOf(journal: JournalAccess, ref: string): unknown {
  const blob = readPayload(journal.root, ref);
  if (blob.status !== "present") return null;
  return JSON.parse(new TextDecoder().decode(blob.bytes));
}

/** Restores `checkpoint` of task `taskId` as `principal`, the task's principal, and journals what happened. */
export async function restoreCheckpoint(
  journal: JournalAccess,
  checkpoints: { readonly workspace: Workspace; readonly store: CheckpointStore },
  taskId: string,
  checkpoint: string,
  principal: string,
): Promise<RestoreOutcome> {
  // The chain is verified as it is read; an unverifiable journal is never trusted for a manifest (D-056).
  const entries = readTrajectory(journal.root, taskId);
  const [first] = entries;
  const admission = first === undefined ? null : AdmissionNote.safeParse(payloadOf(journal, first.payload_ref));
  if (admission === null || !admission.success) return { ok: false, reason: `task ${taskId} has no admitted trajectory` };
  if (admission.data.task.principal !== principal) return { ok: false, reason: `only the task's principal may restore its checkpoints (§2.2.2)` };
  let found: { root: string; manifest: ManifestEntry[]; data_class: z.infer<typeof DataClassSchema> } | null = null;
  for (const entry of entries) {
    if (entry.kind !== "note") continue;
    const note = CheckpointNote.safeParse(payloadOf(journal, entry.payload_ref));
    if (note.success && note.data.checkpoint === checkpoint) found = { root: note.data.root, manifest: note.data.manifest, data_class: entry.data_class };
  }
  if (found === null) return { ok: false, reason: `task ${taskId} has no checkpoint ${checkpoint}` };
  // The id is the manifest's hash, so a manifest that does not match it is not this checkpoint.
  if (checkpointId(found.root, found.manifest) !== checkpoint) return { ok: false, reason: `checkpoint ${checkpoint} does not match its manifest` };
  const { root, manifest, data_class: dataClass } = found;

  let outcome: RestoreOutcome;
  let restored: { ok: true } | { ok: false; reason: string };
  try {
    restored = await checkpoints.workspace.restore(root, manifest, (hash) => checkpoints.store.get(hash));
  } catch (error: unknown) {
    restored = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!restored.ok) outcome = { ok: false, reason: restored.reason };
  else {
    const after = await checkpoints.workspace.list(root, false);
    if (!after.ok) outcome = { ok: false, reason: `the restored workspace could not be listed: ${after.reason}` };
    else if (!sameManifest(after.snapshot.manifest, manifest)) outcome = { ok: false, reason: "the restored workspace does not match the checkpoint" };
    else outcome = { ok: true, root };
  }
  journal.append(taskId, "note", dataClass, { type: "checkpoint_restore", checkpoint, root, principal, outcome: outcome.ok ? "restored" : "failed", ...(outcome.ok ? {} : { reason: outcome.reason }) }, { actor: principal });
  return outcome;
}

const USAGE =
  "usage: juno checkpoint restore --journal <journal dir> --checkpoints <checkpoint dir> --compose <docker-compose.yml> --project <compose project> --principal <operator> <task id> <checkpoint>\n";

/**
 * `juno checkpoint restore` (D-138). Takes the journal's runner lock (a runner holding it means a task may be running,
 * so the restore is refused), restores in a fresh workload container, journals the outcome, and prints it as JSON.
 * Exit 0 restored, 1 not restored, 2 bad usage.
 */
export async function runCheckpointCli(
  args: readonly string[],
  io: CliIo = FILE_IO,
  open: (target: { composeFile: AbsolutePath; project: string; service: string }) => Workspace = workloadWorkspace,
  storeAt: (dir: string) => CheckpointStore = (dir) => new Store(dir),
): Promise<number> {
  const [command, ...rest] = args;
  const names = ["--journal", "--checkpoints", "--compose", "--project", "--principal"];
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    if (names.includes(arg)) {
      const value = rest[index + 1];
      if (value === undefined || options.has(arg)) {
        io.err(USAGE);
        return 2;
      }
      options.set(arg, value);
      index += 1;
    } else positional.push(arg);
  }
  const [taskId, checkpoint, ...extra] = positional;
  const value = (name: string): string | undefined => options.get(name);
  if (command !== "restore" || names.some((name) => value(name) === undefined) || taskId === undefined || checkpoint === undefined || extra.length > 0) {
    io.err(USAGE);
    return 2;
  }
  let lock: { release(): void } | null = null;
  try {
    const journal = Writer.open(value("--journal") ?? "");
    lock = acquireRunnerLock(journal.root);
    const workspace = open({ composeFile: (value("--compose") ?? "") as AbsolutePath, project: value("--project") ?? "", service: "workload" });
    const outcome = await restoreCheckpoint(operatorJournal(journal), { workspace, store: storeAt(value("--checkpoints") ?? "") }, taskId, checkpoint, value("--principal") ?? "");
    io.out(`${JSON.stringify(outcome, null, 2)}\n`);
    return outcome.ok ? 0 : 1;
  } catch (error: unknown) {
    io.err(`juno checkpoint: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    lock?.release();
  }
}
