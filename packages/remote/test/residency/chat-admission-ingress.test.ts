/**
 * #281 DF-08 — first ingress slice: request admission for
 * POST /v1/chat/completions. Every POST admitted at this agent —
 * peer-routed and via/RAG included — holds a slot for the request's
 * lifetime; physical per-node accounting comes later. /v1/messages,
 * /v1/responses and Worker RPC are later slices.
 *
 * Integration cases (2) and (3) are end-to-end regression pins. On
 * Bun 1.4.3 the agent's req.signal fires on socket close (see the
 * openai-proxy.abort.test.ts header), so the req.signal backstop also
 * covers them; their release paths are pinned without a socket by
 * unit cases a6, a7 and a9.
 *
 * The wiring lands as src/server/chat-admission.ts plus a
 * chatCompletionsAdmission agent option; unit cases reach the module
 * through a guarded dynamic import so every RED case fails by
 * assertion at base, never by a missing module or a type error.
 */
import type { RequestQueueLimits } from "@llamactl/core/residency/queue-policy";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRequestAdmission,
  RequestAdmissionError,
  type AdmissionRejectCode,
  type AdmissionRequest,
  type RequestAdmission,
} from "../../src/residency/request-admission.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { generateToken } from "../../src/server/auth.js";
import { type RunningAgent, startAgentServer } from "../../src/server/serve.js";

const ENV_KEYS = [
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMA_CPP_MODELS",
  "LLAMA_CPP_HOST",
  "LLAMA_CPP_PORT",
] as const;

const CHAT_BODY = JSON.stringify({
  model: "no-such-model",
  stream: true,
  messages: [{ role: "user", content: "hi" }],
});

const ADMISSION_LIMITS: RequestQueueLimits = {
  maxExecutions: 1,
  maxQueued: 1,
  maxQueuedBytes: 1_048_576,
  maxQueueWaitMs: 30_000,
  maxPerPrincipal: 10,
  starvationBoundMs: 30_000,
  maxContextTokens: Number.MAX_SAFE_INTEGER,
  retryAfterMs: 2_500,
};

/** Poll `pred` every 10ms until it holds or the deadline passes. */
async function waitFor(pred: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(10);
  }
}

// ── Fake upstream ─────────────────────────────────────────────────────────

interface ChatGate {
  release: () => void;
  fail: () => void;
}

interface FakeChatUpstream {
  readonly port: number;
  hits(): number;
  /** Live per-request gates, oldest first; released/failed/cancelled ones drop out. */
  readonly gates: readonly ChatGate[];
  stop(): Promise<void>;
}

const FIRST_CHUNK =
  'data: {"id":"chatcmpl-admission","object":"chat.completion.chunk","created":0,"model":"no-such-model","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n';
const DONE_FRAME = "data: [DONE]\n\n";

/**
 * Fake llama-server: POST /v1/chat/completions answers an SSE stream that
 * emits one chunk immediately, then parks on a per-request gate — release()
 * enqueues [DONE] and closes, fail() errors the stream. GET /v1/models is
 * answered but never counted; every other path 404s.
 */
function startFakeChatUpstream(): FakeChatUpstream {
  const encoder = new TextEncoder();
  const gates: (ChatGate & { settled: boolean })[] = [];
  let hits = 0;
  const drop = (gate: ChatGate & { settled: boolean }): void => {
    const at = gates.indexOf(gate);
    if (at !== -1) gates.splice(at, 1);
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req: Request): Response {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/v1/models") {
        return Response.json({ object: "list", data: [] });
      }
      if (req.method !== "POST" || path !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 });
      }
      hits += 1;
      const cell: { gate: (ChatGate & { settled: boolean }) | null } = { gate: null };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(FIRST_CHUNK));
          const gate: ChatGate & { settled: boolean } = {
            settled: false,
            release: () => {
              if (gate.settled) return;
              gate.settled = true;
              drop(gate);
              try {
                controller.enqueue(encoder.encode(DONE_FRAME));
                controller.close();
              } catch {
                // The consumer already tore the stream down.
              }
            },
            fail: () => {
              if (gate.settled) return;
              gate.settled = true;
              drop(gate);
              try {
                controller.error(new Error("upstream boom"));
              } catch {
                // The consumer already tore the stream down.
              }
            },
          };
          cell.gate = gate;
          gates.push(gate);
        },
        cancel() {
          const gate = cell.gate;
          if (gate === null) return;
          gate.settled = true;
          drop(gate);
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    port: server.port ?? 0,
    hits: () => hits,
    gates,
    stop: () => server.stop(true),
  };
}

