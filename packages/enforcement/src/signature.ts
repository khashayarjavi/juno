import { type KeyObject, createPublicKey } from "node:crypto";
import { canonicalJson } from "../../journal/src/index.js";
import { publicKeyFromOpenSsh, sshsigSign, sshsigVerify } from "./sshsig.js";

/**
 * Grant signatures (spec §3.2, v0.6 C1; DECISIONS.md D-115).
 *
 * A grant carries `signature`: an Ed25519 signature by the operator's key, in OpenSSH's SSHSIG format (namespace
 * `juno-grant`, SHA-512; the blob in base64, D-124), over the canonical JSON (the journal's own canonical form) of
 * every other field of the grant. The operator makes it with `ssh-keygen -Y sign` and a key held by the Windows
 * OpenSSH agent (D-093, D-124); tests make the identical bytes in memory. The operator's private key lives outside every
 * container and outside any state the runner can write; JUNO holds only the operator's public key, the trust anchor,
 * and only ever verifies. A grant whose signature is missing or does not verify against the trust anchor does not
 * exist: lookup refuses it (`signature_invalid`).
 *
 * Signing and verifying use Node's built-in `node:crypto` (no package).
 */

/** The operator's public key: what every grant's signature is checked against. */
export type TrustAnchor = KeyObject;

/** The bytes a grant's signature covers: the canonical JSON of every field but `signature`. */
export function grantSigningBytes(grant: Readonly<Record<string, unknown>>): Uint8Array {
  const { signature: _signature, ...fields } = grant;
  void _signature;
  return new TextEncoder().encode(canonicalJson(fields));
}

/** Signs a grant's fields with an Ed25519 private key; returns the grant with its `signature`. The operator's side only. */
export function signGrant<T extends Readonly<Record<string, unknown>>>(grant: T, privateKey: KeyObject): T & { readonly signature: string } {
  if (privateKey.asymmetricKeyType !== "ed25519" || privateKey.type !== "private") throw new TypeError("a grant is signed with an Ed25519 private key");
  return { ...grant, signature: sshsigSign(grantSigningBytes(grant), privateKey) };
}

/** Whether a grant's signature verifies against the trust anchor. A missing, malformed or wrong signature does not. */
export function grantSignatureValid(grant: Readonly<Record<string, unknown>>, anchor: TrustAnchor): boolean {
  const signature = grant["signature"];
  if (typeof signature !== "string" || signature === "") return false;
  return sshsigVerify(grantSigningBytes(grant), signature, anchor);
}

/**
 * Reads a trust anchor from a PEM public key or an OpenSSH public key line (`ssh-ed25519 AAAA…`, the operator's
 * `.pub` file, D-124). Refuses anything but an Ed25519 public key.
 */
export function trustAnchorFromPem(text: string): TrustAnchor {
  const key = text.trimStart().startsWith("ssh-") ? publicKeyFromOpenSsh(text) : createPublicKey(text);
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError("the trust anchor must be an Ed25519 public key");
  return key;
}
