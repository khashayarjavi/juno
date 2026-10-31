import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EgressRefused,
  FileTokenLedger,
  GROQ_MODEL,
  GROQ_ORIGIN,
  GroqProvider,
  MemoryTokenLedger,
  ProviderStop,
  egress,
  takeGroqKey,
  toMessages,
  toolSchema,
  wireName,
} from "../src/groq.js";
import { GROQ_PROFILE_FILE, type ProviderProfile, loadProviderProfile } from "../src/profile.js";
import { type ProviderRequest, ProviderResponse } from "../src/provider.js";
import { type Harness, OPERATOR_CRITERION, harness, request } from "./helpers.js";

// Slice 1.1 Part 3: the Groq adapter (DECISIONS.md D-072, D-073). Every test
// uses a fake `fetch`; nothing here reaches the network, and no real key is
// used. The key's prefix is assembled at run time, so the literal is never
// written in the repository.

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const PREFIX = ["g", "s", "k", "_"].join("");
const KEY = `${PREFIX}${"Zq7".repeat(17)}x`;
const PROFILE = loadProviderProfile(GROQ_PROFILE_FILE);
const SHELL_RUN_INTERFACE = JSON.parse(readFileSync(join(repoRoot, "packages/registry/definitions/shell.run.json"), "utf8")).capability.interface as unknown;

type Sent = { url: string; init: RequestInit; body: Record<string, unknown> };
type Answer = { status?: number; body: unknown; headers?: Record<string, string> };

const FREE_HEADERS = { "x-ratelimit-limit-requests": "1000", "x-ratelimit-limit-tokens": "8000" };

function chat(message: Record<string, unknown>, finish = "stop", usage: Record<string, unknown> = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }): Answer {
  return { body: { id: "chatcmpl-1", object: "chat.completion", model: GROQ_MODEL, system_fingerprint: "fp_test", choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }], usage } };
}

/** A fake provider endpoint: answers in order, and records every request. */
function fakeFetch(answers: readonly (Answer | ((sent: Sent) => Answer))[]): { fetch: (url: string, init: RequestInit) => Promise<Response>; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: (url, init) => {
      const record: Sent = { url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> };
      sent.push(record);
      const next = answers[sent.length - 1];
      if (next === undefined) return Promise.reject(new Error("no more answers"));
      const answer = typeof next === "function" ? next(record) : next;
      return Promise.resolve(
        new Response(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body), {
          status: answer.status ?? 200,
          headers: { "content-type": "application/json", ...FREE_HEADERS, ...answer.headers },
        }),
      );
    },
  };
}

function provider(answers: readonly (Answer | ((sent: Sent) => Answer))[], options: { ledger?: MemoryTokenLedger; profile?: ProviderProfile } = {}) {
  const fake = fakeFetch(answers);
  const sleeps: number[] = [];
  const ledger = options.ledger ?? new MemoryTokenLedger(150_000);
  const groq = new GroqProvider({
    profile: options.profile ?? PROFILE,
    key: KEY,
    ledger,
    fetch: fake.fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    now: () => Date.parse("2026-10-30T20:00:00Z"),
  });
  return { groq, sent: fake.sent, sleeps, ledger };
}

const REQUEST: ProviderRequest = {
  model: GROQ_MODEL,
  context: [
    { role: "system", content: { runner: "juno" } },
    { role: "user", content: { objective: "read the notes" } },
  ],
  tools: [{ capability: "shell.run", interface: SHELL_RUN_INTERFACE, slots: { program: ["cat", "ls"], argv: ["project"], cwd: ["project"] } }],
};

const authorization = (sent: Sent): string => new Headers(sent.init.headers).get("authorization") ?? "";
const leaks = (text: string): boolean => text.includes(KEY) || text.includes(PREFIX);

