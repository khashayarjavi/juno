import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { ProviderProfile } from "./profile.js";
import type { ContextItem, Provider, ProviderRequest, ToolDefinition } from "./provider.js";

/**
 * The one real provider adapter (Slice 1.1 Part 3; DECISIONS.md D-072, D-073):
 * Groq's OpenAI-compatible chat completions, model `openai/gpt-oss-120b` only,
 * on the free tier. It runs only under `make smoke`, from the cloud session;
 * never in `make verify` or CI (D-002).
 *
 * What it guarantees:
 *   - **One host.** Every request goes to `https://api.groq.com` and nowhere
 *     else, redirects refused (`egress`). No other runner module opens a
 *     network connection (a unit test reads the sources).
 *   - **One model.** The profile must name `openai/gpt-oss-120b`; the adapter
 *     refuses to start otherwise and never sends another model id.
 *   - **The key stays put.** It is held in a private field, written only into
 *     the `Authorization` header, and every string the adapter returns or
 *     throws is redacted of the key and of anything with its prefix.
 *   - **Zero paid usage.** Any sign of a paid tier (a 402, a billing error, or
 *     rate-limit headers other than the free plan's) stops the run (`stop`).
 *   - **A token cap.** A ledger counts every token across runs in a rolling
 *     24 hours; a call that could pass the cap is never sent.
 *   - **Rate limits.** A short 429 is waited out and retried; a daily limit
 *     stops the run for the day.
 *
 * A thrown error parks the task `routing_unavailable` (the runner's rule for a
 * provider failure). A STOP is also kept on `stopped`, so `make smoke` ends the
 * whole run rather than starting the next task.
 */

export const GROQ_ORIGIN = "https://api.groq.com";
export const GROQ_MODEL = "openai/gpt-oss-120b";
/** The free plan's limits for the model, as the rate-limit headers state them (D-072). */
export const FREE_PLAN_HEADERS = { requests: "1000", tokens: "8000" } as const;
/** Groq's documented free-plan daily token limit for the model (D-072). */
export const GROQ_FREE_DAILY_TOKENS = 200_000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** The key's prefix, assembled so the literal is never written in the repository (D-072). */
const KEY_PREFIX = ["g", "s", "k", "_"].join("");
const PREFIXED = new RegExp(`${KEY_PREFIX}[A-Za-z0-9_-]*`, "g");
/** Words of a billing or paid-tier answer. An advertisement to upgrade is not one; a refusal that needs payment is. */
const BILLING = /billing|payment|credit|balance|invoice|spend|blocked_api_access|paid|insufficient.funds/i;
const DAILY = /per day|\bRPD\b|\bTPD\b|daily/i;

export type StopKind = "paid_tier" | "daily_limit" | "token_cap" | "refused";

/** Ends the whole smoke run: the operator must act, or the next session resumes (D-072). */
export class ProviderStop extends Error {
  override readonly name = "ProviderStop";
  constructor(
    readonly kind: StopKind,
    message: string,
  ) {
    super(`STOP (${kind}): ${message}`);
  }
}

export class EgressRefused extends Error {
  override readonly name = "EgressRefused";
}

/** Reads the key from the runner's environment. The smoke entry calls it once and removes the variable, so no child process inherits it. */
export function takeGroqKey(env: NodeJS.ProcessEnv): string {
  const key = env["GROQ_API_KEY"];
  delete env["GROQ_API_KEY"];
  if (key === undefined || key.length < 20 || /\s/.test(key)) throw new Error("GROQ_API_KEY is not set to a usable key");
  return key;
}

/** Counts tokens spent in a rolling window, so the cap holds across runs and sessions. */
export interface TokenLedger {
  readonly cap: number;
  used(now: number): number;
  record(tokens: number, now: number, note: string): void;
}

export class MemoryTokenLedger implements TokenLedger {
  readonly entries: { at: number; tokens: number; note: string }[] = [];
  constructor(readonly cap: number) {}
  used(now: number): number {
    return this.entries.filter((entry) => now - entry.at < DAY_MS).reduce((sum, entry) => sum + entry.tokens, 0);
  }
  record(tokens: number, now: number, note: string): void {
    this.entries.push({ at: now, tokens, note });
  }
}

const LedgerLine = z.strictObject({ at: z.iso.datetime(), tokens: z.int().nonnegative(), note: z.string() });

