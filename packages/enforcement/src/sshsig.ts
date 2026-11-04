import { type KeyObject, createHash, createPublicKey, sign, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeOutbound } from "../../registry/src/index.js";

/**
 * Grant signatures in OpenSSH's SSHSIG format (spec §3.2, v0.6 C1; DECISIONS.md D-124), so the operator signs with
 * `ssh-keygen -Y sign` and a key held only by the Windows OpenSSH agent (the OS keychain, D-093). Format, from
 * OpenSSH's PROTOCOL.sshsig (read 2026-11-04):
 *
 *   blob   = "SSHSIG" || uint32 1 || string(public key) || string(namespace) || string(reserved) || string(hash alg)
 *            || string(signature)
 *   signed = "SSHSIG" || string(namespace) || string(reserved) || string(hash alg) || string(H(message))
 *
 * JUNO accepts exactly one profile, and refuses everything else: an Ed25519 key, the namespace `juno-grant`, an empty
 * reserved field, SHA-512. The `signature` field of a grant is the blob in base64 (the armour's body, unwrapped).
 * Ed25519 is deterministic, so this module and `ssh-keygen` produce the same bytes for the same key and message
 * (proved in `packages/enforcement/test/sshsig.test.ts` against the real program).
 */

export const GRANT_NAMESPACE = "juno-grant";
const MAGIC = Buffer.from("SSHSIG", "ascii");
const HASH = "sha512";
const KEY_TYPE = "ssh-ed25519";

function sshString(data: Uint8Array | string): Buffer {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** Reads SSH wire strings in order; throws on anything short or left over. */
class Reader {
  #offset = 0;
  constructor(readonly bytes: Buffer) {}
  raw(length: number): Buffer {
    if (this.#offset + length > this.bytes.length) throw new Error("truncated");
    const out = this.bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return out;
  }
  uint32(): number {
    return this.raw(4).readUInt32BE(0);
  }
  string(): Buffer {
    return this.raw(this.uint32());
  }
  end(): void {
    if (this.#offset !== this.bytes.length) throw new Error("trailing bytes");
  }
}

/** The raw 32-byte Ed25519 public key of a KeyObject (public or private). */
function rawEd25519(key: KeyObject): Buffer {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  if (publicKey.asymmetricKeyType !== "ed25519") throw new TypeError("an Ed25519 key is required");
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw new TypeError("an Ed25519 key is required");
  return Buffer.from(jwk.x, "base64url");
}

/** The SSH wire encoding of an Ed25519 public key. */
export function sshPublicKeyBlob(key: KeyObject): Buffer {
  return Buffer.concat([sshString(KEY_TYPE), sshString(rawEd25519(key))]);
}

/** An Ed25519 public key from an OpenSSH public key line (`ssh-ed25519 AAAA... comment`). */
export function publicKeyFromOpenSsh(line: string): KeyObject {
  const [type, base64, ...rest] = line.trim().split(/\s+/);
  void rest;
  if (type !== KEY_TYPE || base64 === undefined) throw new TypeError("an OpenSSH ssh-ed25519 public key is required");
  const reader = new Reader(Buffer.from(base64, "base64"));
  if (reader.string().toString("utf8") !== KEY_TYPE) throw new TypeError("the key blob is not ssh-ed25519");
  const raw = reader.string();
  reader.end();
  if (raw.length !== 32) throw new TypeError("an Ed25519 public key is 32 bytes");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
}

function signedData(message: Uint8Array): Buffer {
  return Buffer.concat([MAGIC, sshString(GRANT_NAMESPACE), sshString(""), sshString(HASH), sshString(createHash(HASH).update(message).digest())]);
}

/** Signs `message` in JUNO's SSHSIG profile with an Ed25519 private key; returns the blob in base64. */
export function sshsigSign(message: Uint8Array, privateKey: KeyObject): string {
  if (privateKey.asymmetricKeyType !== "ed25519" || privateKey.type !== "private") throw new TypeError("a grant is signed with an Ed25519 private key");
  const signature = sign(null, signedData(message), privateKey);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(1);
  return Buffer.concat([
    MAGIC,
    version,
    sshString(sshPublicKeyBlob(privateKey)),
    sshString(GRANT_NAMESPACE),
    sshString(""),
    sshString(HASH),
    sshString(Buffer.concat([sshString(KEY_TYPE), sshString(signature)])),
  ]).toString("base64");
}

/** The blob of an armoured SSH signature (`-----BEGIN SSH SIGNATURE-----` …), in base64. */
export function sshsigFromArmored(text: string): string {
  const match = /^-----BEGIN SSH SIGNATURE-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END SSH SIGNATURE-----\r?\n?$/.exec(text);
  if (match === null || match[1] === undefined) throw new TypeError("not an armoured SSH signature");
  return match[1].replace(/\s+/g, "");
}

/**
 * Whether `blob` (base64) is a valid signature of `message` by the anchor, in JUNO's profile only: the blob's key is
 * the anchor, the namespace `juno-grant`, nothing reserved, SHA-512, an Ed25519 signature that verifies.
 */
export function sshsigVerify(message: Uint8Array, blob: string, anchor: KeyObject): boolean {
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) return false;
    const reader = new Reader(Buffer.from(blob, "base64"));
    if (!reader.raw(6).equals(MAGIC)) return false;
    if (reader.uint32() !== 1) return false;
    if (!reader.string().equals(sshPublicKeyBlob(anchor))) return false;
    if (reader.string().toString("utf8") !== GRANT_NAMESPACE) return false;
    if (reader.string().length !== 0) return false;
    if (reader.string().toString("utf8") !== HASH) return false;
    const inner = new Reader(reader.string());
    reader.end();
    if (inner.string().toString("utf8") !== KEY_TYPE) return false;
    const signature = inner.string();
    inner.end();
    if (signature.length !== 64) return false;
    return verify(null, signedData(message), anchor, signature);
  } catch {
    return false;
  }
}

/**
 * Signs `message` with `ssh-keygen -Y sign` (the operator's side only; D-124). `publicKeyFile` names the operator's
 * `.pub` file: its private half is held by the OpenSSH agent (on Windows, the agent service keeps it in the user's
 * security context), so no private key file need exist. The message goes through a file in a fresh temporary
 * directory, which is removed afterwards; nothing runs through a shell.
 */
export async function sshKeygenSign(message: Uint8Array, publicKeyFile: string, program = "ssh-keygen"): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "juno-sign-"));
  try {
    const file = join(dir, "grant.bytes");
    writeFileSync(file, message, { mode: 0o600 });
    const result = await executeOutbound({ file: program, args: ["-Y", "sign", "-n", GRANT_NAMESPACE, "-O", `hashalg=${HASH}`, "-f", publicKeyFile, file] });
    if (result.exitCode !== 0) throw new Error(`ssh-keygen -Y sign failed: ${result.stderr.toString("utf8").trim()}`);
    return sshsigFromArmored(readFileSync(`${file}.sig`, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
