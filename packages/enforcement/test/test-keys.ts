import { generateKeyPairSync } from "node:crypto";
import { type TrustAnchor, signGrant } from "../src/index.js";

/**
 * The tests' operator key (§3.2 C1, D-093, D-115): an Ed25519 pair generated fresh in memory when a test file loads,
 * never written to disk and never committed. Grants in tests are signed with it, and stores trust its public half.
 */
const pair = generateKeyPairSync("ed25519");

export const TEST_ANCHOR: TrustAnchor = pair.publicKey;
export const TEST_OPERATOR_KEY = pair.privateKey;

/** A grant's fields, signed with the tests' operator key. */
export function signed<T extends Readonly<Record<string, unknown>>>(grant: T): T & { readonly signature: string } {
  return signGrant(grant, TEST_OPERATOR_KEY);
}
