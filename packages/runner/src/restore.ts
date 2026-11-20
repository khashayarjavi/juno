import { closeSync, statSync } from "node:fs";
import { z } from "zod";
import { type AbsolutePath, type DataClass, DataClass as DataClassSchema } from "../../contracts/src/index.js";
import {
  CheckpointStore as Store,
  type CheckpointStore,
  ManifestEntry,
  Workspace,
  checkpointId,
  execFileScript,
  hostRestoreRefusals,
  openWorkspaceRoot,
  restoreHostTree,
  sameManifest,
  workloadWorkspace,
} from "../../enforcement/src/index.js";
import { type FilesystemIo, caseFoldingRefusals, systemFilesystemIo } from "../../mediated/src/filesystem.js";
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
/** `workspace`: the host folder a hook session's checkpoint was taken in (D-221); absent from container checkpoints and from hook checkpoints taken before 1.5-field. */
const CheckpointNote = z.object({ type: z.literal("checkpoint"), root: z.string(), checkpoint: z.string(), manifest: z.array(ManifestEntry), workspace: z.string().optional() });

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

type Located = { readonly root: string; readonly manifest: ManifestEntry[]; readonly dataClass: z.infer<typeof DataClassSchema>; readonly workspace: string | undefined };

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
    if (note.success && note.data.checkpoint === checkpoint) found = { root: note.data.root, manifest: note.data.manifest, dataClass: entry.data_class, workspace: note.data.workspace };
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
    restored = { ok: false, reason: error instanceof Error ? error.message : String(error) };
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
 * Restores a hook session's checkpoint of a host folder (§2.2.2; DECISIONS.md D-221), as the runner, while no service
 * writes the journal (the caller holds the journal's lock). Refuses, and changes nothing, when:
 *   - the checkpoint does not record the host folder it was taken in, or records another than `workspace` (the service's
 *     `--workspace`, given as its real path);
 *   - the folder is not on a case-sensitive Linux file system (D-178);
 *   - the workspace root is not a folder reached without a symbolic link;
 *   - the runner could not finish (`hostRestoreRefusals`).
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
  host: { readonly filesystem: FilesystemIo; readonly uid?: number },
): Promise<RestoreOutcome> {
  const uid = host.uid ?? process.geteuid?.() ?? -1;
  const located = locate(journal, taskId, checkpoint, principal);
  if (!located.ok) return located;
  const { root, manifest, dataClass, workspace: takenIn } = located.found;
  const record = (outcome: "restored" | "failed" | "refused", reason?: string): void => {
    journal.append(taskId, "note", dataClass, { type: "checkpoint_restore", checkpoint, root, workspace, principal, outcome, ...(reason === undefined ? {} : { reason }) }, { actor: principal });
  };
  // D-224 (F2): a refusal once the checkpoint is found is journalled, these two included.
  const refused = (reason: string): RestoreOutcome => {
    record("refused", reason);
    return { ok: false, reason };
  };
  if (takenIn === undefined) return refused(`checkpoint ${checkpoint} does not record the host folder it was taken in (it was taken by JUNO before 1.5-field, or in a container), so this command cannot restore it; nothing was changed`);
  if (takenIn !== workspace) return refused(`checkpoint ${checkpoint} was taken in ${takenIn}, not in ${workspace}; nothing was changed`);
  const hostRoot = workspace + root.slice("/work".length);
  const folding = await caseFoldingRefusals([{ what: "the workspace", path: hostRoot }], host.filesystem);
  if (folding.length > 0) {
    const reason = `${folding.join("; ")}; nothing was changed`;
    record("refused", reason);
    return { ok: false, reason };
  }
  const opened = openWorkspaceRoot(workspace, root);
  if (!opened.ok) {
    const reason = `${opened.reason}; nothing was changed`;
    record("refused", reason);
    return { ok: false, reason };
  }
  let outcome: RestoreOutcome;
  try {
    const refusals = hostRestoreRefusals(opened.fd, manifest, uid);
    if (refusals.length > 0) {
      const reason = `${refusals.join("; ")}; nothing was changed`;
      record("refused", reason);
      return { ok: false, reason };
    }
    try {
      restoreHostTree(opened.fd, manifest, (hash) => store.get(hash), uid);
      outcome = { ok: true, root };
    } catch (error: unknown) {
      outcome = { ok: false, reason: `the restore stopped part way: ${error instanceof Error ? error.message : String(error)}` };
    }
  } finally {
    closeSync(opened.fd);
  }
  if (outcome.ok) outcome = await compared(new Workspace(execFileScript(process.execPath, []), "/work", workspace), root, manifest);
  record(outcome.ok ? "restored" : "failed", outcome.ok ? undefined : outcome.reason);
  return outcome;
}

