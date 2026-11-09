import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startupCheck } from "../src/index.js";
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
