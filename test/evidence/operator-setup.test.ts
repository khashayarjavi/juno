import { execFile } from "node:child_process";
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeOutbound } from "../../packages/registry/src/index.js";
import { GrantStore } from "../../packages/enforcement/src/index.js";
import { TEST_ANCHOR, signed } from "../../packages/enforcement/test/test-keys.js";

/**
 * The operator's rulings of 2026-11-13 for the setup guide (DECISIONS.md D-214; built as D-216), proven against the
 * guide's own text: each test first asserts the guide says the exact command, then runs it (or its git part) for real.
 * The PowerShell lines cannot run here; their git commands are the same on Windows and are run as written.
 */

const guide = readFileSync(new URL("../../docs/operator-setup.md", import.meta.url), "utf8");
const GIT = "/usr/bin/git";

async function run(file: string, args: readonly string[]): Promise<string> {
  const result = await executeOutbound({ file, args: [...args] });
  if (result.exitCode !== 0) throw new Error(`${file} ${args.join(" ")}: ${result.stderr.toString("utf8")}`);
  return result.stdout.toString("utf8");
}

/**
 * The guide's `cmd /c "wsl ... dd of=<target> status=none < <source>"` copy: dd reads the file on its standard input.
 * Here dd writes to its standard output, which is stored as the target, so no argument is built from a path (rule 8).
 */
function ddFrom(source: string, target: string): Promise<number> {
  return new Promise((resolve) => {
    const child = execFile("/usr/bin/dd", ["status=none"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error === null) writeFileSync(target, stdout);
      resolve(error === null ? 0 : typeof error.code === "number" ? error.code : 1);
    });
    if (child.stdin === null) throw new Error("dd has no standard input");
    createReadStream(source).pipe(child.stdin);
  });
}

describe("D-214 item 1: JUNO reaches WSL as a bundle of the exact commit, never by a second sign-in", () => {
  let dir: string;
  let upstream: string;
  let wanted: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "juno-bundle-"));
    // A stand-in for the private repository: three commits; the director gives the operator the middle one.
    upstream = join(dir, "juno-upstream");
    await run(GIT, ["-c", "init.defaultBranch=main", "init", "--quiet", upstream]);
    for (const n of [1, 2, 3]) {
      writeFileSync(join(upstream, "file.txt"), `version ${String(n)}\n`);
      await run(GIT, ["-C", upstream, "add", "file.txt"]);
      await run(GIT, ["-C", upstream, "-c", "user.name=o", "-c", "user.email=o@o", "commit", "--quiet", "-m", `commit ${String(n)}`]);
    }
    wanted = (await run(GIT, ["-C", upstream, "rev-parse", "HEAD~1"])).trim();
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // proves D-214 item 1: the guide's Part A and Part E steps 11 and 12 are these commands, and no step clones the
  // private repository from inside WSL
  it("is what the guide tells the operator to do", () => {
    for (const line of [
      "git clone https://github.com/khashayarjavi/juno.git $env:USERPROFILE\\juno",
      "git checkout --detach <commit>",
      "git rev-parse HEAD",
      "git bundle create $env:USERPROFILE\\juno.bundle HEAD",
      "wsl -d Ubuntu-24.04 -u root --exec /usr/bin/install -d -m 0755 /opt/juno-setup",
      'cmd /c "wsl -d Ubuntu-24.04 -u root --exec /usr/bin/dd of=/opt/juno-setup/juno.bundle status=none < %USERPROFILE%\\juno.bundle"',
      "wsl -d Ubuntu-24.04 -u root --exec /usr/bin/chmod 0444 /opt/juno-setup/juno.bundle",
      "git clone --quiet /opt/juno-setup/juno.bundle ~/juno",
      "git -C ~/juno rev-parse HEAD",
      "sudo git clone --quiet /opt/juno-setup/juno.bundle /opt/juno",
      "sudo git -C /opt/juno rev-parse HEAD",
    ]) {
      expect(guide, line).toContain(line);
    }
    // The only clone of the private repository is the Windows one; inside WSL nothing asks for a token.
    expect(guide.match(/git clone https:\/\/github\.com\/khashayarjavi\/juno\.git/g)).toHaveLength(1);
    expect(guide).not.toContain("git clone https://github.com/khashayarjavi/juno.git ~/juno");
    expect(guide).not.toContain("sudo git clone https://github.com/khashayarjavi/juno.git /opt/juno");
    // After each clone a check names the hash to compare with.
    expect(guide.match(/exactly the commit hash from Part A step 4/g)?.length).toBe(2);
  });

  // proves D-214 item 1 with the real git: the bundle carries exactly the commit checked out on Windows, a byte-for-byte
  // copy of it (dd from standard input, as the guide's copy line) clones twice, and both clones are at that commit with
  // a clean tree that is the commit's own content
  it("bundles the checked-out commit and clones it twice, each at that commit", async () => {
    const windows = join(dir, "windows-juno");
    await run(GIT, ["clone", "--quiet", upstream, windows]);
    await run(GIT, ["-C", windows, "checkout", "--quiet", "--detach", wanted]);
    expect((await run(GIT, ["-C", windows, "rev-parse", "HEAD"])).trim()).toBe(wanted);
    const bundle = join(dir, "juno.bundle");
    await run(GIT, ["-C", windows, "bundle", "create", bundle, "HEAD"]);

    const setup = join(dir, "opt", "juno-setup");
    mkdirSync(setup, { recursive: true, mode: 0o755 });
    const copied = join(setup, "juno.bundle");
    expect(await ddFrom(bundle, copied)).toBe(0);
    expect(readFileSync(copied).equals(readFileSync(bundle))).toBe(true);
    await run("/bin/chmod", ["0444", copied]);

    for (const target of [join(dir, "home", "juno"), join(dir, "opt", "juno")]) {
      await run(GIT, ["clone", "--quiet", copied, target]);
      expect((await run(GIT, ["-C", target, "rev-parse", "HEAD"])).trim(), target).toBe(wanted);
      expect(readFileSync(join(target, "file.txt"), "utf8"), target).toBe("version 2\n");
      expect((await run(GIT, ["-C", target, "status", "--porcelain"])).trim(), target).toBe("");
    }
    // The bundle holds the wanted commit and its history only: the later commit is not in it.
    const later = (await run(GIT, ["-C", upstream, "rev-parse", "HEAD"])).trim();
    const missing = await executeOutbound({ file: GIT, args: ["-C", join(dir, "opt", "juno"), "cat-file", "-e", `${later}^{commit}`] });
    expect(missing.exitCode).not.toBe(0);
  });

  // proves D-214 item 1: a bundle that was changed on the way is not cloned as if it were the commit (git checks every
  // object), so the hash check after a clone is never reached with other content
  it("refuses a bundle damaged on the way", async () => {
    const source = join(dir, "windows-juno");
    const bundle = join(dir, "damaged.bundle");
    await run(GIT, ["-C", source, "bundle", "create", bundle, "HEAD"]);
    const bytes = readFileSync(bundle);
    bytes[bytes.length - 30] = (bytes[bytes.length - 30] ?? 0) ^ 0xff;
    writeFileSync(bundle, bytes);
    const clone = await executeOutbound({ file: GIT, args: ["clone", "--quiet", bundle, join(dir, "damaged-clone")] });
    expect(clone.exitCode).not.toBe(0);
  });
});