/** One JSON line per call. A line that cannot be read stops the run: an unreadable ledger cannot prove the cap. */
export class FileTokenLedger implements TokenLedger {
  constructor(
    readonly file: string,
    readonly cap: number,
  ) {}
  #lines(): z.infer<typeof LedgerLine>[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line, index) => {
        const parsed = LedgerLine.safeParse(safeJson(line));
        if (!parsed.success) throw new ProviderStop("token_cap", `token ledger line ${String(index + 1)} cannot be read`);
        return parsed.data;
      });
  }
  used(now: number): number {
    return this.#lines()
      .filter((line) => now - Date.parse(line.at) < DAY_MS)
      .reduce((sum, line) => sum + line.tokens, 0);
  }
  record(tokens: number, now: number, note: string): void {
    appendFileSync(this.file, `${JSON.stringify({ at: new Date(now).toISOString(), tokens, note })}\n`);
  }
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type GroqOptions = {
  readonly profile: ProviderProfile;
  readonly key: string;
  readonly ledger: TokenLedger;
  readonly fetch?: Fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** The longest single wait on a rate limit; a longer one is a daily limit (default 120 s). */
  readonly maxWaitMs?: number;
  /** Attempts per turn, rate-limit waits and server errors included (default 8). */
  readonly maxAttempts?: number;
};

/** The only way out of the runner: one origin, HTTPS, no redirects (D-073). */
export async function egress(fetcher: Fetch, url: string, init: RequestInit): Promise<Response> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EgressRefused("not a URL");
  }
  if (parsed.origin !== GROQ_ORIGIN || parsed.username !== "" || parsed.password !== "") {
    throw new EgressRefused(`egress to ${parsed.origin} refused: the runner may reach ${GROQ_ORIGIN} only`);
  }
  return fetcher(parsed.href, { ...init, redirect: "error" });
}

/** A capability id as a function name the API accepts; `.` becomes `__`. Collisions fail closed. */
export function wireName(capability: string): string {
  const name = capability.replaceAll(".", "__");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error(`capability ${capability} has no function name the provider accepts`);
  return name;
}

type JsonSchema = Record<string, unknown>;
const SLOT: JsonSchema = { type: "object", properties: { slot: { type: "string" } }, required: ["slot"], additionalProperties: false };
const REF: JsonSchema = { type: "object", properties: { ref: { type: "string" } }, required: ["ref"], additionalProperties: false };

const FieldType = z.looseObject({
  kind: z.string(),
  values: z.unknown().optional(),
  items: z.unknown().optional(),
});
const Field = z.looseObject({ type: FieldType, role: z.string() });

