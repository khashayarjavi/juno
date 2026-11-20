export { canonicalJson, contentAddress } from "./canonical.js";
export {
  CHAIN_FAILURE_CODES,
  ChainHead,
  type ChainFailure,
  type ChainFailureCode,
  type ChainVerdict,
  encodeEntry,
  encodeHead,
  entryHash,
  verifyChain,
} from "./chain.js";
export { type BlobRead } from "./blobs.js";
export { JournalLocationError, journalRoot } from "./layout.js";
export { type JournalHandle, JournalHandleError, journalLayoutRefusals, openJournalFolder } from "./handle.js";
export { type EntryDraft, JournalIntegrityError, JournalWriter, type JournalWriterOptions } from "./writer.js";
export { PendingRepair, type TornTail, clearPendingRepairs, dropTornTail, readPendingRepairs, tornTail, writePendingRepairs } from "./repair.js";
export { type StoredRecord, listRecords, readPayload, readTrajectory, verifyTrajectory } from "./read.js";
export {
  Anchor,
  type AnchorCheck,
  type AnchorFailure,
  AnchorFields,
  TaskDigest,
  anchorOf,
  anchorPath,
  anchorSignatureValid,
  checkAnchors,
  encodeAnchor,
  journalPublicKeyFromPem,
  signAnchor,
  taskDigest,
} from "./anchor.js";
export {
  AnchorExistsError,
  AnchorReadBackError,
  type AnchorSink,
  AnchorSinkError,
  ContainerAnchorSink,
  GitAnchorSink,
  type JournalKey,
  JournalKeyError,
  type PinnedRepository,
  defaultSshWrapper,
  loadOrCreateJournalKey,
  readAnchorDirectory,
  sameKey,
} from "./sinks.js";
export { SSH_ENVIRONMENT, sshInvocation } from "./anchor-ssh.js";
export { HISTORY_GIT, type HistoryVerdict, anchorHistoryVerdict } from "./history.js";
export { LOCK_FILE, RunnerLockError, type RunnerLock, acquireRunnerLock } from "./lock.js";
