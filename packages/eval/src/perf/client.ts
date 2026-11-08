import type { ChatMessage } from "../client.js";

export interface PerfEngineClock {
  now(): number;
}

export interface PerfToken {
  id: number;
  piece: string;
}

export interface PerfCompletionStreamInput {
  prompt: string;
  maxTokens: number;
}

export interface PerfChatStreamInput {
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  seed?: number;
}

/** `final` carries the last-seen `usage`/`timings` objects merged across
 *  SSE chunks; `ttftMs`/`promptTokens` stay null when the stream never
 *  produced them. */
export interface PerfStreamResult {
  ttftMs: number | null;
  completionTokens: number;
  promptTokens: number | null;
  final: Record<string, unknown>;
}

export interface PerfEngineClient {
  listModels(): Promise<unknown>;
  tokenize(content: string): Promise<PerfToken[]>;
  streamCompletion(input: PerfCompletionStreamInput): Promise<PerfStreamResult>;
  streamChat(input: PerfChatStreamInput): Promise<PerfStreamResult>;
}

export interface PerfEngineClientOptions {
  clock: PerfEngineClock;
  fetchImpl?: typeof fetch;
  tokenizePath?: string;
  model?: string;
}

interface HttpPerfEngineContext {
  readonly root: string;
  readonly clock: PerfEngineClock;
  readonly doFetch: typeof fetch;
  readonly tokenizePath: string;
  readonly model: string | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function jsonPostInit(body: Record<string, unknown>): RequestInit & { timeout?: boolean } {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // Bun's fetch arms every socket with an implicit ~5-minute idle
    // ceiling; `timeout: false` is the only lever that lifts it (same
    // workaround as completeChat in ../client.js).
    timeout: false,
  };
}

async function httpListModels(ctx: HttpPerfEngineContext): Promise<unknown> {
  const init = {
    method: "GET",
    timeout: false,
  } satisfies RequestInit & { timeout?: boolean };
  const resp = await ctx.doFetch(`${ctx.root}/v1/models`, init);
  if (!resp.ok) {
    throw new Error(`listModels HTTP ${String(resp.status)}: ${await resp.text()}`);
  }
  const data: unknown = await resp.json();
  return data;
}

function parseTokenizePayload(data: unknown): PerfToken[] {
  const tokens = asRecord(data)?.["tokens"];
  if (!Array.isArray(tokens)) {
    throw new Error("tokenize returned non-string pieces");
  }
  const list: readonly unknown[] = tokens as unknown[];
  const out: PerfToken[] = [];
  for (const item of list) {
    const record = asRecord(item);
    const id = record?.["id"];
    const piece = record?.["piece"];
    if (typeof id !== "number" || typeof piece !== "string") {
      throw new Error("tokenize returned non-string pieces");
    }
    out.push({ id, piece });
  }
  return out;
}

async function httpTokenize(ctx: HttpPerfEngineContext, content: string): Promise<PerfToken[]> {
  const resp = await ctx.doFetch(
    `${ctx.root}${ctx.tokenizePath}`,
    jsonPostInit({ content, add_special: false, with_pieces: true }),
  );
  if (!resp.ok) {
    throw new Error(`tokenize HTTP ${String(resp.status)} at ${ctx.tokenizePath}`);
  }
  const data: unknown = await resp.json();
  return parseTokenizePayload(data);
}

interface StreamAccumulator {
  ttftMs: number | null;
  deltaCount: number;
  lastUsage: Record<string, unknown> | null;
  lastTimings: Record<string, unknown> | null;
  pendingData: string[];
  sawDone: boolean;
}

function createAccumulator(): StreamAccumulator {
  return {
    ttftMs: null,
    deltaCount: 0,
    lastUsage: null,
    lastTimings: null,
    pendingData: [],
    sawDone: false,
  };
}

