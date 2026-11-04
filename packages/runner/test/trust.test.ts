import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResourceSelector } from "../../contracts/src/index.js";
import { TrustAnchorError, loadTrustAnchor } from "../src/trust.js";

/**
 * §3.2 (v0.6 C1), D-116: the runner refuses a trust anchor it could write. These tests run as whatever user runs the
 * suite, who can write a fresh temporary file, so every case here is a refusal; the accepting case, a read-only anchor
 * owned by another user, is proven in the runner container (test/containers/trust.test.ts).
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "juno-anchor-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("§3.2 C1: the trust anchor must be read-only to the runner", () => {
  // proves §3.2 C1 / D-116: an anchor this process can write is refused, so the runner cannot trust a key of its own
  it("refuses an anchor the runner can write", () => {
    const path = join(dir, "operator.pub");
    writeFileSync(path, generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }));
    expect(() => loadTrustAnchor(path)).toThrow(TrustAnchorError);
    expect(() => loadTrustAnchor(path)).toThrow(/not protected/);
  });

  // proves D-116 fail-closed: a missing anchor is refused (its directory is writable here, which is refused first)
  it("refuses a missing anchor", () => {
    expect(() => loadTrustAnchor(join(dir, "missing.pub"))).toThrow(TrustAnchorError);
  });
});

describe("§3.2: no selector may name JUNO's own storage (D-116)", () => {
  // proves §3.2 "No selector may name journal storage": a grant selector can name only the capability namespace, so the
  // journal, the checkpoint store, the trust anchor and the configuration, which all live outside it, can never be named
  it.each([["/journal"], ["/var/lib/juno/journal"], ["/etc/juno/operator.pub"], ["/var/lib/juno/checkpoints"], ["/work/../journal"]])("rejects a grant selector naming %s", (prefix) => {
    expect(ResourceSelector.safeParse({ kind: "path", prefix }).success).toBe(false);
  });

  // proves §3.2 / D-116: an anchor inside the capability namespace, where a grant could name it, is refused
  it("refuses a trust anchor inside the capability namespace", () => {
    expect(() => loadTrustAnchor("/work/operator.pub")).toThrow(/capability namespace/);
  });
});
