import { type Stats, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Sensitivity, maxSensitivity, pathWithin, sensitivityRank } from "../../contracts/src/index.js";
import { CheckpointStore, GrantStore, HostPathResolver, Workspace, execFileScript } from "../../enforcement/src/index.js";
import { JournalWriter, readPayload, readTrajectory } from "../../journal/src/index.js";
import { TEST_ANCHOR, signed } from "../../enforcement/test/test-keys.js";
import { type DeclaredSource, classifyRead } from "../src/reads.js";
import { MediatedSessions, PathMap, SUPPORTED_TOOLS, type SessionRequest } from "../src/session.js";

// Operator ruling 1 of 2026-11-08 (DECISIONS.md D-167): the kernel is the oracle, not path text. This property builds
// real directory trees in a sandbox (folders, files, relative and absolute symlinks to registered and unregistered
// places, outside the workspace and dangling, and hard links), then walks generated paths through them that mix `..`,
// `.`, `//`, trailing slashes and symlinks in any order. For each path and each tool in JUNO's tool table it compares
// JUNO's classification and decision with the identity (device and inode) of what the kernel actually opens for that
// path, and with the classes of the registered sources that identity falls under. Any disagreement where JUNO's class
// is lower than the kernel's fails. proves §4.3 V6-7, §1.5, §1.2, §2.7.1 C4

const PRINCIPAL = "alireza";
const T0 = new Date("2026-11-08T12:00:00.000Z");
const HIGHEST: Sensitivity = "secret";
const CLEARANCES: readonly Sensitivity[] = ["public", "internal", "secret"];
const NAME_MAP = [
  { name: "cat", program: "/usr/bin/cat", side_effect: "read" as const },
  { name: "ls", program: "/usr/bin/ls", side_effect: "read" as const },
];
const SOURCES: DeclaredSource[] = [
  { id: "project", selector: { kind: "path", prefix: "/work/project" }, data_class: { sensitivity: "internal", integrity: "untrusted" } },
  { id: "secrets", selector: { kind: "path", prefix: "/work/project/secrets" }, data_class: { sensitivity: "secret", integrity: "operator" } },
  { id: "other-pub", selector: { kind: "path", prefix: "/work/other/pub" }, data_class: { sensitivity: "public", integrity: "untrusted" } },
];

let box: string; // the sandbox: `work` (the workspace) and `outside` (beyond it); nothing else, so the oracle can scan it whole
let work: string;
let state: string; // the journal and the checkpoint store, outside the sandbox
let journal: JournalWriter;
let sessions: MediatedSessions;
let runs = 0;

const rank = (level: Sensitivity): number => sensitivityRank(level);
const identity = (stat: Stats): string => `${String(stat.dev)}:${String(stat.ino)}`;

