import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CheckpointStore, GrantStore, HostPathResolver, Workspace, execFileScript } from "../../enforcement/src/index.js";
import { JournalWriter, readPayload, readTrajectory } from "../../journal/src/index.js";
import { TEST_ANCHOR, signed } from "../../enforcement/test/test-keys.js";
import { type DeclaredSource, classifyRead, isPublicInternet } from "../src/reads.js";
import { type HookDecision, MediatedSessions, PathMap, SUPPORTED_TOOLS, type SessionRequest } from "../src/session.js";
import { systemFilesystemIo } from "../src/filesystem.js";

// Operator ruling 2 of 2026-11-07, second session (DECISIONS.md D-162): close the class "an unclassified read is counted
// low" structurally. D-150 (a result with no authorized call), D-156 (a path or link no source classifies) and D-160 (a
// fetched page) were each one member of it. For EVERY tool in JUNO's tool table, generated reads of unregistered paths,
// symlinks, hard links, URLs and tool results are judged and recorded at the highest declared class, and stopped before
// running when that is above the session's clearance. Positive controls: a read a declared source matches keeps its
// declared class. proves §4.3 V6-7, §1.5, §1.2, §2.7.1 C4

const PRINCIPAL = "alireza";
const T0 = new Date("2026-11-07T12:00:00.000Z");
const HIGHEST = "secret";
const NAME_MAP = [
  { name: "cat", program: "/usr/bin/cat", side_effect: "read" as const },
  { name: "ls", program: "/usr/bin/ls", side_effect: "read" as const },
];
const ALL_CC = ["cc.read", "cc.glob", "cc.write", "cc.edit", "cc.bash.read", "cc.webfetch"];

/**
 * The sources every generated session declares. `/work/other/pub` is declared but `/work/other` is not: a link to
 * `/work/other` reaches a tree only partly declared, which must not be read at `pub`'s class.
 */
const SOURCES: DeclaredSource[] = [
  { id: "project", selector: { kind: "path", prefix: "/work/project" }, data_class: { sensitivity: "internal", integrity: "untrusted" } },
  { id: "secrets", selector: { kind: "path", prefix: "/work/project/secrets" }, data_class: { sensitivity: "secret", integrity: "operator" } },
  { id: "other-pub", selector: { kind: "path", prefix: "/work/other/pub" }, data_class: { sensitivity: "public", integrity: "untrusted" } },
];

let dir: string;
let work: string;
let journal: JournalWriter;
let grants: GrantStore;
let sessions: MediatedSessions;
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
    max_invocations: 1_000,
    attenuation_parent: null,
    revoked_at: null,
    ...overrides,
  });
}

