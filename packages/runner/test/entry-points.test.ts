import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GrantStore, type HostIo, HostPathResolver, type LayerOpened, SERVICES, type ServiceName, SessionLayer, StartupRefused, Workspace, execFileScript } from "../../enforcement/src/index.js";
import { MemoryAnchorSink, testAnchoring, testJournalKey } from "../../enforcement/test/anchoring.js";
import { ordinaryHost, openTestLayer } from "../../enforcement/test/layer.js";
import { TEST_ANCHOR, signed } from "../../enforcement/test/test-keys.js";
import { type JournalKey, JournalWriter, anchorOf, anchorPath, checkAnchors, listRecords, readPayload, readTrajectory, taskDigest, verifyTrajectory } from "../../journal/src/index.js";
import { blobFile, entriesFile, taskDir } from "../../journal/src/layout.js";
import { systemFilesystemIo } from "../../mediated/src/filesystem.js";
import { MCP_REVISION, McpGateway, type Upstream } from "../../mediated/src/gateway.js";
import { type GatewayCliIo, runGatewayCli } from "../../mediated/src/gateway-cli.js";
import { GatewayService } from "../../mediated/src/gateway-service.js";
import { HookService } from "../../mediated/src/hook-service.js";
import { HookAdmissionService } from "../../mediated/src/hook-admission.js";
import { type HookServeIo, runHookAdmitCli, runHookServeCli } from "../../mediated/src/hook-serve.js";
import { MediatedSessions, PathMap } from "../../mediated/src/session.js";
import { ENTRY_POINTS } from "../src/entry-points.js";
import { runRunnerMain } from "../src/runner-main.js";
import { Runner } from "../src/runner.js";
import { harness, request as runnerRequest, turn } from "./helpers.js";

/**
 * Operator ruling D-193 (DECISIONS.md D-194): every CLI command and entry point that starts a JUNO service or admits a
 * session goes through THE shared start-up check and THE shared session layer. This test takes the entry points from the
 * one registry (`ENTRY_POINTS`, which the `juno` command dispatches from), never from a list of its own, and:
 *   A. reads the source tree and fails on any program, service or session class, journal writer, boundary or layer
 *      opener the registry does not account for (so a new entry point cannot be added beside it);
 *   B. runs every registered entry that starts a service against each thing the shared check refuses (root; JUNO's
 *      state in a workspace; state others could change; an unverified anchor; an open socket folder) and requires the
 *      refusal to be the shared check's own (seen through `SessionLayer.observe`), with nothing opened or served;
 *   C. requires every registered class to refuse any layer but one the shared check opened for its service and its
 *      workspace;
 *   D. drives every registered mode that admits sessions (own loop, hook, gateway) and requires the shared layer to hold
 *      the session, count its rejections to the limit and park it there, and count its calls to the budget.
 *   E. requires every mode's journal to be anchored through the shared layer (D-198);
 *   F. restarts every registered service on its own journal (operator ruling D-201): it starts again and forgets
 *      nothing, and it refuses to start, opening no layer, when the journal was changed, cut, replaced or deleted, when
 *      an anchor disagrees, when a record was planted, or when the anchors cannot be read.
 * Every entry the registry says starts a service or admits a session must have a probe here, or the test fails.
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// ------------------------------------------------------------------------------------------------------------------
// A. The registry accounts for every entry point in the source tree.
// ------------------------------------------------------------------------------------------------------------------

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const pkg of readdirSync(join(ROOT, "packages"))) {
    const src = join(ROOT, "packages", pkg, "src");
    if (!existsSync(src)) continue;
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".ts")) out.push(relative(ROOT, path));
      }
    };
    walk(src);
  }
  return out.sort();
}

type Facts = {
  /** It runs code at module top level that reads `process.argv`, `process.env` or sets `process.exitCode`: a program. */
  readonly program: boolean;
  /** Classes that admit sessions (an `admit` method) or serve (`createServer`). */
  readonly serviceClasses: readonly string[];
  readonly opensLayer: boolean;
  readonly opensJournal: boolean;
  readonly newBoundary: boolean;
  readonly appendsToJournal: boolean;
  readonly requiresLayer: readonly string[];
  readonly exports: readonly string[];
  readonly imports: readonly string[];
};

function factsOf(file: string): Facts {
  const text = readFileSync(join(ROOT, file), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const journalNames = new Set<string>();
  const imports: string[] = [];
  const exports: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push(statement.moduleSpecifier.text);
      const bindings = statement.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) if ((element.propertyName ?? element.name).text === "JournalWriter") journalNames.add(element.name.text);
      }
    }
    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
    if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name !== undefined) exports.push(statement.name.text);
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) exports.push(declaration.name.text);
    }
  }
  let program = false;
  let opensLayer = false;
  let opensJournal = false;
  let newBoundary = false;
  let appendsToJournal = false;
  const serviceClasses: string[] = [];
  const requiresLayer: string[] = [];
  const isProcessAccess = (node: ts.Node): boolean =>
    ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "process" && ["argv", "env", "exitCode"].includes(node.name.text);
  const visit = (node: ts.Node, topLevel: boolean, inClass: string | null): void => {
    if (topLevel && isProcessAccess(node)) program = true;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const target = node.expression.expression.getText(source);
      const method = node.expression.name.text;
      if (target === "SessionLayer" && method === "open") opensLayer = true;
      if (journalNames.has(target) && method === "open") opensJournal = true;
      if (method === "append" && /journal|writer/i.test(target)) appendsToJournal = true;
      if (target === "SessionLayer" && method === "require" && inClass !== null) requiresLayer.push(inClass);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createServer" && inClass !== null) serviceClasses.push(inClass);
    if (ts.isNewExpression(node) && node.expression.getText(source) === "EnforcementBoundary") newBoundary = true;
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      const name = node.name.text;
      if (node.members.some((member) => ts.isMethodDeclaration(member) && member.name.getText(source) === "admit")) serviceClasses.push(name);
      ts.forEachChild(node, (child) => visit(child, false, name));
      return;
    }
    const nested = ts.isFunctionLike(node) ? false : topLevel;
    ts.forEachChild(node, (child) => visit(child, nested, inClass));
  };
  ts.forEachChild(source, (child) => visit(child, true, null));
  return { program, serviceClasses: [...new Set(serviceClasses)], opensLayer, opensJournal, newBoundary, appendsToJournal, requiresLayer: [...new Set(requiresLayer)], exports, imports };
}

const LAYER_MODULE = "packages/enforcement/src/session-layer.ts";
/** The boundary journals its own decisions; only the layer builds it (checked below). */
const BOUNDARY_MODULE = "packages/enforcement/src/boundary.ts";
const operatorWriters = new Set(ENTRY_POINTS.filter((entry) => entry.operatorJournalWrite !== undefined).map((entry) => entry.module));
const serviceEntries = ENTRY_POINTS.filter((entry) => entry.service !== null);

