import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { Grant, parseAtBoundary } from "../../contracts/src/index.js";
import { grantSignatureValid, signGrant, trustAnchorFromPem } from "../../enforcement/src/index.js";

/**
 * `juno grant sign` and `juno grant verify` (spec §3.2, v0.6 C1; the plan's Increment 2 item 3; DECISIONS.md D-117).
 *
 *   juno grant sign --key <private-key.pem> <grant.json>     prints the grant with its signature
 *   juno grant verify --anchor <public-key.pem> <grant.json> prints "valid" (exit 0) or "invalid" (exit 1)
 *
 * Signing is the operator's side only: it is the one place a private key is read, and the runner never calls it; the
 * runner and every mediated mode only verify. The grant is parsed against the Grant contract before it is signed, so
 * what is signed is exactly what lookup will verify. The private key's source on the operator's machine (the Windows
 * keychain, D-093) is wired in with the operator's set-up steps; here it is a PEM file the operator names.
 */

export type CliIo = {
  readonly readFile: (path: string) => string;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
};

export const FILE_IO: CliIo = {
  readFile: (path) => readFileSync(path, "utf8"),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

const USAGE = "usage: juno grant sign --key <private-key.pem> <grant.json> | juno grant verify --anchor <public-key.pem> <grant.json>\n";

/** The grant's fields as the contract parses them, without any signature they carry. */
function fieldsOf(text: string): Record<string, unknown> {
  const { signature: _signature, ...fields } = parseAtBoundary("grant", Grant, JSON.parse(text));
  void _signature;
  return fields;
}

/** Runs `juno grant <args>`; returns the exit code. */
export function runGrantCli(args: readonly string[], io: CliIo = FILE_IO): number {
  const [command, flag, keyPath, grantPath, ...rest] = args;
  if (keyPath === undefined || grantPath === undefined || rest.length > 0) {
    io.err(USAGE);
    return 2;
  }
  try {
    if (command === "sign" && flag === "--key") {
      const key = createPrivateKey(io.readFile(keyPath));
      io.out(`${JSON.stringify(signGrant(fieldsOf(io.readFile(grantPath)), key), null, 2)}\n`);
      return 0;
    }
    if (command === "verify" && flag === "--anchor") {
      const anchor = trustAnchorFromPem(io.readFile(keyPath));
      const grant = parseAtBoundary("grant", Grant, JSON.parse(io.readFile(grantPath)));
      const valid = grantSignatureValid(grant, anchor);
      io.out(valid ? "valid\n" : "invalid\n");
      return valid ? 0 : 1;
    }
  } catch (error: unknown) {
    io.err(`juno grant: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  io.err(USAGE);
  return 2;
}
