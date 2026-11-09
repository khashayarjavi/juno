import { type Stats, chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPayload, readTrajectory } from "../../journal/src/index.js";
import { TEST_ANCHOR, signed } from "../../enforcement/test/test-keys.js";
import { systemFilesystemIo } from "../src/filesystem.js";
import { MCP_REVISION } from "../src/gateway.js";
import { type GatewayCliIo, runGatewayCli } from "../src/gateway-cli.js";
import { relay } from "../src/mcp-shim.js";

// D-191 (plan Increment 5 item 3): `juno gateway serve` loads the operator's session file, admits it, starts the
// upstream with execFile, and serves the gateway on its socket as the runner; Claude Code reaches it through the shim.
// Here the real command function, the real shim, socket and test upstream; only the uid, the anchor loader and the stop
// signal are given.

const SERVER = fileURLToPath(new URL("../../../test/mcp/test-server.mjs", import.meta.url));
let dir: string;
let work: string;
let record: string;

const ENTRY = { capability: { id: "mcp.message.send", interface: { to: { type: { kind: "string" }, role: "data", data_effect: "target" }, body: { type: { kind: "string" }, role: "data", data_effect: "payload" } }, providers: ["gateway.mcp"], side_effect: "external", isolation_tier: 1, max_input_sensitivity: "internal", min_argument_integrity: "operator", output_class: { sensitivity: "input", integrity: "untrusted" }, cost_model: { expected_cost: 0, expected_latency_ms: 100, cost_of_failure: 0 } } };

function grant(id: string): Record<string, unknown> {
  return signed({ id, principal: "alireza", capability_selector: { capabilities: ["mcp.message.send"] }, resource_scope: [{ kind: "path", prefix: "/work/project" }], data_class_bounds: { max_sensitivity: "secret", min_integrity: "untrusted" }, issuance: "preissued", issued_by: "alireza", issued_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString(), max_invocations: 10, attenuation_parent: null, revoked_at: null, enumerated_targets: [{ field: "to", value: "ops@example.com" }] });
}

function sessionFile(grantId = "g"): Record<string, unknown> {
  return {
    session: { session_id: "cli", principal: "alireza", attendance: "autonomous", ttl: 3_600_000, grants: [grantId], budget: { tool_calls: 10, wall_clock_ms: 3_600_000 }, unmetered_accepted: true, provider_clearance: "internal", sources: [{ id: "project", selector: { kind: "path", prefix: "/work/project" }, data_class: { sensitivity: "internal", integrity: "untrusted" } }, { id: "acks", selector: { kind: "tool_result", tool: "mcp.message.send" }, data_class: { sensitivity: "internal", integrity: "untrusted" } }], tools: [{ tool: "message.send", entry: ENTRY }] },
    upstream: { program: process.execPath, argv: [SERVER, work, record] },
  };
}

function io(overrides: Partial<GatewayCliIo> & { stop?: Promise<void> } = {}): GatewayCliIo & { said: string[] } {
  const said: string[] = [];
  // The process's own uid, so files this test writes are its own; as root (a cloud session), an ordinary uid, since the
  // command refuses root, and root's files are accepted as the operator's (found by CI, which runs as an ordinary user).
  const own = typeof process.geteuid === "function" ? process.geteuid() : 1000;
  return {
    uid: own === 0 ? 1000 : own,
    lstat: (path): Stats | null => {
      try {
        return lstatSync(path);
      } catch {
        return null;
      }
    },
    readFile: (path) => readFileSync(path, "utf8"),
    loadAnchor: () => TEST_ANCHOR,
    filesystem: systemFilesystemIo(),
    stopped: () => overrides.stop ?? Promise.resolve(),
    out: (text) => said.push(text),
    err: (text) => said.push(text),
    said,
    ...overrides,
  };
}

function args(extra: Record<string, string> = {}): string[] {
  const options: Record<string, string> = { "--session": join(dir, "session.json"), "--socket": join(dir, "sock", "gateway.sock"), "--journal": join(dir, "journal"), "--anchor": join(dir, "operator.pub"), "--workspace": work, "--grant": join(dir, "grant.json"), ...extra };
  return ["serve", ...Object.entries(options).flat()];
}