function scalarSchema(type: z.infer<typeof FieldType>): JsonSchema {
  switch (type.kind) {
    case "enum":
      return { type: "string", enum: z.array(z.string()).parse(type.values) };
    case "integer":
      return { type: "integer" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    default:
      return { type: "string" };
  }
}

/** Every value may also be a constant slot or a bound reference (D-060); the schema says so, and nothing more. */
function valueSchema(type: z.infer<typeof FieldType>): JsonSchema {
  if (type.kind === "list") {
    const items = FieldType.parse(type.items);
    return { type: "array", items: { anyOf: [scalarSchema(items), SLOT, REF] } };
  }
  if (type.kind === "map") {
    const values = FieldType.parse(type.values);
    return { type: "object", additionalProperties: { anyOf: [scalarSchema(values), SLOT, REF] } };
  }
  return { anyOf: [scalarSchema(type), SLOT, REF] };
}

/**
 * What each role means for the value, stated to the model from §2.2 and D-060;
 * the boundary enforces it either way. An instruction field offers the slot and
 * the reference first, and a literal only as plain text: a literal there is
 * untrusted and parks (§2.2), so the schema does not present an enum value as a
 * literal that would pass. The model can still write one; the boundary, not the
 * schema, stops it.
 */
const SLOT_NOTE = 'one of the task\'s "constants", by name: {"slot": "<name>"}';
const REF_NOTE = 'a value bound from the trajectory: {"ref": "${<seq>.<path>}"}';

function instructionSchema(type: z.infer<typeof FieldType>): JsonSchema {
  const literal = scalarSchema(type);
  const allowed = literal["enum"] === undefined ? "" : ` It must resolve to one of ${JSON.stringify(literal["enum"])}.`;
  return {
    anyOf: [SLOT, REF, { type: literal["type"] }],
    description: `instruction field: give ${SLOT_NOTE}, or ${REF_NOTE} to operator data. A literal you write here is untrusted, and the task parks.${allowed}`,
  };
}

const DATA_FIELD = `data field: a literal you write, ${SLOT_NOTE}, or ${REF_NOTE}.`;

export function toolSchema(tool: ToolDefinition): { type: "function"; function: { name: string; description: string; parameters: JsonSchema } } {
  const fields = z.record(z.string(), Field).parse(tool.interface);
  const properties: Record<string, JsonSchema> = {};
  for (const [name, field] of Object.entries(fields)) {
    properties[name] = field.role === "instruction" && field.type.kind !== "list" && field.type.kind !== "map" ? instructionSchema(field.type) : { ...valueSchema(field.type), description: DATA_FIELD };
  }
  return {
    type: "function",
    function: {
      name: wireName(tool.capability),
      description: `JUNO capability ${tool.capability}. Each value is a literal, {"slot": "<name>"} or {"ref": "<reference>"}.`,
      parameters: { type: "object", properties, required: Object.keys(fields), additionalProperties: false },
    },
  };
}

type WireMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

const AssistantContent = z.object({
  text: z.string().nullable(),
  tool_calls: z.array(z.object({ id: z.string(), capability: z.string(), arguments: z.unknown() })),
});
const ToolContent = z.object({ tool_call: z.string() });

const asText = (content: unknown): string => (typeof content === "string" ? content : JSON.stringify(content));

/**
 * Renders the runner's context as chat messages, deterministically (D-073).
 * Every proposed call is answered by a `tool` message before the next other
 * message: one the runner did not act on (a park mid-turn) is answered with
 * `{"outcome": "not_acted_on"}`, which is what happened. A tool item that
 * answers no open call is sent as a user message.
 */
export function toMessages(context: readonly ContextItem[]): WireMessage[] {
  const messages: WireMessage[] = [];
  let open: string[] = [];
  const closeOpen = (): void => {
    for (const id of open) messages.push({ role: "tool", tool_call_id: id, content: JSON.stringify({ tool_call: id, outcome: "not_acted_on" }) });
    open = [];
  };
  for (const item of context) {
    if (item.role === "tool") {
      const tool = ToolContent.safeParse(item.content);
      if (tool.success && open.includes(tool.data.tool_call)) {
        open = open.filter((id) => id !== tool.data.tool_call);
        messages.push({ role: "tool", tool_call_id: tool.data.tool_call, content: asText(item.content) });
        continue;
      }
      closeOpen();
      messages.push({ role: "user", content: asText(item.content) });
      continue;
    }
    closeOpen();
    if (item.role === "assistant") {
      const assistant = AssistantContent.safeParse(item.content);
      if (!assistant.success) {
        messages.push({ role: "assistant", content: asText(item.content) });
        continue;
      }
      const calls = assistant.data.tool_calls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: renderName(call.capability), arguments: JSON.stringify(call.arguments) },
      }));
      messages.push(calls.length > 0 ? { role: "assistant", content: assistant.data.text ?? "", tool_calls: calls } : { role: "assistant", content: assistant.data.text ?? "" });
      open = calls.map((call) => call.id);
      continue;
    }
    messages.push({ role: item.role, content: asText(item.content) });
  }
  closeOpen();
  return messages;
}

const WireResponse = z.object({
  model: z.string(),
  system_fingerprint: z.string().nullish(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable(),
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z
            .array(z.object({ id: z.string(), type: z.string().optional(), function: z.object({ name: z.string(), arguments: z.string() }) }))
            .nullish(),
        }),
      }),
    )
    .min(1),
  usage: z.object({
    prompt_tokens: z.int().nonnegative(),
    completion_tokens: z.int().nonnegative(),
    total_tokens: z.int().nonnegative(),
    prompt_tokens_details: z.object({ cached_tokens: z.int().nonnegative() }).nullish(),
  }),
});

const WireError = z.object({ error: z.object({ message: z.string().optional(), type: z.string().optional(), code: z.string().nullish() }) });

export class GroqProvider implements Provider {
  readonly profile: ProviderProfile;
  /** The STOP that ended this provider's work, if any; `make smoke` reads it after every run. */
  stopped: ProviderStop | null = null;
  readonly #key: string;
  readonly #ledger: TokenLedger;
  readonly #fetch: Fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #maxWaitMs: number;
  readonly #maxAttempts: number;
  readonly #wire: NonNullable<ProviderProfile["wire"]>;