function request(id: string, clearance: "internal" | "secret", grantId: string, extra: Partial<SessionRequest> = {}): SessionRequest {
  return {
    session_id: id,
    principal: PRINCIPAL,
    attendance: "gated",
    ttl: 3_600_000,
    grants: [grantId],
    budget: { tool_calls: 50, wall_clock_ms: 3_600_000 },
    unmetered_accepted: true,
    provider_clearance: clearance,
    sources: SOURCES,
    name_map: NAME_MAP,
    ...extra,
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "juno-reads-property-"));
  work = join(dir, "work");
  mkdirSync(join(work, "project", "secrets", "sub"), { recursive: true });
  mkdirSync(join(work, "project", "docs"), { recursive: true });
  mkdirSync(join(work, "project", "rw"), { recursive: true });
  mkdirSync(join(work, "other", "pub"), { recursive: true });
  mkdirSync(join(dir, "outside"), { recursive: true });
  writeFileSync(join(work, "project", "notes.txt"), "notes\n");
  writeFileSync(join(work, "project", "docs", "guide.txt"), "guide\n");
  writeFileSync(join(work, "project", "rw", "draft.txt"), "draft\n");
  writeFileSync(join(work, "project", "secrets", "key.txt"), "secret\n");
  writeFileSync(join(work, "other", "plain.txt"), "unclassified\n");
  writeFileSync(join(work, "other", "pub", "readme.txt"), "public\n");
  writeFileSync(join(dir, "outside", "host.txt"), "outside the workspace\n");
  journal = JournalWriter.open(join(dir, "journal"));
  grants = new GrantStore(TEST_ANCHOR);
  grants.add(grant("grant-all", ALL_CC));
  sessions = new MediatedSessions({
    journal,
    grants,
    paths: new PathMap([work]),
    resolver: new HostPathResolver(work),
    view: new Workspace(execFileScript(process.execPath, []), "/work", work),
    filesystem: systemFilesystemIo(), protectedPaths: [join(dir, "checkpoints")],
    clock: () => T0,
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const payload = (entry: { payload_ref: string }): Record<string, unknown> => {
  const blob = readPayload(journal.root, entry.payload_ref);
  return blob.status === "present" ? (JSON.parse(new TextDecoder().decode(blob.bytes)) as Record<string, unknown>) : {};
};
const trajectory = (id: string) => readTrajectory(journal.root, `session-${id}`);
const lastResult = (id: string) => {
  const entry = trajectory(id).filter((candidate) => candidate.kind === "capability_result").at(-1);
  return entry === undefined ? undefined : ({ data_class: entry.data_class, ...payload(entry) } as Record<string, unknown>);
};
const lastPark = (id: string) => trajectory(id).filter((entry) => entry.kind === "park").map(payload).at(-1);

/** Asks once, then reports a result whether or not JUNO allowed the call (as a harness acting without a decision would). */
async function askAndReport(id: string, tool: string, input: Record<string, unknown>): Promise<HookDecision> {
  runs += 1;
  const asked = { session_id: id, hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: `toolu_${String(runs)}`, cwd: join(work, "project") };
  const decision = await sessions.preToolUse(asked);
  expect(await sessions.postToolUse({ ...asked, hook_event_name: "PostToolUse", tool_response: { content: "whatever was read" } })).toEqual({ recorded: true });
  return decision;
}

/** An unregistered read as a file system fixture: what kind, and where its link leads. */
const fixture = fc.record({
  kind: fc.constantFrom("hard_link", "link_by_name", "link_in_tree", "hard_link_in_tree", "link_then_dotdot"),
  // Every target lies in no declared source, or is the same file as one (a hard link is the highest class whatever it names).
  linkTarget: fc.constantFrom("other", "other/plain.txt", "outside", "outside/host.txt", "other/missing.txt"),
  hardTarget: fc.constantFrom("project/secrets/key.txt", "other/plain.txt", "project/notes.txt"),
  name: fc.stringMatching(/^[a-z][a-z0-9_-]{0,11}$/),
});
type Fixture = typeof fixture extends fc.Arbitrary<infer T> ? T : never;

/** Builds the fixture in a fresh directory under the project; returns its directory and the file a call names. */
function build(f: Fixture): { readonly root: string; readonly relRoot: string; readonly named: string; readonly relNamed: string } {
  const relRoot = `run-${String(runs)}-${String(Math.random()).slice(2, 8)}`;
  const root = join(work, "project", relRoot);
  mkdirSync(join(root, "tree"), { recursive: true });
  const linkTo = f.linkTarget.startsWith("outside") ? join(dir, f.linkTarget) : join(work, f.linkTarget);
  const hardFrom = join(work, f.hardTarget);
  const rel = (path: string) => path.slice(join(work, "project").length + 1);
  switch (f.kind) {
    case "hard_link": {
      const named = join(root, `${f.name}.txt`);
      linkSync(hardFrom, named);
      return { root, relRoot, named, relNamed: rel(named) };
    }
    case "link_by_name": {
      const named = join(root, `${f.name}.lnk`);
      symlinkSync(linkTo, named);
      return { root, relRoot, named, relNamed: rel(named) };
    }
    case "link_in_tree": {
      symlinkSync(linkTo, join(root, "tree", `${f.name}.lnk`));
      return { root, relRoot, named: join(root, "tree"), relNamed: rel(join(root, "tree")) };
    }
    case "hard_link_in_tree": {
      linkSync(hardFrom, join(root, "tree", `${f.name}.txt`));
      return { root, relRoot, named: join(root, "tree"), relNamed: rel(join(root, "tree")) };
    }
    case "link_then_dotdot": {
      // PR #40 review round 6 (D-166): a link followed by `..` leaves where the text says; the file system takes the
      // link first, so `<link to secrets/sub>/../key.txt` is the secret key.
      symlinkSync(join(work, "project", "secrets", "sub"), join(root, `${f.name}.d`));
      const named = `${root}/${f.name}.d/../key.txt`;
      return { root, relRoot, named, relNamed: rel(named) };
    }
  }
}

/** One generated tool input per tool in the table: what the call names, from the fixture. */
const CASES: Readonly<Record<string, (built: ReturnType<typeof build>, pick: number) => Record<string, unknown>>> = {
  Read: (built) => ({ file_path: built.named }),
  Glob: (built, pick) => ({ pattern: "**/*", path: pick % 2 === 0 ? built.root : built.named }),
  Write: (built) => ({ file_path: built.named, content: "written" }),
  Edit: (built) => ({ file_path: built.named, old_string: "a", new_string: "b", replace_all: false }),
  Bash: (built, pick) => ({ command: [`cat ${built.relNamed}`, `ls ${built.relNamed}`, `ls -R ${built.relRoot}`, `cat -- ${built.relNamed}`][pick % 4] ?? "" }),
};

/** URLs no declared source matches, with the URL sources the session declares for each. */
const privateHost = fc.constantFrom("localhost", "intranet", "wiki.corp", "jenkins.internal", "nas.local", "router.lan", "printer.home.arpa", "intranet.example", "x.test", "127.0.0.1", "10.0.0.8", "0x7f.1", "[::1]", "192.168.1.1", "169.254.169.254");
const publicHost = fc.tuple(fc.stringMatching(/^[a-z][a-z0-9-]{0,14}[a-z0-9]$/), fc.constantFrom("com", "org", "net", "io", "dev", "co.uk")).map(([name, top]) => `${name}.${top}`);
const path = fc.stringMatching(/^[a-z0-9/_.-]{0,20}$/).map((rest) => `/${rest}`);
const unregisteredUrl = fc.oneof(
  // No URL source at all: every URL is the highest class.
  fc.tuple(fc.constantFrom("https", "http"), fc.oneof(publicHost, privateHost), path).map(([scheme, host, rest]) => ({ url: `${scheme}://${host}${rest}`, sources: [] as DeclaredSource[] })),
  // An origin source for a different origin, sub-domain or port: no match.
  fc.tuple(publicHost, path, fc.constantFrom("sub.", "", ":8443", "http")).map(([host, rest, twist]) => ({
    url: twist === "http" ? `http://${host}${rest}` : twist === ":8443" ? `https://${host}:8443${rest}` : `https://${twist}${host}${rest}`,
    sources: [{ id: "docs", selector: { kind: "url", origin: twist === "sub." ? `https://${host}` : `https://docs-${host}` }, data_class: { sensitivity: "public", integrity: "untrusted" } }] as DeclaredSource[],
  })),
  // The public internet declared: a private, special-use, IP-literal, non-default-port or credentialed URL is not it.
  fc.tuple(privateHost, path, fc.constantFrom("", ":8080", "user:pw@")).map(([host, rest, twist]) => ({
    url: twist === "user:pw@" ? `https://${twist}${host}${rest}` : `https://${host}${twist}${rest}`,
    sources: [{ id: "web", selector: { kind: "internet" }, data_class: { sensitivity: "public", integrity: "untrusted" } }] as DeclaredSource[],
  })),
  fc.tuple(publicHost, path).map(([host, rest]) => ({ url: `https://user:pw@${host}${rest}`, sources: [{ id: "web", selector: { kind: "internet" }, data_class: { sensitivity: "public", integrity: "untrusted" } }] as DeclaredSource[] })),
  fc.constantFrom("ftp://files.example.org/x", "file:///etc/passwd", "not a url", "", "javascript:alert(1)", "data:text/plain,hi").map((url) => ({ url, sources: [{ id: "web", selector: { kind: "internet" }, data_class: { sensitivity: "public", integrity: "untrusted" } }] as DeclaredSource[] })),
);

/** Admits a pair of sessions for one run: clearance below the highest class, and at it. */
async function pair(extra: (clearance: "internal" | "secret") => Partial<SessionRequest> = () => ({}), grantId = "grant-all"): Promise<{ low: string; high: string }> {
  const low = `low-${String(runs)}-${String(Math.random()).slice(2, 8)}`;
  const high = `high-${String(runs)}-${String(Math.random()).slice(2, 8)}`;
  expect(await sessions.admit(request(low, "internal", grantId, extra("internal")))).toMatchObject({ admitted: true });
  expect(await sessions.admit(request(high, "secret", grantId, extra("secret")))).toMatchObject({ admitted: true });
  return { low, high };
}

/** The property's assertions for one call in each session of a pair. */
async function judge(ids: { low: string; high: string }, tool: string, input: Record<string, unknown>, proceeded: Map<string, number>): Promise<void> {
  // Below the highest class: stopped before it runs, and a result reported anyway is one with no authorized call,
  // recorded at the highest class.
  const low = await askAndReport(ids.low, tool, input);
  expect(low.decision).toBe("deny");
  expect(lastResult(ids.low)).toMatchObject({ data_class: { sensitivity: HIGHEST, integrity: "untrusted" }, without_authorized_call: true });
  const park = lastPark(ids.low);
  if (park?.["reason"] === "sensitivity_ceiling") expect(park).toMatchObject({ detail: expect.objectContaining({ read_gate: true, aggregate: HIGHEST }) });
  // At the highest class: either stopped for another reason (never the read gate), or it runs and its result is recorded
  // at the highest class.
  const high = await askAndReport(ids.high, tool, input);
  if (high.decision === "deny") expect(lastPark(ids.high)?.["reason"]).not.toBe("sensitivity_ceiling");
  else {
    proceeded.set(tool, (proceeded.get(tool) ?? 0) + 1);
    expect(lastResult(ids.high)).toMatchObject({ data_class: { sensitivity: HIGHEST, integrity: "untrusted" } });
    expect(lastResult(ids.high)?.["without_authorized_call"]).toBeUndefined();
  }
}

describe("D-162: every tool in the table reads an unregistered target at the highest declared class (§4.3 V6-7, §1.5)", () => {
  // proves D-162: the property covers exactly the tool table, so a tool added to the table without a case fails here
  it("has a generated case for every tool in the table", () => {
    expect([...Object.keys(CASES), "WebFetch"].sort()).toEqual([...SUPPORTED_TOOLS].sort());
  });

  const proceeded = new Map<string, number>();

  // proves §4.3 V6-7 with §2.7.1 C4 and D-157, for each path-reading tool: unregistered paths, symlinks (by name and
  // inside a tree, to a place no source declares, partly declared, outside the workspace, or dangling) and hard links
  it.each(Object.keys(CASES))("%s: unregistered paths, symlinks and hard links", async (tool) => {
    await fc.assert(
      fc.asyncProperty(fixture, fc.nat(), async (f, pick) => {
        const built = build(f);
        try {
          await judge(await pair(), tool, (CASES[tool] ?? (() => ({})))(built, pick), proceeded);
        } finally {
          rmSync(built.root, { recursive: true, force: true });
        }
      }),
      { numRuns: 30, seed: 20261107 },
    );
  }, 300_000);

  // proves §4.3 V6-7 with §1.5 for WebFetch: a URL no URL source positively matches is the highest class (D-160, D-162)
  it("WebFetch: URLs no source matches", async () => {
    await fc.assert(
      fc.asyncProperty(unregisteredUrl, async ({ url, sources }) => {
        const grantId = `grant-fetch-${String(runs)}-${String(Math.random()).slice(2, 8)}`;
        // The URL is enumerated, so step 4 (§2.2.2) passes and the read gate alone decides.
        grants.add(grant(grantId, ["cc.webfetch"], { enumerated_targets: [{ field: "url", value: url === "" ? "-" : url }] }));
        await judge(await pair(() => ({ sources: [...SOURCES, ...sources] }), grantId), "WebFetch", { url, prompt: "summarise" }, proceeded);
      }),
      { numRuns: 60, seed: 20261107 },
    );
  }, 300_000);

  // proves the property is not vacuous: each tool that can read an unregistered target in scope did run at the highest
  // clearance and was recorded at the highest class; Write and Edit never run on one (D-158 or scope stops them first)
  it("ran the read-gate path for Read, Glob, Bash and WebFetch", () => {
    for (const tool of ["Read", "Glob", "Bash", "WebFetch"]) expect(proceeded.get(tool) ?? 0).toBeGreaterThan(0);
  });

  // proves §1.5 and D-150 for tool results: for every tool in the table and any other tool name, a result with no
  // authorized call is recorded at the highest class, even when a tool_result source names some other tool
  it("records every unauthorized tool result at the highest class", async () => {
    const ids = await pair(() => ({ sources: [...SOURCES, { id: "todo", selector: { kind: "tool_result", tool: "TodoWrite" }, data_class: { sensitivity: "public", integrity: "untrusted" } }] }));
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.constantFrom(...SUPPORTED_TOOLS, "Grep", "Task", "NotebookEdit", "mcp__server__read", "todowrite", "TodoWrite "), fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,20}$/).filter((name) => name !== "TodoWrite")), async (tool) => {
        runs += 1;
        expect(await sessions.postToolUse({ session_id: ids.low, hook_event_name: "PostToolUse", tool_name: tool, tool_input: {}, tool_use_id: `stray_${String(runs)}`, tool_response: { content: "x" } })).toEqual({ recorded: true });
        expect(lastResult(ids.low)).toMatchObject({ data_class: { sensitivity: HIGHEST, integrity: "untrusted" }, without_authorized_call: true });
      }),
      { numRuns: 100, seed: 20261107 },
    );
  }, 120_000);

  // proves D-162 for a tool outside the table: it is denied (unknown_capability), and its result is the highest class
  it("denies a tool outside the table and records its result at the highest class", async () => {
    const ids = await pair();
    for (const tool of ["Grep", "NotebookEdit", "mcp__server__fetch"]) {
      expect(await askAndReport(ids.low, tool, { path: join(work, "project", "notes.txt") })).toMatchObject({ decision: "deny" });
      expect(lastResult(ids.low)).toMatchObject({ data_class: { sensitivity: HIGHEST }, without_authorized_call: true });
    }
  });
});