async function through(socket: string, messages: readonly unknown[]): Promise<Record<string, unknown>[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  const answers: Record<string, unknown>[] = [];
  let text = "";
  output.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
    for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n")) {
      answers.push(JSON.parse(text.slice(0, at)) as Record<string, unknown>);
      text = text.slice(at + 1);
    }
  });
  const done = relay(socket, input, output);
  for (const message of messages) input.write(`${JSON.stringify(message)}\n`);
  const expected = messages.filter((message) => (message as { id?: unknown }).id !== undefined).length;
  const deadline = Date.now() + 20_000;
  while (answers.length < expected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  input.end();
  await done;
  return answers;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "juno-gw-cli-"));
  work = join(dir, "work");
  record = join(dir, "record.jsonl");
  mkdirSync(join(work, "project"), { recursive: true });
  mkdirSync(join(dir, "sock"), { mode: 0o750 });
  writeFileSync(join(dir, "session.json"), JSON.stringify(sessionFile()), { mode: 0o644 });
  writeFileSync(join(dir, "grant.json"), JSON.stringify(grant("g")), { mode: 0o644 });
  writeFileSync(join(dir, "operator.pub"), "unused: the anchor loader is given\n");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("juno gateway serve (D-191)", () => {
  // proves D-191 with §4.3 acceptance test 3 at protocol level: the command admits the session and serves it; an
  // unenumerated untrusted recipient parks and is never sent, the enumerated one is delivered
  it("admits the operator's session file and serves the gateway on its socket until stopped", async () => {
    let stop: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    const target = io({ stop: stopped });
    let finished = false;
    const running = runGatewayCli(args(), target).finally(() => (finished = true));
    const socket = join(dir, "sock", "gateway.sock");
    for (let tries = 0; tries < 400 && !finished && !existsSync(socket); tries += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    // A command that refused says why here, rather than as a missing socket.
    expect(finished ? target.said.join("") : "serving").toBe("serving");
    expect((lstatSync(socket).mode & 0o777).toString(8)).toBe("660");
    const answers = await through(socket, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_REVISION, capabilities: {}, clientInfo: { name: "scripted", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "message.send", arguments: { to: "attacker@example.com", body: "x" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "message.send", arguments: { to: "ops@example.com", body: "y" } } },
    ]);
    stop();
    expect(await running).toBe(0);
    expect(answers[1]).toMatchObject({ id: 2, result: { isError: true } });
    expect(answers[2]).toMatchObject({ id: 3, result: { content: [{ type: "text", text: "recorded a message to ops@example.com" }] } });
    const received = readFileSync(record, "utf8");
    expect(received).not.toContain("attacker@example.com");
    expect(received).toContain("ops@example.com");
    const parks = readTrajectory(join(dir, "journal"), "gateway-cli").filter((entry) => entry.kind === "park").map((entry) => {
      const blob = readPayload(join(dir, "journal"), entry.payload_ref);
      return blob.status === "present" ? (JSON.parse(new TextDecoder().decode(blob.bytes)) as Record<string, unknown>) : {};
    });
    expect(parks).toEqual([expect.objectContaining({ reason: "integrity_floor" })]);
  }, 60_000);

  // proves D-191: as root, with a session file or grant file others could change, or with bad input, it refuses and serves nothing
  it.each([
    ["it runs as root", (): Partial<GatewayCliIo> => ({ uid: 0 })],
    ["the session file is writable by others", (): Partial<GatewayCliIo> => { chmodSync(join(dir, "session.json"), 0o666); return {}; }],
    ["the grant file is writable by its group", (): Partial<GatewayCliIo> => { chmodSync(join(dir, "grant.json"), 0o664); return {}; }],
    ["the session file is owned by another user", (): Partial<GatewayCliIo> => ({ uid: 4242, lstat: (path) => { const stats = lstatSync(path); return Object.assign(Object.create(Object.getPrototypeOf(stats) as object) as Stats, stats, { uid: 4243 }); } })],
    ["the session file is not a gateway session", (): Partial<GatewayCliIo> => { writeFileSync(join(dir, "session.json"), JSON.stringify({ session: {} })); return {}; }],
    ["the upstream program is not absolute", (): Partial<GatewayCliIo> => { writeFileSync(join(dir, "session.json"), JSON.stringify({ ...sessionFile(), upstream: { program: "node", argv: [] } })); return {}; }],
    ["the anchor cannot be trusted", (): Partial<GatewayCliIo> => ({ loadAnchor: () => { throw new Error("the trust anchor is writable by this process"); } })],
    ["the grant is forged", (): Partial<GatewayCliIo> => { writeFileSync(join(dir, "grant.json"), JSON.stringify({ ...grant("g"), max_invocations: 9999 })); return {}; }],
  ])("refuses when %s", async (_what, arrange) => {
    const target = io(arrange());
    expect(await runGatewayCli(args(), target)).toBe(1);
    expect(existsSync(join(dir, "sock", "gateway.sock"))).toBe(false);
    expect(existsSync(record)).toBe(false);
  });

  // proves D-192 (D-148 for mode B): a journal, session file, grant file, anchor or socket folder inside the workspace is
  // refused before anything is opened, so no gateway tool call can reach JUNO's own state
  it.each([
    ["the journal", "--journal", (): string => join(work, "project", ".journal")],
    ["the socket", "--socket", (): string => join(work, "sock", "gateway.sock")],
    ["the anchor", "--anchor", (): string => join(work, "operator.pub")],
  ])("refuses when %s lies in the workspace", async (_what, option, path) => {
    const target = io();
    expect(await runGatewayCli(args({ [option]: path() }), target)).toBe(1);
    expect(target.said.join("")).toContain("D-148");
    expect(existsSync(join(work, "project", ".journal"))).toBe(false);
  });

  // proves D-191: without a grant, a socket or the serve verb it is bad usage
  it("is bad usage without every required option", async () => {
    const without = args().filter((_value, index, all) => all[index] !== "--grant" && all[index - 1] !== "--grant");
    expect(await runGatewayCli(without, io())).toBe(2);
    expect(await runGatewayCli(["run", ...args().slice(1)], io())).toBe(2);
  });
});
