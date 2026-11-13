import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GrantStore, HostPathResolver, Workspace, execFileScript, readCommandString } from "../../enforcement/src/index.js";
import { readPayload, readTrajectory } from "../../journal/src/index.js";
import { openTestLayer } from "../../enforcement/test/layer.js";
import type { SessionLayer } from "../../enforcement/src/index.js";
import { TEST_ANCHOR, signed } from "../../enforcement/test/test-keys.js";
import { MediatedSessions, PathMap, type SessionRequest } from "../src/session.js";
import { systemFilesystemIo } from "../src/filesystem.js";

// Operator ruling 1 of 2026-11-07 (DECISIONS.md D-152): close the class that review rounds 1 to 3 of PR #37 each found
// one member of. For ANY Bash tool input whose command holds shell syntax, an interpreter, or a program outside the
// name map, combined with ANY subset of other defects, the outcome is a non-overridable integrity_floor park, recorded
// as such, and the command never runs (in mode C Claude Code runs a call only on JUNO's `allow` or no decision).
// The hand-written tests in session.test.ts stay; this generalises them.

const PRINCIPAL = "alireza";
const T0 = new Date("2026-11-07T09:00:00.000Z");
const TTL = 120_000;
const WALL_CLOCK = 60_000;
const NAME_MAP = [
  { name: "cat", program: "/usr/bin/cat", side_effect: "read" as const },
  { name: "rm", program: "/usr/bin/rm", side_effect: "write" as const },
];
const MAP = new Map(NAME_MAP.map((entry) => [entry.name, entry.program]));
const ALL_CC = ["cc.read", "cc.glob", "cc.write", "cc.edit", "cc.bash.read", "cc.bash.write", "cc.webfetch"];

let dir: string;
let work: string;
let journal: { readonly root: string };
let layer: SessionLayer;
let grants: GrantStore;
let sessions: MediatedSessions;
let now: Date;
let runs = 0;

