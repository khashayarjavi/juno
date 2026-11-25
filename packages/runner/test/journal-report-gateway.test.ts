import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAnchorSink, testAnchoring, testJournalKey } from "../../enforcement/test/anchoring.js";
import { ordinaryHost } from "../../enforcement/test/layer.js";
import { TEST_ANCHOR, signed } from "../../enforcement/test/test-keys.js";
import { systemFilesystemIo } from "../../mediated/src/filesystem.js";
import { MCP_REVISION } from "../../mediated/src/gateway.js";
import { runGatewayCli } from "../../mediated/src/gateway-cli.js";
import { relay } from "../../mediated/src/mcp-shim.js";
import { executeOutbound } from "../../registry/src/index.js";
import { runJournalCli } from "../src/journal-cli.js";

// D-254 and D-256 (review round 2 of PR #68): `juno journal report` on a journal JUNO's gateway wrote (`juno gateway
// serve`, the real shim, socket and test upstream, as packages/mediated/test/gateway-cli.test.ts runs them). The gateway
// journals a call its boundary rejects twice over: the judged call (outcome `reject`) and a `rejection` note naming it.
// The report counts that call once, by the rule a service's replay uses (`journalledCall`).

const SERVER = fileURLToPath(new URL("../../../test/mcp/test-server.mjs", import.meta.url));
const ENTRY = { capability: { id: "mcp.message.send", interface: { to: { type: { kind: "string" }, role: "data", data_effect: "target" }, body: { type: { kind: "string" }, role: "data", data_effect: "payload" } }, providers: ["gateway.mcp"], side_effect: "external", isolation_tier: 1, max_input_sensitivity: "internal", min_argument_integrity: "operator", output_class: { sensitivity: "input", integrity: "untrusted" }, cost_model: { expected_cost: 0, expected_latency_ms: 100, cost_of_failure: 0 } } };

let dir: string;
let work: string;
let sink: MemoryAnchorSink;
const journalKey = testJournalKey();

beforeEach(() => {
  sink = new MemoryAnchorSink();
  dir = mkdtempSync(join(tmpdir(), "juno-report-gw-"));
  work = join(dir, "work");
  mkdirSync(join(work, "project"), { recursive: true });
  mkdirSync(join(dir, "sock"), { mode: 0o750 });
  const grant = signed({ id: "g", principal: "alireza", capability_selector: { capabilities: ["mcp.message.send"] }, resource_scope: [{ kind: "path", prefix: "/work/project" }], data_class_bounds: { max_sensitivity: "secret", min_integrity: "untrusted" }, issuance: "preissued", issued_by: "alireza", issued_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString(), max_invocations: 10, attenuation_parent: null, revoked_at: null, enumerated_targets: [{ field: "to", value: "ops@example.com" }] });
  writeFileSync(join(dir, "grant.json"), JSON.stringify(grant), { mode: 0o644 });
  writeFileSync(join(dir, "session.json"), JSON.stringify({
    session: { session_id: "weekly", principal: "alireza", attendance: "autonomous", ttl: 3_600_000, grants: ["g"], budget: { tool_calls: 10, wall_clock_ms: 3_600_000 }, unmetered_accepted: true, provider_clearance: "internal", sources: [{ id: "project", selector: { kind: "path", prefix: "/work/project" }, data_class: { sensitivity: "internal", integrity: "untrusted" } }, { id: "acks", selector: { kind: "tool_result", tool: "mcp.message.send" }, data_class: { sensitivity: "internal", integrity: "untrusted" } }], tools: [{ tool: "message.send", entry: ENTRY }] },
    upstream: { program: process.execPath, argv: [SERVER, work, join(dir, "record.jsonl")] },
  }), { mode: 0o644 });
  mkdirSync(join(dir, "anchor"));
  writeFileSync(join(dir, "anchor", "operator.pub"), TEST_ANCHOR.export({ type: "spki", format: "pem" }), { mode: 0o444 });
  chmodSync(join(dir, "anchor"), 0o555);
  mkdirSync(join(dir, "root-owned"), { mode: 0o755 });
  writeFileSync(join(dir, "root-owned", "anchors.json"), JSON.stringify({ url: join(dir, "pinned-juno-anchors.git"), branch: "main", host_key_fingerprint: null, known_hosts: null, push_key: null, git: "/usr/bin/git", journals: [{ path: join(dir, "journal"), recovery_epoch: "2020-01-01T00:00:00Z" }] }), { mode: 0o644 });
});

