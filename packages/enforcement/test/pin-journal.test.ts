import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeOutbound } from "../../registry/src/index.js";
import { GrantStore, SessionLayer, type SessionLimits, anchoringState, gitAnchoring, startupCheck } from "../src/index.js";
import { ordinaryHost } from "./layer.js";
import { TEST_ANCHOR, signed } from "./test-keys.js";

/**
 * Review round 6 on PR #51, finding D3 (DECISIONS.md D-209), in D-206 item 2's class ("does not start as new"): the
 * runner's account moves a folder above the journal aside and puts a symbolic link to an empty folder in its place.
 * The pin, the service's settings and the pinned repository are untouched. The start must be refused. Reproduced as
 * the reviewer did, with the real git and the real `SessionLayer.open` and `gitAnchoring`.
 */

const LIMITS: SessionLimits = { rejection_limit: 3, ttl: 3_600_000, budget: { tokens: 1, currency: 1, wall_clock_ms: 3_600_000, turns: 10 }, metered: ["turns", "wall_clock_ms"], clock: "from_admission" };
const CLASS = { sensitivity: "internal" as const, integrity: "operator" as const };

async function git(args: readonly string[]): Promise<void> {
  const result = await executeOutbound({ file: "/usr/bin/git", args: ["-c", "user.name=o", "-c", "user.email=o@o", "-c", "init.defaultBranch=main", ...args] });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8"));
}