function grant(id: string, capabilities: readonly string[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return signed({
    id,
    principal: PRINCIPAL,
    capability_selector: { capabilities: [...capabilities] },
    resource_scope: [{ kind: "path", prefix: "/work/project" }],
    data_class_bounds: { max_sensitivity: "secret", min_integrity: "untrusted" },
    issuance: "preissued",
    issued_by: PRINCIPAL,
    issued_at: new Date(T0.getTime() - 60_000).toISOString(),
    expires_at: new Date(T0.getTime() + 86_400_000).toISOString(),
    max_invocations: 100,
    attenuation_parent: null,
    revoked_at: null,
    ...overrides,
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "juno-injection-property-"));
  work = join(dir, "work");
  mkdirSync(join(work, "project", "secrets"), { recursive: true });
  writeFileSync(join(work, "project", "notes.txt"), "notes\n");
  writeFileSync(join(work, "project", "secrets", "key.txt"), "secret\n");
  layer = await openTestLayer("hook", { journal: join(dir, "journal"), workspaces: [work], state: [{ what: "the checkpoint store", path: join(dir, "checkpoints"), kind: "dir" }] });
  journal = { root: layer.root };
  grants = new GrantStore(TEST_ANCHOR);
  grants.add(grant("grant-all", ALL_CC));
  grants.add(grant("grant-no-bash", ["cc.read", "cc.write"]));
  grants.add(grant("grant-revoked", ALL_CC));
  grants.revoke("grant-revoked", T0);
  grants.add(grant("grant-expired", ALL_CC, { expires_at: new Date(T0.getTime() + 1_000).toISOString() }));
  // A forged grant: its signature no longer covers its fields, so a session naming it is refused (§3.2 C1).
  grants.add({ ...grant("grant-forged", ALL_CC), max_invocations: 9_999 });
  now = T0;
  sessions = new MediatedSessions({ layer, grants, paths: new PathMap([work]), resolver: new HostPathResolver(work), view: new Workspace(execFileScript(process.execPath, []), "/work", work), filesystem: systemFilesystemIo(), clock: () => now });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Safe words a command may carry around the injected part. */
const word = fc.constantFrom("notes.txt", "secrets/key.txt", "-n", "--", "x", "a b", "'q'", '"d"', "/etc/passwd");
const tail = fc.array(word, { maxLength: 3 }).map((words) => words.join(" "));

/** Shell syntax anywhere in an otherwise mapped command (§2.3.2), including D-105's `#` and D-140's `!`. */
const shellSyntax = fc
  .tuple(
    fc.constantFrom("cat notes.txt", "rm notes.txt", "cat", "cat -n notes.txt"),
    fc.constantFrom(";", "|", "&", "&&", "||", "$(id)", "`id`", ">", ">>", "<", "\n", "\r", "#", "{", "}", "(", ")", "\\", "$HOME", "*", "?", "[a]", "!", '"$x"', '"a\\b"'),
    fc.constantFrom("", " ", "x"),
    tail,
  )
  .map(([head, syntax, glue, rest]) => [head, syntax].join(glue === "x" ? "" : glue) + (rest === "" ? "" : ` ${rest}`));
/** A leading `~`, a leading assignment, or a keyword or builtin in any position (§2.3.2). */
const shellWords = fc
  .tuple(fc.constantFrom("~/x", "X=1 cat", "PATH=/tmp cat", "eval cat", "cat notes.txt source", "exec cat", "cd /tmp", ". notes.txt", "if", "cat do"), tail)
  .map(([head, rest]) => (rest === "" ? head : `${head} ${rest}`));
/** An interpreter or a program the name map does not hold, by name or by path (§2.3, §2.3.2). */
const interpreter = fc
  .tuple(fc.constantFrom("sh", "bash", "zsh", "python3", "python", "node", "perl", "ruby", "env", "xargs", "find", "awk", "make", "npm", "pytest", "git", "ssh-keygen", "wsl.exe", "powershell", "/bin/sh", "/usr/bin/cat", "./cat", "Cat"), tail)
  .map(([head, rest]) => (rest === "" ? head : `${head} ${rest}`));
const unmapped = fc
  .tuple(fc.stringMatching(/^[a-z][a-z0-9_-]{0,9}$/), tail)
  .filter(([name]) => !MAP.has(name))
  .map(([name, rest]) => (rest === "" ? name : `${name} ${rest}`));
/** Every generated command is one the strict reader refuses, so the property is never vacuous. */
const injected = fc.oneof(shellSyntax, shellWords, interpreter, unmapped).filter((command) => !readCommandString(command, MAP).ok);

/** Any subset of the other defects the ruling lists, plus the session states rounds 1 to 3 met. */
const defects = fc.record({
  extraField: fc.option(fc.constantFrom("dangerouslyDisableSandbox", "sandbox", "env", "shell", "command2"), { nil: undefined }),
  missing: fc.subarray(["cwd", "tool_use_id", "description"] as const),
  cwdOutside: fc.boolean(),
  budget: fc.constantFrom("ok", "calls_spent", "wall_clock_spent"),
  grant: fc.constantFrom("ok", "none", "no_bash", "revoked", "expired", "forged"),
  sensitiveRead: fc.boolean(),
  malformed: fc.subarray(["cwd", "tool_use_id", "agent_id", "timeout", "description", "run_in_background", "hook_extra"] as const),
  pendingResult: fc.boolean(),
  ttl: fc.constantFrom("ok", "expired_now", "already_failed"),
});
type Defects = typeof defects extends fc.Arbitrary<infer T> ? T : never;

const MALFORMED: Readonly<Record<Defects["malformed"][number], { readonly top?: Record<string, unknown>; readonly tool?: Record<string, unknown> }>> = {
  cwd: { top: { cwd: 42 } },
  tool_use_id: { top: { tool_use_id: 7 } },
  agent_id: { top: { agent_id: { nested: true } } },
  timeout: { tool: { timeout: "soon" } },
  description: { tool: { description: 5 } },
  run_in_background: { tool: { run_in_background: "yes" } },
  hook_extra: { top: { permission_mode: ["x"], tool_response: { stdout: "spoofed" } } },
};

function hookInput(sessionId: string, command: string, d: Defects, toolUseId: string): Record<string, unknown> {
  const tool: Record<string, unknown> = { command: d.sensitiveRead ? `${command} secrets/key.txt` : command, description: "a call", timeout: 1_000 };
  const top: Record<string, unknown> = { session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: toolUseId, cwd: d.cwdOutside ? "/etc" : join(work, "project") };
  if (d.extraField !== undefined) tool[d.extraField] = true;
  if (d.missing.includes("cwd")) delete top["cwd"];
  if (d.missing.includes("tool_use_id")) delete top["tool_use_id"];
  if (d.missing.includes("description")) delete tool["description"];
  for (const key of d.malformed) {
    Object.assign(top, MALFORMED[key].top ?? {});
    Object.assign(tool, MALFORMED[key].tool ?? {});
  }
  return { ...top, tool_input: tool };
}

function request(sessionId: string, d: Defects): SessionRequest {
  const grantIds = { ok: ["grant-all"], none: [], no_bash: ["grant-no-bash"], revoked: ["grant-revoked"], expired: ["grant-expired"], forged: ["grant-forged"] }[d.grant];
  return {
    session_id: sessionId,
    principal: PRINCIPAL,
    attendance: "gated",
    ttl: TTL,
    grants: grantIds,
    // With the calls budget spent, the earlier calls below use it all up.
    budget: { tool_calls: d.budget === "calls_spent" ? 1 : 50, wall_clock_ms: WALL_CLOCK },
    unmetered_accepted: true,
    provider_clearance: "internal",
    sources: [
      { id: "project", selector: { kind: "path", prefix: "/work/project" }, data_class: { sensitivity: "internal", integrity: "untrusted" } },
      { id: "secrets", selector: { kind: "path", prefix: "/work/project/secrets" }, data_class: { sensitivity: "secret", integrity: "operator" } },
    ],
    name_map: NAME_MAP,
  };
}

const records = (taskId: string) => readTrajectory(journal.root, taskId);
const payload = (entry: { payload_ref: string }): Record<string, unknown> => {
  const blob = readPayload(journal.root, entry.payload_ref);
  return blob.status === "present" ? (JSON.parse(new TextDecoder().decode(blob.bytes)) as Record<string, unknown>) : {};
};

/** Puts the session in the state the defects name, with real earlier calls, as Claude Code would. */
async function prepare(sessionId: string, d: Defects): Promise<void> {
  const benign = (toolUseId: string): Record<string, unknown> => ({ session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "cat notes.txt" }, tool_use_id: toolUseId, cwd: join(work, "project") });
  if (d.budget === "calls_spent" || d.pendingResult) {
    const first = benign(`prep-${sessionId}-1`);
    await sessions.preToolUse(first);
    if (!d.pendingResult) await sessions.postToolUse({ ...first, hook_event_name: "PostToolUse", tool_response: {} });
  }
  if (d.ttl === "already_failed") {
    now = new Date(T0.getTime() + TTL + 1_000);
    await sessions.preToolUse(benign(`prep-${sessionId}-ttl`));
  }
  if (d.ttl === "expired_now") now = new Date(T0.getTime() + TTL + 1_000);
  else if (d.budget === "wall_clock_spent" && d.ttl === "ok") now = new Date(T0.getTime() + WALL_CLOCK + 1_000);
}

describe("operator ruling 1 (D-152): the injected-command class is closed in hook mode", () => {
  // proves §2.3.2 with §2.7.1 D5 and §8.3: for any injected Bash command and any subset of other defects, the call parks
  // integrity_floor, not overridable, recorded as exactly that one park, and is denied, so it never runs; the same call
  // with a mapped command is never recorded as integrity_floor, so the park comes from the command and nothing else
  it("parks every injected command integrity_floor, non-overridable, whatever else is wrong", async () => {
    let refusedRuns = 0;
    await fc.assert(
      fc.asyncProperty(injected, defects, async (command, d) => {
        runs += 1;
        const sessionId = `prop-${String(runs)}`;
        const taskId = `session-${sessionId}`;
        now = T0;
        const admitted = await sessions.admit(request(sessionId, d));
        // A forged grant, and a revoked one (its signature covers revoked_at), do not exist (§3.2 C1): admission is refused.
        expect(admitted.admitted).toBe(d.grant !== "forged" && d.grant !== "revoked");
        if (!admitted.admitted) refusedRuns += 1;
        await prepare(sessionId, d);
        const before = records(taskId).length;
        const toolUseId = `toolu-${sessionId}`;
        const input = hookInput(sessionId, command, d, toolUseId);

        const decision = await sessions.preToolUse(input);

        // Denied, so Claude Code never runs it: no allow, no rebuilt command, no "no decision".
        expect(decision).toEqual({ decision: "deny", reason: "JUNO parked this call: integrity_floor. This cannot be overridden (§8.3)." });
        // Recorded as exactly one park: integrity_floor, not overridable, with the command; no call record, nothing else.
        const added = records(taskId).slice(before);
        expect(added.map((entry) => entry.kind)).toEqual(["park"]);
        const park = payload(added[0] ?? { payload_ref: "" });
        expect(park).toMatchObject({ reason: "integrity_floor", overridable: false, answer: "deny", mode: "hook", tool: "Bash", command: (input["tool_input"] as Record<string, unknown>)["command"] });
        // Nothing was authorized: a result reported for this call is recorded as one without an authorized call.
        if (admitted.admitted && typeof input["tool_use_id"] === "string") {
          await sessions.postToolUse({ ...input, cwd: join(work, "project"), agent_id: undefined, hook_event_name: "PostToolUse", tool_response: {} });
          expect(payload(records(taskId).at(-1) ?? { payload_ref: "" })).toMatchObject({ tool_use_id: toolUseId, call_seq: null, without_authorized_call: true });
        }

        // Control: the same defects with a mapped command are never recorded as integrity_floor.
        const control = hookInput(sessionId, "cat notes.txt", d, `${toolUseId}-control`);
        const mark = records(taskId).length;
        const answer = await sessions.preToolUse(control);
        expect(answer.decision === "deny" && answer.reason.includes("integrity_floor")).toBe(false);
        expect(records(taskId).slice(mark).filter((entry) => entry.kind === "park").map(payload).some((item) => item["reason"] === "integrity_floor")).toBe(false);
      }),
      { numRuns: 150, seed: 20261107 },
    );
    // The refused-admission branch was exercised, not skipped.
    expect(refusedRuns).toBeGreaterThan(0);
  }, 120_000);
});