describe("the one host (D-072, D-073)", () => {
  // proves D-072 "runner network: outbound to api.groq.com only": every other origin is refused before any request
  it("refuses every origin but https://api.groq.com, and refuses redirects", async () => {
    const calls: string[] = [];
    const fetcher = (url: string, init: RequestInit): Promise<Response> => {
      calls.push(`${url} ${String(init.redirect)}`);
      return Promise.resolve(new Response("{}"));
    };
    for (const url of ["http://api.groq.com/openai/v1/chat/completions", "https://api.groq.com.evil.example/x", "https://evil.example/", "https://user:pw@api.groq.com/x", "https://api.groq.com:8443/x", "not a url"]) {
      await expect(egress(fetcher, url, {})).rejects.toThrow(EgressRefused);
    }
    expect(calls).toEqual([]);
    await egress(fetcher, `${GROQ_ORIGIN}/openai/v1/chat/completions`, { redirect: "follow" });
    expect(calls).toEqual(["https://api.groq.com/openai/v1/chat/completions error"]);
  });

  // proves D-073: no runner, enforcement, registry, journal or contracts source opens a network connection except the Groq adapter
  it("leaves the Groq adapter as the only network code in the packages", () => {
    const network = /\bfetch\(|node:https?\b|node:net\b|node:tls\b|node:dgram\b|\bundici\b|WebSocket/;
    const offenders: string[] = [];
    for (const pkg of readdirSync(join(repoRoot, "packages"))) {
      const src = join(repoRoot, "packages", pkg, "src");
      for (const file of readdirSync(src, { recursive: true }).map(String)) {
        if (!file.endsWith(".ts")) continue;
        if (network.test(readFileSync(join(src, file), "utf8")) && `${pkg}/${file}` !== "runner/groq.ts") offenders.push(`${pkg}/${file}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the profile (§13.1, D-073)", () => {
  // proves §13.1 / D-072: the Groq profile is a valid Provider Capability Profile for openai/gpt-oss-120b, with its settings captured
  it("is a §13.1 profile for the one model, stateless and client-driven, with wire settings", () => {
    expect(PROFILE).toMatchObject({
      id: "groq",
      model: GROQ_MODEL,
      conversation_state: "stateless",
      turn_control: "client",
      replay_fidelity: "full",
      native_tool_calling: { supported: true, parallel: false },
      context_window: 131072,
      wire: { endpoint: "https://api.groq.com/openai/v1/chat/completions" },
    });
  });

  // proves D-072 "model gpt-oss-120b only": the adapter refuses any other model, and any profile endpoint off the one host
  it("refuses another model, another host, and a cap at or above the free daily limit", () => {
    const base = { key: KEY, ledger: new MemoryTokenLedger(150_000) };
    expect(() => new GroqProvider({ ...base, profile: { ...PROFILE, model: "openai/gpt-oss-20b" } })).toThrow(/serves openai\/gpt-oss-120b only/);
    const wire = PROFILE.wire;
    if (wire === undefined) throw new Error("the Groq profile has no wire settings");
    expect(() => new GroqProvider({ ...base, profile: { ...PROFILE, wire: { ...wire, endpoint: "https://evil.example/v1" } } })).toThrow(/must be on/);
    expect(() => new GroqProvider({ ...base, profile: PROFILE, ledger: new MemoryTokenLedger(200_000) })).toThrow(/below Groq's free daily limit/);
  });
});

describe("the request (D-072 docs read)", () => {
  // proves D-073: the body names the one model, carries the profile's settings, and never a field Groq documents as unsupported
  it("sends the one model, the profile's settings and the tools, to the one endpoint", async () => {
    const { groq, sent } = provider([chat({ content: "done" })]);
    await groq.complete(REQUEST);
    expect(sent).toHaveLength(1);
    const [first] = sent;
    expect(first?.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(first === undefined ? "" : authorization(first)).toBe(`Bearer ${KEY}`);
    expect(first?.body).toMatchObject({ model: GROQ_MODEL, temperature: 0, reasoning_effort: "medium", max_completion_tokens: 1024, seed: 1729, n: 1, stream: false });
    for (const field of ["logprobs", "logit_bias", "top_logprobs"]) expect(first?.body).not.toHaveProperty(field);
    for (const message of first?.body["messages"] as Record<string, unknown>[]) expect(message).not.toHaveProperty("name");
    const tools = first?.body["tools"] as ReturnType<typeof toolSchema>[];
    expect(tools.map((tool) => tool.function.name)).toEqual(["shell__run"]);
    // Slice 1.2 (D-075): the schema names slots only, never a constant's value; the program enum's values appear nowhere.
    expect(JSON.stringify(tools[0]?.function.parameters)).not.toContain("/usr/bin/");
  });

  // proves Slice 1.2 / D-075 / §2.2: an instruction field is offered only as an offered slot (enumerated by name) or a reference;
  // a data field also as a literal; and the function name maps back to the capability
  it("offers an instruction field only as a slot or a reference, and maps the function name back", async () => {
    const tool = REQUEST.tools[0];
    if (tool === undefined) throw new Error("no tool");
    const schema = toolSchema(tool).function.parameters as { properties: Record<string, { anyOf?: unknown[]; items?: { anyOf: unknown[] }; description: string }> };
    const slotOf = (names: string[]): unknown => ({ type: "object", properties: { slot: { type: "string", enum: names } }, required: ["slot"], additionalProperties: false });
    const ref = expect.objectContaining({ required: ["ref"] });
    expect(schema.properties["program"]?.anyOf).toEqual([slotOf(["cat", "ls"]), ref]);
    expect(schema.properties["program"]?.description).toMatch(/^instruction field: Name one of the constants \["cat","ls"\].*\$\{12\.stdout_lines\[0\]\}.*anything else parks the task/);
    expect(schema.properties["argv"]?.items?.anyOf).toEqual([{ type: "string" }, slotOf(["project"]), ref]);
    expect(schema.properties["cwd"]?.anyOf).toEqual([{ type: "string" }, slotOf(["project"]), ref]);
    expect(schema.properties["argv"]?.description).toMatch(/^data field: a literal you write/);
    // No slot offered: the instruction field is offered as a reference alone.
    const bare = toolSchema({ ...tool, slots: {} }).function.parameters as { properties: Record<string, { anyOf: unknown[] }> };
    expect(bare.properties["program"]?.anyOf).toEqual([ref]);
    expect(wireName("shell.run")).toBe("shell__run");
    expect(() => wireName("a".repeat(65))).toThrow();
    const { groq } = provider([chat({ content: null, tool_calls: [{ id: "fc_1", type: "function", function: { name: "shell__run", arguments: '{"program":{"slot":"cat"},"argv":["notes.txt"],"cwd":{"slot":"project"}}' } }] }, "tool_calls")]);
    const answer = ProviderResponse.parse(await groq.complete(REQUEST));
    expect(answer.tool_calls).toEqual([{ id: "fc_1", capability: "shell.run", arguments: { program: { slot: "cat" }, argv: ["notes.txt"], cwd: { slot: "project" } } }]);
    expect(answer).toMatchObject({ model: GROQ_MODEL, model_version: "fp_test", text: null, usage: { tokens_in: 120, tokens_out: 30, tokens_cached: 0 } });
  });

  // proves §3.4 / D-073: cached prompt tokens are counted apart from the rest, as the runner prices them
  it("splits cached prompt tokens from the rest", async () => {
    const { groq } = provider([chat({ content: "x" }, "stop", { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, prompt_tokens_details: { cached_tokens: 600 } })]);
    expect(ProviderResponse.parse(await groq.complete(REQUEST)).usage).toEqual({ tokens_in: 400, tokens_out: 10, tokens_cached: 600 });
  });

  // proves §6.1 / D-073: a turn cut short, or arguments that are not an object, is a malformed turn, never a claim of done
  it("makes a truncated turn, unreadable arguments and a tool_use_failed refusal malformed", async () => {
    const { groq } = provider([
      chat({ content: "" }, "length"),
      chat({ content: null, tool_calls: [{ id: "fc_2", function: { name: "shell__run", arguments: "not json" } }] }, "tool_calls"),
      { status: 400, body: { error: { message: "Failed to call a function", type: "invalid_request_error", code: "tool_use_failed" } } },
    ]);
    expect(ProviderResponse.safeParse(await groq.complete(REQUEST)).success).toBe(false);
    expect(ProviderResponse.safeParse(await groq.complete(REQUEST)).success).toBe(false);
    expect(ProviderResponse.safeParse(await groq.complete(REQUEST)).success).toBe(false);
    expect(groq.stopped).toBeNull();
  });
});

describe("the context rendering (D-073)", () => {
  // proves D-073: every proposed call is answered before the next message; a call not acted on says so; a stray tool item is a user message
  it("pairs every call with a tool message", () => {
    const messages = toMessages([
      { role: "system", content: "s" },
      { role: "assistant", content: { turn_seq: 3, text: null, tool_calls: [{ id: "a", capability: "shell.run", arguments: {} }, { id: "b", capability: "shell.run", arguments: {} }] } },
      { role: "tool", content: { tool_call: "a", outcome: "parked", resumed: true } },
      { role: "user", content: { error: "x" } },
      { role: "tool", content: { tool_call: "zzz" } },
    ]);
    expect(messages.map((message) => [message.role, "tool_call_id" in message ? message.tool_call_id : null])).toEqual([
      ["system", null],
      ["assistant", null],
      ["tool", "a"],
      ["tool", "b"],
      ["user", null],
      ["user", null],
    ]);
    expect(messages[3]).toMatchObject({ content: '{"tool_call":"b","outcome":"not_acted_on"}' });
  });
});

describe("zero paid usage (D-072)", () => {
  const paid: [string, Answer][] = [
    ["HTTP 402", { status: 402, body: { error: { message: "payment required", type: "x" } } }],
    ["a billing error", { status: 400, body: { error: { message: "Organization has a billing issue", type: "invalid_request_error" } } }],
    ["a blocked_api_access spend limit", { status: 400, body: { error: { message: "limit", type: "x", code: "blocked_api_access" } } }],
    ["Developer-plan rate-limit headers", { body: chat({ content: "x" }).body, headers: { "x-ratelimit-limit-requests": "500000", "x-ratelimit-limit-tokens": "250000" } }],
  ];
  for (const [what, answer] of paid) {
    // proves D-072 "any billing or paid-tier response is a STOP": the run stops, and no further request is sent
    it(`stops on ${what}`, async () => {
      const { groq, sent } = provider([answer, chat({ content: "never" })]);
      await expect(groq.complete(REQUEST)).rejects.toMatchObject({ name: "ProviderStop", kind: "paid_tier" });
      expect(groq.stopped).toBeInstanceOf(ProviderStop);
      await expect(groq.complete(REQUEST)).rejects.toBe(groq.stopped);
      expect(sent).toHaveLength(1);
    });
  }

  // proves D-072: an account the provider refuses stops the run with the provider's answer
  it("stops when the provider refuses the key", async () => {
    const { groq } = provider([{ status: 401, body: { error: { message: "Invalid API Key", type: "invalid_request_error" } } }]);
    await expect(groq.complete(REQUEST)).rejects.toMatchObject({ kind: "refused", message: expect.stringContaining("Invalid API Key") });
  });
});

describe("rate limits and the token cap (D-072)", () => {
  // proves D-072 "on a rate limit, wait and resume ... never switch model": a short 429 is waited out, and every request names the one model
  it("waits out a short rate limit and resumes on the same model", async () => {
    const limited: Answer = { status: 429, body: { error: { message: "Rate limit reached on tokens per minute (TPM)", type: "tokens" } }, headers: { "retry-after": "7" } };
    const { groq, sent, sleeps } = provider([limited, limited, chat({ content: "done" })]);
    expect(ProviderResponse.parse(await groq.complete(REQUEST)).text).toBe("done");
    expect(sleeps).toEqual([7000, 7000]);
    expect(sent.map((item) => item.body["model"])).toEqual([GROQ_MODEL, GROQ_MODEL, GROQ_MODEL]);
  });

  // proves D-072 "if the daily cap is reached, save state and STOP for the day"
  it("stops for the day on a daily limit or a long wait", async () => {
    const daily: Answer = { status: 429, body: { error: { message: "Rate limit reached on tokens per day (TPD)", type: "tokens" } }, headers: { "retry-after": "30" } };
    await expect(provider([daily]).groq.complete(REQUEST)).rejects.toMatchObject({ kind: "daily_limit" });
    const long: Answer = { status: 429, body: { error: { message: "slow down", type: "requests" } }, headers: { "retry-after": "3600" } };
    await expect(provider([long]).groq.complete(REQUEST)).rejects.toMatchObject({ kind: "daily_limit" });
    const none: Answer = { status: 429, body: { error: { message: "slow down", type: "requests" } }, headers: { "x-ratelimit-remaining-requests": "0", "retry-after": "1" } };
    await expect(provider([none]).groq.complete(REQUEST)).rejects.toMatchObject({ kind: "daily_limit" });
  });

  // proves D-072 "a token cap below Groq's documented daily limit": a call that could pass the cap is never sent
  it("never sends a call that could pass the token cap, and counts every answer", async () => {
    const ledger = new MemoryTokenLedger(150_000);
    ledger.record(149_000, Date.parse("2026-10-30T19:00:00Z"), "earlier");
    const capped = provider([chat({ content: "never" })], { ledger });
    await expect(capped.groq.complete(REQUEST)).rejects.toMatchObject({ kind: "token_cap" });
    expect(capped.sent).toEqual([]);

    const fresh = provider([chat({ content: "x" })]);
    await fresh.groq.complete(REQUEST);
    expect(fresh.ledger.used(Date.parse("2026-10-30T20:00:00Z"))).toBe(150);
    // A day later the window has rolled past it.
    expect(fresh.ledger.used(Date.parse("2026-10-31T20:00:01Z"))).toBe(0);
  });

  // proves D-072: the ledger holds across processes in a file, and an unreadable ledger stops the run rather than guessing
  it("keeps the ledger in a file, and stops on a line it cannot read", () => {
    const dir = mkdtempSync(join(tmpdir(), "juno-ledger-"));
    try {
      const file = join(dir, "usage.jsonl");
      const ledger = new FileTokenLedger(file, 150_000);
      ledger.record(100, Date.parse("2026-10-30T10:00:00Z"), "a");
      ledger.record(50, Date.parse("2026-10-30T12:00:00Z"), "b");
      expect(new FileTokenLedger(file, 150_000).used(Date.parse("2026-10-31T11:00:00Z"))).toBe(50);
      // Slice 1.2: an earlier slice's ledger counts against the same cap; new lines go to this ledger only.
      const earlier = join(dir, "earlier.jsonl");
      new FileTokenLedger(earlier, 150_000).record(70, Date.parse("2026-10-31T10:30:00Z"), "earlier slice");
      const both = new FileTokenLedger(file, 150_000, [earlier]);
      expect(both.used(Date.parse("2026-10-31T11:00:00Z"))).toBe(120);
      both.record(5, Date.parse("2026-10-31T11:00:00Z"), "this slice");
      expect(new FileTokenLedger(earlier, 150_000).used(Date.parse("2026-10-31T11:00:00Z"))).toBe(70);
      writeFileSync(earlier, "{broken\n", { flag: "a" });
      expect(() => both.used(Date.now())).toThrow(ProviderStop);
      writeFileSync(file, "{broken\n", { flag: "a" });
      expect(() => ledger.used(Date.now())).toThrow(ProviderStop);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the key never leaves the runner (D-072)", () => {
  // proves D-072: the key is read once and removed from the environment, so no child process (docker, the workload) inherits it
  it("takes the key out of the environment", () => {
    const env: NodeJS.ProcessEnv = { GROQ_API_KEY: KEY, OTHER: "1" };
    expect(takeGroqKey(env)).toBe(KEY);
    expect(env).toEqual({ OTHER: "1" });
    expect(() => takeGroqKey({})).toThrow(/not set/);
  });

  // proves D-072: an answer or an error that echoes the key, or anything with its prefix, is redacted before it leaves the adapter
  it("redacts the key and its prefix from answers and errors", async () => {
    const echo = (sent: Sent): Answer => chat({ content: `key ${authorization(sent)} and ${PREFIX}other`, tool_calls: [{ id: `fc_${PREFIX}1`, function: { name: "shell__run", arguments: JSON.stringify({ program: { slot: "cat" }, argv: [authorization(sent)], cwd: { slot: "project" } }) } }] }, "tool_calls");
    const { groq } = provider([echo, (sent) => ({ status: 400, body: { error: { message: `bad ${authorization(sent)}`, type: "invalid_request_error" } } }), (sent) => ({ status: 401, body: `no ${authorization(sent)}` })]);
    expect(leaks(JSON.stringify(await groq.complete(REQUEST)))).toBe(false);
    const error = (await groq.complete(REQUEST).catch((caught: unknown) => caught)) as Error;
    expect(leaks(error.message)).toBe(false);
    const stop = (await groq.complete(REQUEST).catch((caught: unknown) => caught)) as Error;
    expect(stop).toBeInstanceOf(ProviderStop);
    expect(leaks(stop.message)).toBe(false);
  });

  describe("end to end through the runner", () => {
    let h: Harness;
    beforeEach(() => {
      h = harness();
    });
    afterEach(() => {
      h.cleanup();
    });

    // proves D-072 "neither the key nor its prefix may appear in any journal": a whole task, with a model that echoes the key, leaves no trace of it
    it("journals a whole Groq task with no trace of the key", async () => {
      const call = (sent: Sent): Answer =>
        chat({ content: `using ${authorization(sent)}`, tool_calls: [{ id: "fc_a", function: { name: "shell__run", arguments: JSON.stringify({ program: { slot: "cat" }, argv: ["notes.txt", authorization(sent)], cwd: { slot: "project" } }) } }] }, "tool_calls");
      const { groq, sent } = provider([call, (item) => chat({ content: `done ${authorization(item)}` })]);
      const { runner } = h.runner([], { providers: [groq] });
      const admitted = runner.admit(
        request({ criterion: OPERATOR_CRITERION, verification: "command_exit", model_policy: { permitted_providers: ["groq"], posture: "cloud", conversation_state: "any" } }),
      );
      expect(admitted.admitted ? [] : admitted.failures).toEqual([]);
      expect(await runner.run("task-1")).toEqual({ task_id: "task-1", state: "verified", reason: "verification_pass" });
      expect(sent).toHaveLength(2);
      // The second request carried the first result back as a tool message answering the call.
      expect((sent[1]?.body["messages"] as { role: string; tool_call_id?: string }[]).filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual(["fc_a"]);
      const files = readdirSync(h.dir, { recursive: true }).map((file) => join(h.dir, String(file))).filter((file) => statSync(file).isFile());
      expect(files.length).toBeGreaterThan(3);
      expect(files.filter((file) => leaks(readFileSync(file, "latin1")))).toEqual([]);
    });
  });
});

describe("Slice 1.2: what the model is shown, and what a literal still does (D-075, D-052)", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => {
    h.cleanup();
  });
  const groqTask = (): Record<string, unknown> =>
    request({ criterion: OPERATOR_CRITERION, verification: "command_exit", model_policy: { permitted_providers: ["groq"], posture: "cloud", conversation_state: "any" } });

  // proves D-075: the request the model receives shows no instruction-field value (no program path from the constants or
  // the criterion) and offers no slot fixed for the verifier; the operator's constants appear by name
  it("sends no instruction-field value and no verifier slot to the model", async () => {
    const { groq, sent } = provider([chat({ content: "done" })]);
    const { runner } = h.runner([], { providers: [groq] });
    expect(runner.admit(groqTask()).admitted).toBe(true);
    await runner.run("task-1");
    const wire = JSON.stringify(sent[0]?.body);
    expect(wire).not.toContain("/usr/bin/");
    expect(wire).not.toContain("criterion.");
    const first = (sent[0]?.body["messages"] as { role: string; content: string }[])[1];
    expect(JSON.parse(first?.content ?? "{}")).toMatchObject({
      constants: ["cat", "project"],
      criterion: { command: { arguments: { program: "(fixed by the operator for the verifier)", argv: ["done.txt"], cwd: "/work/project" } } },
    });
  });

  // proves D-075 on a later turn (first review of PR #19): after a rejected call, the next request the model receives
  // still carries no allowed program path, though the registry's rejection message lists them
  it("sends no instruction-field value on a later turn after a rejection", async () => {
    const wrong = chat({ content: null, tool_calls: [{ id: "fc_w", function: { name: "shell__run", arguments: JSON.stringify({ program: { slot: "project" }, argv: [], cwd: { slot: "project" } }) } }] }, "tool_calls");
    const { groq, sent } = provider([wrong, chat({ content: "done" })]);
    const { runner } = h.runner([], { providers: [groq] });
    expect(runner.admit(groqTask()).admitted).toBe(true);
    await runner.run("task-1");
    expect(sent).toHaveLength(2);
    const wire = JSON.stringify(sent[1]?.body);
    expect(wire).toContain("malformed_call");
    expect(wire).not.toContain("/usr/bin/");
  });

  // proves D-077 / D-072: when Groq refuses a turn (tool_use_failed), its refusal text, including what the model wrote, is
  // in the journal's turn entry, with the key and its prefix scrubbed; and no program constant is offered for argv
  it("journals the provider's refusal of a turn, scrubbed of the key", async () => {
    const refused = (item: Sent): Answer => ({
      status: 400,
      body: { error: { message: "Failed to call a function. Please adjust your prompt.", type: "invalid_request_error", code: "tool_use_failed", failed_generation: `{"name":"shell__run","arguments":{"program":"/bin/sh","note":"${authorization(item)}"}}` } },
    });
    const { groq, sent } = provider([refused, chat({ content: "done" })]);
    const { runner } = h.runner([], { providers: [groq] });
    expect(runner.admit(groqTask()).admitted).toBe(true);
    await runner.run("task-1");
    const tools = sent[0]?.body["tools"] as ReturnType<typeof toolSchema>[];
    expect(JSON.stringify((tools[0]?.function.parameters as { properties: Record<string, unknown> }).properties["argv"])).not.toContain('"cat"');
    const first = h.entries().filter((entry) => entry.kind === "turn").map(h.payload)[0];
    expect(first).toMatchObject({ response: null, unread: expect.stringContaining("tool_use_failed") });
    expect(String(first?.["unread"])).toContain("/bin/sh");
    const files = readdirSync(h.dir, { recursive: true }).map((file) => join(h.dir, String(file))).filter((file) => statSync(file).isFile());
    expect(files.filter((file) => leaks(readFileSync(file, "latin1")))).toEqual([]);
  });

  // proves D-052 / §2.2 / §8.3 (Slice 1.2 requirement): a literal the model sends in an instruction field, though the schema
  // no longer offers one, is still passed to the boundary, judged synthesized/untrusted, and parks integrity_floor, not overridable
  it("still parks a literal program exactly as before", async () => {
    const literal = chat({ content: null, tool_calls: [{ id: "fc_lit", function: { name: "shell__run", arguments: JSON.stringify({ program: "/usr/bin/cat", argv: ["notes.txt"], cwd: { slot: "project" } }) } }] }, "tool_calls");
    const { groq } = provider([literal]);
    const { runner } = h.runner([], { providers: [groq] });
    expect(runner.admit(groqTask()).admitted).toBe(true);
    expect(await runner.run("task-1")).toEqual({ task_id: "task-1", state: "parked", reason: "integrity_floor" });
    const call = h.entries().filter((entry) => entry.kind === "capability_call").at(-1);
    expect(call?.argument_provenance).toContainEqual({ argument: "program", class: "synthesized", integrity: "untrusted" });
    expect(h.entries().filter((entry) => entry.kind === "park").map(h.payload)).toEqual([expect.objectContaining({ reason: "integrity_floor", overridable: false })]);
    expect(h.entries().filter((entry) => entry.kind === "capability_result").map(h.payload).filter((result) => result["call_seq"] === call?.seq)).toEqual([]);
  });
});

describe("make smoke stays out of make verify and CI (D-002, D-072)", () => {
  // proves D-002 / D-072: `make verify` and the CI workflows never run the smoke run, and the unit and container configs never include it
  it("is not reachable from make verify, the vitest configs or any workflow", () => {
    const makefile = readFileSync(join(repoRoot, "Makefile"), "utf8");
    const verify = makefile.slice(makefile.indexOf("\nverify:"), makefile.indexOf("\ntypecheck:"));
    expect(verify).not.toMatch(/smoke/);
    expect(makefile).toMatch(/\nsmoke:/);
    for (const config of ["vitest.config.ts", "vitest.containers.config.ts"]) expect(readFileSync(join(repoRoot, config), "utf8")).not.toMatch(/smoke/);
    const workflows = join(repoRoot, ".github", "workflows");
    for (const file of readdirSync(workflows)) expect(readFileSync(join(workflows, file), "utf8")).not.toMatch(/smoke|GROQ/i);
  });

  // proves D-072: only the Groq adapter reads the key's variable; the Makefile names it only to remove it, and nothing else names it
  it("names GROQ_API_KEY in no other code file", async () => {
    const { stdout } = await promisify(execFile)("git", ["ls-files", "-co", "--exclude-standard"], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
    const code = stdout.split("\n").filter((file) => /\.(ts|js|mjs|cjs|json|ya?ml|sh)$/.test(file) || file === "Makefile");
    const naming = code.filter((file) => readFileSync(join(repoRoot, file), "utf8").includes("GROQ_API_KEY"));
    expect(naming.sort()).toEqual(["Makefile", "packages/runner/src/groq.ts", "packages/runner/test/groq.test.ts"]);
    // The Makefile names it only to remove it from the build steps' environment.
    const makeLines = readFileSync(join(repoRoot, "Makefile"), "utf8").split("\n").filter((line) => line.includes("GROQ_API_KEY"));
    expect(makeLines.length).toBeGreaterThan(0);
    expect(makeLines.every((line) => /^\tenv -u GROQ_API_KEY /.test(line))).toBe(true);
  });

  // proves D-072 "neither the key nor its prefix may appear in any diff": no file in the repository contains the prefix
  it("finds the key's prefix in no file of the repository", async () => {
    const { stdout } = await promisify(execFile)("git", ["ls-files", "-co", "--exclude-standard"], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
    const files = stdout.split("\n").filter((file) => file.length > 0);
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((file) => readFileSync(join(repoRoot, file), "latin1").includes(PREFIX))).toEqual([]);
  });
});
