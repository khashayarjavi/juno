import { dirname } from "node:path";
import { statSync } from "node:fs";
import { z } from "zod";
import { type AbsolutePath, type DataClass, DataClass as DataClassSchema } from "../../contracts/src/index.js";
import {
  CheckpointStore as Store,
  type CheckpointStore,
  ManifestEntry,
  type SealedLauncher,
  SealedWorkspace,
  Workspace,
  checkpointId,
  dockerSealedLauncher,
  probeContainerRuntime,
  runtimeRefusal,
  sameManifest,
  workloadWorkspace,
} from "../../enforcement/src/index.js";
import { type FilesystemIo, caseFoldingRefusals, systemFilesystemIo } from "../../mediated/src/filesystem.js";
import { canonicalJson, commandText, type EntryDraft, JournalWriter as Writer, junoProgramText, operatorText, readPayload, readTrajectory, serviceCommand, userName } from "../../journal/src/index.js";
import { type CliIo, FILE_IO } from "./grant-cli.js";
import { RunnerLockRefused, acquireRunnerLock } from "./lock.js";

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
/**
 * `workspace`: the host folder a hook session's checkpoint was taken in (D-221); absent from container checkpoints and
 * from hook checkpoints taken before 1.5-field. `taken_by: "sealed"`: taken in the sealed context (D-228); absent from
 * every hook checkpoint taken before it.
 */
const CheckpointNote = z.object({ type: z.literal("checkpoint"), root: z.string(), checkpoint: z.string(), manifest: z.array(ManifestEntry), workspace: z.string().optional(), taken_by: z.literal("sealed").optional() });

/**
 * `kept` (the host form only, D-234): the host folder the session's folder as it stood was moved aside to, whole, kept
 * for the operator and never removed by JUNO; absent when there was none (the folder was gone).
 */
export type RestoreOutcome = { readonly ok: true; readonly root: string; readonly kept?: string } | { readonly ok: false; readonly reason: string; readonly kept?: string };

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

type Located = { readonly root: string; readonly manifest: ManifestEntry[]; readonly dataClass: z.infer<typeof DataClassSchema>; readonly workspace: string | undefined; readonly sealed: boolean };

/**
 * The checkpoint `checkpoint` of task `taskId`, read from the task's own verified trajectory, if `principal` is the
 * task's principal and the manifest is the one the id names; or why not.
 */
function locate(journal: JournalAccess, taskId: string, checkpoint: string, principal: string): { ok: true; found: Located } | { ok: false; reason: string } {
  // The chain is verified as it is read; an unverifiable journal is never trusted for a manifest (D-056).
  const entries = readTrajectory(journal.root, taskId);
  const [first] = entries;
  const admission = first === undefined ? null : AdmissionNote.safeParse(payloadOf(journal, first.payload_ref));
  if (admission === null || !admission.success) return { ok: false, reason: `task ${taskId} has no admitted trajectory` };
  if (admission.data.task.principal !== principal) return { ok: false, reason: `only the task's principal may restore its checkpoints (§2.2.2)` };
  let found: Located | null = null;
  for (const entry of entries) {
    if (entry.kind !== "note") continue;
    const note = CheckpointNote.safeParse(payloadOf(journal, entry.payload_ref));
    if (note.success && note.data.checkpoint === checkpoint) found = { root: note.data.root, manifest: note.data.manifest, dataClass: entry.data_class, workspace: note.data.workspace, sealed: note.data.taken_by === "sealed" };
  }
  if (found === null) return { ok: false, reason: `task ${taskId} has no checkpoint ${checkpoint}` };
  // The id is the manifest's hash, so a manifest that does not match it is not this checkpoint.
  if (checkpointId(found.root, found.manifest) !== checkpoint) return { ok: false, reason: `checkpoint ${checkpoint} does not match its manifest` };
  return { ok: true, found };
}