function latestGate(upstream: FakeChatUpstream): ChatGate {
  const gate = upstream.gates.at(-1);
  if (gate === undefined) throw new Error("upstream never saw a chat request");
  return gate;
}

// ── chat-admission module (lands with the fix) ────────────────────────────

interface ChatAdmissionModule {
  admitChatCompletions: (
    req: Request,
    admission: RequestAdmission,
    forward: (r: Request) => Promise<Response>,
  ) => Promise<Response>;
  admissionErrorResponse: (err: unknown) => Response;
  createChatCompletionsAdmission: (caps: {
    maxExecutions: number;
    maxQueued: number;
  }) => RequestAdmission;
}

async function loadChatAdmission(): Promise<ChatAdmissionModule | null> {
  const modPath = join(import.meta.dir, "../../src/server/chat-admission.ts");
  const loaded: unknown = await import(modPath).catch(() => null);
  return loaded as ChatAdmissionModule | null;
}

function unitAdmission(limits: RequestQueueLimits = ADMISSION_LIMITS): RequestAdmission {
  return createRequestAdmission({ limits, load: async () => undefined });
}

function chatRequest(body: string, signal: AbortSignal): Request {
  return new Request("http://x/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal,
  });
}

/** Wraps an admission so every release() invocation is counted. */
function countedAdmission(admission: RequestAdmission): {
  admission: RequestAdmission;
  releases: () => number;
} {
  let releases = 0;
  return {
    releases: () => releases,
    admission: {
      acquire: async (request, options) => {
        const release = await admission.acquire(request, options);
        return () => {
          releases += 1;
          release();
        };
      },
      snapshot: () => admission.snapshot(),
    },
  };
}

// ── Integration: real agent + real fake upstream ──────────────────────────

type Opts = Parameters<typeof startAgentServer>[0] & {
  chatCompletionsAdmission?: RequestAdmission;
};

type AgentReader = import("node:stream/web").ReadableStreamDefaultReader;