describe("D-206 item 2 (D-209): a journal reached through a symbolic link is not the journal the pin names", () => {
  for (const depth of ["directly inside", "two levels below"] as const) {
    // proves D-206 item 2 with §3.4.1: the swap below makes the journal resolve elsewhere; the service refuses to start
    // and opens nothing, where before this fix it started as new (no admission remembered, the grant counted from zero)
    it(`refuses to start when a folder the journal lies ${depth} is replaced by a symbolic link`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "juno-pin-journal-"));
      try {
        const remote = join(dir, "pinned.git");
        await git(["init", "--bare", "--quiet", remote]);
        const seed = join(dir, "seed");
        await git(["clone", "--quiet", remote, seed]);
        writeFileSync(join(seed, "README.md"), "juno-anchors\n");
        await git(["-C", seed, "add", "README.md"]);
        await git(["-C", seed, "commit", "--quiet", "-m", "start"]);
        await git(["-C", seed, "push", "--quiet", "origin", "HEAD:main"]);
        const sub = depth === "directly inside" ? "" : "svc";
        const work = join(dir, "work");
        mkdirSync(work);
        const state = join(dir, "state");
        const journal = join(state, sub, "journal");
        const config = { journalKeyDir: join(state, sub, "journal-key"), anchorClone: join(state, sub, "juno-anchors"), intervalMs: 60_000, pin: join(dir, "root-owned", "anchors.json") };
        mkdirSync(join(state, sub), { recursive: true, mode: 0o700 });
        mkdirSync(join(dir, "root-owned"), { mode: 0o755 });
        writeFileSync(config.pin, JSON.stringify({ url: remote, branch: "main", host_key_fingerprint: null, known_hosts: null, push_key: null, git: "/usr/bin/git", journals: [{ path: journal, recovery_epoch: "2020-01-01T00:00:00Z" }] }), { mode: 0o644 });
        chmodSync(config.pin, 0o644);
        const opened: string[][] = [];
        const stop = SessionLayer.observe((event) => opened.push([...event.refusals]));
        const open = (): Promise<SessionLayer> => SessionLayer.open({ service: "gateway", journal, workspaces: [work], state: anchoringState(config), anchor: null }, { host: ordinaryHost(), anchoring: (root, pin) => gitAnchoring(config, root, pin) });
        try {
          const first = await open();
          first.admit("session-1", LIMITS, { dataClass: CLASS, actor: "probe", payload: { admitted_at: new Date().toISOString(), task: { grants: ["g"] } } });
          expect(await first.close()).toEqual([]);
          // Positive control: an honest restart remembers the admission.
          const second = await open();
          expect(second.admitted("session-1")).toBe(true);
          expect(await second.close()).toEqual([]);
          // The swap, by the runner's account alone.
          renameSync(state, join(dir, "state-kept-aside"));
          mkdirSync(join(dir, "state2", sub), { recursive: true, mode: 0o700 });
          symlinkSync(join(dir, "state2"), state);
          opened.length = 0;
          await expect(open()).rejects.toThrow(/symbolic link/);
          expect(opened).toHaveLength(1);
        } finally {
          stop();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);
  }

  // proves D-209: the start-up check refuses a journal path with a symbolic link anywhere in it, however far up
  it("refuses a journal whose path goes through a symbolic link at any depth", () => {
    const dir = mkdtempSync(join(tmpdir(), "juno-pin-journal-"));
    try {
      mkdirSync(join(dir, "work"));
      mkdirSync(join(dir, "real", "a", "b"), { recursive: true, mode: 0o700 });
      symlinkSync(join(dir, "real"), join(dir, "link"));
      const journal = join(dir, "link", "a", "b", "journal");
      mkdirSync(join(dir, "root-owned"), { mode: 0o755 });
      const pin = join(dir, "root-owned", "anchors.json");
      // The pin names the journal through the link, and the resolved path too: neither makes a linked path acceptable.
      writeFileSync(pin, JSON.stringify({ url: join(dir, "pinned.git"), branch: "main", host_key_fingerprint: null, known_hosts: null, push_key: null, git: "/usr/bin/git", journals: [{ path: journal, recovery_epoch: "2020-01-01T00:00:00Z" }, { path: join(dir, "real", "a", "b", "journal"), recovery_epoch: "2020-01-01T00:00:00Z" }] }), { mode: 0o644 });
      const checked = startupCheck({ service: "hook", journal, workspaces: [join(dir, "work")], state: [{ what: "the anchor pin", path: pin, kind: "pin" }], anchor: null }, ordinaryHost());
      expect(checked.ok ? "" : checked.refusals.join("\n")).toMatch(/resolves to .*real\/a\/b\/journal: a folder on its path is a symbolic link/);
      // Positive control: the real path is accepted.
      expect(startupCheck({ service: "hook", journal: join(dir, "real", "a", "b", "journal"), workspaces: [join(dir, "work")], state: [{ what: "the anchor pin", path: pin, kind: "pin" }], anchor: null }, ordinaryHost())).toMatchObject({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Review round 6 on PR #51, finding D2 (DECISIONS.md D-209): the guide's own dates must give grants the grant store
 * honours. Part C issues the first grant yesterday (UTC midnight); Part D step 7 sets the first journal's recovery epoch
 * to a fixed early date, so the first grant is honoured however many days pass between Part C and Part D (review round
 * 7, D-210, D-213); after a manual recovery the epoch is the time `date -u` printed, and new grants are issued at that
 * time. After a torn write, the new grants are issued at the time `date -u` prints then (D-214 item 5;
 * test/evidence/operator-setup.test.ts).
 */
describe("D-206 item 1 (D-209): the operator guide's dates give grants JUNO honours", () => {
  const guide = readFileSync(new URL("../../../docs/operator-setup.md", import.meta.url), "utf8");
  const midnight = (daysAgo: number): string => {
    const day = new Date(Date.now() - daysAgo * 86_400_000);
    return `${day.toISOString().slice(0, 10)}T00:00:00Z`;
  };
  function reason(epoch: string, issuedAt: string): string {
    const store = new GrantStore(TEST_ANCHOR);
    store.add(signed({ id: "g", principal: "operator", capability_selector: { capabilities: ["fs.read"] }, resource_scope: [{ kind: "path", prefix: "/work/project" }], data_class_bounds: { max_sensitivity: "secret", min_integrity: "untrusted" }, issuance: "preissued", issued_by: "operator", issued_at: issuedAt, expires_at: "2099-01-01T00:00:00Z", max_invocations: null, attenuation_parent: null, revoked_at: null }));
    store.restoreRecovery({ exhausted: [], recoveryEpoch: Date.parse(epoch) });
    const coverage = store.coverage({ principal: "operator", grants: ["g"] }, "fs.read", new Date());
    return coverage.covering.length === 1 ? "honoured" : (coverage.refused[0]?.reason ?? "none");
  }

  // proves D-206 item 1 with §3.2: the guide says what this test assumes
  it("is what the guide tells the operator to do", () => {
    expect(guide).toContain("`issued_at`, to **yesterday's** date");
    expect(guide).toContain("text with exactly `2020-01-01T00:00:00Z`");
    expect(guide).not.toContain("2 days ago");
    expect(guide).toContain("date -u +%Y-%m-%dT%H:%M:%SZ");
    expect(guide).toContain("set `issued_at` to **the time you copied in step 2**");
  });

  // proves D-206 item 1 with §3.2: the first journal honours the first grant; after a recovery, a grant issued at the
  // recovery time is honoured and one issued as on the first day (yesterday) is refused
  it("honours the first grant, refuses a pre-recovery grant, and honours one issued at the recovery", () => {
    expect(reason("2020-01-01T00:00:00Z", midnight(1))).toBe("honoured");
    // Part D done any number of days after Part C (round 7): the fixed epoch is still earlier than the first grant.
    expect(reason("2020-01-01T00:00:00Z", midnight(30))).toBe("honoured");
    const recovery = new Date(Date.now() - 60_000).toISOString().replace(/\.[0-9]{3}Z$/, "Z");
    expect(reason(recovery, midnight(1))).toBe("issued_before_recovery");
    expect(reason(recovery, recovery)).toBe("honoured");
  });
});
