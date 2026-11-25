import { createPrivateKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Grant, parseAtBoundary } from "../../contracts/src/index.js";
import { grantSignatureValid, grantSigningBytes, signGrant, sshKeygenSign, trustAnchorFromPem } from "../../enforcement/src/index.js";
import { junoProgramText } from "../../journal/src/index.js";

/**
 * `juno grant sign` and `juno grant verify` (spec §3.2, v0.6 C1; the plan's Increment 2 item 3; DECISIONS.md D-117).
 *
 * Either `grant sign` form may end with `--out <file>`, which writes the signed grant to a new UTF-8 file.
 *
 *   juno grant sign --ssh-key <juno_grant.pub> <grant.json>  signs with `ssh-keygen -Y sign`; the private key is held by
 *                                                            the OpenSSH agent (the Windows keychain, D-093, D-124)
 *   juno grant sign --key <private-key.pem> <grant.json>     signs with a PEM private key file (D-117)
 *   juno grant verify --anchor <public key> <grant.json>     prints "valid" (exit 0) or "invalid" (exit 1); the anchor is a
 *                                                            PEM public key or an OpenSSH `.pub` line
 *
 * Signing is the operator's side only: it is the one place a private key is read, and the runner never calls it; the
 * runner and every mediated mode only verify. The grant is parsed against the Grant contract before it is signed, so
 * what is signed is exactly what lookup will verify. On the operator's machine the key is held by the Windows OpenSSH
 * agent and never exists as a file (D-124).
 */

export type CliIo = {
  readonly readFile: (path: string) => string;
  /** Writes a new file (never replaces one); used by `grant sign --out`. */
  readonly writeFile?: (path: string, text: string) => void;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
};

export const FILE_IO: CliIo = {
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, text) => writeFileSync(path, text, { encoding: "utf8", flag: "wx" }),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

const USAGE = `usage: ${junoProgramText()} grant sign --ssh-key <key.pub> <grant.json> [--out <file>] | ${junoProgramText()} grant sign --key <private-key.pem> <grant.json> [--out <file>] | ${junoProgramText()} grant verify --anchor <public key> <grant.json>\n`;

/**
 * What a failed `--ssh-key` signing tells the operator (operator ruling D-214 item 4; D-216). `ssh-keygen -Y sign` with
 * the key held by the agent needs OpenSSH 8.2 or later (8.1 added agent signing but refuses the `-O hashalg=` option
 * this command passes), and the key loaded from the backup (docs/operator-setup.md, Part B step 6).
 */
export const SSH_SIGN_HELP =
  "juno grant: signing needs OpenSSH 8.2 or later and your key loaded in the agent from its backup (`ssh-add -l` lists it; docs/operator-setup.md, Part B step 6). Remove the key now with `ssh-add -D`, then send the agent the line above and the line `ssh -V` prints (D-216).\n";

/** JSON text, a leading byte-order mark allowed (Windows editors write one). */
function parseJson(text: string): unknown {
  return JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
}

/** The grant's fields as the contract parses them, without any signature they carry. */
function fieldsOf(text: string): Record<string, unknown> {
  const { signature: _signature, ...fields } = parseAtBoundary("grant", Grant, parseJson(text));
  void _signature;
  return fields;
}

/** Signs grant bytes with `ssh-keygen` and the agent's key; replaceable in tests. */
export type SshSigner = (message: Uint8Array, publicKeyFile: string) => Promise<string>;

/** Runs `juno grant <args>`; returns the exit code. */
export async function runGrantCli(args: readonly string[], io: CliIo = FILE_IO, sshSign: SshSigner = sshKeygenSign): Promise<number> {
  const [command, flag, keyPath, grantPath, ...rest] = args;
  // `grant sign ... --out <file>` writes the signed grant to a new UTF-8 file instead of standard output.
  const outPath = command === "sign" && rest.length === 2 && rest[0] === "--out" ? rest[1] : undefined;
  if (keyPath === undefined || grantPath === undefined || (rest.length > 0 && outPath === undefined)) {
    io.err(USAGE);
    return 2;
  }
  const emit = (text: string): void => {
    if (outPath === undefined) io.out(text);
    else if (io.writeFile === undefined) throw new Error("this command cannot write files");
    else {
      io.writeFile(outPath, text);
      io.out(`signed grant written to ${outPath}\n`);
    }
  };
  try {
    if (command === "sign" && flag === "--ssh-key") {
      const fields = fieldsOf(io.readFile(grantPath));
      emit(`${JSON.stringify({ ...fields, signature: await sshSign(grantSigningBytes(fields), keyPath) }, null, 2)}\n`);
      return 0;
    }
    if (command === "sign" && flag === "--key") {
      const key = createPrivateKey(io.readFile(keyPath));
      emit(`${JSON.stringify(signGrant(fieldsOf(io.readFile(grantPath)), key), null, 2)}\n`);
      return 0;
    }
    if (command === "verify" && flag === "--anchor") {
      const anchor = trustAnchorFromPem(io.readFile(keyPath));
      const grant = parseAtBoundary("grant", Grant, parseJson(io.readFile(grantPath)));
      const valid = grantSignatureValid(grant, anchor);
      io.out(valid ? "valid\n" : "invalid\n");
      return valid ? 0 : 1;
    }
  } catch (error: unknown) {
    io.err(`juno grant: ${error instanceof Error ? error.message : String(error)}\n`);
    if (command === "sign" && flag === "--ssh-key") io.err(SSH_SIGN_HELP);
    return 1;
  }
  io.err(USAGE);
  return 2;
}
