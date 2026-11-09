import { type HostIo, type TrustAnchor, systemHostIo, verifyTrustAnchor } from "../../enforcement/src/index.js";

/**
 * The trust anchor (spec §3.2, v0.6 C1; DECISIONS.md D-116): the operator's Ed25519 public key, which every grant's
 * signature is checked against. JUNO holds only this public key; the private key never enters the runner.
 *
 * The rule itself is the shared start-up check's (D-194: `verifyTrustAnchor` in startup.ts), so there is one copy; this
 * is its throwing form, for code that loads the anchor outside a service start (the operator's `grant verify`, tests).
 */

export class TrustAnchorError extends Error {
  override readonly name = "TrustAnchorError";
}

/** Loads the trust anchor from `path`, refusing one this process could write or replace. */
export function loadTrustAnchor(path: string, host: HostIo = systemHostIo()): TrustAnchor {
  const verified = verifyTrustAnchor(path, host);
  if (!verified.ok) throw new TrustAnchorError(verified.refusals.join("; "));
  return verified.anchor;
}
