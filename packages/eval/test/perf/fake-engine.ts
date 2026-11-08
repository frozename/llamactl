// Deterministic fake inference engine for the perf-suite tests. A
// random-port OpenAI-ish server whose SSE streams advance an injected
// manual clock only as the client pulls chunks, so timings are exact.

export interface ManualClock {
  now(): number;
  advance(ms: number): void;
}

export function createManualClock(start = 0): ManualClock {
  let current = start;
  return {
    now: (): number => current,
    advance: (ms: number): void => {
      current += ms;
    },
  };
}

export type FakeEngineAcceptance = "llamacpp" | "gufo" | "kapitsa" | "none";
export type FakeEngineTokenizeMode = "ok" | "missing" | "inexact";

export interface FakeEngineOptions {
  clock: ManualClock;
  ctx: number;
  acceptance: FakeEngineAcceptance;
  ttftMs: number;
  tokenMs: number;
  promptTps: number;
  decodeTps: number;
  tokenize?: FakeEngineTokenizeMode;
  rejectPromptAbove?: number;
  promptTokenOverride?: number;
  promptTokenOffset?: number;
  noCtxFields?: boolean;
}

export interface FakeEngineRequest {
  path: string;
  body: unknown;
}

export interface FakeEngine {
  url: string;
  port: number;
  requests: FakeEngineRequest[];
  stop(): void;
}

interface FakeToken {
  id: number;
  piece: string;
}

interface StreamPlan {
  maxTokens: number;
  chat: boolean;
  finalPayload: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function numberField(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

function chatWordCount(body: unknown): number {
  const messages = asRecord(body)?.["messages"];
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const message of messages as unknown[]) {
    total += countWords(stringField(asRecord(message), "content"));
  }
  return total;
}

async function readBody(req: Request): Promise<unknown> {
  try {
    return (await req.json()) as unknown;
  } catch {
    return null;
  }
}

function handleModels(opts: FakeEngineOptions): Response {
  if (opts.noCtxFields) {
    return Response.json({
      object: "list",
      data: [{ id: "fake-model", object: "model" }],
    });
  }
  return Response.json({
    object: "list",
    data: [{ id: "fake-model", object: "model", meta: { n_ctx_train: opts.ctx } }],
  });
}

function tokenizeWords(content: string, inexact: boolean): FakeToken[] {
  const words = content.split(/\s+/).filter((word) => word.length > 0);
  const tokens = words.map((word, index) => ({ id: index, piece: `${word} ` }));
  if (inexact) tokens.push({ id: 0, piece: "" });
  return tokens;
}

function handleTokenize(body: unknown, opts: FakeEngineOptions): Response {
  if (opts.tokenize === "missing") {
    return new Response("not found", { status: 404 });
  }
  const record = asRecord(body);
  const tokens = tokenizeWords(stringField(record, "content"), opts.tokenize === "inexact");
  if (record !== null && Boolean(record["with_pieces"])) {
    return Response.json({ tokens });
  }
  return Response.json({ tokens: tokens.map((token) => token.id) });
}

function llamacppTimings(
  opts: FakeEngineOptions,
  words: number,
  maxTokens: number,
  draft: boolean,
): Record<string, unknown> {
  return {
    prompt_n: words,
    prompt_per_second: opts.promptTps,
    predicted_n: maxTokens,
    predicted_per_second: opts.decodeTps,
    ...(draft ? { draft_n: 100, draft_n_accepted: 75 } : {}),
  };
}

function buildFinalPayload(
  opts: FakeEngineOptions,
  words: number,
  maxTokens: number,
): Record<string, unknown> {
  const promptTokens = opts.promptTokenOverride ?? (opts.promptTokenOffset ?? 0) + words;
  const usage: Record<string, unknown> = {
    prompt_tokens: promptTokens,
    completion_tokens: maxTokens,
  };
  switch (opts.acceptance) {
    case "gufo":
      return {
        choices: [],
        usage: {
          ...usage,
          prompt_tokens_per_second: opts.promptTps,
          completion_tokens_per_second: opts.decodeTps,
          draft_tokens: 4405,
          draft_tokens_accepted: 3467,
          gufo: {
            ttft_ms: opts.ttftMs,
            prefill_ms: Math.round((words / opts.promptTps) * 1000),
            decode_ms: maxTokens * opts.tokenMs,
          },
        },
      };
    case "kapitsa":
      return {
        choices: [],
        usage: { ...usage, kapitsa: { draft_tokens: 200, draft_tokens_accepted: 120 } },
        timings: llamacppTimings(opts, words, maxTokens, false),
      };
    case "none":
      return { choices: [], usage, timings: llamacppTimings(opts, words, maxTokens, false) };
    case "llamacpp":
      return { choices: [], usage, timings: llamacppTimings(opts, words, maxTokens, true) };
  }
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function deltaPayload(chat: boolean): Record<string, unknown> {
  return chat ? { choices: [{ delta: { content: "x" } }] } : { choices: [{ text: "x" }] };
}

function streamResponse(opts: FakeEngineOptions, plan: StreamPlan): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller): void {
      if (index === 0) {
        opts.clock.advance(opts.ttftMs);
        controller.enqueue(encoder.encode(sseData(deltaPayload(plan.chat))));
      } else if (index < plan.maxTokens) {
        opts.clock.advance(opts.tokenMs);
        controller.enqueue(encoder.encode(sseData(deltaPayload(plan.chat))));
      } else if (index === plan.maxTokens) {
        controller.enqueue(encoder.encode(sseData(plan.finalPayload)));
      } else if (index === plan.maxTokens + 1) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } else {
        controller.close();
      }
      index += 1;
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

function handleStreamed(
  opts: FakeEngineOptions,
  body: unknown,
  words: number,
  chat: boolean,
): Response {
  const record = asRecord(body);
  const rejected = opts.rejectPromptAbove !== undefined && words > opts.rejectPromptAbove;
  if (rejected) {
    return Response.json({ error: { message: "prompt exceeds context" } }, { status: 400 });
  }
  const maxTokens = numberField(record, "max_tokens") ?? 16;
  const plan: StreamPlan = {
    maxTokens,
    chat,
    finalPayload: buildFinalPayload(opts, words, maxTokens),
  };
  return streamResponse(opts, plan);
}

async function routeRequest(
  req: Request,
  opts: FakeEngineOptions,
  requests: FakeEngineRequest[],
): Promise<Response> {
  const path = new URL(req.url).pathname;
  const body = await readBody(req);
  requests.push({ path, body });
  if (req.method === "GET" && path === "/v1/models") return handleModels(opts);
  if (req.method === "POST" && path === "/tokenize") return handleTokenize(body, opts);
  if (req.method === "POST" && path === "/v1/completions") {
    return handleStreamed(opts, body, countWords(stringField(asRecord(body), "prompt")), false);
  }
  if (req.method === "POST" && path === "/v1/chat/completions") {
    return handleStreamed(opts, body, chatWordCount(body), true);
  }
  return new Response("not found", { status: 404 });
}

export function startFakeEngine(opts: FakeEngineOptions): FakeEngine {
  const requests: FakeEngineRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req: Request): Promise<Response> => routeRequest(req, opts, requests),
  });
  const port = server.port ?? 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    port,
    requests,
    stop: (): void => {
      void server.stop(true);
    },
  };
}