afterEach(() => {
  chmodSync(join(dir, "anchor"), 0o755);
  rmSync(dir, { recursive: true, force: true });
});

/** Messages through the real shim to the gateway's socket; the answers to those with an id. */
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

describe("juno journal report on a gateway journal (D-254, D-256)", () => {
  // proves D-256 over §3.4.2: a call the gateway's boundary rejects is counted once, as the service's replay counts it;
  // the allowed call and the parked one are counted too
  it("counts a rejected gateway call once", async () => {
    let stop: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    const said: string[] = [];
    let finished = false;
    const args = ["serve", "--session", join(dir, "session.json"), "--socket", join(dir, "sock", "gateway.sock"), "--journal", join(dir, "journal"), "--anchor", join(dir, "anchor", "operator.pub"), "--workspace", work, "--journal-key", join(dir, "journal-key"), "--anchors", join(dir, "juno-anchors"), "--anchor-pin", join(dir, "root-owned", "anchors.json"), "--grant", join(dir, "grant.json")];
    const running = runGatewayCli(args, { host: ordinaryHost(), readFile: (path) => readFileSync(path, "utf8"), filesystem: systemFilesystemIo(), anchoring: testAnchoring({ sink, journalKey }), stopped: () => stopped, out: (text) => said.push(text), err: (text) => said.push(text) }).finally(() => (finished = true));
    const socket = join(dir, "sock", "gateway.sock");
    for (let tries = 0; tries < 400 && !finished && !existsSync(socket); tries += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(finished ? said.join("") : "serving").toBe("serving");
    const answers = await through(socket, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_REVISION, capabilities: {}, clientInfo: { name: "scripted", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "message.send", arguments: { to: "attacker@example.com", body: "x" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "message.send", arguments: { to: "ops@example.com", body: "y" } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "message.send", arguments: { to: "ops@example.com", body: "z", cc: "attacker@example.com" } } },
    ]);
    stop();
    expect(await running).toBe(0);
    expect(answers.slice(1).map((answer) => (answer["result"] as { isError?: boolean } | undefined)?.isError === true)).toEqual([true, false, true]);
    // The operator's copy and clone, as Part G step 7 makes them.
    const copy = join(dir, "juno-check");
    mkdirSync(copy, { mode: 0o700 });
    expect((await executeOutbound({ file: "/bin/cp", args: ["-RP", join(dir, "journal"), join(copy, "journal")] })).exitCode).toBe(0);
    for (const [path, anchor] of sink.stored) {
      mkdirSync(join(copy, "anchors", path.split("/")[0] ?? ""), { recursive: true });
      writeFileSync(join(copy, "anchors", path), JSON.stringify(anchor));
    }
    for (const step of [["init", "--quiet"], ["add", "-A"], ["commit", "--quiet", "-m", "anchors"]]) {
      expect((await executeOutbound({ file: "/usr/bin/git", args: ["-c", "user.name=o", "-c", "user.email=o@o", "-c", "init.defaultBranch=main", "-C", join(copy, "anchors"), ...step] })).exitCode).toBe(0);
    }
    writeFileSync(join(copy, "key.pem"), journalKey.publicKey.export({ type: "spki", format: "pem" }).toString());
    const out: string[] = [];
    const code = await runJournalCli(["report", "--journal", join(copy, "journal"), "--anchors", join(copy, "anchors"), "--key", join(copy, "key.pem"), "--json"], { readFile: (path) => readFileSync(path, "utf8"), out: (text) => out.push(text), err: (text) => out.push(text) });
    expect(code, out.join("")).toBe(0);
    const report = JSON.parse(out.join("")) as { sessions: Record<string, unknown>[]; total: Record<string, unknown> };
    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]).toMatchObject({ mode: "gateway", allowed: 1, parked: 1, rejected: 1, passed_to_gateway: 0, parks_by_capability: [{ value: "mcp.message.send", count: 1 }] });
    expect(report.total).toMatchObject({ allowed: 1, parked: 1, rejected: 1 });
  }, 120_000);
});