/** Restores `checkpoint` of task `taskId` as `principal`, the task's principal, and journals what happened. */
export async function restoreCheckpoint(
  journal: JournalAccess,
  checkpoints: { readonly workspace: Workspace; readonly store: CheckpointStore },
  taskId: string,
  checkpoint: string,
  principal: string,
): Promise<RestoreOutcome> {
  const located = locate(journal, taskId, checkpoint, principal);
  if (!located.ok) return located;
  const { root, manifest, dataClass } = located.found;

  let outcome: RestoreOutcome;
  let restored: { ok: true } | { ok: false; reason: string };
  try {
    restored = await checkpoints.workspace.restore(root, manifest, (hash) => checkpoints.store.get(hash));
  } catch (error: unknown) {
    restored = { ok: false, reason: operatorText(error instanceof Error ? error.message : String(error)) };
  }
  if (!restored.ok) outcome = { ok: false, reason: restored.reason };
  else outcome = await compared(checkpoints.workspace, root, manifest);
  journal.append(taskId, "note", dataClass, { type: "checkpoint_restore", checkpoint, root, principal, outcome: outcome.ok ? "restored" : "failed", ...(outcome.ok ? {} : { reason: outcome.reason }) }, { actor: principal });
  return outcome;
}

/** The workspace listed again after a restore, and compared with the manifest: only an identical listing is restored. */
async function compared(workspace: Workspace, root: string, manifest: readonly ManifestEntry[]): Promise<RestoreOutcome> {
  const after = await workspace.list(root, false);
  if (!after.ok) return { ok: false, reason: `the restored workspace could not be listed: ${after.reason}` };
  if (!sameManifest(after.snapshot.manifest, manifest)) return { ok: false, reason: "the restored workspace does not match the checkpoint" };
  return { ok: true, root };
}

/**
 * Restores a hook session's checkpoint of a host folder (§2.2.2; DECISIONS.md D-221, D-228), while no service writes
 * the journal (the caller holds the journal's lock). Everything that reads or changes the folder runs in the sealed
 * context (`SealedWorkspace`): a fresh container that can reach the workspace and nothing else of the runner's; the
 * checkpoint's bytes are handed to it on standard input. Refuses, and changes nothing, when:
 *   - the checkpoint does not record the host folder it was taken in, or records another than `workspace` (the service's
 *     `--workspace`, given as its real path), or was not taken in the sealed context;
 *   - the folder is not on a case-sensitive Linux file system (D-178);
 *   - someone other than root and the runner could replace the workspace's path, or the folder mounted is not the one
 *     JUNO opened;
 *   - a folder on the way to the session's folder is not one the runner can read, change and enter without a link, on
 *     the workspace's file system and with no special bit, or the session's folder is a mount (D-234).
 * The undo moves the session's folder as it stands aside, whole, with one rename beside it (`kept`, never removed by
 * JUNO), and makes it again from the checkpoint (operator ruling 2 of D-234): what the folder held does not matter.
 * A refusal after the checkpoint is found, and every restore, is journalled with the operator as its actor: `refused`
 * (nothing changed), `failed` (the result differs from the checkpoint, or a step failed), or `restored`.
 */
