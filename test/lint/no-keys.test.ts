import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { executeOutbound } from "../../packages/registry/src/index.js";
import { sshPublicKeyBlob } from "../../packages/enforcement/src/index.js";

/**
 * §3.2 (v0.6 C1), D-093, D-125: no key, private or public, is ever committed. Test keys are generated per run, in
 * memory or in temporary directories outside the work volume and the journal. This scans every file git tracks for key
 * material (PEM keys of any kind, OpenSSH public keys) and for key file names. A self-test first proves the scan finds
 * real keys, so it cannot pass by finding nothing. The samples are generated at run time, so this file holds none.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const PEM_KEY = /-----BEGIN [A-Z0-9 ]*KEY-----/;
const OPENSSH_KEY = /(?:ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com) AAAA[A-Za-z0-9+/]{40,}/;
const KEY_FILE = /\.(?:pem|key|pub|p12|pfx|jwk)$|(?:^|\/)id_(?:rsa|ed25519|ecdsa|dsa)|juno_grant|journal-key/i;

/** Why `text` (the content of `name`) looks like key material, or null. */
function keyFinding(name: string, text: string): string | null {
  if (KEY_FILE.test(name)) return "a key file name";
  if (PEM_KEY.test(text)) return "a PEM key";
  if (OPENSSH_KEY.test(text)) return "an OpenSSH public key";
  return null;
}

describe("no key is committed (§3.2 C1, D-125)", () => {
  // proves the scan works: freshly generated keys, in every form JUNO uses, are each found
  it("finds a key in every form JUNO uses", () => {
    const pair = generateKeyPairSync("ed25519");
    const samples: [string, string][] = [
      ["notes.txt", String(pair.privateKey.export({ type: "pkcs8", format: "pem" }))],
      ["notes.txt", String(pair.publicKey.export({ type: "spki", format: "pem" }))],
      ["notes.txt", `ssh-ed25519 ${sshPublicKeyBlob(pair.publicKey).toString("base64")} juno`],
      ["keys/operator.pem", "x"],
      ["keys/juno_grant", "x"],
      ["state/journal-key.pub.pem", "x"],
    ];
    for (const [name, text] of samples) expect(keyFinding(name, text), name).not.toBeNull();
    expect(keyFinding("notes.txt", "-----BEGIN SSH SIGNATURE-----")).toBeNull();
  });

  // proves §3.2 C1: no tracked file holds a key or is a key file
  it("finds no key in any tracked file", async () => {
    const listed = await executeOutbound({ file: "git", args: ["-C", repoRoot, "ls-files", "-z"] });
    expect(listed.exitCode).toBe(0);
    const files = listed.stdout.toString("utf8").split("\0").filter((name) => name !== "");
    expect(files.length).toBeGreaterThan(100);
    const findings = files.flatMap((name) => {
      let text: string;
      try {
        text = readFileSync(join(repoRoot, name), "latin1");
      } catch {
        return [];
      }
      const finding = keyFinding(name, text);
      return finding === null ? [] : [`${name}: ${finding}`];
    });
    expect(findings).toEqual([]);
  });
});