function firstDeltaText(chunk: Record<string, unknown>): string | null {
  const choices = chunk["choices"];
  if (!Array.isArray(choices)) return null;
  const first = asRecord((choices as unknown[])[0]);
  if (first === null) return null;
  const text = first["text"];
  if (typeof text === "string" && text.length > 0) return text;
  const delta = asRecord(first["delta"]);
  if (delta === null) return null;
  for (const key of ["content", "reasoning_content"] as const) {
    const value = delta[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function handleSsePayload(
  acc: StreamAccumulator,
  payload: string,
  clock: PerfEngineClock,
  start: number,
): void {
  if (payload === "[DONE]") {
    acc.sawDone = true;
    return;
  }
  const chunk = parseJsonRecord(payload);
  if (chunk === null) return;
  const usage = asRecord(chunk["usage"]);
  if (usage !== null) acc.lastUsage = usage;
  const timings = asRecord(chunk["timings"]);
  if (timings !== null) acc.lastTimings = timings;
  if (firstDeltaText(chunk) !== null) {
    acc.deltaCount += 1;
    acc.ttftMs ??= clock.now() - start;
  }
}

function dispatchSseEvent(acc: StreamAccumulator, clock: PerfEngineClock, start: number): void {
  if (acc.pendingData.length === 0) return;
  const payload = acc.pendingData.join("\n").trim();
  acc.pendingData = [];
  handleSsePayload(acc, payload, clock, start);
}

function handleSseLine(
  acc: StreamAccumulator,
  line: string,
  clock: PerfEngineClock,
  start: number,
): void {
  if (line === "") {
    dispatchSseEvent(acc, clock, start);
    return;
  }
  if (line.startsWith("data:")) {
    acc.pendingData.push(line.slice(5).trimStart());
  }
}

async function readEventStream(
  resp: Response,
  clock: PerfEngineClock,
  start: number,
): Promise<PerfStreamResult> {
  const body = resp.body;
  if (body === null) {
    return { ttftMs: null, completionTokens: 0, promptTokens: null, final: {} };
  }
  const acc = createAccumulator();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const drainLines = (): void => {
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/u, "");
      buffer = buffer.slice(newline + 1);
      handleSseLine(acc, line, clock, start);
      newline = buffer.indexOf("\n");
    }
  };

  while (!acc.sawDone) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    drainLines();
  }
  buffer += decoder.decode();
  const tail = buffer.replace(/\r$/u, "");
  if (tail.length > 0) handleSseLine(acc, tail, clock, start);
  dispatchSseEvent(acc, clock, start);

  const final: Record<string, unknown> = {};
  if (acc.lastUsage !== null) final["usage"] = acc.lastUsage;
  if (acc.lastTimings !== null) final["timings"] = acc.lastTimings;
  const usage = asRecord(final["usage"]);
  const timings = asRecord(final["timings"]);
  const promptTokens =
    finiteNumber(usage?.["prompt_tokens"]) ?? finiteNumber(timings?.["prompt_n"]);
  const completionTokens = finiteNumber(usage?.["completion_tokens"]) ?? acc.deltaCount;
  return { ttftMs: acc.ttftMs, completionTokens, promptTokens, final };
}

async function httpStream(
  ctx: HttpPerfEngineContext,
  path: string,
  body: Record<string, unknown>,
): Promise<PerfStreamResult> {
  const start = ctx.clock.now();
  const resp = await ctx.doFetch(`${ctx.root}${path}`, jsonPostInit(body));
  if (!resp.ok) {
    throw new Error(`${path} HTTP ${String(resp.status)}: ${await resp.text()}`);
  }
  return await readEventStream(resp, ctx.clock, start);
}

async function httpStreamCompletion(
  ctx: HttpPerfEngineContext,
  input: PerfCompletionStreamInput,
): Promise<PerfStreamResult> {
  return await httpStream(ctx, "/v1/completions", {
    prompt: input.prompt,
    max_tokens: input.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    cache_prompt: false,
    temperature: 0,
    ...(ctx.model !== undefined ? { model: ctx.model } : {}),
  });
}

async function httpStreamChat(
  ctx: HttpPerfEngineContext,
  input: PerfChatStreamInput,
): Promise<PerfStreamResult> {
  return await httpStream(ctx, "/v1/chat/completions", {
    messages: input.messages,
    max_tokens: input.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    ...(ctx.model !== undefined ? { model: ctx.model } : {}),
  });
}

export function createHttpPerfEngineClient(
  baseUrl: string,
  options: PerfEngineClientOptions,
): PerfEngineClient {
  const ctx: HttpPerfEngineContext = {
    root: baseUrl.replace(/\/+$/u, ""),
    clock: options.clock,
    doFetch: options.fetchImpl ?? fetch,
    tokenizePath: options.tokenizePath ?? "/tokenize",
    model: options.model,
  };
  return {
    listModels: () => httpListModels(ctx),
    tokenize: (content) => httpTokenize(ctx, content),
    streamCompletion: (input) => httpStreamCompletion(ctx, input),
    streamChat: (input) => httpStreamChat(ctx, input),
  };
}