describe("D-214 item 5: the date for a new grant after a torn write", () => {
  const COMMAND = "date -u +%Y-%m-%dT%H:%M:%S.000Z";
  const RECOVERY = "date -u +%Y-%m-%dT%H:%M:%SZ";
  function reason(epoch: string, issuedAt: string, now = new Date()): string {
    const store = new GrantStore(TEST_ANCHOR);
    store.add(signed({ id: "g", principal: "operator", capability_selector: { capabilities: ["fs.read"] }, resource_scope: [{ kind: "path", prefix: "/work/project" }], data_class_bounds: { max_sensitivity: "secret", min_integrity: "untrusted" }, issuance: "preissued", issued_by: "operator", issued_at: issuedAt, expires_at: "2099-01-01T00:00:00Z", max_invocations: null, attenuation_parent: null, revoked_at: null }));
    store.restoreRecovery({ exhausted: [], recoveryEpoch: Date.parse(epoch) });
    const coverage = store.coverage({ principal: "operator", grants: ["g"] }, "fs.read", now);
    return coverage.covering.length === 1 ? "honoured" : (coverage.refused[0]?.reason ?? "none");
  }

  // proves D-214 item 5: the guide states the rule and gives one command, and no longer says "yesterday" there
  it("is what the guide tells the operator to do", () => {
    const section = guide.slice(guide.indexOf("**A power loss or a crash interrupted one journal write**"), guide.indexOf("- The service refuses to start saying `the anchor repository's history"));
    expect(section).toContain("**at or after the recovery epoch**");
    expect(section).toContain("**and in the past**");
    expect(section).toContain(COMMAND);
    expect(section).toContain("`issued_at`, to the time you copied in step 1");
    expect(section).not.toContain("yesterday's");
    // Both services, and where the message appears.
    expect(section).toContain("systemctl --user status juno-hook.service --no-pager");
    expect(section).toContain("journalctl --user -u juno-hook.service --no-pager");
    expect(section).toContain("juno gateway: the journal's last entry was left incomplete");
    expect(section).toContain("/var/lib/juno-runner/gateway-session.json");
  });

  // proves D-214 item 5 with §3.2: the value the command prints is a grant time the contract accepts, and a grant issued
  // at it is honoured on the first journal (epoch 2020) and on a journal recovered just before (epoch printed earlier by
  // the manual recovery's command), at once and later; one issued yesterday is refused on the recovered journal
  it("prints a value honoured on the first journal and right after a manual recovery", async () => {
    const epoch = (await run("/usr/bin/date", ["-u", "+%Y-%m-%dT%H:%M:%SZ"])).trim();
    expect(guide).toContain(RECOVERY);
    const value = (await run("/usr/bin/date", ["-u", "+%Y-%m-%dT%H:%M:%S.000Z"])).trim();
    expect(value).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z$/);
    // The value is in the past (or now) by the time a grant is used; the rule is at or after the epoch.
    expect(Date.parse(value)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(value)).toBeGreaterThanOrEqual(Date.parse(epoch));
    expect(reason("2020-01-01T00:00:00Z", value)).toBe("honoured");
    expect(reason(epoch, value)).toBe("honoured");
    expect(reason(epoch, value, new Date(Date.now() + 86_400_000))).toBe("honoured");
    const yesterday = `${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`;
    expect(reason(epoch, yesterday)).toBe("issued_before_recovery");
    // A value ahead of the service's clock is refused until that time: why the guide prints it on the WSL side.
    expect(reason(epoch, new Date(Date.now() + 3_600_000).toISOString())).toBe("not_yet_issued");
  });
});