export async function restoreHostCheckpoint(
  journal: JournalAccess,
  store: CheckpointStore,
  workspace: string,
  taskId: string,
  checkpoint: string,
  principal: string,
  host: { readonly filesystem: FilesystemIo; readonly launcher: SealedLauncher },
): Promise<RestoreOutcome> {
  const located = locate(journal, taskId, checkpoint, principal);
  if (!located.ok) return located;
  const { root, manifest, dataClass, workspace: takenIn, sealed } = located.found;
  const record = (outcome: "restored" | "failed" | "refused", reason?: string, kept?: string): void => {
    journal.append(taskId, "note", dataClass, { type: "checkpoint_restore", checkpoint, root, workspace, principal, outcome, ...(reason === undefined ? {} : { reason }), ...(kept === undefined ? {} : { kept }) }, { actor: principal });
  };
  // D-224 (F2): a refusal once the checkpoint is found is journalled, these included.
  const refused = (reason: string): RestoreOutcome => {
    record("refused", reason);
    return { ok: false, reason };
  };
  if (takenIn === undefined) return refused(`checkpoint ${checkpoint} does not record the host folder it was taken in (it was taken by JUNO before 1.5-field, or in a container), so this command cannot restore it; nothing was changed`);
  if (takenIn !== workspace) return refused(`checkpoint ${checkpoint} was taken in ${takenIn}, not in ${workspace}; nothing was changed`);
  // D-228: only a checkpoint the sealed context took holds nothing but files and folders with the fixed modes.
  if (!sealed) return refused(`checkpoint ${checkpoint} was not taken in the sealed copy context (it was taken before D-228), so this command will not restore it; nothing was changed`);
  // D-178 for what the undo touches (D-237, review round 11 on PR #62): the folder holding the session's folder, where
  // the folder is made again and whose case-folding attribute a new folder would inherit. Never the tree the undo moves
  // aside, which it does not look into (D-234): what that tree holds (its size, its depth, a folder the runner cannot
  // list) cannot stop the undo.
  const hostRoot = workspace + root.slice("/work".length);
  const folding = await caseFoldingRefusals([{ what: "the folder holding the session's folder", path: dirname(hostRoot) }], host.filesystem, { tree: false });
  if (folding.length > 0) return refused(`${folding.join("; ")}; nothing was changed`);
  let outcome: Awaited<ReturnType<SealedWorkspace["restore"]>>;
  try {
    outcome = await new SealedWorkspace(workspace, host.launcher).restore(root, manifest, (hash) => store.get(hash));
  } catch (error: unknown) {
    outcome = { ok: false, changed: true, reason: `the restore stopped part way: ${operatorText(error instanceof Error ? error.message : String(error))}` };
  }
  // D-234: the folder as it stood was moved aside, whole, beside it; the journal and the answer say where (a host path).
  const keptAt = (kept: string | null | undefined): string | undefined => (typeof kept === "string" ? workspace + kept.slice("/work".length) : undefined);
  if (outcome.ok) {
    const kept = keptAt(outcome.kept);
    record("restored", undefined, kept);
    return { ok: true, root, ...(kept === undefined ? {} : { kept }) };
  }
  if (!outcome.changed) return refused(outcome.reason.endsWith("nothing was changed") || outcome.reason.endsWith("nothing was read or changed") ? outcome.reason : `${outcome.reason}; nothing was changed`);
  const kept = keptAt(outcome.kept);
  record("failed", outcome.reason, kept);
  return { ok: false, reason: outcome.reason, ...(kept === undefined ? {} : { kept }) };
}

const USAGE =
  `usage: ${junoProgramText()} checkpoint restore --journal <journal dir> --checkpoints <checkpoint dir> --compose <docker-compose.yml> --project <compose project> --principal <operator> <task id> <checkpoint>\n` +
  `       ${junoProgramText()} checkpoint restore --journal <journal dir> --checkpoints <checkpoint dir> --workspace <host folder> --principal <operator> <task id> <checkpoint>\n` +
  `       ${junoProgramText()} checkpoint list --journal <journal dir> <task id>\n`;

/**
 * Why the restore could not lock the journal, in the operator's words (D-243): a running service is stopped first; a
 * service that stopped without releasing its lock is started once, so that it takes the lock over and checks the
 * journal, and stopped again; any other case names the lock's real path and how to remove it.
 */
export function lockRefusal(error: unknown): string {
  // D-247: every command named here is built by the one shared helper; the lock's own message names its real path.
  if (!(error instanceof RunnerLockRefused)) return operatorText(`the journal could not be locked: ${error instanceof Error ? error.message : String(error)}`);
  if (error.reason === "owner_running") return `the journal is in use, so its service is running. Stop it first (${commandText(serviceCommand("stop"))}), then run this again. (${error.message})`;
  if (error.reason === "owner_dead")
    return `JUNO's service stopped without releasing the journal's lock (for example WSL shut down under it). Start the service once, so that it takes the lock over, records that and checks the journal (${commandText(serviceCommand("start"))}, then ${commandText(serviceCommand("status"))} must show active (running)); stop it again (${commandText(serviceCommand("stop"))}); then run this again. (${error.message})`;
  return error.message;
}

