import { createHash } from "node:crypto";
import { z } from "zod";
import { AbsolutePath, Timestamp, instant } from "../../contracts/src/index.js";

/**
 * The anchor pin (operator ruling D-206 item 2; DECISIONS.md D-208).
 *
 * Where a service's journal is anchored is not a setting of the runner. It is read from one file the runner cannot
 * change (root-owned, like Claude Code's managed settings), which the shared start-up check verifies before anything is
 * opened and `juno hook check` verifies for the operator. The file pins:
 *   - `url` and `branch`: the anchor repository every start fetches from, whatever the local clone says;
 *   - `host_key_fingerprint` and `known_hosts`: the SSH host key that repository's server must present (GitHub's), as
 *     the fingerprint the operator compared with GitHub's published one, and the root-owned file holding the key itself;
 *   - `push_key`: the runner's own deploy key file that ssh uses, so nothing in the runner's ssh settings is read;
 *   - `journals`: every journal folder that may anchor there, each with its recovery epoch (D-207): the time the
 *     operator registered that folder. A journal folder the pin does not name is refused, so giving a service a new,
 *     empty journal is the operator's act as root, never the runner's.
 * A pin whose `url` is a local path names no host key and no push key; it is for JUNO's own tests, and
 * `juno hook check` refuses it.
 */

/** `SHA256:` and the unpadded base64 of the SHA-256 of the key blob, as OpenSSH prints it. */
const Fingerprint = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/, "must be an OpenSSH SHA256 fingerprint (SHA256: and 43 base64 characters)");

const Branch = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/, "must be a plain branch name").max(200);

export const AnchorPinFile = z.strictObject({
  url: z.string().min(1).max(1024),
  branch: Branch,
  host_key_fingerprint: Fingerprint.nullable(),
  known_hosts: AbsolutePath.nullable(),
  push_key: AbsolutePath.nullable(),
  journals: z
    .array(z.strictObject({ path: AbsolutePath, recovery_epoch: Timestamp }))
    .min(1)
    .refine((journals) => new Set(journals.map((journal) => journal.path)).size === journals.length, "each journal folder is named once"),
});
export type AnchorPinFile = z.infer<typeof AnchorPinFile>;

/** The pin as the start-up check verified it. */
export type VerifiedPin = {
  /** The pin file. */
  readonly path: string;
  readonly url: string;
  readonly branch: string;
  /** How the repository is reached: over SSH with the pinned host key, or a local path (tests only). */
  readonly transport: "ssh" | "local";
  /** The SSH server's name, or null for a local path. */
  readonly host: string | null;
  readonly fingerprint: string | null;
  readonly knownHosts: string | null;
  readonly pushKey: string | null;
  readonly journals: readonly { readonly path: string; readonly recovery_epoch: string }[];
  /** The entry for the journal this service was started on. */
  readonly journal: { readonly path: string; readonly recovery_epoch: string };
};

const SCP_URL = /^[a-z_][a-z0-9_-]{0,31}@([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?):[A-Za-z0-9._][A-Za-z0-9._/-]*$/;
const SSH_URL = /^ssh:\/\/[a-z_][a-z0-9_-]{0,31}@([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::[0-9]{1,5})?\/[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/** How a pinned URL is reached, or why it is not one JUNO accepts. Only SSH and an absolute local path are accepted. */
export function pinnedTransport(url: string): { readonly transport: "ssh"; readonly host: string } | { readonly transport: "local" } | { readonly refusal: string } {
  const ssh = SSH_URL.exec(url) ?? SCP_URL.exec(url);
  if (ssh !== null) return { transport: "ssh", host: ssh[1] ?? "" };
  if (AbsolutePath.safeParse(url).success) return { transport: "local" };
  return { refusal: "the pinned url is neither an SSH address (git@host:owner/repository.git or ssh://git@host/owner/repository.git) nor an absolute local path" };
}

/** The OpenSSH SHA256 fingerprint of a public key given as its base64 blob (the second field of a public key line). */
export function sshFingerprint(base64Blob: string): string {
  return `SHA256:${createHash("sha256").update(Buffer.from(base64Blob, "base64")).digest("base64").replace(/=+$/, "")}`;
}

/**
 * Why a known-hosts file is not exactly the pinned host key for `host` (empty: it is). Every line must be a plain
 * `host keytype key` line naming `host`, with a key whose fingerprint is the pinned one. A marker line (`@cert-authority`
 * would trust every key a certificate authority signs), a hashed host name or a pattern is refused: the file must say
 * one thing only.
 */
export function knownHostsRefusals(text: string, host: string, fingerprint: string): string[] {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
  if (lines.length === 0) return ["the pinned known-hosts file holds no host key"];
  const refusals: string[] = [];
  for (const line of lines) {
    const fields = line.split(/\s+/);
    const [hosts, type, blob] = fields;
    if (line.startsWith("@") || hosts === undefined || type === undefined || blob === undefined || fields.length > 4) {
      refusals.push("the pinned known-hosts file has a line that is not a plain `host keytype key` line (markers such as @cert-authority are refused)");
      continue;
    }
    if (hosts !== host) refusals.push(`the pinned known-hosts file has a line for ${JSON.stringify(hosts)}, not exactly the pinned host ${host} (no lists, patterns or hashed names)`);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blob) || !/^[a-z0-9@.-]+$/.test(type)) refusals.push("the pinned known-hosts file has a key that is not base64");
    else if (sshFingerprint(blob) !== fingerprint) refusals.push(`the pinned known-hosts file holds a ${type} key with fingerprint ${sshFingerprint(blob)}, not the pinned ${fingerprint}`);
  }
  return refusals;
}

/** Parses a pin file's text. Throws with every problem in plain words. */
export function parseAnchorPin(text: string): AnchorPinFile & { readonly transport: "ssh" | "local"; readonly host: string | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("it is not JSON");
  }
  const parsed = AnchorPinFile.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".") || "(file)"}: ${issue.message}`).join("; "));
  const pin = parsed.data;
  const reach = pinnedTransport(pin.url);
  if ("refusal" in reach) throw new Error(reach.refusal);
  if (reach.transport === "ssh") {
    if (pin.host_key_fingerprint === null || pin.known_hosts === null || pin.push_key === null) throw new Error("an SSH url needs host_key_fingerprint, known_hosts and push_key");
    return { ...pin, transport: "ssh", host: reach.host };
  }
  if (pin.host_key_fingerprint !== null || pin.known_hosts !== null || pin.push_key !== null) throw new Error("a local path url has no host key and no push key; set host_key_fingerprint, known_hosts and push_key to null");
  return { ...pin, transport: "local", host: null };
}

/** The recovery epoch as a time. */
export function recoveryEpochOf(pin: VerifiedPin): number {
  return instant(pin.journal.recovery_epoch);
}
