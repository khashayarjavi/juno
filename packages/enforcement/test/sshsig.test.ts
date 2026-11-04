import { type ChildProcess, execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeOutbound } from "../../registry/src/index.js";
import { GRANT_NAMESPACE, grantSignatureValid, grantSigningBytes, publicKeyFromOpenSsh, sshKeygenSign, sshPublicKeyBlob, sshsigSign, sshsigVerify, trustAnchorFromPem } from "../src/index.js";

/**
 * §3.2 (v0.6 C1), D-093, D-124: grant signatures in OpenSSH's SSHSIG format, so the operator signs with `ssh-keygen
 * -Y sign` and a key that only the OpenSSH agent holds. Proved against the real programs, both directions, and
 * through a real agent with the private key file deleted (the operator's set-up on Windows).
 */

let dir: string;
let pubLine: string;
const message = new TextEncoder().encode('{"id":"grant-1","principal":"alireza"}');
const GRANT = { id: "grant-ssh", principal: "alireza", expires_at: "2026-11-05T00:00:00.000Z" };

async function run(file: string, args: readonly string[]): Promise<{ code: number | null; stderr: string }> {
  const result = await executeOutbound({ file, args });
  return { code: result.exitCode, stderr: result.stderr.toString("utf8") };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "juno-sshsig-"));
  expect((await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "juno-grant-test", "-f", join(dir, "juno_grant")])).code).toBe(0);
  pubLine = readFileSync(join(dir, "juno_grant.pub"), "utf8");
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SSHSIG grant signatures (§3.2 C1, D-124)", () => {
  // proves D-124: what ssh-keygen -Y sign produces verifies in JUNO against the operator's .pub
  it("verifies a signature made by ssh-keygen", async () => {
    const blob = await sshKeygenSign(message, join(dir, "juno_grant"));
    const anchor = publicKeyFromOpenSsh(pubLine);
    expect(sshsigVerify(message, blob, anchor)).toBe(true);
    expect(sshsigVerify(new TextEncoder().encode("changed"), blob, anchor)).toBe(false);
    expect(sshsigVerify(message, blob, generateKeyPairSync("ed25519").publicKey)).toBe(false);
    expect(trustAnchorFromPem(pubLine).equals(anchor)).toBe(true);
  });

  // proves D-124: a signature under another namespace or hash is refused, even by the right key
  it("refuses any other namespace or hash algorithm", async () => {
    const file = join(dir, "message");
    writeFileSync(file, message);
    for (const [namespace, hash] of [["file", "sha512"], [GRANT_NAMESPACE, "sha256"]] as const) {
      rmSync(`${file}.sig`, { force: true });
      expect((await run("ssh-keygen", ["-Y", "sign", "-n", namespace, "-O", `hashalg=${hash}`, "-f", join(dir, "juno_grant"), file])).code).toBe(0);
      const armored = readFileSync(`${file}.sig`, "utf8");
      const blob = armored.split("\n").filter((line) => !line.startsWith("-----")).join("");
      expect(sshsigVerify(message, blob, publicKeyFromOpenSsh(pubLine))).toBe(false);
    }
  });

  // proves D-124: what JUNO signs in memory (the tests' grants) verifies with ssh-keygen -Y verify
  it("is verified by ssh-keygen when JUNO signs", async () => {
    const pair = generateKeyPairSync("ed25519");
    const blob = sshsigSign(message, pair.privateKey);
    const lines = blob.match(/.{1,76}/g) ?? [];
    writeFileSync(join(dir, "node.sig"), `-----BEGIN SSH SIGNATURE-----\n${lines.join("\n")}\n-----END SSH SIGNATURE-----\n`);
    writeFileSync(join(dir, "allowed_signers"), `juno ssh-ed25519 ${sshPublicKeyBlob(pair.publicKey).toString("base64")}\n`);
    const code = await new Promise<number | null>((resolve) => {
      const child = execFile("ssh-keygen", ["-Y", "verify", "-f", join(dir, "allowed_signers"), "-I", "juno", "-n", GRANT_NAMESPACE, "-s", join(dir, "node.sig")], (error) => {
        resolve(error === null ? 0 : typeof error.code === "number" ? error.code : -1);
      });
      child.stdin?.end(Buffer.from(message));
    });
    expect(code).toBe(0);
  });

  // proves D-093 / D-124: with the private key only in the OpenSSH agent (its file deleted), a grant signed through
  // ssh-keygen and the agent is valid against the operator's .pub, the trust anchor
  it("signs through the agent with no private key file", async () => {
    const socket = join(dir, "agent.sock");
    const agent: ChildProcess = execFile("ssh-agent", ["-D", "-a", socket], () => undefined);
    const previous = process.env["SSH_AUTH_SOCK"];
    try {
      for (let i = 0; i < 50 && !existsSync(socket); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      process.env["SSH_AUTH_SOCK"] = socket;
      const agentKey = join(dir, "agent_key");
      expect((await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", agentKey])).code).toBe(0);
      expect((await run("ssh-add", ["-q", agentKey])).code).toBe(0);
      unlinkSync(agentKey);
      const fields = { ...GRANT };
      const signature = await sshKeygenSign(grantSigningBytes(fields), `${agentKey}.pub`);
      const anchor = trustAnchorFromPem(readFileSync(`${agentKey}.pub`, "utf8"));
      expect(grantSignatureValid({ ...fields, signature }, anchor)).toBe(true);
      expect(grantSignatureValid({ ...fields, principal: "someone-else", signature }, anchor)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["SSH_AUTH_SOCK"];
      else process.env["SSH_AUTH_SOCK"] = previous;
      agent.kill();
    }
  });
});