/**
 * `juno checkpoint list` (D-221): the checkpoints a task's verified trajectory holds, oldest first, and every restore
 * recorded after them, with who restored it (`by`, the principal it was recorded under, D-243). Reads only; takes no lock.
 */
export function listCheckpoints(journalRoot: string, taskId: string): { readonly checkpoints: readonly Record<string, unknown>[]; readonly restores: readonly Record<string, unknown>[] } {
  const access: JournalAccess = { root: journalRoot, append: () => { throw new Error("listing writes nothing"); } };
  const checkpoints: Record<string, unknown>[] = [];
  const restores: Record<string, unknown>[] = [];
  for (const entry of readTrajectory(journalRoot, taskId)) {
    if (entry.kind !== "note") continue;
    const payload = payloadOf(access, entry.payload_ref);
    const note = CheckpointNote.safeParse(payload);
    if (note.success) checkpoints.push({ checkpoint: note.data.checkpoint, root: note.data.root, ...(note.data.workspace === undefined ? {} : { workspace: note.data.workspace }), ...(note.data.taken_by === undefined ? {} : { taken_by: note.data.taken_by }), taken_at: entry.timestamp, entries: note.data.manifest.length });
    const restore = z.object({ type: z.literal("checkpoint_restore"), checkpoint: z.string(), principal: z.string().optional(), outcome: z.string(), reason: z.string().optional(), kept: z.string().optional() }).safeParse(payload);
    if (restore.success) restores.push({ checkpoint: restore.data.checkpoint, outcome: restore.data.outcome, at: entry.timestamp, by: restore.data.principal ?? entry.actor, ...(restore.data.reason === undefined ? {} : { reason: restore.data.reason }), ...(restore.data.kept === undefined ? {} : { kept: restore.data.kept }) });
  }
  return { checkpoints, restores };
}

/** What the host form reads of the process and the machine; tests give their own. */
export type HostRestoreIo = {
  /** The user running the command. */
  readonly uid: () => number;
  /** The owner of a folder, or null when it is not a folder that exists. */
  readonly ownerOf: (path: string) => number | null;
  readonly filesystem: FilesystemIo;
  /** The sealed copy context (D-228); in real use a fresh container on the runner's own runtime. */
  readonly launcher: () => Promise<SealedLauncher>;
};
const SYSTEM_HOST: HostRestoreIo = {
  uid: () => process.geteuid?.() ?? -1,
  ownerOf: (path) => {
    try {
      const stats = statSync(path);
      return stats.isDirectory() ? stats.uid : null;
    } catch {
      return null;
    }
  },
  filesystem: systemFilesystemIo(),
  // D-131 as `hook serve` applies it: a runtime that would ignore the sealed container's limits is refused (D-232).
  launcher: async () => {
    const runtime = await probeContainerRuntime();
    const why = runtimeRefusal(runtime);
    if (why !== null) throw new Error(`refused, nothing was changed: ${why}`);
    return dockerSealedLauncher({ rootless: runtime.rootless });
  },
};

/**
 * `juno checkpoint restore` (D-138; the host form D-221). Takes the journal's lock: a runner, a hook service or a gateway
 * service holding it means the journal is being written, so the restore is refused. The Compose form restores in a fresh
 * workload container; the host form (`--workspace`) restores a hook session's host folder on this machine, as the
 * runner: never as root, and only as the user that owns the journal and the checkpoint store. Either journals the
 * outcome and prints it as JSON. Exit 0 restored, 1 not restored, 2 bad usage.
 */