describe("D-194 A: the registry accounts for every entry point, service, session class and journal writer", () => {
  const files = sourceFiles();
  const facts = new Map(files.map((file) => [file, factsOf(file)]));

  // proves D-193: one registry, every entry named once, and each points at code that exists
  it("names each entry once, at a module that exists and exports it", () => {
    expect(new Set(ENTRY_POINTS.map((entry) => entry.id)).size).toBe(ENTRY_POINTS.length);
    for (const entry of ENTRY_POINTS) {
      const found = facts.get(entry.module);
      expect(found, `${entry.id}: ${entry.module}`).toBeDefined();
      if (entry.kind !== "command") expect(found?.exports, entry.id).toContain(entry.name);
      if (entry.kind === "program") expect(entry.program !== undefined && facts.get(entry.program)?.program === true, `${entry.id}: its program file runs at top level`).toBe(true);
      if (entry.service === null) expect(entry.why, `${entry.id} starts no service and must say why`).toBeTruthy();
      if (entry.kind === "class") expect((entry.implementation as { name?: string }).name).toBe(entry.name);
    }
  });

  // proves D-193: a program of its own (anything run with node) is a registered program
  it("has no program the registry does not list", () => {
    const programs = files.filter((file) => facts.get(file)?.program === true);
    const registered = new Set(ENTRY_POINTS.flatMap((entry) => (entry.program === undefined ? [] : [entry.program])));
    expect(programs.filter((file) => !registered.has(file))).toEqual([]);
  });

  // proves D-193: the `juno` command runs only what the registry lists
  it("has a juno command that imports nothing but the registry", () => {
    expect(facts.get("packages/runner/src/juno.ts")?.imports).toEqual(["./entry-points.js"]);
  });

  // proves D-193: every class that admits sessions or serves a socket is a registered class, and checks its layer
  it("has no service or session class the registry does not list, and each requires the shared layer", () => {
    // The shared layer itself admits every session; it is what the others must go through.
    const found = files.filter((file) => file !== LAYER_MODULE).flatMap((file) => (facts.get(file)?.serviceClasses ?? []).map((name) => `${file}#${name}`));
    const registered = ENTRY_POINTS.filter((entry) => entry.kind === "class").map((entry) => `${entry.module}#${String(entry.name)}`);
    expect(found.filter((name) => !registered.includes(name))).toEqual([]);
    for (const entry of ENTRY_POINTS.filter((candidate) => candidate.kind === "class")) {
      expect(facts.get(entry.module)?.requiresLayer, `${entry.id} calls SessionLayer.require in its own body`).toContain(entry.name);
    }
  });

  // proves D-193 "no mode may ... pass a call except through it": the journal is opened, appended to and given to a
  // boundary only by the shared layer (and the journal package itself); an operator action recorded in the journal is
  // registered as such
  it("writes the journal only through the shared layer", () => {
    const outside = (predicate: (fact: Facts) => boolean, allowed: (file: string) => boolean): string[] =>
      files.filter((file) => predicate(facts.get(file) as Facts) && !allowed(file));
    const journalPackage = (file: string): boolean => file.startsWith("packages/journal/src/");
    expect(outside((fact) => fact.opensJournal, (file) => file === LAYER_MODULE || journalPackage(file) || operatorWriters.has(file))).toEqual([]);
    expect(outside((fact) => fact.newBoundary, (file) => file === LAYER_MODULE)).toEqual([]);
    expect(outside((fact) => fact.appendsToJournal, (file) => file === LAYER_MODULE || file === BOUNDARY_MODULE || journalPackage(file) || operatorWriters.has(file))).toEqual([]);
  });

  // proves D-193: a layer is opened (so the shared check run) only by a registered service entry, and every registered
  // command or program that starts a service opens one
  it("opens a session layer only in a registered service entry, and in each of them", () => {
    const openers = files.filter((file) => facts.get(file)?.opensLayer === true && file !== LAYER_MODULE);
    const starting = serviceEntries.filter((entry) => entry.kind !== "class").map((entry) => entry.module);
    expect(openers.filter((file) => !starting.includes(file))).toEqual([]);
    for (const module of starting) expect(openers, module).toContain(module);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// The fixture every probe starts from: a workspace, JUNO's state beside it, a protected anchor, a socket folder.
// ------------------------------------------------------------------------------------------------------------------

type Fixture = { dir: string; work: string; journal: string; anchor: string; session: string; grant: string; sockets: string; socket: string; keys: string; clone: string };

let fx: Fixture;
/** The anchor destination every probe's layer uses (D-198); a fresh one per test. */
let sink: MemoryAnchorSink;
/** The journal key every probe's service uses; one per test, kept across a service's restarts (D-201). */
let journalKey: JournalKey;
let events: LayerOpened[];
let stopObserving: () => void;

const PRINCIPAL = "alireza";
const SEND = { capability: { id: "mcp.message.send", interface: { to: { type: { kind: "string" }, role: "data", data_effect: "target" }, body: { type: { kind: "string" }, role: "data", data_effect: "payload" } }, providers: ["gateway.mcp"], side_effect: "external", isolation_tier: 1, max_input_sensitivity: "internal", min_argument_integrity: "operator", output_class: { sensitivity: "input", integrity: "untrusted" }, cost_model: { expected_cost: 0, expected_latency_ms: 100, cost_of_failure: 0 } } };
const SOURCE = { id: "project", selector: { kind: "path", prefix: "/work/project" }, data_class: { sensitivity: "internal", integrity: "untrusted" } } as const;

function gatewayGrant(): Record<string, unknown> {
  return signed({ id: "g", principal: PRINCIPAL, capability_selector: { capabilities: ["mcp.message.send"] }, resource_scope: [{ kind: "path", prefix: "/work/project" }], data_class_bounds: { max_sensitivity: "secret", min_integrity: "untrusted" }, issuance: "preissued", issued_by: PRINCIPAL, issued_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString(), max_invocations: 50, attenuation_parent: null, revoked_at: null, enumerated_targets: [{ field: "to", value: "ops@example.com" }] });
}

function gatewaySession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { session_id: "probe", principal: PRINCIPAL, attendance: "autonomous", ttl: 3_600_000, grants: ["g"], budget: { tool_calls: 4, wall_clock_ms: 3_600_000 }, unmetered_accepted: true, provider_clearance: "internal", sources: [SOURCE], tools: [{ tool: "message.send", entry: SEND }], rejection_limit: 2, ...overrides };
}

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "juno-entry-"));
  fx = { dir, work: join(dir, "work"), journal: join(dir, "journal"), anchor: join(dir, "anchor", "operator.pub"), session: join(dir, "session.json"), grant: join(dir, "grant.json"), sockets: join(dir, "sock"), socket: join(dir, "sock", "service.sock"), keys: join(dir, "journal-key"), clone: join(dir, "juno-anchors") };
  sink = new MemoryAnchorSink();
  journalKey = testJournalKey();
  mkdirSync(join(fx.work, "project"), { recursive: true });
  writeFileSync(join(fx.work, "project", "notes.txt"), "notes\n");
  mkdirSync(fx.sockets, { mode: 0o700 });
  mkdirSync(join(dir, "anchor"));
  writeFileSync(fx.anchor, TEST_ANCHOR.export({ type: "spki", format: "pem" }), { mode: 0o444 });
  chmodSync(fx.anchor, 0o444);
  chmodSync(join(dir, "anchor"), 0o555);
  writeFileSync(fx.session, JSON.stringify({ session: gatewaySession(), upstream: { program: process.execPath, argv: [fileURLToPath(new URL("../../../test/mcp/test-server.mjs", import.meta.url)), fx.work, join(dir, "record.jsonl")] } }), { mode: 0o644 });
  writeFileSync(fx.grant, JSON.stringify(gatewayGrant()), { mode: 0o644 });
  events = [];
  stopObserving = SessionLayer.observe((event) => events.push(event));
});

