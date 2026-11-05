// A scripted Anthropic Messages API server for the mediated end-to-end test (build plan Slice 1.5 §4; D-092, D-145).
// It runs inside the e2e container on loopback only. Each POST /v1/messages answers the next scripted turn, as a
// streamed message (the event sequence the real Claude Code binary was observed to accept, 2026-11-05). Every request
// is recorded. It calls no model and reaches no network.
//
//   node messages-server.mjs <script.json> <requests.log> <port>
//   script.json: [{ "text": "..." } | { "tool_use": { "name": "Write", "input": { ... } } }, ...]
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import process from "node:process";

const [scriptFile, logFile, port] = process.argv.slice(2);
const turns = JSON.parse(readFileSync(scriptFile, "utf8"));
let next = 0;

function events(turn, index) {
  const message = { id: `msg_${index}`, type: "message", role: "assistant", model: "claude-scripted", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  const block = turn.tool_use === undefined ? { type: "text", text: "" } : { type: "tool_use", id: `toolu_e2e_${index}`, name: turn.tool_use.name, input: {} };
  const delta = turn.tool_use === undefined ? { type: "text_delta", text: turn.text ?? "done" } : { type: "input_json_delta", partial_json: JSON.stringify(turn.tool_use.input) };
  return [
    ["message_start", { type: "message_start", message }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: block }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: turn.tool_use === undefined ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ];
}

createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    appendFileSync(logFile, `${JSON.stringify({ method: request.method, url: request.url, body })}\n`);
    if (request.method === "POST" && request.url.startsWith("/v1/messages") && !request.url.includes("count_tokens")) {
      const index = next;
      next += 1;
      const turn = turns[Math.min(index, turns.length - 1)] ?? { text: "done" };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const [name, data] of events(index >= turns.length ? { text: "done" } : turn, index)) response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      response.end();
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "not scripted" } }));
  });
}).listen(Number(port), "127.0.0.1", () => appendFileSync(logFile, `${JSON.stringify({ listening: Number(port) })}\n`));