describe("D-214 item 2: the check that counts runs from the admin account", () => {
  // proves D-214 item 2 (D-211): the guide's Part G step 7 is run as the admin user, in a clean environment, using only
  // root's node and JUNO, on a fresh clone the admin user made and a journal copy root made into the admin's own folder
  it("is what the guide tells the operator to do", () => {
    const step = guide.slice(guide.indexOf("7. **Check the journal against what GitHub holds, from your admin account"), guide.indexOf("A session JUNO did not admit is denied every call."));
    for (const line of [
      "install -d -m 0700 ~/juno-check",
      "git clone --quiet https://github.com/<you>/juno-anchors.git ~/juno-check/anchors",
      "sudo cp -RP /var/lib/juno-runner/journal ~/juno-check/journal",
      "sudo cp -P /var/lib/juno-runner/journal-key/journal-key.pub.pem ~/juno-check/journal-key.pub.pem",
      'sudo chown -hR "$(id -un):$(id -gn)" ~/juno-check/journal ~/juno-check/journal-key.pub.pem',
      "env -i /opt/node22/bin/node /opt/juno/dist/runner/src/juno.js journal check --journal ~/juno-check/journal --anchors ~/juno-check/anchors --key ~/juno-check/journal-key.pub.pem <task id>",
    ]) {
      expect(step, line).toContain(line);
    }
    // The commands after stopping the service are the admin terminal's; nothing of the check is done as juno-runner.
    expect(step.indexOf("**admin terminal**")).toBeGreaterThan(step.indexOf("systemctl --user stop juno-hook.service"));
    expect(step).not.toContain("~/anchors-check");
    expect(step).toContain("A check run as `juno-runner` does not count.");
  });
});

describe("D-214 items 3 and 4: the Windows account's rules, the signing key's window, and OpenSSH's version", () => {
  // proves D-214 item 3: the key is loaded from the backup only to sign and removed straight after, the guide no longer
  // claims the key never leaves the agent or that deleting the file removes it, and the box of rules comes first
  it("says what the operator must do and no longer claims more than holds", () => {
    expect(guide.indexOf("**Rules for your Windows account**")).toBeGreaterThan(0);
    expect(guide.indexOf("**Rules for your Windows account**")).toBeLessThan(guide.indexOf("## Part A"));
    expect(guide).not.toContain("never leaves Windows' key agent");
    expect(guide).not.toContain("Hand the key to the agent: `ssh-add $env:USERPROFILE\\.ssh\\juno_grant`");
    expect(guide).toContain("deleting the key file does **not** remove the key from this computer while the agent holds it");
    // Every signing in the guide is wrapped: loaded from the backup before, removed after, and the agent shown empty.
    const signings = guide.split("\n").filter((line) => line.includes("grant sign --ssh-key"));
    expect(signings.length).toBe(2);
    for (const marker of ["## Part C", "**A power loss or a crash interrupted one journal write**"]) {
      const from = guide.indexOf(marker);
      const sign = guide.indexOf("grant sign --ssh-key", from);
      const before = guide.lastIndexOf("ssh-add <backup path>", sign);
      const removed = guide.indexOf("ssh-add -D", sign);
      const empty = guide.indexOf("ssh-add -l", removed);
      expect(before, marker).toBeGreaterThan(from);
      expect(removed - sign, marker).toBeLessThan(400);
      expect(empty - removed, marker).toBeLessThan(40);
    }
    expect(guide).toContain("`ssh-add -l` prints `The agent has no identities.`, and `Test-Path $env:USERPROFILE\\.ssh\\juno_grant` prints `False`");
  });

  // proves D-214 item 4: Part A prints the OpenSSH version and names the minimum (D-216), with what to do when older
  it("checks OpenSSH's version in Part A", () => {
    const partA = guide.slice(guide.indexOf("## Part A"), guide.indexOf("## Part B"));
    expect(partA).toContain("ssh -V");
    expect(partA).toContain("**The version must be 8.2 or later**");
    expect(partA).toContain("If it is still older than 8.2, **stop**");
  });
});
