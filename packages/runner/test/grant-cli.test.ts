import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
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
  it("signs a grant that then verifies against the operator's anchor only", () => {
    const signing = io({ "key.pem": pem(operator.privateKey), "grant.json": JSON.stringify(GRANT) });
    expect(runGrantCli(["sign", "--key", "key.pem", "grant.json"], signing)).toBe(0);
    const signedText = signing.output.join("");
    expect(JSON.parse(signedText)).toMatchObject({ ...GRANT, signature: expect.stringMatching(/^[A-Za-z0-9+/]+={0,2}$/) });

    const good = io({ "anchor.pem": pem(operator.publicKey), "grant.json": signedText });
    expect(runGrantCli(["verify", "--anchor", "anchor.pem", "grant.json"], good)).toBe(0);
    expect(good.output.join("")).toBe("valid\n");
    const wrong = io({ "anchor.pem": pem(other.publicKey), "grant.json": signedText });
    expect(runGrantCli(["verify", "--anchor", "anchor.pem", "grant.json"], wrong)).toBe(1);
    expect(wrong.output.join("")).toBe("invalid\n");
  });

  // proves §3.2 C1: any field changed after signing no longer verifies
  it("reports a grant changed after signing as invalid", () => {
    const signing = io({ "key.pem": pem(operator.privateKey), "grant.json": JSON.stringify(GRANT) });
    runGrantCli(["sign", "--key", "key.pem", "grant.json"], signing);
    const tampered = JSON.stringify({ ...JSON.parse(signing.output.join("")), max_invocations: 1000 });
    expect(runGrantCli(["verify", "--anchor", "anchor.pem", "grant.json"], io({ "anchor.pem": pem(operator.publicKey), "grant.json": tampered }))).toBe(1);
  });

  // proves D-117: the CLI refuses what is not a grant, a key that is not Ed25519, and bad usage
  it("refuses a malformed grant, a wrong key type and bad usage", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(runGrantCli(["sign", "--key", "key.pem", "grant.json"], io({ "key.pem": pem(operator.privateKey), "grant.json": JSON.stringify({ id: "x" }) }))).toBe(1);
    expect(runGrantCli(["sign", "--key", "key.pem", "grant.json"], io({ "key.pem": String(rsa.privateKey.export({ type: "pkcs8", format: "pem" })), "grant.json": JSON.stringify(GRANT) }))).toBe(1);
    expect(runGrantCli(["verify", "--anchor", "a.pem", "grant.json"], io({ "a.pem": String(rsa.publicKey.export({ type: "spki", format: "pem" })), "grant.json": JSON.stringify(GRANT) }))).toBe(1);
    expect(runGrantCli(["sign"], io({}))).toBe(2);
    expect(runGrantCli(["frobnicate", "--key", "k", "g"], io({}))).toBe(2);
  });
});