afterEach(() => {
  stopObserving();
  chmodSync(join(fx.dir, "anchor"), 0o755);
  rmSync(fx.dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------------------------------
// B. Every registered command or program that starts a service refuses what the shared check refuses.
// ------------------------------------------------------------------------------------------------------------------

type Run = { readonly code: number; readonly said: string };
type CommandProbe = {
  /** Runs the registered implementation with this host, and these overrides of the fixture's paths. */
  readonly run: (implementation: unknown, host: HostIo, paths: Partial<Fixture>) => Promise<Run>;
  /** Makes one piece of the entry's own state changeable by others. */
  readonly loosenState: () => void;
  readonly socket: boolean;
  /** The positive control's extra check, on the layer the entry opened. */
  readonly admitted?: (layer: SessionLayer) => void;
};

const COMMAND_PROBES: Readonly<Record<string, CommandProbe>> = {
  "gateway.serve": {
    run: async (implementation, host, paths) => {
      const at = { ...fx, ...paths };
      const said: string[] = [];
      const io: GatewayCliIo = { host, readFile: (path) => readFileSync(path, "utf8"), filesystem: systemFilesystemIo(), anchoring: testAnchoring({ sink, journalKey }), stopped: () => Promise.resolve(), out: (text) => said.push(text), err: (text) => said.push(text) };
      const code = await (implementation as typeof runGatewayCli)(["serve", "--session", at.session, "--socket", at.socket, "--journal", at.journal, "--anchor", at.anchor, "--workspace", at.work, "--journal-key", at.keys, "--anchors", at.clone, "--grant", at.grant], io);
      return { code, said: said.join("") };
    },
    loosenState: () => chmodSync(fx.session, 0o666),
    socket: true,
    admitted: (layer) => expect(layer.sessions().map((session) => [session.id, session.mode])).toEqual([["gateway-probe", "gateway"]]),
  },
  "hook.serve": {
    run: async (implementation, host, paths) => {
      const at = { ...fx, ...paths };
      const said: string[] = [];
      const control = join(at.sockets, "admit.sock");
      const sessionFile = join(fx.dir, "hook-session.json");
      writeFileSync(sessionFile, JSON.stringify({ session: hookRequest("probe"), grants: [] }), { mode: 0o644 });
      let admitting: Promise<number> | null = null;
      const io: HookServeIo = {
        host,
        filesystem: systemFilesystemIo(),
        runtime: () => Promise.resolve({ cgroupDriver: "systemd", cgroupVersion: "2", rootless: true }),
        anchoring: testAnchoring({ sink, journalKey }),
        // Once it serves, the operator admits a session through the admission socket, then it stops.
        ready: () => {
          admitting = runHookAdmitCli(["--control", control, sessionFile], { out: (text) => said.push(text), err: (text) => said.push(text) });
        },
        stopped: async () => {
          await admitting;
        },
        out: (text) => said.push(text),
        err: (text) => said.push(text),
      };
      const code = await (implementation as typeof runHookServeCli)(["--socket", at.socket, "--control", control, "--journal", at.journal, "--anchor", at.anchor, "--workspace", at.work, "--checkpoints", join(fx.dir, "checkpoints"), "--journal-key", at.keys, "--anchors", at.clone], io);
      return { code, said: said.join("") };
    },
    loosenState: () => {
      mkdirSync(join(fx.dir, "checkpoints"), { mode: 0o777 });
      chmodSync(join(fx.dir, "checkpoints"), 0o777);
    },
    socket: true,
    admitted: (layer) => expect(layer.sessions().map((session) => [session.id, session.mode])).toEqual([["session-probe", "hook"]]),
  },
  "runner.process": {
    run: async (implementation, host, paths) => {
      const at = { ...fx, ...paths };
      const said: string[] = [];
      const code = await (implementation as typeof runRunnerMain)({ JUNO_JOURNAL_DIR: at.journal, JUNO_WORK_DIR: at.work, JUNO_TRUST_ANCHOR: at.anchor, JUNO_JOURNAL_KEY_DIR: at.keys, JUNO_ANCHOR_CLONE: at.clone }, { host, anchoring: testAnchoring({ sink, journalKey }), out: (text) => said.push(text), err: (text) => said.push(text) });
      return { code, said: said.join("") };
    },
    loosenState: () => {
      mkdirSync(fx.journal, { mode: 0o777 });
      chmodSync(fx.journal, 0o777);
    },
    socket: false,
  },
};

type Refusal = { readonly name: string; readonly arrange: (probe: CommandProbe) => { host?: HostIo; paths?: Partial<Fixture> } | null; readonly text: RegExp };

const REFUSALS: readonly Refusal[] = [
  { name: "it runs as root", arrange: () => ({ host: { ...ordinaryHost(), uid: 0 } }), text: /must not run as root/ },
  { name: "the journal lies in the workspace", arrange: () => ({ paths: { journal: join(fx.work, "project", ".journal") } }), text: /overlaps the workspace/ },
  { name: "the workspace holds JUNO's state", arrange: () => ({ paths: { work: fx.dir } }), text: /overlaps the workspace/ },
  { name: "a piece of its state could be changed by others", arrange: (probe) => { probe.loosenState(); return {}; }, text: /writable by group or others/ },
  { name: "the trust anchor is not verified", arrange: () => { chmodSync(join(fx.dir, "anchor"), 0o755); chmodSync(fx.anchor, 0o666); chmodSync(join(fx.dir, "anchor"), 0o555); return {}; }, text: /trust anchor .*(not protected|writable by group or others)/ },
  { name: "the journal key lies in the workspace (D-198)", arrange: () => ({ paths: { keys: join(fx.work, "project", ".journal-key") } }), text: /journal key folder .*overlaps the workspace/ },
  { name: "the anchor clone lies in the workspace (D-198)", arrange: () => ({ paths: { clone: join(fx.work, "project", "juno-anchors") } }), text: /anchor repository clone .*overlaps the workspace/ },
  { name: "its socket folder could be changed by others", arrange: (probe) => { if (!probe.socket) return null; chmodSync(fx.sockets, 0o777); return {}; }, text: /writable by group or others/ },
];

describe("D-194 B: every command or program that starts a service runs the shared start-up check", () => {
  const starting = serviceEntries.filter((entry) => entry.kind !== "class");

  // proves D-193: the test covers what the registry lists, not a list of its own
  it("has a probe for every registered command or program that starts a service", () => {
    expect(starting.map((entry) => entry.id).filter((id) => COMMAND_PROBES[id] === undefined)).toEqual([]);
    expect(starting.length).toBeGreaterThanOrEqual(2);
  });

  for (const entry of starting) {
    const probe = COMMAND_PROBES[entry.id];
    if (probe === undefined) continue;
    // proves D-193 (positive control): with nothing to refuse, the entry starts through the shared check and its layer
    it(`${entry.id}: starts through the shared check when nothing is wrong`, async () => {
      const run = await probe.run(entry.implementation, ordinaryHost(), {});
      expect(run, run.said).toMatchObject({ code: 0 });
      const opened = events.filter((event) => event.spec.service === entry.service);
      expect(opened).toHaveLength(1);
      expect(opened[0]?.refusals).toEqual([]);
      const layer = opened[0]?.layer;
      expect(layer).toBeInstanceOf(SessionLayer);
      if (layer !== null && layer !== undefined) {
        probe.admitted?.(layer);
        // proves §3.4.1 (D-198): the service anchors through its layer: every record it wrote is anchored by the time it
        // stops, and each record's chain agrees with its anchors
        for (const session of layer.sessions()) {
          const anchors = await sink.list(taskDigest(session.id));
          expect(anchors.length, session.id).toBeGreaterThan(0);
          expect(checkAnchors(session.id, verifyTrajectory(layer.root, session.id), anchors, layer.anchoring.journalKey.publicKey)).toMatchObject({ ok: true, unanchored: 0 });
        }
      }
    }, 30_000);

    // proves §3.4.1 (D-198): a service named without its journal key or anchor destination does not start, and opens nothing
    it(`${entry.id}: will not start without a journal key and an anchor destination`, async () => {
      const run = await probe.run(entry.implementation, ordinaryHost(), { keys: "", clone: "" });
      expect(run.code).not.toBe(0);
      expect(events.filter((event) => event.layer !== null)).toEqual([]);
      expect(existsSync(join(fx.journal, "tasks"))).toBe(false);
    });

    for (const refusal of REFUSALS) {
      // proves D-193 / §3.2 / §3.4.1 / D-148 / D-173 / D-116: the entry refuses exactly what the shared check refuses, with
      // its words, and opens, serves and journals nothing
      it(`${entry.id}: refuses when ${refusal.name}`, async () => {
        const arranged = refusal.arrange(probe);
        if (arranged === null) return;
        const run = await probe.run(entry.implementation, arranged.host ?? ordinaryHost(), arranged.paths ?? {});
        expect(run.code).toBe(1);
        const checked = events.filter((event) => event.spec.service === entry.service);
        expect(checked, "the entry ran the shared check").toHaveLength(1);
        expect(checked[0]?.layer ?? null).toBeNull();
        expect(checked[0]?.refusals.join("\n")).toMatch(refusal.text);
        for (const line of checked[0]?.refusals ?? []) expect(run.said).toContain(line);
        expect(existsSync(fx.socket)).toBe(false);
        expect(existsSync(join(fx.journal, "tasks"))).toBe(false);
        expect(existsSync(join(fx.work, "project", ".journal"))).toBe(false);
      });
    }
  }
});

// ------------------------------------------------------------------------------------------------------------------
// C. Every registered class refuses any layer but one the shared check opened for its service and its workspace.
// ------------------------------------------------------------------------------------------------------------------

const upstream = (): Upstream => ({
  request: (method) => Promise.resolve(method === "initialize" ? { protocolVersion: MCP_REVISION, capabilities: { tools: {} } } : { tools: [] }),
  notify: () => undefined,
  close: () => undefined,
});

const view = (root: string): Workspace => new Workspace(execFileScript(process.execPath, []), "/work", root);
const grantsOf = (...grants: readonly Record<string, unknown>[]): GrantStore => {
  const store = new GrantStore(TEST_ANCHOR);
  for (const grant of grants) store.add(grant);
  return store;
};

type ClassProbe = {
  /** Builds the class on `layer` with the fixture's workspace; for a service, listens on `socket`. */
  readonly build: (layer: unknown, socket?: string) => Promise<unknown>;
  /** The state a layer for it must judge (its socket, for a service). */
  readonly state: readonly { what: string; path: string; kind: "socket" }[];
};

function sessionsOn(layer: unknown, work = fx.work): MediatedSessions {
  return new MediatedSessions({ layer: layer as SessionLayer, grants: grantsOf(), paths: new PathMap([work]), resolver: new HostPathResolver(work), view: view(work), filesystem: systemFilesystemIo() });
}
function gatewayOn(layer: unknown, work = fx.work): McpGateway {
  return new McpGateway({ layer: layer as SessionLayer, grants: grantsOf(gatewayGrant()), resolver: new HostPathResolver(work), view: view(work), filesystem: systemFilesystemIo(), upstream });
}
async function runnerOn(layer: unknown, work = fx.work): Promise<Runner> {
  const h = await harness();
  try {
    return new Runner({ layer: layer as SessionLayer, registry: h.registry, grants: h.grants, providers: [], sources: [], resolver: new HostPathResolver(work) });
  } finally {
    h.cleanup();
  }
}

const CLASS_PROBES: Readonly<Record<string, ClassProbe>> = {
  "class.Runner": { build: async (layer) => runnerOn(layer), state: [] },
  "class.MediatedSessions": { build: async (layer) => Promise.resolve(sessionsOn(layer)), state: [] },
  "class.McpGateway": { build: async (layer) => Promise.resolve(gatewayOn(layer)), state: [] },
  "class.HookAdmissionService": {
    build: async (layer, socket = fx.socket) => {
      const service = new HookAdmissionService(SessionLayer.genuine(layer) ? sessionsOn(layer) : ({ layer } as unknown as MediatedSessions), grantsOf());
      await service.listen(socket);
      await service.close();
      return service;
    },
    state: [{ what: "the socket", path: join("<dir>", "sock", "service.sock"), kind: "socket" }],
  },
  "class.HookService": {
    build: async (layer, socket = fx.socket) => {
      const service = new HookService(SessionLayer.genuine(layer) ? sessionsOn(layer) : ({ layer } as unknown as MediatedSessions));
      await service.listen(socket);
      await service.close();
      return service;
    },
    state: [{ what: "the socket", path: join("<dir>", "sock", "service.sock"), kind: "socket" }],
  },
  "class.GatewayService": {
    build: async (layer, socket = fx.socket) => {
      const service = new GatewayService(SessionLayer.genuine(layer) ? gatewayOn(layer) : ({ layer } as unknown as McpGateway));
      await service.listen(socket);
      await service.close();
      return service;
    },
    state: [{ what: "the socket", path: join("<dir>", "sock", "service.sock"), kind: "socket" }],
  },
};

const OTHER: Readonly<Record<ServiceName, ServiceName>> = { runner: "hook", hook: "gateway", gateway: "runner" };

describe("D-194 C: every registered class runs only on a layer the shared check opened for it", () => {
  const classes = ENTRY_POINTS.filter((entry) => entry.kind === "class");
  const stateOf = (probe: ClassProbe) => probe.state.map((item) => ({ ...item, path: item.path.replace("<dir>", fx.dir) }));

  // proves D-193: the test covers what the registry lists
  it("has a probe for every registered class", () => {
    expect(classes.map((entry) => entry.id).filter((id) => CLASS_PROBES[id] === undefined)).toEqual([]);
  });

  // proves D-194: no code can make a layer without the shared check
  it("cannot make a layer except by SessionLayer.open", () => {
    const Raw = SessionLayer as unknown as new (...args: unknown[]) => unknown;
    expect(() => new Raw(Symbol("forged"), {}, null, ordinaryHost(), () => new Date(), {})).toThrow(/made only by SessionLayer.open/);
  });

  for (const entry of classes) {
    const probe = CLASS_PROBES[entry.id];
    if (probe === undefined || entry.service === null) continue;
    const service = entry.service;
    // proves D-194 (positive control): on a layer the check opened for its service and workspace, it starts
    it(`${entry.id}: starts on a layer opened for the ${service} service`, async () => {
      const layer = await openTestLayer(service, { journal: fx.journal, workspaces: [fx.work], state: stateOf(probe) });
      await expect(probe.build(layer)).resolves.toBeDefined();
    });

    // proves D-193: an object shaped like a layer, but not opened by the shared check, is refused
    it(`${entry.id}: refuses a layer the shared check did not open`, async () => {
      const forged: unknown = Object.create(SessionLayer.prototype);
      await expect(probe.build(forged)).rejects.toThrow(/not given a session layer opened by the shared start-up check/);
    });

    // proves D-193: a layer opened for another service is refused
    it(`${entry.id}: refuses a layer opened for another service`, async () => {
      const other = await openTestLayer(OTHER[service], { journal: fx.journal, workspaces: [fx.work], state: stateOf(probe) });
      await expect(probe.build(other)).rejects.toThrow(/was opened for the .* service, not the/);
    });

    // proves D-148 / D-194: a layer whose check did not judge the workspace (or socket) this class uses is refused
    it(`${entry.id}: refuses a workspace or socket the shared check did not judge`, async () => {
      const elsewhere = join(fx.dir, "elsewhere");
      const layer = await openTestLayer(service, { journal: fx.journal, workspaces: [elsewhere] });
      await expect(probe.build(layer)).rejects.toThrow(/not a workspace the start-up check judged|not one the start-up check judged/);
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------
// D. Every mode that admits sessions does so, and passes calls, only through the shared session layer.
// ------------------------------------------------------------------------------------------------------------------

type Parks = () => readonly Record<string, unknown>[];
const parksIn = (root: string, id: string): Parks => () =>
  readTrajectory(root, id).filter((entry) => entry.kind === "park").map((entry) => {
    const blob = readPayload(root, entry.payload_ref);
    return blob.status === "present" ? (JSON.parse(new TextDecoder().decode(blob.bytes)) as Record<string, unknown>) : {};
  });

type ModeDriver = {
  /**
   * Admits one session with a rejection limit of 2 and drives two rejected calls through the mode's own public surface;
   * returns the layer, the session id and how to read its parks, plus a step after the first rejection.
   */
  readonly rejections: (afterFirst: (layer: SessionLayer, id: string) => void) => Promise<{ layer: SessionLayer; id: string; parks: Parks }>;
  /** Admits one session with a budget of `calls` calls (or turns) and makes one more; returns as above. */
  readonly budget: (calls: number) => Promise<{ layer: SessionLayer; id: string; parks: Parks }>;
};

let hookIds = 0;
const hookCall = (session: string, tool: string): unknown => {
  hookIds += 1;
  return { session_id: session, hook_event_name: "PreToolUse", tool_name: tool, tool_input: {}, tool_use_id: `toolu_${String(hookIds)}`, cwd: join(fx.work, "project") };
};
const hookRequest = (id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ session_id: id, principal: PRINCIPAL, attendance: "gated", ttl: 3_600_000, grants: [], budget: { tool_calls: 50, wall_clock_ms: 3_600_000 }, unmetered_accepted: true, provider_clearance: "internal", sources: [SOURCE], rejection_limit: 2, ...overrides });

const gatewayCall = (gateway: McpGateway, name: string, id: number) => gateway.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
async function openedGateway(layer: SessionLayer, overrides: Record<string, unknown> = {}): Promise<McpGateway> {
  const gateway = gatewayOn(layer);
  expect(await gateway.admit(gatewaySession(overrides))).toMatchObject({ admitted: true });
  await gateway.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_REVISION, capabilities: {}, clientInfo: { name: "probe", version: "1" } } });
  return gateway;
}

const unknownCall = (n: number): unknown => ({ id: `bad-${String(n)}`, capability: "fs.nothing", arguments: {} });

const MODE_DRIVERS: Readonly<Record<ServiceName, ModeDriver>> = {
  runner: {
    rejections: async (afterFirst) => {
      const h = await harness();
      const { runner } = h.runner([turn([unknownCall(1)]), turn([unknownCall(2)])]);
      expect(runner.admit(runnerRequest({ rejection_limit: 2 }))).toMatchObject({ admitted: true });
      await runner.run("task-1");
      afterFirst(h.layer, "task-1");
      return { layer: h.layer, id: "task-1", parks: parksIn(h.journal.root, "task-1") };
    },
    budget: async (calls) => {
      const h = await harness();
      const { runner } = h.runner(Array.from({ length: calls + 1 }, (_, index) => turn([unknownCall(100 + index)])));
      expect(runner.admit(runnerRequest({ rejection_limit: 10, budget: { tokens: 1_000_000, currency: 100, wall_clock_ms: 3_600_000, turns: calls } }))).toMatchObject({ admitted: true });
      await runner.run("task-1");
      return { layer: h.layer, id: "task-1", parks: parksIn(h.journal.root, "task-1") };
    },
  },
  hook: {
    rejections: async (afterFirst) => {
      const layer = await openTestLayer("hook", { journal: fx.journal, workspaces: [fx.work] });
      const sessions = sessionsOn(layer);
      expect(await sessions.admit(hookRequest("probe"))).toMatchObject({ admitted: true });
      await sessions.preToolUse(hookCall("probe", "Frobnicate"));
      afterFirst(layer, "session-probe");
      await sessions.preToolUse(hookCall("probe", "Frobnicate"));
      return { layer, id: "session-probe", parks: parksIn(layer.root, "session-probe") };
    },
    budget: async (calls) => {
      const layer = await openTestLayer("hook", { journal: fx.journal, workspaces: [fx.work] });
      const sessions = sessionsOn(layer);
      expect(await sessions.admit(hookRequest("budget", { rejection_limit: 10, budget: { tool_calls: calls, wall_clock_ms: 3_600_000 } }))).toMatchObject({ admitted: true });
      for (let index = 0; index <= calls; index += 1) await sessions.preToolUse(hookCall("budget", "Frobnicate"));
      return { layer, id: "session-budget", parks: parksIn(layer.root, "session-budget") };
    },
  },
  gateway: {
    rejections: async (afterFirst) => {
      const layer = await openTestLayer("gateway", { journal: fx.journal, workspaces: [fx.work] });
      const gateway = await openedGateway(layer);
      await gatewayCall(gateway, "admin.wipe", 2);
      afterFirst(layer, "gateway-probe");
      await gatewayCall(gateway, "admin.wipe", 3);
      return { layer, id: "gateway-probe", parks: parksIn(layer.root, "gateway-probe") };
    },
    budget: async (calls) => {
      const layer = await openTestLayer("gateway", { journal: fx.journal, workspaces: [fx.work] });
      const gateway = await openedGateway(layer, { session_id: "budget", rejection_limit: 10, budget: { tool_calls: calls, wall_clock_ms: 3_600_000 } });
      for (let index = 0; index <= calls; index += 1) await gatewayCall(gateway, "admin.wipe", 10 + index);
      return { layer, id: "gateway-budget", parks: parksIn(layer.root, "gateway-budget") };
    },
  },
};

describe("D-194 D: every mode admits, counts and parks its sessions through the shared session layer", () => {
  const admitting = ENTRY_POINTS.filter((entry) => entry.admits && entry.kind === "class");

  // proves D-193: the test covers every mode the registry says admits sessions
  it("has a driver for every registered mode that admits sessions", () => {
    expect(admitting.map((entry) => entry.service).filter((service) => service === null || MODE_DRIVERS[service] === undefined)).toEqual([]);
    expect(new Set(admitting.map((entry) => entry.service))).toEqual(new Set(["runner", "hook", "gateway"]));
  });

  for (const entry of admitting) {
    const service = entry.service;
    if (service === null) continue;
    const driver = MODE_DRIVERS[service];
    // proves §2.7.1 A4 in every mode, held by the shared layer: it holds the session, counts the first rejection, and
    // at the limit journals one rejection_limit park (overridable) and clears the count
    it(`${entry.id}: the shared layer holds the session and owns its rejection limit`, async () => {
      let counted = -1;
      const { layer, id, parks } = await driver.rejections((at, sessionId) => {
        counted = at.session(sessionId)?.rejections.length ?? -1;
      });
      expect(layer.sessions().map((session) => session.id)).toContain(id);
      expect(layer.session(id)?.mode).toBe(layer.mode);
      expect(layer.service).toBe(service);
      expect(parks().filter((park) => park["reason"] === "rejection_limit")).toEqual([expect.objectContaining({ overridable: true })]);
      expect(layer.session(id)?.rejections).toEqual([]);
      if (service !== "runner") expect(counted).toBe(1);
    });

    // proves §3.1 / §4.3 in every mode, held by the shared layer: every call (or turn) counts, and the one past the
    // budget parks budget_exceeded
    it(`${entry.id}: the shared layer owns its budget`, async () => {
      const { layer, id, parks } = await driver.budget(3);
      expect(layer.session(id)?.spent().turns).toBe(3);
      expect(parks().filter((park) => park["reason"] === "budget_exceeded")).toHaveLength(1);
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------
// E (D-198). Every mode's journal is anchored through the shared session layer (§3.4.1).
// ------------------------------------------------------------------------------------------------------------------

type AnchorDriver = {
  /** Admits one session on a layer anchoring to `anchors` every `intervalMs`, makes one call; returns the layer and id. */
  readonly drive: (anchors: MemoryAnchorSink, intervalMs: number) => Promise<{ layer: SessionLayer; id: string }>;
  /** Admits one session, then makes the destination unreachable and makes calls; answers how many calls proceeded after. */
  readonly cutOff: (anchors: MemoryAnchorSink) => Promise<{ layer: SessionLayer; id: string; proceededAfter: number; admitted: boolean }>;
};

const noteTypes = (root: string, id: string): string[] =>
  readTrajectory(root, id).filter((entry) => entry.kind === "note").map((entry) => {
    const blob = readPayload(root, entry.payload_ref);
    return blob.status === "present" ? String((JSON.parse(new TextDecoder().decode(blob.bytes)) as Record<string, unknown>)["type"]) : "";
  });

/** Calls that went on after the first one stopped for the anchor; -1 when none stopped (which fails the test). */
const proceededAfterStop = (stops: readonly boolean[]): number => {
  const first = stops.indexOf(true);
  return first === -1 ? -1 : stops.slice(first).filter((stopped) => !stopped).length;
};

const ANCHOR_DRIVERS: Readonly<Record<ServiceName, AnchorDriver>> = {
  runner: {
    drive: async (anchors, intervalMs) => {
      const h = await harness(undefined, { anchoring: { sink: anchors, intervalMs } });
      const { runner } = h.runner([turn([unknownCall(1)]), turn([])]);
      expect(runner.admit(runnerRequest())).toMatchObject({ admitted: true });
      await runner.run("task-1");
      return { layer: h.layer, id: "task-1" };
    },
    cutOff: async (anchors) => {
      const h = await harness(undefined, { anchoring: { sink: anchors, intervalMs: 1 } });
      const { runner, provider } = h.runner([
        () => {
          anchors.unreachable = "the destination is gone";
          h.now.value = new Date(h.now.value.getTime() + 10);
          return turn([unknownCall(1)]);
        },
        turn([unknownCall(2)]),
        turn([]),
      ]);
      expect(runner.admit(runnerRequest())).toMatchObject({ admitted: true });
      const outcome = await runner.run("task-1");
      expect(outcome).toMatchObject({ state: "failed", reason: "anchor_unavailable" });
      return { layer: h.layer, id: "task-1", proceededAfter: provider.requests.length - 1, admitted: true };
    },
  },
  hook: {
    drive: async (anchors, intervalMs) => {
      const layer = await openTestLayer("hook", { journal: fx.journal, workspaces: [fx.work], anchoring: testAnchoring({ sink: anchors, intervalMs }) });
      const sessions = sessionsOn(layer);
      expect(await sessions.admit(hookRequest("anchored"))).toMatchObject({ admitted: true });
      await sessions.preToolUse(hookCall("anchored", "Frobnicate"));
      return { layer, id: "session-anchored" };
    },
    cutOff: async (anchors) => {
      const layer = await openTestLayer("hook", { journal: fx.journal, workspaces: [fx.work], anchoring: testAnchoring({ sink: anchors, intervalMs: 1 }) });
      const sessions = sessionsOn(layer);
      const admitted = (await sessions.admit(hookRequest("cut"))).admitted;
      anchors.unreachable = "the destination is gone";
      await new Promise((resolve) => setTimeout(resolve, 5));
      // A call whose entries before it are all anchored may go on (nothing new needed copying); the first call that finds
      // its head cannot be anchored stops the session, and no call after it goes on.
      const stops: boolean[] = [];
      for (let index = 0; index < 3; index += 1) {
        const answer = (await sessions.preToolUse(hookCall("cut", "Read"))) as { decision: string; reason?: string };
        stops.push(answer.decision === "deny" && /off the host|is failed/.test(answer.reason ?? ""));
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      return { layer, id: "session-cut", proceededAfter: proceededAfterStop(stops), admitted };
    },
  },
  gateway: {
    drive: async (anchors, intervalMs) => {
      const layer = await openTestLayer("gateway", { journal: fx.journal, workspaces: [fx.work], anchoring: testAnchoring({ sink: anchors, intervalMs }) });
      const gateway = await openedGateway(layer);
      await gatewayCall(gateway, "admin.wipe", 2);
      return { layer, id: "gateway-probe" };
    },
    cutOff: async (anchors) => {
      const layer = await openTestLayer("gateway", { journal: fx.journal, workspaces: [fx.work], anchoring: testAnchoring({ sink: anchors, intervalMs: 1 }) });
      const gateway = await openedGateway(layer);
      anchors.unreachable = "the destination is gone";
      await new Promise((resolve) => setTimeout(resolve, 5));
      const stops: boolean[] = [];
      for (let index = 0; index < 3; index += 1) {
        const reply = (await gateway.handle({ jsonrpc: "2.0", id: 10 + index, method: "tools/call", params: { name: "message.send", arguments: { to: "ops@example.com", body: "hello" } } })) as { result?: { isError?: boolean; content?: { text?: string }[] } } | null;
        stops.push(reply?.result?.isError === true && /off the host|is failed/.test(reply.result.content?.[0]?.text ?? ""));
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      return { layer, id: "gateway-probe", proceededAfter: proceededAfterStop(stops), admitted: true };
    },
  },
};

describe("D-198 E: every mode's journal is anchored through the shared session layer (§3.4.1)", () => {
  const admitting = ENTRY_POINTS.filter((entry) => entry.admits && entry.kind === "class");

  // proves D-198: the test covers every mode the registry says admits sessions
  it("has an anchoring driver for every registered mode that admits sessions", () => {
    expect(admitting.map((entry) => entry.service).filter((service) => service === null || ANCHOR_DRIVERS[service] === undefined)).toEqual([]);
  });

  // proves §3.4.1 (D-198): no service gets a layer, and so a journal, without an anchor destination and a journal key;
  // the refusal is the shared check's own and nothing is opened
  for (const service of SERVICES) {
    it(`${service}: the shared layer will not open without anchoring`, async () => {
      const spec = { service, journal: fx.journal, workspaces: [fx.work], state: [], anchor: null };
      await expect(SessionLayer.open(spec, { host: ordinaryHost() } as unknown as Parameters<typeof SessionLayer.open>[1])).rejects.toThrow(StartupRefused);
      await expect(SessionLayer.open(spec, { host: ordinaryHost(), anchoring: { ...testAnchoring(), intervalMs: 0 } })).rejects.toThrow(/interval/);
      expect(events.map((event) => event.layer)).toEqual([null, null]);
      expect(existsSync(fx.journal)).toBe(false);
    });
  }

  // proves §3.4.1 (D-198): the shared layer refuses the operator's grant-signing key as the journal key in every service
  for (const service of SERVICES) {
    it(`${service}: the shared layer refuses the operator's key as the journal key`, async () => {
      const { TEST_OPERATOR_KEY } = await import("../../enforcement/test/test-keys.js");
      const spec = { service, journal: fx.journal, workspaces: [fx.work], state: [], anchor: fx.anchor };
      await expect(SessionLayer.open(spec, { host: ordinaryHost(), anchoring: testAnchoring({ journalKey: { privateKey: TEST_OPERATOR_KEY, publicKey: TEST_ANCHOR } }) })).rejects.toThrow(/operator's grant-signing key/);
    });
  }

  for (const entry of admitting) {
    const service = entry.service;
    if (service === null) continue;
    const driver = ANCHOR_DRIVERS[service];

    // proves §3.4.1 (D-198): in every mode the session's journal records the interval and the journal key, and its
    // chain agrees with the anchors the layer took, with nothing left unanchored once the layer closes
    it(`${entry.id}: the session's journal is anchored and agrees with its anchors`, async () => {
      const anchors = new MemoryAnchorSink();
      const { layer, id } = await driver.drive(anchors, 3_600_000);
      expect(await layer.close()).toEqual([]);
      expect(noteTypes(layer.root, id)).toContain("anchoring");
      const stored = await anchors.list(taskDigest(id));
      expect(stored.length).toBeGreaterThan(0);
      expect(checkAnchors(id, verifyTrajectory(layer.root, id), stored, layer.anchoring.journalKey.publicKey)).toMatchObject({ ok: true, unanchored: 0 });
    });

    // proves §3.4.1 (D-198): in every mode a session whose head cannot be anchored stops: no call proceeds after, and
    // the failure is journalled
    it(`${entry.id}: a session whose head cannot be anchored stops`, async () => {
      const anchors = new MemoryAnchorSink();
      const { layer, id, proceededAfter } = await driver.cutOff(anchors);
      expect(proceededAfter).toBe(0);
      expect(noteTypes(layer.root, id)).toContain("anchor_failed");
      expect(layer.session(id)?.stopped ?? "anchor_unavailable").toBe("anchor_unavailable");
    });

    // proves §3.4.1 (D-198, D-203): when the interval's background anchoring finds the destination gone, the failure is
    // journalled in every record it could not copy, the journal's own record included, nothing is thrown, and every
    // session stops for good, with the stop in its journal (so a restart finds it)
    it(`${entry.id}: a failed background anchor is journalled, the journal's own record included, and stops every session in the journal`, async () => {
      const anchors = new MemoryAnchorSink();
      const { layer, id } = await driver.drive(anchors, 3_600_000);
      anchors.unreachable = "the destination is gone";
      const failed = await layer.anchorPending();
      expect(failed).toContain(layer.journalRecord);
      expect(noteTypes(layer.root, layer.journalRecord)).toContain("anchor_failed");
      expect(layer.sessions().map((session) => session.stopped)).toEqual(layer.sessions().map(() => "anchor_unavailable"));
      expect(layer.sessions().length).toBeGreaterThan(0);
      expect(noteTypes(layer.root, id)).toContain("stopped");
      // A service's last act anchors what is pending: it answers what it could not copy, and does not throw either.
      expect(await layer.close()).toContain(layer.journalRecord);
    });

    // proves §3.4.1 (D-198): a session whose head cannot be anchored at admission is never run
    it(`${entry.id}: a session that cannot be anchored when it starts never runs a call`, async () => {
      const anchors = new MemoryAnchorSink();
      // D-201: a service whose anchor destination cannot be read does not start at all (part F). So the destination is
      // lost after the service started and before the session does.
      const lost = (): void => {
        anchors.unreachable = "no destination";
      };
      if (service === "runner") {
        const h = await harness(undefined, { anchoring: { sink: anchors } });
        lost();
        const { runner, provider } = h.runner([turn([unknownCall(1)])]);
        expect(runner.admit(runnerRequest())).toMatchObject({ admitted: true });
        expect(await runner.run("task-1")).toMatchObject({ state: "failed", reason: "anchor_unavailable" });
        expect(provider.requests.length).toBe(0);
        return;
      }
      if (service === "hook") {
        const layer = await openTestLayer("hook", { journal: fx.journal, workspaces: [fx.work], anchoring: testAnchoring({ sink: anchors }) });
        lost();
        const sessions = sessionsOn(layer);
        expect(await sessions.admit(hookRequest("never"))).toMatchObject({ admitted: false });
        expect(await sessions.preToolUse(hookCall("never", "Read"))).toMatchObject({ decision: "deny" });
        expect(noteTypes(layer.root, "session-never")).toContain("anchor_failed");
        return;
      }
      const layer = await openTestLayer("gateway", { journal: fx.journal, workspaces: [fx.work], anchoring: testAnchoring({ sink: anchors }) });
      lost();
      const gateway = gatewayOn(layer);
      expect(await gateway.admit(gatewaySession())).toMatchObject({ admitted: false });
      expect(noteTypes(layer.root, "gateway-probe")).toContain("anchor_failed");
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------
// F. Operator ruling D-201: at start, after the start-up check, every service verifies the journal chain and its off-host
//    anchors, and refuses to start if either fails; only then is anything rebuilt.
// ------------------------------------------------------------------------------------------------------------------

/** The record each service's first run leaves in its journal, beside the journal's own record. */
const RECORD_OF: Readonly<Record<string, string>> = { "gateway.serve": "gateway-probe", "hook.serve": "session-probe", "runner.process": "task-1" };

/** One way the journal or its anchors can be wrong when a service starts again. */
type Tamper = { readonly name: string; readonly arrange: (record: string) => void; readonly text: RegExp };

const journalAbs = (): string => fx.journal;
const forgedEntry = { kind: "note" as const, actor: "someone", provider: null, data_class: { sensitivity: "internal" as const, integrity: "derived" as const }, cost: { tokens_in: 0, tokens_out: 0, tokens_cached: 0, currency: 0, duration_ms: 0 } };

const TAMPERS: readonly Tamper[] = [
  {
    // One character of one stored entry is changed: the chain no longer verifies (§3.4.2).
    name: "an entry of the journal was changed",
    arrange: (record) => {
      const file = entriesFile(journalAbs() as never, record);
      const text = readFileSync(file, "utf8");
      writeFileSync(file, text.replace(/"actor":"[^"]+"/, '"actor":"someone-else"'));
    },
    text: /does not verify/,
  },
  {
    // The record is replaced by a different one whose chain verifies on its own: only the anchors show it (§3.4.1).
    name: "a record was rewritten wholesale, with every hash recomputed",
    arrange: (record) => {
      const length = readTrajectory(journalAbs(), record).length;
      rmSync(taskDir(journalAbs() as never, record), { recursive: true });
      const writer = JournalWriter.open(journalAbs());
      for (let seq = 0; seq < length; seq += 1) writer.append(record, forgedEntry, new TextEncoder().encode(JSON.stringify({ type: "admission", outcome: "rejected", forged: seq })));
    },
    text: /disagrees with its off-host anchors: .*rewritten/,
  },
  {
    // The record's folder is deleted: the journal's own record names it and its anchors are off the host.
    name: "a record was deleted",
    arrange: (record) => rmSync(taskDir(journalAbs() as never, record), { recursive: true }),
    text: /disagrees with its off-host anchors: .*entries were removed/,
  },
  {
    // The whole journal is deleted, as if the service had never run: the anchors of its own record remain.
    name: "the whole journal was deleted",
    arrange: () => rmSync(journalAbs(), { recursive: true }),
    text: /disagrees with its off-host anchors: .*entries were removed/,
  },
  {
    // The destination holds an anchor, signed with the journal key, that names another head at an anchored entry.
    name: "an anchor disagrees with the journal",
    arrange: (record) => {
      const verdict = verifyTrajectory(journalAbs(), record);
      if (!verdict.ok) throw new Error("the record does not verify before the test changes anything");
      const path = [...sink.stored.keys()].find((key) => key.startsWith(`${taskDigest(record)}/`));
      const stored = path === undefined ? undefined : sink.stored.get(path);
      if (path === undefined || stored === undefined) throw new Error("the record has no anchor");
      sink.stored.set(path, anchorOf(record, { seq: stored.seq, hash: `sha256:${"0".repeat(64)}` }, new Date(stored.at), journalKey.privateKey));
      expect(anchorPath(stored.task, stored.seq)).toBe(path);
    },
    text: /disagrees with its off-host anchors: .*rewritten/,
  },
  {
    // An anchor of the record was not signed with this journal's key.
    name: "an anchor does not carry the journal key's signature",
    arrange: (record) => {
      const path = [...sink.stored.keys()].find((key) => key.startsWith(`${taskDigest(record)}/`));
      const stored = path === undefined ? undefined : sink.stored.get(path);
      if (path === undefined || stored === undefined) throw new Error("the record has no anchor");
      sink.stored.set(path, anchorOf(record, { seq: stored.seq, hash: stored.head }, new Date(stored.at), testJournalKey().privateKey));
    },
    text: /disagrees with its off-host anchors: .*signature/,
  },
  {
    // A record JUNO did not write is planted in the journal: an admission nobody made.
    name: "a record was planted in the journal",
    arrange: () => {
      JournalWriter.open(journalAbs()).append("session-planted", forgedEntry, new TextEncoder().encode(JSON.stringify({ type: "admission", outcome: "admitted" })));
    },
    text: /not named by the journal's own record/,
  },
  {
    // The payload one entry names is removed from the blob store: the chain and the anchors still agree, but what the
    // entry records can no longer be rebuilt (D-204).
    name: "a stored payload was removed",
    arrange: (record) => {
      const entry = readTrajectory(journalAbs(), record).at(-1);
      if (entry === undefined) throw new Error("the record has no entry");
      rmSync(blobFile(journalAbs() as never, entry.payload_ref));
    },
    text: /has no readable payload/,
  },
  {
    // The anchors cannot be read, so nothing can be verified.
    name: "the anchor destination cannot be read",
    arrange: () => {
      sink.unreachable = "the destination is down";
    },
    text: /anchor destination could not be read/,
  },
];

describe("D-201 F: every service verifies its journal and its anchors before it starts, and forgets nothing", () => {
  const starting = serviceEntries.filter((entry) => entry.kind !== "class");

  // proves D-203 with D-201 (D-205): an outage of the anchor destination while a new record waits for its first anchor
  // leaves an `anchor_failed` note in the journal's own record. That note is JUNO's own: once the destination is back,
  // the service starts again on the same journal, and what was admitted is still admitted.
  for (const service of SERVICES) {
    it(`${service}: starts again after an outage that reached the journal's own record`, async () => {
      const spec = { service, journal: fx.journal, workspaces: [fx.work], state: [], anchor: fx.anchor };
      const open = (): Promise<SessionLayer> => SessionLayer.open(spec, { host: ordinaryHost(), anchoring: testAnchoring({ sink, journalKey }) });
      const layer = await open();
      const limits = { rejection_limit: 2, ttl: 3_600_000, budget: { tokens: 0, currency: 0, wall_clock_ms: 3_600_000, turns: 5 }, metered: ["turns", "wall_clock_ms"] as const, clock: "from_admission" as const };
      layer.admit("session-kept", limits, { dataClass: { sensitivity: "internal", integrity: "operator" }, payload: { admitted_at: new Date().toISOString() }, actor: "test" });
      sink.unreachable = "the destination is down";
      expect(await layer.close()).toContain(layer.journalRecord);
      expect(noteTypes(fx.journal, layer.journalRecord)).toContain("anchor_failed");
      // While the destination is down, nothing starts.
      await expect(open()).rejects.toThrow(/anchor destination could not be read/);
      sink.unreachable = null;
      const again = await open();
      expect(again.admitted("session-kept")).toBe(true);
      expect(() => again.admit("session-kept", limits, { dataClass: { sensitivity: "internal", integrity: "operator" }, payload: {}, actor: "test" })).toThrow(/admitted once/);
      // And a second restart is as good as the first.
      expect(await again.close()).toEqual([]);
      expect((await open()).admitted("session-kept")).toBe(true);
    });
  }

  /** The service's first run: it starts, admits what its probe admits, and stops, leaving a journal and its anchors. */
  async function firstRun(entry: (typeof starting)[number]): Promise<string> {
    const probe = COMMAND_PROBES[entry.id];
    const record = RECORD_OF[entry.id];
    if (probe === undefined || record === undefined) throw new Error(`no restart probe for ${entry.id}`);
    if (entry.id === "runner.process") {
      // The runner process admits nothing itself; the Runner class writes its journal, through a layer on the same
      // journal, anchors and journal key.
      const layer = await SessionLayer.open({ service: "runner", journal: fx.journal, workspaces: [fx.work], state: [], anchor: fx.anchor }, { host: ordinaryHost(), anchoring: testAnchoring({ sink, journalKey }) });
      const h = await harness();
      try {
        const runner = new Runner({ layer, registry: h.registry, grants: h.grants, providers: [], sources: [], resolver: new HostPathResolver(fx.work) });
        // A refused admission is a record too: journalled under the task's id and anchored.
        expect(runner.admit(runnerRequest())).toMatchObject({ admitted: false });
        runner.close();
      } finally {
        h.cleanup();
      }
      expect(await layer.close()).toEqual([]);
    } else {
      const run = await probe.run(entry.implementation, ordinaryHost(), {});
      expect(run, run.said).toMatchObject({ code: 0 });
    }
    expect(listRecords(fx.journal).map((item) => item.taskId)).toContain(record);
    expect((await sink.list(taskDigest(record))).length).toBeGreaterThan(0);
    events.length = 0;
    return record;
  }

  // proves D-193's rule for this part: every registered service that starts has a restart probe
  it("has a restart probe for every registered command or program that starts a service", () => {
    expect(starting.map((entry) => entry.id).filter((id) => RECORD_OF[id] === undefined || COMMAND_PROBES[id] === undefined)).toEqual([]);
  });

  for (const entry of starting) {
    const probe = COMMAND_PROBES[entry.id];
    if (probe === undefined) continue;

    // proves D-201 (positive control): on an untouched journal the service starts again; the session it admitted is
    // still open and is not admitted a second time (§5: an id is admitted once)
    it(`${entry.id}: starts again on its own journal, and admits nothing twice`, async () => {
      const record = await firstRun(entry);
      const before = readTrajectory(fx.journal, record).length;
      const run = await probe.run(entry.implementation, ordinaryHost(), {});
      expect(run, run.said).toMatchObject({ code: 0 });
      const opened = events.filter((event) => event.spec.service === entry.service);
      expect(opened.map((event) => event.refusals)).toEqual([[]]);
      // No second admission was journalled under the id.
      const admissions = readTrajectory(fx.journal, record).filter((item) => {
        const blob = readPayload(fx.journal, item.payload_ref);
        const payload = blob.status === "present" ? (JSON.parse(new TextDecoder().decode(blob.bytes)) as Record<string, unknown>) : {};
        return payload["type"] === "admission";
      });
      expect(admissions).toHaveLength(1);
      expect(readTrajectory(fx.journal, record).length).toBe(before);
      if (entry.id === "hook.serve") expect(run.said).toMatch(/1 session\(s\) admitted before this start go on from the journal[^]*session probe is already admitted/);
      if (entry.id === "gateway.serve") expect(run.said).toMatch(/goes on from its journal/);
      if (entry.admits) expect(opened[0]?.layer?.sessions().map((session) => session.id)).toEqual([record]);
    }, 30_000);

    for (const tamper of TAMPERS) {
      // proves D-201: the service refuses to start (fail-closed); the refusal is the shared layer's own, no layer is
      // handed out, and so nothing is rebuilt, admitted or served
      it(`${entry.id}: refuses to start when ${tamper.name}`, async () => {
        const record = await firstRun(entry);
        tamper.arrange(record);
        const run = await probe.run(entry.implementation, ordinaryHost(), {});
        expect(run.code, run.said).toBe(1);
        expect(run.said).toMatch(tamper.text);
        const opened = events.filter((event) => event.spec.service === entry.service);
        expect(opened).toHaveLength(1);
        expect(opened[0]?.layer).toBeNull();
        expect(opened[0]?.refusals.join("\n")).toMatch(tamper.text);
        expect(run.said).not.toMatch(/serving|ready/);
      }, 30_000);
    }
  }
});
