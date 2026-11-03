import { accessSync, constants, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { type TrustAnchor, trustAnchorFromPem } from "../../enforcement/src/index.js";

/**
 * The trust anchor (spec §3.2, v0.6 C1; DECISIONS.md D-116): the operator's Ed25519 public key, which every grant's
 * signature is checked against. JUNO holds only this public key; the private key never enters the runner.
 *
 * The anchor must sit where the runner cannot write it: a runner that could replace the anchor could trust a key of
 * its own and so issue authority. The runner therefore refuses to start when it can write the anchor file or the
 * directory holding it (which would let it replace the file). Anything it cannot read as an Ed25519 public key is
 * refused too.
 */

export class TrustAnchorError extends Error {
  override readonly name = "TrustAnchorError";
}

function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Loads the trust anchor from `path`, refusing one this process could write or replace. */
export function loadTrustAnchor(path: string): TrustAnchor {
  for (const target of [path, dirname(path)]) {
    if (writable(target)) {
      throw new TrustAnchorError(`the trust anchor ${path} is not protected: this process can write ${target}; it must be read-only to the runner (§3.2)`);
    }
  }
  let pem: string;
  try {
    pem = readFileSync(path, "utf8");
  } catch (error: unknown) {
    throw new TrustAnchorError(`the trust anchor ${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return trustAnchorFromPem(pem);
  } catch (error: unknown) {
    throw new TrustAnchorError(`the trust anchor ${path} is not an Ed25519 public key: ${error instanceof Error ? error.message : String(error)}`);
  }
}
