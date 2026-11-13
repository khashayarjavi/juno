import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sshFingerprint, startupCheck } from "../src/index.js";
import { ordinaryHost } from "./layer.js";

// The shared start-up check (D-194) on the state a service opens after it: D-195 (review round 2, PR #46, note 1).

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "juno-startup-"));
  mkdirSync(join(dir, "work"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const spec = (journal: string) => ({ service: "runner" as const, journal, workspaces: [join(dir, "work")], state: [], anchor: null });

describe("D-195: state not yet created is never left to a shared folder", () => {
  // proves §3.4.1 / D-195: a journal that does not exist yet, under a folder others can write (even with the sticky bit),
  // is refused, since another user could create it between the check and the open
  it("refuses a journal not yet created in a shared sticky folder", () => {
    mkdirSync(join(dir, "shared"));
    chmodSync(join(dir, "shared"), 0o1777);
    const checked = startupCheck(spec(join(dir, "shared", "journal")), ordinaryHost());
    expect(checked).toMatchObject({ ok: false, refusals: [expect.stringContaining("could create it first (D-195)")] });
  });

  // proves D-194 / D-195 (positive controls): an existing journal folder of this process's own, in a sticky shared folder,
  // cannot be replaced by another user and is accepted; a journal not yet created in a private folder is accepted
  it("accepts an existing journal in a sticky folder, and a new one in a private folder", () => {
    mkdirSync(join(dir, "shared"));
    mkdirSync(join(dir, "shared", "journal"), { mode: 0o700 });
    chmodSync(join(dir, "shared"), 0o1777);
    expect(startupCheck(spec(join(dir, "shared", "journal")), ordinaryHost())).toMatchObject({ ok: true });
    expect(startupCheck(spec(join(dir, "journal")), ordinaryHost())).toMatchObject({ ok: true });
  });
});

describe("D-206 item 2 (D-208): the anchor pin, as the operator writes it, in the shared start-up check", () => {
  const KEY = Buffer.from("a host key for the test").toString("base64");
  /** An SSH pin under a folder the test host reports as root's, with the runner's own push key. */
  function layout(overrides: { pin?: Record<string, unknown>; knownHosts?: string; pinDir?: string } = {}): { pin: string; knownHosts: string; pushKey: string } {
    const etc = join(dir, overrides.pinDir ?? "root-owned");
    mkdirSync(etc, { recursive: true, mode: 0o755 });
    mkdirSync(join(dir, "ssh"), { recursive: true, mode: 0o700 });
    const knownHosts = join(etc, "anchors_known_hosts");
    const pushKey = join(dir, "ssh", "juno_anchors");
    writeFileSync(knownHosts, overrides.knownHosts ?? `github.com ssh-ed25519 ${KEY}\n`, { mode: 0o644 });
    writeFileSync(pushKey, "key\n", { mode: 0o600 });
    const pin = join(etc, "anchors.json");
    writeFileSync(pin, JSON.stringify({ url: "git@github.com:operator/juno-anchors.git", branch: "main", host_key_fingerprint: sshFingerprint(KEY), known_hosts: knownHosts, push_key: pushKey, git: "/usr/bin/git", journals: [{ path: join(dir, "journal"), recovery_epoch: "2026-11-13T00:00:00Z" }], ...overrides.pin }), { mode: 0o644 });
    return { pin, knownHosts, pushKey };
  }
  const check = (pin: string, journal = join(dir, "journal")) => startupCheck({ ...spec(journal), state: [{ what: "the anchor pin", path: pin, kind: "pin" }] }, ordinaryHost());

  // proves D-206 item 2: a root-owned pin naming an SSH address, exactly the pinned host key, the runner's push key and
  // this journal is verified, and the check answers what it pins
  it("verifies the operator's pin and answers what it pins", () => {
    const at = layout();
    expect(check(at.pin)).toMatchObject({ ok: true, pin: { transport: "ssh", host: "github.com", url: "git@github.com:operator/juno-anchors.git", knownHosts: at.knownHosts, pushKey: at.pushKey, journal: { recovery_epoch: "2026-11-13T00:00:00Z" } } });
  });

  // proves D-206 item 2: each way the pin could be the runner's to change, or could pin less than one host key, refuses the start
  it("refuses a pin or a known-hosts file that is not root's own, a host key that is not the pinned one, and a push key others could change", () => {
    const refusals = (result: ReturnType<typeof check>): string => (result.ok ? "" : result.refusals.join("\n"));
    expect(refusals(check(layout({ pinDir: "runner-owned" }).pin))).toMatch(/the anchor pin .* is owned by uid [0-9]+, not root/);
    const loose = layout();
    chmodSync(loose.knownHosts, 0o666);
    expect(refusals(check(loose.pin))).toMatch(/the pinned known-hosts file .* is writable by group or others/);
    chmodSync(loose.knownHosts, 0o644);
    chmodSync(loose.pushKey, 0o666);
    expect(refusals(check(loose.pin))).toMatch(/the anchor push key .* is writable by group or others/);
    chmodSync(loose.pushKey, 0o600);
    expect(refusals(check(layout({ knownHosts: `github.com ssh-ed25519 ${Buffer.from("another key").toString("base64")}\n` }).pin))).toMatch(/not the pinned SHA256:/);
    expect(refusals(check(layout({ knownHosts: `github.com ssh-ed25519 ${KEY}\n@cert-authority * ssh-ed25519 ${KEY}\n` }).pin))).toMatch(/markers such as @cert-authority are refused/);
    expect(refusals(check(layout().pin, join(dir, "another-journal")))).toMatch(/is not a journal folder the anchor pin .* names/);
    expect(refusals(check(layout({ pin: { url: "https://github.com/operator/juno-anchors.git" } }).pin))).toMatch(/cannot be used: the pinned url is neither an SSH address/);
    expect(refusals(startupCheck({ ...spec(join(dir, "journal")), state: [{ what: "the anchor pin", path: layout().pin, kind: "pin" }, { what: "the anchor pin", path: layout().pin, kind: "pin" }] }, ordinaryHost()))).toMatch(/more than one anchor pin/);
  });
});