export async function runCheckpointCli(
  args: readonly string[],
  io: CliIo = FILE_IO,
  open: (target: { composeFile: AbsolutePath; project: string; service: string }) => Workspace = workloadWorkspace,
  storeAt: (dir: string) => CheckpointStore = (dir) => new Store(dir),
  host: HostRestoreIo = SYSTEM_HOST,
): Promise<number> {
  const [command, ...rest] = args;
  if (command === "list") {
    const [flag, journalDir, taskId, ...extra] = rest;
    if (flag !== "--journal" || journalDir === undefined || taskId === undefined || extra.length > 0) {
      io.err(USAGE);
      return 2;
    }
    try {
      io.out(`${JSON.stringify(listCheckpoints(journalDir, taskId), null, 2)}\n`);
      return 0;
    } catch (error: unknown) {
      io.err(`juno checkpoint list: ${operatorText(error instanceof Error ? error.message : String(error))}\n`);
      return 1;
    }
  }
  const names = ["--journal", "--checkpoints", "--compose", "--project", "--principal", "--workspace"];
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
  const hostForm = options.has("--workspace");
  const required = hostForm ? ["--journal", "--checkpoints", "--workspace", "--principal"] : ["--journal", "--checkpoints", "--compose", "--project", "--principal"];
  const excluded = hostForm ? ["--compose", "--project"] : [];
  if (command !== "restore" || required.some((name) => value(name) === undefined) || excluded.some((name) => options.has(name)) || taskId === undefined || checkpoint === undefined || extra.length > 0) {
    io.err(USAGE);
    return 2;
  }
  const journalDir = value("--journal") ?? "";
  const storeDir = value("--checkpoints") ?? "";
  if (hostForm) {
    // D-221: the operator runs it as juno-runner, never as root: the user that owns the journal and the checkpoint store.
    const uid = host.uid();
    const refusals: string[] = [];
    // D-247: the user named is the journal's owner, by name, never a literal.
    const journalOwner = journalDir.startsWith("/") ? host.ownerOf(journalDir) : null;
    if (uid === 0) refusals.push(`it runs as root; run it as ${journalOwner === null || journalOwner === 0 ? "the user that owns the journal and the checkpoint store" : `${userName(journalOwner)}, the user that owns the journal ${journalDir}`}, never as root`);
    for (const [what, dir] of [["the journal", journalDir], ["the checkpoint store", storeDir]] as const) {
      if (!dir.startsWith("/")) {
        refusals.push(`${what} ${dir} is not an absolute path`);
        continue;
      }
      const owner = host.ownerOf(dir);
      if (owner === null) refusals.push(`${what} ${dir} is not a folder that exists`);
      else if (owner !== uid) refusals.push(`${what} ${dir} is not this user's: run it as the user that owns it (${userName(owner)})`);
    }
    if (refusals.length > 0) {
      io.err(`juno checkpoint restore: refused, nothing was changed:\n${refusals.map((line) => `  - ${line}`).join("\n")}\n`);
      return 1;
    }
  }
  let lock: { release(): void } | null = null;
  try {
    const journal = Writer.open(journalDir);
    try {
      // D-243: the restore, in either form, never takes over a stale lock itself. A service start does, and records it in
      // the journal only after checking the whole journal and repairing a torn write (D-206); a restore does neither.
      lock = acquireRunnerLock(journal.root, undefined, undefined, { shown: journalDir, reclaim: false });
    } catch (error: unknown) {
      if (!hostForm) throw error;
      io.err(`juno checkpoint restore: refused, nothing was changed: ${operatorText(lockRefusal(error))}\n`);
      return 1;
    }
    const outcome = hostForm
      ? await restoreHostCheckpoint(operatorJournal(journal), storeAt(storeDir), value("--workspace") ?? "", taskId, checkpoint, value("--principal") ?? "", { filesystem: host.filesystem, launcher: await host.launcher() })
      : await restoreCheckpoint(operatorJournal(journal), { workspace: open({ composeFile: (value("--compose") ?? "") as AbsolutePath, project: value("--project") ?? "", service: "workload" }), store: storeAt(storeDir) }, taskId, checkpoint, value("--principal") ?? "");
    io.out(`${JSON.stringify(outcome, null, 2)}\n`);
    return outcome.ok ? 0 : 1;
  } catch (error: unknown) {
    io.err(`juno checkpoint: ${operatorText(error instanceof Error ? error.message : String(error))}\n`);
    return 1;
  } finally {
    lock?.release();
  }
}
