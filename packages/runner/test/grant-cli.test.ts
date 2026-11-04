import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sshsigSign } from "../../enforcement/src/index.js";
import { type CliIo, runGrantCli } from "../src/grant-cli.js";

/**
 * §3.2 (v0.6 C1), D-117: `juno grant sign` and `juno grant verify`. Keys are generated per run, in memory; the files the
 * CLI reads are served from memory too, so no key ever touches disk.
 */

const operator = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const pem = (key: typeof operator.privateKey): string => String(key.export({ type: key.type === "private" ? "pkcs8" : "spki", format: "pem" }));
const GRANT = {
  id: "grant-1",
  principal: "alireza",
  capability_selector: { capabilities: ["shell.run"] },
  resource_scope: [{ kind: "path", prefix: "/work/project" }],
  data_class_bounds: { max_sensitivity: "internal", min_integrity: "untrusted" },
  issuance: "preissued",
  issued_by: "alireza",
  issued_at: "2026-11-03T09:00:00.000Z",
  expires_at: "2026-11-04T09:00:00.000Z",
  max_invocations: 10,
  attenuation_parent: null,
  revoked_at: null,
};

function io(files: Record<string, string>): CliIo & { readonly output: string[]; readonly errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`no file ${path}`);
      return text;
    },
    out: (text) => output.push(text),
    err: (text) => errors.push(text),
  };
}

describe("juno grant sign and verify (§3.2 C1, D-117)", () => {
  // proves §3.2 C1: a grant signed by the operator's key verifies against the operator's public key, and not another's
  it("signs a grant that then verifies against the operator's anchor only", async () => {
    const signing = io({ "key.pem": pem(operator.privateKey), "grant.json": JSON.stringify(GRANT) });
    expect(await runGrantCli(["sign", "--key", "key.pem", "grant.json"], signing)).toBe(0);
    const signedText = signing.output.join("");
    expect(JSON.parse(signedText)).toMatchObject({ ...GRANT, signature: expect.stringMatching(/^[A-Za-z0-9+/]+={0,2}$/) });

    const good = io({ "anchor.pem": pem(operator.publicKey), "grant.json": signedText });
    expect(await runGrantCli(["verify", "--anchor", "anchor.pem", "grant.json"], good)).toBe(0);
    expect(good.output.join("")).toBe("valid\n");
    const wrong = io({ "anchor.pem": pem(other.publicKey), "grant.json": signedText });
    expect(await runGrantCli(["verify", "--anchor", "anchor.pem", "grant.json"], wrong)).toBe(1);
    expect(wrong.output.join("")).toBe("invalid\n");
  });

  // proves §3.2 C1: any field changed after signing no longer verifies
  it("reports a grant changed after signing as invalid", async () => {
    const signing = io({ "key.pem": pem(operator.privateKey), "grant.json": JSON.stringify(GRANT) });
    await runGrantCli(["sign", "--key", "key.pem", "grant.json"], signing);
    const tampered = JSON.stringify({ ...JSON.parse(signing.output.join("")), max_invocations: 1000 });
    expect(await runGrantCli(["verify", "--anchor", "anchor.pem", "grant.json"], io({ "anchor.pem": pem(operator.publicKey), "grant.json": tampered }))).toBe(1);
  });

  // proves D-117: the CLI refuses what is not a grant, a key that is not Ed25519, and bad usage
  it("refuses a malformed grant, a wrong key type and bad usage", async () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(await runGrantCli(["sign", "--key", "key.pem", "grant.json"], io({ "key.pem": pem(operator.privateKey), "grant.json": JSON.stringify({ id: "x" }) }))).toBe(1);
    expect(await runGrantCli(["sign", "--key", "key.pem", "grant.json"], io({ "key.pem": String(rsa.privateKey.export({ type: "pkcs8", format: "pem" })), "grant.json": JSON.stringify(GRANT) }))).toBe(1);
    expect(await runGrantCli(["verify", "--anchor", "a.pem", "grant.json"], io({ "a.pem": String(rsa.publicKey.export({ type: "spki", format: "pem" })), "grant.json": JSON.stringify(GRANT) }))).toBe(1);
    expect(await runGrantCli(["sign"], io({}))).toBe(2);
    expect(await runGrantCli(["frobnicate", "--key", "k", "g"], io({}))).toBe(2);
  });

  // proves D-124: --ssh-key signs through ssh-keygen (here a stand-in signing with the same SSHSIG profile), --out
  // writes a new file, and a byte-order mark from a Windows editor is accepted
  it("signs through the ssh signer and writes the signed grant with --out", async () => {
    const files: Record<string, string> = { "juno_grant.pub": "unused", "grant.json": `\uFEFF${JSON.stringify(GRANT)}` };
    const written: Record<string, string> = {};
    const signing = { ...io(files), writeFile: (path: string, text: string): void => {
      if (path in written) throw new Error("exists");
      written[path] = text;
    } };
    const signer = (message: Uint8Array, keyFile: string): Promise<string> => {
      expect(keyFile).toBe("juno_grant.pub");
      return Promise.resolve(sshsigSign(message, operator.privateKey));
    };
    expect(await runGrantCli(["sign", "--ssh-key", "juno_grant.pub", "grant.json", "--out", "signed.json"], signing, signer)).toBe(0);
    expect(signing.output.join("")).toBe("signed grant written to signed.json\n");
    const verify = io({ "anchor.pem": pem(operator.publicKey), "signed.json": written["signed.json"] ?? "" });
    expect(await runGrantCli(["verify", "--anchor", "anchor.pem", "signed.json"], verify)).toBe(0);
    expect(await runGrantCli(["sign", "--ssh-key", "juno_grant.pub", "grant.json", "--out"], io(files), signer)).toBe(2);
  });

  // proves the operator's steps (STATE.md, D-124): the example grant they sign is a valid Grant
  it("parses the example grant the operator signs", async () => {
    const example = readFileSync(fileURLToPath(new URL("../../../docs/examples/grant.example.json", import.meta.url)), "utf8");
    const signing = io({ "key.pem": pem(operator.privateKey), "grant.json": example });
    expect(await runGrantCli(["sign", "--key", "key.pem", "grant.json"], signing)).toBe(0);
  });
});
