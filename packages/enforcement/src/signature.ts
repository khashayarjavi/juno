import { type KeyObject, createPublicKey, sign, verify } from "node:crypto";
import { canonicalJson } from "../../journal/src/index.js";

/**
 * Grant signatures (spec §3.2, v0.6 C1; DECISIONS.md D-115).
 *
 * A grant carries `signature`: an Ed25519 signature, base64, by the operator's key, over the canonical JSON (the
 * journal's own canonical form) of every other field of the grant. The operator's private key lives outside every
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
  const signature = sign(null, grantSigningBytes(grant), privateKey).toString("base64");
  return { ...grant, signature };
}

/** Whether a grant's signature verifies against the trust anchor. A missing, malformed or wrong signature does not. */
export function grantSignatureValid(grant: Readonly<Record<string, unknown>>, anchor: TrustAnchor): boolean {
  const signature = grant["signature"];
  if (typeof signature !== "string" || signature === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false;
  try {
    return verify(null, grantSigningBytes(grant), anchor, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/** Reads a trust anchor from a PEM public key. Refuses anything but an Ed25519 public key. */
export function trustAnchorFromPem(pem: string): TrustAnchor {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError("the trust anchor must be an Ed25519 public key");
  return key;
}