describe("D-162 positive controls: a read a declared source matches keeps its class", () => {
  // proves §4.3 V6-7: registered paths and trees, by every path-reading tool, proceed below the highest clearance and are
  // recorded at their own class
  it("keeps the registered class for Read, Glob, Bash, Write and Edit", async () => {
    const ids = await pair(() => ({ reversible_workspaces: [] }));
    const id = `rw-${String(runs)}`;
    const checkpointed = new MediatedSessions({
      journal,
      grants,
      paths: new PathMap([work]),
      resolver: new HostPathResolver(work),
      view: new Workspace(execFileScript(process.execPath, []), "/work", work),
      filesystem: systemFilesystemIo(), protectedPaths: [join(dir, "checkpoints")],
      clock: () => T0,
      checkpoints: { workspace: new Workspace(execFileScript(process.execPath, []), "/work", work), store: new CheckpointStore(join(dir, "checkpoints")) },
    });
    expect(await checkpointed.admit(request(id, "internal", "grant-all", { reversible_workspaces: ["/work/project/rw"] }))).toMatchObject({ admitted: true });
    const cases: [string, Record<string, unknown>][] = [
      ["Read", { file_path: join(work, "project", "notes.txt") }],
      ["Glob", { pattern: "**/*", path: join(work, "project", "docs") }],
      ["Bash", { command: "cat notes.txt" }],
      ["Bash", { command: "ls -R docs" }],
    ];
    for (const [tool, input] of cases) {
      expect((await askAndReport(ids.low, tool, input)).decision).not.toBe("deny");
      expect(lastResult(ids.low)).toMatchObject({ data_class: { sensitivity: "internal", integrity: "untrusted" } });
      expect(lastResult(ids.low)?.["without_authorized_call"]).toBeUndefined();
    }
    for (const [tool, input] of [
      ["Write", { file_path: join(work, "project", "rw", "new.txt"), content: "x" }],
      ["Edit", { file_path: join(work, "project", "rw", "draft.txt"), old_string: "draft", new_string: "edited", replace_all: false }],
    ] as const) {
      runs += 1;
      const asked = { session_id: id, hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: `toolu_rw_${String(runs)}`, cwd: join(work, "project") };
      expect(await checkpointed.preToolUse(asked)).toEqual({ decision: "none" });
      expect(await checkpointed.postToolUse({ ...asked, hook_event_name: "PostToolUse", tool_response: {} })).toEqual({ recorded: true });
      expect(lastResult(id)).toMatchObject({ data_class: { sensitivity: "internal", integrity: "untrusted" } });
    }
  });

  // proves §1.5 with D-162: an operator who declares a URL source (one origin, or the public internet) has a fetch from
  // it recorded at that class, and it runs below the highest clearance
  it("keeps the registered class for a WebFetch from a declared origin or the public internet", async () => {
    for (const [url, selector] of [
      ["https://docs.example.com/guide?x=1", { kind: "url", origin: "https://docs.example.com" }],
      ["https://www.wikipedia.org/wiki/Hook", { kind: "internet" }],
      ["http://news.ycombinator.com/", { kind: "internet" }],
    ] as const) {
      const grantId = `grant-fetch-ok-${String(runs)}`;
      runs += 1;
      grants.add(grant(grantId, ["cc.webfetch"], { enumerated_targets: [{ field: "url", value: url }] }));
      const ids = await pair(() => ({ sources: [...SOURCES, { id: "web", selector, data_class: { sensitivity: "public", integrity: "untrusted" } }] }), grantId);
      expect(await askAndReport(ids.low, "WebFetch", { url, prompt: "summarise" })).toEqual({ decision: "none" });
      expect(lastResult(ids.low)).toMatchObject({ data_class: { sensitivity: "public", integrity: "untrusted" } });
    }
  });

  // proves D-162 and D-164: a tool_result source for a tool outside the table classifies that tool's results; one
  // naming a tool in the table is refused at admission, because its results are classified by what its call read (D-150)
  it("keeps the registered class for a declared tool_result, and refuses one naming a tool in the table", async () => {
    const todo: DeclaredSource = { id: "todo", selector: { kind: "tool_result", tool: "TodoWrite" }, data_class: { sensitivity: "public", integrity: "untrusted" } };
    const ids = await pair(() => ({ sources: [...SOURCES, todo] }));
    expect(await sessions.postToolUse({ session_id: ids.low, hook_event_name: "PostToolUse", tool_name: "TodoWrite", tool_input: {}, tool_use_id: "todo_1", tool_response: {} })).toEqual({ recorded: true });
    expect(lastResult(ids.low)).toMatchObject({ data_class: { sensitivity: "public", integrity: "untrusted" }, without_authorized_call: true });
    for (const tool of SUPPORTED_TOOLS) {
      const refused = await sessions.admit(request(`refused-${tool}-${String(runs)}`, "internal", "grant-all", { sources: [...SOURCES, { ...todo, selector: { kind: "tool_result", tool } }] }));
      expect(refused).toMatchObject({ admitted: false, failures: [expect.stringContaining("D-164")] });
    }
  });
});