const USAGE =
  "usage: juno checkpoint restore --journal <journal dir> --checkpoints <checkpoint dir> --compose <docker-compose.yml> --project <compose project> --principal <operator> <task id> <checkpoint>\n" +
  "       juno checkpoint restore --journal <journal dir> --checkpoints <checkpoint dir> --workspace <host folder> --principal <operator> <task id> <checkpoint>\n" +
  "       juno checkpoint list --journal <journal dir> <task id>\n";

/**
 * `juno checkpoint list` (D-221): the checkpoints a task's verified trajectory holds, oldest first, and every restore
 * recorded after them. Reads only; takes no lock.
 */
export function listCheckpoints(journalRoot: string, taskId: string): { readonly checkpoints: readonly Record<string, unknown>[]; readonly restores: readonly Record<string, unknown>[] } {
  const access: JournalAccess = { root: journalRoot, append: () => { throw new Error("listing writes nothing"); } };
  const checkpoints: Record<string, unknown>[] = [];
  const restores: Record<string, unknown>[] = [];
  for (const entry of readTrajectory(journalRoot, taskId)) {
    if (entry.kind !== "note") continue;
    const payload = payloadOf(access, entry.payload_ref);
    const note = CheckpointNote.safeParse(payload);
    if (note.success) checkpoints.push({ checkpoint: note.data.checkpoint, root: note.data.root, ...(note.data.workspace === undefined ? {} : { workspace: note.data.workspace }), taken_at: entry.timestamp, entries: note.data.manifest.length });
    const restore = z.object({ type: z.literal("checkpoint_restore"), checkpoint: z.string(), outcome: z.string(), reason: z.string().optional() }).safeParse(payload);
    if (restore.success) restores.push({ checkpoint: restore.data.checkpoint, outcome: restore.data.outcome, at: entry.timestamp, ...(restore.data.reason === undefined ? {} : { reason: restore.data.reason }) });
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
      io.err(`juno checkpoint list: ${error instanceof Error ? error.message : String(error)}\n`);
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
    if (uid === 0) refusals.push("it runs as root; run it as juno-runner (sudo -iu juno-runner), never as root");
    for (const [what, dir] of [["the journal", journalDir], ["the checkpoint store", storeDir]] as const) {
      if (!dir.startsWith("/")) {
        refusals.push(`${what} ${dir} is not an absolute path`);
        continue;
      }
      const owner = host.ownerOf(dir);
      if (owner === null) refusals.push(`${what} ${dir} is not a folder that exists`);
      else if (owner !== uid) refusals.push(`${what} ${dir} is not this user's: run it as the user that owns it (juno-runner)`);
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
      lock = acquireRunnerLock(journal.root);
    } catch (error: unknown) {
      if (!hostForm) throw error;
      io.err(`juno checkpoint restore: refused, nothing was changed: the journal is in use, so its service is running. Stop it first (systemctl --user stop juno-hook.service), then run this again. (${error instanceof Error ? error.message : String(error)})\n`);
      return 1;
    }
    const outcome = hostForm
      ? await restoreHostCheckpoint(operatorJournal(journal), storeAt(storeDir), value("--workspace") ?? "", taskId, checkpoint, value("--principal") ?? "", { filesystem: host.filesystem })
      : await restoreCheckpoint(operatorJournal(journal), { workspace: open({ composeFile: (value("--compose") ?? "") as AbsolutePath, project: value("--project") ?? "", service: "workload" }), store: storeAt(storeDir) }, taskId, checkpoint, value("--principal") ?? "");
    io.out(`${JSON.stringify(outcome, null, 2)}\n`);
    return outcome.ok ? 0 : 1;
  } catch (error: unknown) {
    io.err(`juno checkpoint: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    lock?.release();
  }
}