  constructor(options: GroqOptions) {
    const { profile } = options;
    if (profile.model !== GROQ_MODEL) throw new Error(`the Groq adapter serves ${GROQ_MODEL} only, not ${profile.model} (D-072)`);
    if (profile.wire === undefined) throw new Error("the Groq profile has no wire settings");
    if (new URL(profile.wire.endpoint).origin !== GROQ_ORIGIN) throw new Error(`the Groq profile's endpoint must be on ${GROQ_ORIGIN}`);
    if (options.ledger.cap >= GROQ_FREE_DAILY_TOKENS) throw new Error(`the token cap must be below Groq's free daily limit of ${String(GROQ_FREE_DAILY_TOKENS)} tokens`);
    this.profile = profile;
    this.#wire = profile.wire;
    this.#key = options.key;
    this.#ledger = options.ledger;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? (() => Date.now());
    this.#maxWaitMs = options.maxWaitMs ?? 120_000;
    this.#maxAttempts = options.maxAttempts ?? 8;
  }

  /** Removes the key, and anything carrying its prefix, from every string. */
  redact(text: string): string {
    return text.split(this.#key).join("[redacted]").replace(PREFIXED, "[redacted]");
  }

  #redactDeep(value: unknown): unknown {
    if (typeof value === "string") return this.redact(value);
    if (Array.isArray(value)) return value.map((item: unknown) => this.#redactDeep(item));
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, member]) => [this.redact(key), this.#redactDeep(member)]));
    }
    return value;
  }

  #stop(kind: StopKind, message: string): never {
    const stop = new ProviderStop(kind, this.redact(message));
    this.stopped = stop;
    throw stop;
  }

  /** The request body: the profile's model and settings, the rendered context and the tools. */
  body(request: ProviderRequest): Record<string, unknown> {
    const tools = request.tools.map(toolSchema);
    const names = new Set(tools.map((tool) => tool.function.name));
    if (names.size !== tools.length) throw new Error("two capabilities share one function name");
    const { sampling } = this.#wire;
    return {
      model: GROQ_MODEL,
      messages: toMessages(request.context),
      ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
      temperature: sampling.temperature,
      reasoning_effort: sampling.reasoning_effort,
      max_completion_tokens: sampling.max_completion_tokens,
      seed: sampling.seed,
      n: 1,
      stream: false,
    };
  }

  async complete(request: ProviderRequest): Promise<unknown> {
    if (this.stopped !== null) throw this.stopped;
    if (request.model !== GROQ_MODEL) this.#stop("refused", `the runner asked for ${request.model}; this adapter serves ${GROQ_MODEL} only`);
    const body = JSON.stringify(this.body(request));
    // Conservative: about three characters per token for the prompt, plus every output token allowed.
    const estimate = Math.ceil(body.length / 3) + this.#wire.sampling.max_completion_tokens;
    const used = this.#ledger.used(this.#now());
    if (used + estimate > this.#ledger.cap) {
      this.#stop("token_cap", `${String(used)} tokens used in the last 24 hours; this call could use ${String(estimate)} more, past the cap of ${String(this.#ledger.cap)}`);
    }
    const tools = new Map(request.tools.map((tool) => [wireName(tool.capability), tool.capability]));

    for (let attempt = 1; ; attempt += 1) {
      let response: Response | null = null;
      let unreachable = "";
      try {
        response = await egress(this.#fetch, this.#wire.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.#key}` },
          body,
        });
      } catch (error: unknown) {
        if (error instanceof EgressRefused) throw error;
        // Only redacted text leaves this block: the original error object is never passed on.
        unreachable = this.redact(error instanceof Error ? error.message : String(error));
      }
      if (response === null) {
        if (attempt >= this.#maxAttempts) throw new Error(`the provider could not be reached: ${unreachable}`);
        await this.#sleep(Math.min(this.#maxWaitMs, 1000 * 2 ** attempt));
        continue;
      }
      const text = this.redact(await response.text());
      this.#checkPlan(response, text);

      if (response.status === 200) {
        const wire = WireResponse.safeParse(safeJson(text));
        if (!wire.success) throw new Error(`the provider's answer has an unexpected shape: ${wire.error.message}`);
        this.#ledger.record(wire.data.usage.total_tokens, this.#now(), `turn of ${request.model}`);
        return this.#redactDeep(this.#toResponse(wire.data, tools));
      }
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after") ?? "NaN");
        const waitMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : this.#maxWaitMs + 1;
        if (DAILY.test(text) || response.headers.get("x-ratelimit-remaining-requests") === "0" || waitMs > this.#maxWaitMs) {
          this.#stop("daily_limit", `HTTP 429, retry-after ${String(response.headers.get("retry-after"))}: ${text}`);
        }
        if (attempt >= this.#maxAttempts) throw new Error(`rate limited ${String(attempt)} times in a row: ${text}`);
        await this.#sleep(waitMs);
        continue;
      }
      if (response.status === 401 || response.status === 403) this.#stop("refused", `HTTP ${String(response.status)}: ${text}`);
      // Any other refusal may have read the prompt; count it, so the cap stays conservative.
      if (response.status < 500) this.#ledger.record(Math.ceil(body.length / 3), this.#now(), `HTTP ${String(response.status)}`);
      const error = WireError.safeParse(safeJson(text));
      if (response.status === 400 && error.success && error.data.error.code === "tool_use_failed") {
        // The model wrote a call the provider could not parse. That is a turn the runner cannot read: it is
        // recorded as malformed, and the model is told so (D-073). The extra fields make it fail the runner's parse.
        return { provider_error: "tool_use_failed", detail: error.data.error.message ?? null };
      }
      if (response.status >= 500 || response.status === 498) {
        if (attempt >= this.#maxAttempts) throw new Error(`HTTP ${String(response.status)} ${String(attempt)} times in a row: ${text}`);
        await this.#sleep(Math.min(this.#maxWaitMs, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`HTTP ${String(response.status)}: ${text}`);
    }
  }

  /** Zero paid usage (D-072): a 402, a billing error, or limits other than the free plan's stop the run. */
  #checkPlan(response: Response, text: string): void {
    if (response.status === 402) this.#stop("paid_tier", `HTTP 402: ${text}`);
    if (response.status !== 200) {
      const error = WireError.safeParse(safeJson(text));
      const words = error.success ? [error.data.error.type, error.data.error.code, error.data.error.message].filter((word) => typeof word === "string").join(" ") : text;
      if (response.status !== 429 && BILLING.test(words)) this.#stop("paid_tier", `HTTP ${String(response.status)}: ${text}`);
    }
    const requests = response.headers.get("x-ratelimit-limit-requests");
    const tokens = response.headers.get("x-ratelimit-limit-tokens");
    if (response.status === 200 && (requests !== FREE_PLAN_HEADERS.requests || tokens !== FREE_PLAN_HEADERS.tokens)) {
      this.#stop("paid_tier", `rate-limit headers are not the free plan's: requests ${String(requests)}, tokens ${String(tokens)}`);
    }
  }

  #toResponse(wire: z.infer<typeof WireResponse>, tools: ReadonlyMap<string, string>): Record<string, unknown> {
    const choice = wire.choices[0];
    const cached = wire.usage.prompt_tokens_details?.cached_tokens ?? 0;
    const response: Record<string, unknown> = {
      model: wire.model,
      model_version: wire.system_fingerprint ?? this.profile.model_version,
      text: choice?.message.content ?? null,
      tool_calls: (choice?.message.tool_calls ?? []).map((call) => ({
        id: call.id,
        // A name the model made up is passed as it is; the boundary rejects an unknown capability.
        capability: tools.get(call.function.name) ?? call.function.name,
        arguments: parseArguments(call.function.arguments),
      })),
      usage: { tokens_in: Math.max(0, wire.usage.prompt_tokens - cached), tokens_out: wire.usage.completion_tokens, tokens_cached: Math.min(cached, wire.usage.prompt_tokens) },
    };
    // A turn cut short is not a claim of done: the extra field makes it a malformed turn, recorded and retried (D-073).
    if (choice?.finish_reason !== "stop" && choice?.finish_reason !== "tool_calls") response["finish_reason"] = choice?.finish_reason ?? null;
    return response;
  }
}

/** The name a call is rendered under: the capability's function name, or the name made safe if it has none. */
function renderName(capability: string): string {
  try {
    return wireName(capability);
  } catch {
    return capability.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "_";
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Arguments the model wrote that are not a JSON object stay a string, so the runner records a malformed turn. */
function parseArguments(text: string): unknown {
  const value = safeJson(text);
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : text;
}