beforeAll(() => {
  box = realpathSync(mkdtempSync(join(tmpdir(), "juno-kernel-oracle-")));
  state = mkdtempSync(join(tmpdir(), "juno-kernel-oracle-state-"));
  work = join(box, "work");
  for (const folder of ["project/secrets/sub", "project/docs", "other/pub"]) mkdirSync(join(work, folder), { recursive: true });
  mkdirSync(join(box, "outside"));
  writeFileSync(join(work, "project", "notes.txt"), "internal\n");
  writeFileSync(join(work, "project", "docs", "guide.txt"), "internal\n");
  writeFileSync(join(work, "project", "secrets", "key.txt"), "secret\n");
  writeFileSync(join(work, "project", "secrets", "sub", "deep.txt"), "secret\n");
  writeFileSync(join(work, "other", "plain.txt"), "unregistered\n");
  writeFileSync(join(work, "other", "pub", "readme.txt"), "public\n");
  writeFileSync(join(box, "outside", "host.txt"), "outside the workspace\n");
  journal = JournalWriter.open(join(state, "journal"));
  const grants = new GrantStore(TEST_ANCHOR);
  // Every declared path source is in scope (§5.4 check 4 refuses a grant beyond them), so step 4 passes for every read
  // the kernel places in one and the read gate alone decides it; an unregistered place is out of scope, a deny.
  grants.add(
    signed({
      id: "grant-oracle",
      principal: PRINCIPAL,
      capability_selector: { capabilities: ["cc.read", "cc.glob", "cc.write", "cc.edit", "cc.bash.read", "cc.webfetch"] },
      resource_scope: [{ kind: "path", prefix: "/work/project" }, { kind: "path", prefix: "/work/other/pub" }],
      data_class_bounds: { max_sensitivity: "secret", min_integrity: "untrusted" },
      issuance: "preissued",
      issued_by: PRINCIPAL,
      issued_at: new Date(T0.getTime() - 60_000).toISOString(),
      expires_at: new Date(T0.getTime() + 86_400_000).toISOString(),
      max_invocations: 100_000,
      attenuation_parent: null,
      revoked_at: null,
    }),
  );
  const view = new Workspace(execFileScript(process.execPath, []), "/work", work);
  sessions = new MediatedSessions({
    journal,
    grants,
    paths: new PathMap([work]),
    resolver: new HostPathResolver(work),
    view,
    protectedPaths: [state],
    clock: () => T0,
    checkpoints: { workspace: view, store: new CheckpointStore(join(state, "checkpoints")) },
  });
});