describe("D-162 and D-164: classifyRead on URLs, without a session", () => {
  const unused = { resolver: { resolve: () => Promise.reject(new Error("no path is resolved for a URL")) }, view: {} as Workspace };
  const declared = (selector: DeclaredSource["selector"]): DeclaredSource[] => [...SOURCES, { id: "web", selector, data_class: { sensitivity: "public", integrity: "untrusted" } }];

  // proves §1.5: a URL no source positively matches is the highest declared class
  it("reads every unregistered URL at the highest declared class", async () => {
    await fc.assert(
      fc.asyncProperty(unregisteredUrl, async ({ url, sources }) => {
        expect(await classifyRead([{ kind: "url", url }], { ...unused, sources: [...SOURCES, ...sources] })).toBe(HIGHEST);
      }),
      { numRuns: 1_000, seed: 20261107 },
    );
  });

  // proves the positive control: an exact origin, and a public host name under the internet source, keep their class
  it("keeps the class of an exact origin and of a public host name", async () => {
    await fc.assert(
      fc.asyncProperty(publicHost, path, async (host, rest) => {
        expect(await classifyRead([{ kind: "url", url: `https://${host}${rest}` }], { ...unused, sources: declared({ kind: "url", origin: `https://${host}` }) })).toBe("public");
        expect(await classifyRead([{ kind: "url", url: `https://${host}${rest}` }], { ...unused, sources: declared({ kind: "internet" }) })).toBe("public");
        expect(isPublicInternet(new URL(`https://${host}${rest}`))).toBe(true);
      }),
      { numRuns: 500, seed: 20261107 },
    );
  });

  // proves D-162: an unknown read, and a tool that declares no read at all, are the highest class
  it("reads an unknown target, or no declared target, at the highest class", async () => {
    expect(await classifyRead([{ kind: "unknown", why: "test" }], { ...unused, sources: declared({ kind: "internet" }) })).toBe(HIGHEST);
    expect(await classifyRead([], { ...unused, sources: declared({ kind: "internet" }) })).toBe(HIGHEST);
  });
});
