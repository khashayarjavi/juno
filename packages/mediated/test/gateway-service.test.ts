import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GrantStore, HostPathResolver, Workspace, execFileScript } from "../../enforcement/src/index.js";
import { openTestLayer } from "../../enforcement/test/layer.js";
import { TEST_ANCHOR, signed } from "../../enforcement/test/test-keys.js";
import { systemFilesystemIo } from "../src/filesystem.js";
import { MCP_REVISION, McpGateway } from "../src/gateway.js";
import { GatewayService } from "../src/gateway-service.js";
import { StdioUpstream } from "../src/gateway-stdio.js";
import { relay } from "../src/mcp-shim.js";

// D-188: the gateway runs as the runner, on a socket it owns; Claude Code starts the stdio shim, which relays lines and
// holds nothing. Here the real shim, the real socket service and the real test upstream; the client is scripted.

const SERVER = fileURLToPath(new URL("../../../test/mcp/test-server.mjs", import.meta.url));
const T0 = new Date("2026-11-08T12:00:00.000Z");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "juno-gw-svc-"));
  mkdirSync(join(dir, "work", "project"), { recursive: true });
  writeFileSync(join(dir, "work", "project", "notes.txt"), "the notes\n");
  mkdirSync(join(dir, "sock"), { mode: 0o700 });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes `messages` through the shim and collects the answers, one per line. */
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

describe("D-188: the gateway is served by the runner on a socket; Claude Code's shim only relays", () => {
  // proves D-188 and §4.3 mode B: a call made through the shim is judged by the runner's gateway and journalled
  it("relays a session through the shim to the runner's gateway, which judges every call", async () => {
    const work = join(dir, "work");
    const record = join(dir, "record.jsonl");
    const grants = new GrantStore(TEST_ANCHOR);
    grants.add(signed({ id: "g", principal: "alireza", capability_selector: { capabilities: ["mcp.message.send"] }, resource_scope: [{ kind: "path", prefix: "/work/project" }], data_class_bounds: { max_sensitivity: "secret", min_integrity: "untrusted" }, issuance: "preissued", issued_by: "alireza", issued_at: new Date(T0.getTime() - 60_000).toISOString(), expires_at: new Date(T0.getTime() + 86_400_000).toISOString(), max_invocations: 10, attenuation_parent: null, revoked_at: null, enumerated_targets: [{ field: "to", value: "ops@example.com" }] }));
    const gateway = new McpGateway({ layer: openTestLayer("gateway", { journal: join(dir, "journal"), workspaces: [work], state: [{ what: "the gateway socket", path: join(dir, "sock", "gateway.sock"), kind: "socket" }] }), grants, resolver: new HostPathResolver(work), view: new Workspace(execFileScript(process.execPath, []), "/work", work), filesystem: systemFilesystemIo(), clock: () => T0, upstream: (refused) => new StdioUpstream(process.execPath, [SERVER, work, record], { refused }) });
    const entry = { capability: { id: "mcp.message.send", interface: { to: { type: { kind: "string" }, role: "data", data_effect: "target" }, body: { type: { kind: "string" }, role: "data", data_effect: "payload" } }, providers: ["gateway.mcp"], side_effect: "external", isolation_tier: 1, max_input_sensitivity: "internal", min_argument_integrity: "operator", output_class: { sensitivity: "input", integrity: "untrusted" }, cost_model: { expected_cost: 0, expected_latency_ms: 100, cost_of_failure: 0 } } };
    expect(await gateway.admit({ session_id: "svc", principal: "alireza", attendance: "autonomous", ttl: 3_600_000, grants: ["g"], budget: { tool_calls: 10, wall_clock_ms: 3_600_000 }, unmetered_accepted: true, provider_clearance: "internal", sources: [{ id: "project", selector: { kind: "path", prefix: "/work/project" }, data_class: { sensitivity: "internal", integrity: "untrusted" } }, { id: "acks", selector: { kind: "tool_result", tool: "mcp.message.send" }, data_class: { sensitivity: "internal", integrity: "untrusted" } }], tools: [{ tool: "message.send", entry }] })).toMatchObject({ admitted: true });
    const service = new GatewayService(gateway);
    const socket = join(dir, "sock", "gateway.sock");
    await service.listen(socket);
    try {
      const answers = await through(socket, [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_REVISION, capabilities: {}, clientInfo: { name: "scripted", version: "1" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "message.send", arguments: { to: "attacker@example.com", body: "x" } } },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "message.send", arguments: { to: "ops@example.com", body: "y" } } },
      ]);
      expect(answers).toEqual([
        expect.objectContaining({ id: 1, result: expect.objectContaining({ protocolVersion: MCP_REVISION }) }),
        expect.objectContaining({ id: 2, result: expect.objectContaining({ isError: true }) }),
        expect.objectContaining({ id: 3, result: { content: [{ type: "text", text: "recorded a message to ops@example.com" }] } }),
      ]);
      const lines = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines.filter((line) => line["would_send"] !== undefined)).toEqual([{ would_send: { to: "ops@example.com", body: "y" } }]);
    } finally {
      await service.close();
    }
  }, 60_000);

  // proves D-188 fail-closed: when the gateway's socket cannot be reached, every request gets an error and nothing runs
  it("answers every request with an error when the gateway is down", async () => {
    const answers = await through(join(dir, "sock", "missing.sock"), [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_REVISION } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "message.send", arguments: { to: "ops@example.com", body: "y" } } },
    ]);
    expect(answers).toEqual([
      expect.objectContaining({ id: 1, error: expect.objectContaining({ code: -32603, message: expect.stringContaining("not reachable") }) }),
      expect.objectContaining({ id: 2, error: expect.objectContaining({ code: -32603 }) }),
    ]);
    expect(existsSync(join(dir, "record.jsonl"))).toBe(false);
  });

  // proves D-173 as applied to D-188: the service refuses a socket folder others could write, and a mode open to everyone.
  // (D-194: the shared start-up check refuses such a folder before anything starts; the service checks again when it
  // listens, so a folder opened up after start-up is refused too, and a socket the check never judged is refused.)
  it("refuses an unsafe socket folder or mode", async () => {
    const { chmodSync } = await import("node:fs");
    mkdirSync(join(dir, "open"), { mode: 0o700 });
    const state = [{ what: "the gateway socket", path: join(dir, "open", "g.sock"), kind: "socket" as const }, { what: "the gateway socket", path: join(dir, "sock", "g.sock"), kind: "socket" as const }];
    const gateway = new McpGateway({ layer: openTestLayer("gateway", { journal: join(dir, "j2"), workspaces: [join(dir, "work")], state }), grants: new GrantStore(TEST_ANCHOR), resolver: new HostPathResolver(join(dir, "work")), view: new Workspace(execFileScript(process.execPath, []), "/work", join(dir, "work")), filesystem: systemFilesystemIo(), upstream: () => { throw new Error("unused"); } });
    chmodSync(join(dir, "open"), 0o777);
    expect(() => openTestLayer("gateway", { journal: join(dir, "j3"), workspaces: [join(dir, "work")], state })).toThrow(/writable by group or others/);
    await expect(new GatewayService(gateway).listen(join(dir, "open", "g.sock"))).rejects.toThrow(/writable by group or others/);
    await expect(new GatewayService(gateway, { socketMode: 0o666 }).listen(join(dir, "sock", "g.sock"))).rejects.toThrow(/at most read and write/);
    await expect(new GatewayService(gateway).listen(join(dir, "sock", "other.sock"))).rejects.toThrow(/not one the start-up check judged/);
  });
});