describe("#281 DF-08: chat-completions admission at the agent ingress", () => {
  let dir: string;
  let upstream: FakeChatUpstream;
  let agent: RunningAgent | null = null;
  let admission: RequestAdmission;
  let token = "";
  let tokenHash = "";
  const savedEnv = new Map<string, string | undefined>();
  const readers: AgentReader[] = [];

  function startAgent(withAdmission: boolean): RunningAgent {
    const options: Opts = {
      tokenHash,
      advertiseMdns: false,
      ...(withAdmission ? { chatCompletionsAdmission: admission } : {}),
    };
    agent = (startAgentServer as unknown as (o: Opts) => RunningAgent)(options);
    return agent;
  }

  function postChat(signal?: AbortSignal): Promise<Response> {
    return fetch(`${agent!.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: CHAT_BODY,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  async function firstChunk(res: Response): Promise<AgentReader> {
    const reader = res.body!.getReader();
    readers.push(reader);
    const first = await reader.read();
    expect(first.done).toBe(false);
    return reader;
  }

  async function drain(reader: AgentReader): Promise<void> {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llamactl-chat-admission-"));
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    upstream = startFakeChatUpstream();
    process.env["DEV_STORAGE"] = dir;
    process.env["LOCAL_AI_RUNTIME_DIR"] = join(dir, "runtime");
    process.env["LLAMA_CPP_MODELS"] = join(dir, "models");
    process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
    process.env["LLAMA_CPP_PORT"] = String(upstream.port);
    const generated = generateToken();
    token = generated.token;
    tokenHash = generated.hash;
    admission = createRequestAdmission({
      limits: ADMISSION_LIMITS,
      load: async () => undefined,
    });
  });

  afterEach(async () => {
    for (const gate of [...upstream.gates]) gate.release();
    for (const reader of readers.splice(0)) {
      await reader.cancel("cleanup").catch(() => undefined);
    }
    await agent?.stop();
    agent = null;
    await upstream.stop();
    rmSync(dir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    savedEnv.clear();
  });

  // Kills: releasing when forward() resolves (at headers); never releasing.
  test("(1) the slot is held while the stream runs and released when it ends", async () => {
    startAgent(true);
    const res = await postChat();
    expect(res.status).toBe(200);
    const reader = await firstChunk(res);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);

    latestGate(upstream).release();
    await drain(reader);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // Kills: never releasing on client hangup.
  test("(2) a client abort mid-stream releases the slot and it is reusable", async () => {
    startAgent(true);
    const ac = new AbortController();
    const res = await postChat(ac.signal);
    expect(res.status).toBe(200);
    await firstChunk(res);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);

    ac.abort();
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);

    const res2 = await postChat();
    expect(res2.status).toBe(200);
    const reader2 = await firstChunk(res2);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);
    latestGate(upstream).release();
    await drain(reader2);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // Kills: no release on the upstream-error path.
  test("(3) an upstream stream error releases the slot", async () => {
    startAgent(true);
    const res = await postChat();
    expect(res.status).toBe(200);
    const reader = await firstChunk(res);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);

    latestGate(upstream).fail();
    try {
      await drain(reader);
    } catch {
      // The upstream error surfaces to the client as a read failure.
    }
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // Kills: passing a refusal through to the fallback; dropping Retry-After;
  // mapping QueueFull to 503.
  test("(4) a full queue refuses with 429 + Retry-After and never forwards", async () => {
    startAgent(true);
    const resA = await postChat();
    expect(resA.status).toBe(200);
    const readerA = await firstChunk(resA);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);

    const pendingB = postChat();
    void pendingB.catch(() => undefined);
    expect(await waitFor(() => admission.snapshot().queued === 1)).toBe(true);

    const resC = await postChat();
    expect(resC.status).toBe(429);
    expect(resC.headers.get("retry-after")).toBe("3");
    const errBody = (await resC.json()) as { error?: { code?: unknown } };
    expect(errBody.error?.code).toBe("QueueFull");
    expect(upstream.hits()).toBe(1);

    latestGate(upstream).release();
    await drain(readerA);
    const resB = await pendingB;
    expect(resB.status).toBe(200);
    expect(upstream.hits()).toBe(2);
    const readerB = await firstChunk(resB);
    latestGate(upstream).release();
    await drain(readerB);
  }, 15_000);

  // Passes at base: with no chatCompletionsAdmission the proxy streams
  // exactly as before — this case only guards the inert default.
  test("(5) pin: with no chatCompletionsAdmission the proxy streams as before", async () => {
    startAgent(false);
    const res = await postChat();
    expect(res.status).toBe(200);
    const reader = await firstChunk(res);
    latestGate(upstream).release();
    await drain(reader);
  }, 15_000);
});

// ── Unit: src/server/chat-admission.ts, no socket ─────────────────────────

describe("#281 DF-08: chat-admission module", () => {
  // Kills: no release in the forward catch path; forwarding before acquire.
  test("(a1) a throwing forward() releases the slot and propagates the error", async () => {
    const mod = await loadChatAdmission();
    expect(typeof mod?.admitChatCompletions).toBe("function");
    const admission = unitAdmission();
    const ac = new AbortController();
    let seen = -1;
    await expect(
      mod!.admitChatCompletions(chatRequest(CHAT_BODY, ac.signal), admission, async () => {
        seen = admission.snapshot().executing;
        throw new Error("forward boom");
      }),
    ).rejects.toThrow("forward boom");
    expect(seen).toBe(1);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 10_000);

  // Kills: the null-body path never releasing.
  test("(a2) a null-body (204) forward result still releases the slot", async () => {
    const mod = await loadChatAdmission();
    expect(typeof mod?.admitChatCompletions).toBe("function");
    const admission = unitAdmission();
    const ac = new AbortController();
    const res = await mod!.admitChatCompletions(
      chatRequest(CHAT_BODY, ac.signal),
      admission,
      async () => new Response(null, { status: 204 }),
    );
    expect(res.status).toBe(204);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 10_000);

  // Kills: mapping QueueBytesExceeded unconditionally to 429.
  test("(a3) an oversized body is refused 413 before forward runs", async () => {
    const mod = await loadChatAdmission();
    expect(typeof mod?.admitChatCompletions).toBe("function");
    const admission = unitAdmission({ ...ADMISSION_LIMITS, maxQueuedBytes: 16 });
    const ac = new AbortController();
    const bigBody = JSON.stringify({
      model: "no-such-model",
      stream: true,
      messages: [{ role: "user", content: "x".repeat(100) }],
    });
    let forwarded = false;
    const res = await mod!.admitChatCompletions(
      chatRequest(bigBody, ac.signal),
      admission,
      async () => {
        forwarded = true;
        return new Response("ok");
      },
    );
    expect(res.status).toBe(413);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(forwarded).toBe(false);
  }, 10_000);

  // Kills: any 429 without Retry-After.
  test("(a4) admissionErrorResponse maps each admission code to status + Retry-After", async () => {
    const mod = await loadChatAdmission();
    expect(typeof mod?.admissionErrorResponse).toBe("function");
    const cases: {
      code: AdmissionRejectCode;
      retryAfterMs: number | null;
      status: number;
      retryAfter: string | null;
    }[] = [
      { code: "QueueFull", retryAfterMs: 1500, status: 429, retryAfter: "2" },
      { code: "PrincipalShareExceeded", retryAfterMs: 1000, status: 429, retryAfter: "1" },
      { code: "QueueBytesExceeded", retryAfterMs: 1000, status: 429, retryAfter: "1" },
      { code: "QueueBytesExceeded", retryAfterMs: null, status: 413, retryAfter: null },
      { code: "QueueWaitExceeded", retryAfterMs: 1000, status: 503, retryAfter: "1" },
      { code: "LoadFailed", retryAfterMs: 1000, status: 503, retryAfter: "1" },
      { code: "DeadlineExceeded", retryAfterMs: null, status: 504, retryAfter: null },
      { code: "InvalidRequest", retryAfterMs: null, status: 400, retryAfter: null },
      { code: "ContextLimitExceeded", retryAfterMs: null, status: 400, retryAfter: null },
      { code: "DuplicateRequest", retryAfterMs: null, status: 409, retryAfter: null },
    ];
    for (const row of cases) {
      const res = mod!.admissionErrorResponse(
        new RequestAdmissionError(row.code, row.retryAfterMs, "r"),
      );
      expect(res.status).toBe(row.status);
      expect(res.headers.get("retry-after")).toBe(row.retryAfter);
      if (row.retryAfterMs === null) {
        expect(res.status).not.toBe(429);
        expect(res.headers.get("retry-after")).toBeNull();
      }
    }
  }, 10_000);

  // Kills: forwarding the consumed original; dropping the signal.
  test("(a5) forward receives a replayable request carrying the client signal", async () => {
    const mod = await loadChatAdmission();
    expect(typeof mod?.admitChatCompletions).toBe("function");
    const admission = unitAdmission();
    const ac = new AbortController();
    let forwarded: Request | null = null;
    const res = await mod!.admitChatCompletions(
      chatRequest(CHAT_BODY, ac.signal),
      admission,
      async (r) => {
        forwarded = r;
        return new Response("ok", { status: 200 });
      },
    );
    expect(res.status).toBe(200);
    expect(await forwarded!.text()).toBe(CHAT_BODY);
    ac.abort();
    expect(await waitFor(() => forwarded!.signal.aborted)).toBe(true);
    await res.body?.cancel().catch(() => undefined);
  }, 10_000);

  // Kills: a wrapped stream with no cancel() release; a missing
  // once-guard (double release).
  test("(a6) cancelling the response body releases the slot exactly once", async () => {
    const mod = await loadChatAdmission();
    expect(typeof mod?.admitChatCompletions).toBe("function");
    const { admission: counted, releases } = countedAdmission(unitAdmission());
    const ac = new AbortController();
    const enc = new TextEncoder();
    const res = await mod!.admitChatCompletions(
      chatRequest(CHAT_BODY, ac.signal),
      counted,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.encode("x"));
            },
          }),
          { status: 200 },
        ),
    );
    const rd = res.body!.getReader();
    await rd.read();
    expect(await waitFor(() => counted.snapshot().executing === 1)).toBe(true);

    await rd.cancel("bye");
    expect(await waitFor(() => counted.snapshot().executing === 0)).toBe(true);
    expect(releases()).toBe(1);

    ac.abort();
    expect(await waitFor(() => false, 50)).toBe(false);
    expect(releases()).toBe(1);
  }, 10_000);

  // Kills: the pull read-error branch not releasing.
  test("(a7) a mid-stream read error releases the slot", async () => {
    const mod = await loadChatAdmission();
    expect(typeof mod?.admitChatCompletions).toBe("function");
    const { admission: counted, releases } = countedAdmission(unitAdmission());
    const ac = new AbortController();
    const enc = new TextEncoder();
    let pulls = 0;
    const res = await mod!.admitChatCompletions(
      chatRequest(CHAT_BODY, ac.signal),
      counted,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              pulls += 1;
              if (pulls === 1) c.enqueue(enc.encode("x"));
              else c.error(new Error("mid boom"));
            },
          }),
          { status: 200 },
        ),
    );
    const rd = res.body!.getReader();
    let caught: unknown = null;
    try {
      for (;;) {
        const next = await rd.read();
        if (next.done) break;
      }
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toBe("mid boom");
    expect(await waitFor(() => counted.snapshot().executing === 0)).toBe(true);
    expect(releases()).toBe(1);
  }, 10_000);

  // Kills: maxPerPrincipal = maxExecutions + maxQueued, which yields
  // PrincipalShareExceeded instead of QueueFull.
  test("(a8) createChatCompletionsAdmission honors the execution and queue caps", async () => {
    const mod = await loadChatAdmission();
    expect(typeof mod?.createChatCompletionsAdmission).toBe("function");
    const adm = mod!.createChatCompletionsAdmission({ maxExecutions: 1, maxQueued: 1 });
    const req = (id: string): AdmissionRequest => ({
      requestId: id,
      principal: "agent",
      priority: "interactive",
      model: { name: "chat-completions", revision: "agent" },
      bytes: 0,
      promptTokens: 0,
      maxCompletionTokens: 0,
    });
    const relA = await adm.acquire(req("a"));
    expect(await waitFor(() => adm.snapshot().executing === 1)).toBe(true);
    const pendingB = adm.acquire(req("b"));
    void pendingB.catch(() => undefined);
    expect(await waitFor(() => adm.snapshot().queued === 1)).toBe(true);
    const err = await adm.acquire(req("c")).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as { code?: unknown }).code).toBe("QueueFull");
    relA();
    const relB = await pendingB;
    relB();
  }, 10_000);

  // Kills: removing the abort-listener backstop.
  test("(a9) the req.signal backstop releases a stream nobody reads", async () => {
    const mod = await loadChatAdmission();
    expect(typeof mod?.admitChatCompletions).toBe("function");
    const { admission: counted, releases } = countedAdmission(unitAdmission());
    const ac = new AbortController();
    const res = await mod!.admitChatCompletions(
      chatRequest(CHAT_BODY, ac.signal),
      counted,
      async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }),
    );
    expect(await waitFor(() => counted.snapshot().executing === 1)).toBe(true);

    ac.abort();
    expect(await waitFor(() => counted.snapshot().executing === 0)).toBe(true);
    expect(releases()).toBe(1);

    await res.body?.cancel().catch(() => undefined);
    expect(releases()).toBe(1);
  }, 10_000);
});