afterAll(() => {
  rmSync(box, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

/** The /work spelling of a host path in the workspace, or null outside it. */
function toWork(host: string): string | null {
  return host === work ? "/work" : host.startsWith(`${work}/`) ? `/work${host.slice(work.length)}` : null;
}

/**
 * The oracle's classes: every identity in the sandbox, at the highest class of every place it lies (a place in no
 * declared source, the outside included, is the highest class, §1.5). The scan never follows a symlink, so every place
 * it names is a canonical place; a hard link's identity collects the classes of all its names.
 */
function identityClasses(): Map<string, Sensitivity> {
  const classes = new Map<string, Sensitivity>();
  const visit = (host: string): void => {
    const stat = lstatSync(host);
    const at = toWork(host);
    const containing = at === null ? [] : SOURCES.filter((source) => source.selector.kind === "path" && pathWithin(at, source.selector.prefix));
    const placed = containing.length === 0 ? HIGHEST : containing.reduce<Sensitivity>((high, source) => maxSensitivity(high, source.data_class.sensitivity), "public");
    classes.set(identity(stat), maxSensitivity(classes.get(identity(stat)) ?? "public", placed));
    if (stat.isDirectory()) for (const name of readdirSync(host)) visit(join(host, name));
  };
  visit(box);
  return classes;
}

/**
 * What the kernel opens for `host` (the path exactly as a program passes it to the kernel): nothing, when stat(2) fails;
 * the file's identity; or, for a directory, the identity of everything under it, following every symlink (a superset of
 * what any tool in the table reads there). Its class: the highest class of those identities; one the scan never saw is
 * the highest class.
 */
function oracle(host: string, classes: ReadonlyMap<string, Sensitivity>): Sensitivity | null {
  let root: Stats;
  try {
    root = statSync(host);
  } catch {
    return null;
  }
  const seen = new Set<string>([identity(root)]);
  const folders = root.isDirectory() ? [host] : [];
  for (let folder = folders.pop(); folder !== undefined; folder = folders.pop()) {
    for (const name of readdirSync(folder)) {
      let stat: Stats;
      try {
        stat = statSync(join(folder, name));
      } catch {
        continue; // a dangling link: nothing to open
      }
      if (seen.has(identity(stat))) continue;
      seen.add(identity(stat));
      if (stat.isDirectory()) folders.push(join(folder, name));
    }
  }
  let reads: Sensitivity = "public";
  for (const id of seen) reads = maxSensitivity(reads, classes.get(id) ?? HIGHEST);
  return reads;
}

/** One generated tree: nodes made in order inside a fresh run folder placed in a registered or unregistered place. */
const node = fc.record({ kind: fc.constantFrom("dir", "dir", "file", "symlink", "symlink", "hardlink"), parent: fc.nat(), target: fc.nat(), relativeLink: fc.boolean() });
const scenario = fc.record({
  home: fc.constantFrom("project", "project", "project/docs", "project/secrets", "other", "other/pub"),
  nodes: fc.array(node, { minLength: 2, maxLength: 12 }),
  // A walk: each step is `..`, `.`, an empty component (`//`) or an entry the kernel lists where the walk is.
  walk: fc.array(fc.nat(), { minLength: 1, maxLength: 7 }),
  trailingSlash: fc.constantFrom(false, false, false, true),
});
type Scenario = typeof scenario extends fc.Arbitrary<infer T> ? T : never;

/** Fixed places a generated link or hard link can reach: registered, unregistered, outside the workspace, or missing. */
const LINK_PLACES = ["project", "project/notes.txt", "project/docs", "project/secrets", "project/secrets/key.txt", "project/secrets/sub", "other", "other/plain.txt", "other/pub", "other/pub/readme.txt", "OUTSIDE", "OUTSIDE/host.txt", "project/missing.txt"];
const HARD_PLACES = ["project/notes.txt", "project/secrets/key.txt", "project/secrets/sub/deep.txt", "other/plain.txt", "other/pub/readme.txt", "OUTSIDE/host.txt"];
const place = (name: string): string => (name.startsWith("OUTSIDE") ? join(box, "outside", name.slice("OUTSIDE".length)) : join(work, name));

/** Builds the scenario's tree and walks its path; returns the run folder and the path, as an absolute host path and relative to the project. */
function build(s: Scenario): { readonly runRoot: string; readonly host: string; readonly fromProject: string } {
  runs += 1;
  const runRoot = join(work, s.home, `run-${String(runs)}`);
  mkdirSync(runRoot);
  const dirs = [runRoot];
  const files: string[] = [];
  s.nodes.forEach((n, index) => {
    const parent = dirs[n.parent % dirs.length] ?? runRoot;
    const at = join(parent, `n${String(index)}`);
    switch (n.kind) {
      case "dir":
        mkdirSync(at);
        dirs.push(at);
        break;
      case "file":
        writeFileSync(at, `${s.home} ${String(index)}\n`);
        files.push(at);
        break;
      case "symlink": {
        const pool = [...dirs, ...files, ...LINK_PLACES.map(place)];
        const target = pool[n.target % pool.length] ?? runRoot;
        symlinkSync(n.relativeLink ? relative(parent, target) || "." : target, at);
        break;
      }
      case "hardlink": {
        const pool = [...HARD_PLACES.map(place), ...files];
        linkSync(pool[n.target % pool.length] ?? place("project/notes.txt"), at);
        break;
      }
    }
  });
  // The walk asks the kernel where it is at each step, so it hops through links and `..` as a program's path would.
  const steps: string[] = [];
  const here = (): string => [runRoot, ...steps].join("/");
  for (const seed of s.walk) {
    let real: string;
    try {
      real = realpathSync.native(here());
      // A walk ends at a file (a step past it opens nothing, which the trailing slash already covers).
      if (!statSync(real).isDirectory()) break;
    } catch {
      break;
    }
    const choice = seed % 10;
    if (choice === 0) steps.push(real === box ? "." : ".."); // never above the sandbox
    else if (choice === 1) steps.push(".");
    else if (choice === 2) steps.push("");
    else {
      const names = readdirSync(real).sort();
      steps.push(names.length === 0 ? (real === box ? "." : "..") : (names[Math.floor(seed / 10) % names.length] ?? "."));
    }
  }
  const suffix = steps.join("/") + (s.trailingSlash ? "/" : "");
  const host = `${runRoot}/${suffix}`;
  const fromProject = `${relative(join(work, "project"), runRoot)}/${suffix}`;
  return { runRoot, host, fromProject };
}

const payload = (entry: { payload_ref: string }): Record<string, unknown> => {
  const blob = readPayload(journal.root, entry.payload_ref);
  return blob.status === "present" ? (JSON.parse(new TextDecoder().decode(blob.bytes)) as Record<string, unknown>) : {};
};
const lastResult = (id: string) => {
  const entry = readTrajectory(journal.root, `session-${id}`).filter((candidate) => candidate.kind === "capability_result").at(-1);
  return entry === undefined ? undefined : ({ data_class: entry.data_class, ...payload(entry) } as Record<string, unknown>);
};

/** Each tool in the table, as the call a model would make on the generated path. */
const CALLS: Readonly<Record<string, (built: ReturnType<typeof build>) => readonly Record<string, unknown>[]>> = {
  Read: (b) => [{ file_path: b.host }],
  Glob: (b) => [{ pattern: "**/*", path: b.host }],
  Write: (b) => [{ file_path: b.host, content: "written" }],
  Edit: (b) => [{ file_path: b.host, old_string: "a", new_string: "b", replace_all: false }],
  Bash: (b) => [{ command: `cat ${b.fromProject}` }, { command: `ls -R ${b.fromProject}` }, { command: `cat -- ${b.fromProject}` }],
  // A WebFetch reads no path; a `file://` URL of the same place must still never be classified below the kernel's class.
  WebFetch: (b) => [{ url: `file://${b.host}`, prompt: "summarise" }],
};

type Tally = { proceeded: Map<string, number>; keptBelowHighest: number; compared: number; opened: number };

async function check(s: Scenario, tally: Tally): Promise<void> {
  const built = build(s);
  try {
    const classes = identityClasses();
    const kernel = oracle(built.host, classes);
    tally.compared += 1;
    if (kernel !== null) tally.opened += 1;
    // JUNO's classification of the path itself, by the one classification function (D-162).
    const asWork = toWork(built.host);
    const view = new Workspace(execFileScript(process.execPath, []), "/work", work);
    const classified = asWork === null ? HIGHEST : await classifyRead([{ kind: "tree", path: asWork }], { sources: SOURCES, resolver: new HostPathResolver(work), view });
    if (kernel !== null) {
      expect(rank(classified), `classifyRead(${built.host}) = ${classified}, the kernel opens ${kernel}`).toBeGreaterThanOrEqual(rank(kernel));
      if (classified === kernel && rank(kernel) < rank(HIGHEST)) tally.keptBelowHighest += 1;
    }
    // JUNO's decision and record, for every tool in the table, in a session at each clearance.
    const workRoot = toWork(built.runRoot) ?? "/work";
    // The run folder is a reversible workspace when it lies in the grant's scope, so a Write or Edit there can run.
    const reversible = s.home === "other" ? [] : [workRoot];
    for (const clearance of CLEARANCES) {
      const id = `oracle-${String(runs)}-${clearance}`;
      const request: SessionRequest = {
        session_id: id,
        principal: PRINCIPAL,
        attendance: "gated",
        ttl: 3_600_000,
        grants: ["grant-oracle"],
        budget: { tool_calls: 100, wall_clock_ms: 3_600_000 },
        unmetered_accepted: true,
        provider_clearance: clearance,
        sources: SOURCES,
        name_map: NAME_MAP,
        reversible_workspaces: reversible,
      };
      const admitted = await sessions.admit(request);
      expect(admitted, JSON.stringify(admitted)).toMatchObject({ admitted: true });
      for (const [tool, calls] of Object.entries(CALLS)) {
        for (const input of calls(built)) {
          runs += 1;
          const asked = { session_id: id, hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: `toolu_${String(runs)}`, cwd: join(work, "project") };
          const decision = await sessions.preToolUse(asked);
          // Reported whether or not JUNO allowed it, as a harness acting without a decision would.
          expect(await sessions.postToolUse({ ...asked, hook_event_name: "PostToolUse", tool_response: { content: "whatever the kernel returned" } })).toEqual({ recorded: true });
          const recorded = lastResult(id)?.["data_class"] as { sensitivity: Sensitivity } | undefined;
          const what = `${tool} ${JSON.stringify(input)} at clearance ${clearance}: kernel ${String(kernel)}, decision ${decision.decision}, recorded ${String(recorded?.sensitivity)}`;
          if (kernel === null) continue;
          // Stopped before it runs whenever what the kernel opens is above the clearance.
          if (rank(kernel) > rank(clearance)) expect(decision.decision, what).toBe("deny");
          // Whatever happened, the result is never recorded below what the kernel opened (§1.2).
          expect(rank(recorded?.sensitivity ?? "public"), what).toBeGreaterThanOrEqual(rank(kernel));
          if (decision.decision !== "deny") tally.proceeded.set(tool, (tally.proceeded.get(tool) ?? 0) + 1);
        }
      }
    }
  } finally {
    rmSync(built.runRoot, { recursive: true, force: true });
  }
}

describe("D-167: the kernel is the oracle for every tool in the table (§4.3 V6-7, §1.5, §2.7.1 C4)", () => {
  // proves D-167 covers the whole table: a tool added to it without a call here fails
  it("has a call for every tool in the table", () => {
    expect(Object.keys(CALLS).sort()).toEqual([...SUPPORTED_TOOLS].sort());
  });

  // proves the oracle is the kernel's, not text: known places get the class of the sources their identity lies in
  it("the oracle reads identities, not text", () => {
    mkdirSync(join(work, "project", "probe"));
    try {
      symlinkSync(place("project/secrets/key.txt"), join(work, "project", "probe", "to-key"));
      symlinkSync(place("project/secrets/sub"), join(work, "project", "probe", "to-sub"));
      linkSync(place("other/plain.txt"), join(work, "project", "probe", "hard"));
      const classes = identityClasses();
      expect(oracle(join(work, "project", "notes.txt"), classes)).toBe("internal");
      expect(oracle(join(work, "other", "pub", "readme.txt"), classes)).toBe("public");
      expect(oracle(join(work, "project", "probe", "to-key"), classes)).toBe("secret");
      // `..` after a link is taken by the kernel: to-sub/.. is the secrets folder.
      expect(oracle(`${join(work, "project", "probe", "to-sub")}/../key.txt`, classes)).toBe("secret");
      // A hard link to an unregistered file is that file: the highest class.
      expect(oracle(join(work, "project", "probe", "hard"), classes)).toBe(HIGHEST);
      expect(oracle(join(work, "other", "plain.txt"), classes)).toBe(HIGHEST);
      expect(oracle(join(work, "project", "docs"), classes)).toBe("internal");
      expect(oracle(join(work, "project", "missing.txt"), classes)).toBeNull();
      expect(oracle(`${join(work, "project", "notes.txt")}/`, classes)).toBeNull();
    } finally {
      rmSync(join(work, "project", "probe"), { recursive: true, force: true });
    }
  });

  const tally: Tally = { proceeded: new Map(), keptBelowHighest: 0, compared: 0, opened: 0 };

  // proves D-167: for generated trees and paths, JUNO never classifies, lets run below the clearance, or records a read
  // below the class of what the kernel opens
  it("never judges a generated path below what the kernel opens", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        await check(s, tally);
      }),
      { numRuns: 100, seed: 20261108 },
    );
  }, 900_000);

  // proves the property is not vacuous: most paths opened something, path tools ran, and plain paths kept a registered
  // class below the highest (so JUNO is not passing by reading everything at the highest class)
  it("compared real reads, and kept registered classes for plain paths", () => {
    expect(tally.compared).toBe(100);
    expect(tally.opened).toBeGreaterThan(50);
    expect(tally.keptBelowHighest).toBeGreaterThan(5);
    for (const tool of ["Read", "Glob", "Write", "Edit", "Bash"]) expect(tally.proceeded.get(tool) ?? 0, tool).toBeGreaterThan(0);
  });
});
