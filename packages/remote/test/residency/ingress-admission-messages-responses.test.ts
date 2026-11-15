/**
 * Part of #281, DF-08 follow-up to #699.
 *
 * #699 wired the RequestAdmission slot into POST /v1/chat/completions
 * only. This slice pins the same slot on the two remaining translated
 * ingresses — POST /v1/messages (Anthropic) and POST /v1/responses —
 * sharing ONE admission instance (opts.chatCompletionsAdmission) with
 * chat completions. Every case is end-to-end through startAgentServer
 * against a fake llama-server that only speaks POST /v1/chat/completions,
 * because core translates both ingress bodies onto that path.
 *
 * Fixture note: core's Anthropic translation drops `stream` before the
 * upstream call (known defect owned by #132), so the translated
 * /v1/messages body never carries stream:true and the upstream cannot
 * tell a streaming Messages request from a buffered one. Every
 * /v1/messages POST here sends anthropic-version (required by the
 * surface), and the fake upstream answers SSE whenever that header is
 * present — the only upstream-visible signal — so the Messages cases
 * exercise a real stream lifetime. /v1/responses never streams by
 * contract (core 501s it), so its cases pin the parked-upstream shape
 * instead: the JSON translation buffers, and the slot is observed held
 * while the upstream body is parked.
 *
 * Throwing-forward note: the (m6, r6e) cases drive a rejecting unified-proxy
 * handler through the real Bun.serve agent. The admitted route releases the
 * slot inside admitChatCompletions and maps the rejection to a resolved 502
 * whose body carries error.type "api_error", so the client fetch resolves and
 * no rejection escapes Bun.serve. Both cases pin that exact status and body:
 * without the mapping the rejection would reset the socket instead.
 */
import type { RequestQueueLimits } from "@llamactl/core/residency/queue-policy";
import type { ReadableStreamDefaultReader as WebStreamReader } from "node:stream/web";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __setSharedUnifiedProxyForTests } from "../../src/proxy/create-proxy.js";
import {
  createRequestAdmission,
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
  "LLAMACTL_UNIFIED_PROXY",
] as const;

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

// ── Request bodies ────────────────────────────────────────────────────────
// A monotonic counter keeps every message text unique so the deterministic
// response cache can never short-circuit the upstream; temperature is never
// sent for the same reason.

let bodySeq = 0;

function nextText(): string {
  bodySeq += 1;
  return `hi ${String(bodySeq)}`;
}

function messagesBody(): string {
  return JSON.stringify({
    model: "no-such-model",
    max_tokens: 16,
    stream: true,
    messages: [{ role: "user", content: nextText() }],
  });
}

function responsesBody(): string {
  return JSON.stringify({ model: "no-such-model", input: nextText() });
}

function chatBody(): string {
  return JSON.stringify({
    model: "no-such-model",
    stream: true,
    messages: [{ role: "user", content: nextText() }],
  });
}

function oversizeResponsesBody(): string {
  return JSON.stringify({
    model: "no-such-model",
    input: `OVERSIZE-MARKER ${"x".repeat(2_000_000)}`,
  });
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

const encoder = new TextEncoder();
const FIRST_CHUNK =
  'data: {"id":"chatcmpl-admission","object":"chat.completion.chunk","created":0,"model":"no-such-model","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n';
const DONE_FRAME = "data: [DONE]\n\n";
const COMPLETION_JSON = JSON.stringify({
  id: "chatcmpl-admission",
  object: "chat.completion",
  created: 0,
  model: "no-such-model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "hi" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 1 },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentHasMarker(content: unknown): boolean {
  if (typeof content === "string") return content.includes("OVERSIZE-MARKER");
  if (Array.isArray(content)) {
    return content.some(
      (part) =>
        isRecord(part) &&
        typeof part["text"] === "string" &&
        part["text"].includes("OVERSIZE-MARKER"),
    );
  }
  return false;
}

function bodyHasOversizeMarker(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const messages = body["messages"];
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => isRecord(message) && contentHasMarker(message["content"]));
}

/**
 * Fake llama-server: POST /v1/chat/completions is the only served path —
 * core translates /v1/messages and /v1/responses onto it. Stream bodies
 * (stream===true) and every anthropic-ingress request (the anthropic-version
 * header survives translation while `stream` does not — see the file header)
 * answer SSE: one chat.completion.chunk immediately, then the body parks on
 * a per-request gate — release() enqueues [DONE] and closes, fail() errors
 * the stream. Other bodies answer application/json with a ReadableStream
 * that parks on the gate; release() enqueues the full chat.completion JSON
 * and closes. A body carrying the OVERSIZE-MARKER answers that JSON at once
 * with no gate. GET /v1/models is answered but never counted; every other
 * path 404s.
 */
function startFakeChatUpstream(): FakeChatUpstream {
  const gates: (ChatGate & { settled: boolean })[] = [];
  let hits = 0;
  const drop = (gate: ChatGate & { settled: boolean }): void => {
    const at = gates.indexOf(gate);
    if (at !== -1) gates.splice(at, 1);
  };
  const gated = (opts: {
    contentType: string;
    onStart?: (c: ReadableStreamDefaultController<Uint8Array>) => void;
    onRelease: (c: ReadableStreamDefaultController<Uint8Array>) => void;
  }): Response => {
    const cell: { gate: (ChatGate & { settled: boolean }) | null } = { gate: null };
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        opts.onStart?.(controller);
        const gate: ChatGate & { settled: boolean } = {
          settled: false,
          release: () => {
            if (gate.settled) return;
            gate.settled = true;
            drop(gate);
            try {
              opts.onRelease(controller);
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
      cancel(): void {
        const gate = cell.gate;
        if (gate === null) return;
        gate.settled = true;
        drop(gate);
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": opts.contentType },
    });
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/v1/models") {
        return Response.json({ object: "list", data: [] });
      }
      if (req.method !== "POST" || path !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 });
      }
      hits += 1;
      const parsed: unknown = await req.json().catch(() => null);
      if (bodyHasOversizeMarker(parsed)) {
        return new Response(COMPLETION_JSON, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const wantsStream = isRecord(parsed) && parsed["stream"] === true;
      const anthropicIngress = req.headers.get("anthropic-version") !== null;
      if (wantsStream || anthropicIngress) {
        return gated({
          contentType: "text/event-stream",
          onStart: (c) => {
            c.enqueue(encoder.encode(FIRST_CHUNK));
          },
          onRelease: (c) => {
            c.enqueue(encoder.encode(DONE_FRAME));
            c.close();
          },
        });
      }
      return gated({
        contentType: "application/json",
        onRelease: (c) => {
          c.enqueue(encoder.encode(COMPLETION_JSON));
          c.close();
        },
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

// ── counted admission ─────────────────────────────────────────────────────

/** Wraps an admission so every acquire() and release() invocation is counted. */
function countedAdmission(admission: RequestAdmission): {
  admission: RequestAdmission;
  acquires: () => number;
  releases: () => number;
} {
  let acquires = 0;
  let releases = 0;
  return {
    acquires: () => acquires,
    releases: () => releases,
    admission: {
      acquire: async (request, options) => {
        acquires += 1;
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

type Opts = Parameters<typeof startAgentServer>[0];

type AgentReader = WebStreamReader;

interface PostOpts {
  signal?: AbortSignal;
  bearer?: boolean;
}

describe("#281 DF-08: messages/responses admission at the agent ingress", () => {
  let dir: string;
  let upstream: FakeChatUpstream;
  let agent: RunningAgent | null = null;
  let admission: RequestAdmission;
  let token = "";
  let tokenHash = "";
  const savedEnv = new Map<string, string | undefined>();
  const readers: AgentReader[] = [];

  function startAgent(withAdmission: boolean, override?: RequestAdmission): RunningAgent {
    const adm = override ?? admission;
    const options: Opts = {
      tokenHash,
      advertiseMdns: false,
      ...(withAdmission ? { chatCompletionsAdmission: adm } : {}),
    };
    agent = startAgentServer(options);
    return agent;
  }

  function postMessages(body: string, opts?: PostOpts): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (opts?.bearer !== false) headers["authorization"] = `Bearer ${token}`;
    return fetch(`${agent!.url}/v1/messages`, {
      method: "POST",
      headers,
      body,
      ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    });
  }

  function postResponses(body: string, opts?: PostOpts): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    };
    return fetch(`${agent!.url}/v1/responses`, {
      method: "POST",
      headers,
      body,
      ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    });
  }

  function postChat(body: string): Promise<Response> {
    return fetch(`${agent!.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body,
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

  /**
   * Arms the unified-proxy seam for the throwing-forward cases: the first
   * forward rejects, then `handler` is swapped to answer 204. The admitted
   * route catches that rejection after admitChatCompletions has released the
   * slot and answers a resolved 502 with error.type "api_error", so the
   * client fetch resolves rather than seeing a reset socket.
   */
  function armThrowingForward(): {
    counted: ReturnType<typeof countedAdmission>;
    setHandler: (handler: () => Promise<Response>) => void;
  } {
    process.env["LLAMACTL_UNIFIED_PROXY"] = "1";
    let handler: () => Promise<Response> = () => Promise.reject(new Error("boom"));
    __setSharedUnifiedProxyForTests({
      unifiedEnabled: true,
      describe: () => ({ unified: true, executors: [] }),
      shadowCatalog: () => Promise.reject(new Error("unused")),
      handleRequest: () => handler(),
    });
    const counted = countedAdmission(admission);
    startAgent(true, counted.admission);
    return {
      counted,
      setHandler: (next): void => {
        handler = next;
      },
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llamactl-ingress-admission-"));
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
      load: () => Promise.resolve(),
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
    __setSharedUnifiedProxyForTests(null);
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    savedEnv.clear();
  });

  // ── /v1/messages ────────────────────────────────────────────────────────

  // Kills: /v1/messages missing from the admitted-route condition; releasing
  // at forward() resolution instead of reusing admitChatCompletions /
  // responseHoldingSlot.
  test("(m1) the slot is held for the /v1/messages stream lifetime", async () => {
    startAgent(true);
    const res = await postMessages(messagesBody());
    expect(res.status).toBe(200);
    const reader = await firstChunk(res);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);

    latestGate(upstream).release();
    await drain(reader);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // Kills: not passing req through admitChatCompletions, which drops the
  // req.signal backstop.
  test("(m2) a client abort mid-stream releases the /v1/messages slot", async () => {
    startAgent(true);
    const ac = new AbortController();
    const res = await postMessages(messagesBody(), { signal: ac.signal });
    expect(res.status).toBe(200);
    await firstChunk(res);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);

    ac.abort();
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);

    const res2 = await postMessages(messagesBody());
    expect(res2.status).toBe(200);
    const reader2 = await firstChunk(res2);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);
    latestGate(upstream).release();
    await drain(reader2);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // Kills: a hand-rolled acquire/release with no error path.
  test("(m3) an upstream stream error releases the /v1/messages slot", async () => {
    startAgent(true);
    const res = await postMessages(messagesBody());
    expect(res.status).toBe(200);
    const reader = await firstChunk(res);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);

    latestGate(upstream).fail();
    try {
      await drain(reader);
    } catch {
      // The upstream error may surface to the client as a read failure.
    }
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // Kills: a separate status mapping that sends QueueFull to 503, or a copied
  // admissionErrorResponse without Retry-After.
  test("(m4) a full queue refuses /v1/messages with 429 + Retry-After and never forwards", async () => {
    startAgent(true);
    const resA = await postMessages(messagesBody());
    expect(resA.status).toBe(200);
    const readerA = await firstChunk(resA);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);

    const pendingB = postMessages(messagesBody());
    void pendingB.catch(() => undefined);
    expect(await waitFor(() => admission.snapshot().queued === 1)).toBe(true);

    const resC = await postMessages(messagesBody());
    expect(resC.status).toBe(429);
    expect(resC.headers.get("retry-after")).toBe("3");
    const errBody = (await resC.json()) as { error?: { code?: unknown; type?: unknown } };
    expect(errBody.error?.code).toBe("QueueFull");
    expect(errBody.error?.type).toBe("overloaded_error");
    expect(upstream.hits()).toBe(1);

    latestGate(upstream).release();
    await drain(readerA);
    const resB = await pendingB;
    expect(resB.status).toBe(200);
    expect(upstream.hits()).toBe(2);
    const readerB = await firstChunk(resB);
    latestGate(upstream).release();
    await drain(readerB);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // Kills: the null-body path not releasing on this ingress.
  test("(m5) a null-body forward result releases the /v1/messages slot", async () => {
    process.env["LLAMACTL_UNIFIED_PROXY"] = "1";
    __setSharedUnifiedProxyForTests({
      unifiedEnabled: true,
      describe: () => ({ unified: true, executors: [] }),
      shadowCatalog: () => Promise.reject(new Error("unused")),
      handleRequest: () => Promise.resolve(new Response(null, { status: 204 })),
    });
    const counted = countedAdmission(admission);
    startAgent(true, counted.admission);

    const res = await postMessages(messagesBody());
    expect(res.status).toBe(204);
    expect(counted.acquires()).toBe(1);
    expect(counted.releases()).toBe(1);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // Kills: no release on the forward-throw path when the route bypasses
  // admitChatCompletions; dropping the .catch that maps the rejection to a
  // 502 (the fetch then rejects); mapping it to any status other than 502.
  test("(m6) a throwing forward releases the /v1/messages slot", async () => {
    const { counted, setHandler } = armThrowingForward();

    // The admitted route maps the rejecting forward to a resolved 502 with
    // error.type "api_error", so the client fetch resolves.
    let firstRes: Response | null = null;
    let firstErr: unknown = null;
    try {
      firstRes = await postMessages(messagesBody());
    } catch (err) {
      firstErr = err;
    }
    expect(firstErr).toBeNull();
    expect(firstRes).not.toBeNull();
    expect(firstRes!.status).toBe(502);
    const firstBody = (await firstRes!.json()) as { error?: { type?: unknown } };
    expect(firstBody.error?.type).toBe("api_error");
    expect(counted.acquires()).toBe(1);
    expect(counted.releases()).toBe(1);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);

    setHandler(() => Promise.resolve(new Response(null, { status: 204 })));
    const second = await postMessages(messagesBody());
    expect(second.status).toBe(204);
    expect(counted.acquires()).toBe(2);
    expect(counted.releases()).toBe(2);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // ── /v1/responses ───────────────────────────────────────────────────────

  // Kills: /v1/responses missing from the admitted-route condition. The
  // release-at-resolution mutation cannot be observed here because core
  // buffers the Responses JSON — (m1) covers it on the streaming ingress.
  test("(r1) the slot is held while the /v1/responses upstream is parked", async () => {
    startAgent(true);
    const pending = postResponses(responsesBody());
    void pending.catch(() => undefined);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);
    expect(await waitFor(() => upstream.gates.length > 0)).toBe(true);

    latestGate(upstream).release();
    const res = await pending;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object?: unknown };
    expect(body.object).toBe("response");
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // Kills: not passing req through admitChatCompletions, which drops the
  // req.signal backstop.
  test("(r2) a client abort releases the /v1/responses slot", async () => {
    startAgent(true);
    const ac = new AbortController();
    const pending = postResponses(responsesBody(), { signal: ac.signal });
    void pending.catch(() => undefined);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);

    ac.abort();
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);

    const pending2 = postResponses(responsesBody());
    void pending2.catch(() => undefined);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);
    expect(await waitFor(() => upstream.gates.length > 0)).toBe(true);
    latestGate(upstream).release();
    const res2 = await pending2;
    expect(res2.status).toBe(200);
    await res2.json();
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // Kills: a hand-rolled acquire/release with no error path.
  test("(r3) an upstream error releases the /v1/responses slot", async () => {
    startAgent(true);
    const pending = postResponses(responsesBody());
    void pending.catch(() => undefined);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);
    expect(await waitFor(() => upstream.gates.length > 0)).toBe(true);

    latestGate(upstream).fail();
    const outcome = await pending.then(
      (res) => ({ res, err: null as unknown }),
      (err: unknown) => ({ res: null, err }),
    );
    if (outcome.res !== null) {
      expect(outcome.res.status).toBeGreaterThanOrEqual(500);
      await outcome.res.text().catch(() => undefined);
    } else {
      expect(outcome.err).toBeInstanceOf(Error);
    }
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // Kills: a separate status mapping that sends QueueFull to 503, or a copied
  // admissionErrorResponse without Retry-After.
  test("(r4) a full queue refuses /v1/responses with 429 + Retry-After and never forwards", async () => {
    startAgent(true);
    const pendingA = postResponses(responsesBody());
    void pendingA.catch(() => undefined);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);
    expect(await waitFor(() => upstream.gates.length > 0)).toBe(true);

    const pendingB = postResponses(responsesBody());
    void pendingB.catch(() => undefined);
    expect(await waitFor(() => admission.snapshot().queued === 1)).toBe(true);

    const resC = await postResponses(responsesBody());
    expect(resC.status).toBe(429);
    expect(resC.headers.get("retry-after")).toBe("3");
    const errBody = (await resC.json()) as { error?: { code?: unknown; type?: unknown } };
    expect(errBody.error?.code).toBe("QueueFull");
    expect(errBody.error?.type).toBe("overloaded_error");
    expect(upstream.hits()).toBe(1);

    latestGate(upstream).release();
    const resA = await pendingA;
    expect(resA.status).toBe(200);
    await resA.json();
    expect(await waitFor(() => upstream.hits() === 2)).toBe(true);
    expect(await waitFor(() => upstream.gates.length > 0)).toBe(true);
    latestGate(upstream).release();
    const resB = await pendingB;
    expect(resB.status).toBe(200);
    await resB.json();
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // Kills: the null-body path not releasing on this ingress.
  test("(r5) a null-body forward result releases the /v1/responses slot", async () => {
    process.env["LLAMACTL_UNIFIED_PROXY"] = "1";
    __setSharedUnifiedProxyForTests({
      unifiedEnabled: true,
      describe: () => ({ unified: true, executors: [] }),
      shadowCatalog: () => Promise.reject(new Error("unused")),
      handleRequest: () => Promise.resolve(new Response(null, { status: 204 })),
    });
    const counted = countedAdmission(admission);
    startAgent(true, counted.admission);

    const res = await postResponses(responsesBody());
    expect(res.status).toBe(204);
    expect(counted.acquires()).toBe(1);
    expect(counted.releases()).toBe(1);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // Kills: no release on the forward-throw path when the route bypasses
  // admitChatCompletions; dropping the .catch that maps the rejection to a
  // 502 (the fetch then rejects); mapping it to any status other than 502.
  test("(r6e) a throwing forward releases the /v1/responses slot", async () => {
    const { counted, setHandler } = armThrowingForward();

    // Same outcome as (m6): the rejecting forward is mapped to a resolved 502
    // with error.type "api_error", so the client fetch resolves.
    let firstRes: Response | null = null;
    let firstErr: unknown = null;
    try {
      firstRes = await postResponses(responsesBody());
    } catch (err) {
      firstErr = err;
    }
    expect(firstErr).toBeNull();
    expect(firstRes).not.toBeNull();
    expect(firstRes!.status).toBe(502);
    const firstBody = (await firstRes!.json()) as { error?: { type?: unknown } };
    expect(firstBody.error?.type).toBe("api_error");
    expect(counted.acquires()).toBe(1);
    expect(counted.releases()).toBe(1);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);

    setHandler(() => Promise.resolve(new Response(null, { status: 204 })));
    const second = await postResponses(responsesBody());
    expect(second.status).toBe(204);
    expect(counted.acquires()).toBe(2);
    expect(counted.releases()).toBe(2);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // Kills: a route that forwards before admission, or that maps bytes
  // refusals differently. The marker makes the base upstream answer at once,
  // so this fails on 200 !== 413 by assertion, never by timeout.
  test("(r6) an oversized /v1/responses body is refused 413 and never forwarded", async () => {
    startAgent(true);
    const res = await postResponses(oversizeResponsesBody());
    expect(res.status).toBe(413);
    expect(res.headers.get("retry-after")).toBeNull();
    const errBody = (await res.json()) as { error?: { code?: unknown } };
    expect(errBody.error?.code).toBe("QueueBytesExceeded");
    expect(upstream.hits()).toBe(0);
  }, 15_000);

  // ── shared limit: one admission across all three ingresses ──────────────

  // Kills: a second admission instance for messages/responses (a new
  // createChatCompletionsAdmission or a new option) instead of
  // opts.chatCompletionsAdmission.
  test("(s1) a chat stream holds the slot so /v1/messages queues and /v1/responses refuses", async () => {
    startAgent(true);
    const resChat = await postChat(chatBody());
    expect(resChat.status).toBe(200);
    const readerChat = await firstChunk(resChat);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);

    const pendingMessages = postMessages(messagesBody());
    void pendingMessages.catch(() => undefined);
    expect(await waitFor(() => admission.snapshot().queued === 1)).toBe(true);
    expect(upstream.hits()).toBe(1);

    const resResponses = await postResponses(responsesBody());
    expect(resResponses.status).toBe(429);
    const errBody = (await resResponses.json()) as { error?: { code?: unknown } };
    expect(errBody.error?.code).toBe("QueueFull");
    expect(upstream.hits()).toBe(1);

    latestGate(upstream).release();
    await drain(readerChat);
    const resMessages = await pendingMessages;
    expect(resMessages.status).toBe(200);
    expect(upstream.hits()).toBe(2);
    const readerMessages = await firstChunk(resMessages);
    latestGate(upstream).release();
    await drain(readerMessages);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // Kills: a second admission instance for messages/responses (a new
  // createChatCompletionsAdmission or a new option) instead of
  // opts.chatCompletionsAdmission.
  test("(s2) a /v1/messages stream holds the slot so chat queues and /v1/responses refuses", async () => {
    startAgent(true);
    const resMessages = await postMessages(messagesBody());
    expect(resMessages.status).toBe(200);
    const readerMessages = await firstChunk(resMessages);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);

    const pendingChat = postChat(chatBody());
    void pendingChat.catch(() => undefined);
    expect(await waitFor(() => admission.snapshot().queued === 1)).toBe(true);
    expect(upstream.hits()).toBe(1);

    const resResponses = await postResponses(responsesBody());
    expect(resResponses.status).toBe(429);
    expect(upstream.hits()).toBe(1);

    latestGate(upstream).release();
    await drain(readerMessages);
    const resChat = await pendingChat;
    expect(resChat.status).toBe(200);
    expect(upstream.hits()).toBe(2);
    const readerChat = await firstChunk(resChat);
    latestGate(upstream).release();
    await drain(readerChat);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // ── pins (pass at base) ─────────────────────────────────────────────────

  // Pin: with no chatCompletionsAdmission the messages/responses proxy is
  // exactly as before — unbounded. FLAG_OFF_CONCURRENCY requests (half
  // /v1/messages streams, half parked /v1/responses) are all in flight at the
  // upstream at once, and every one completes 200. Kills: constructing a
  // default admission when the option is absent — any cap below
  // FLAG_OFF_CONCURRENCY queues or refuses a request, so the upstream never
  // sees them all concurrently.
  test("(p1) pin: with no chatCompletionsAdmission the proxy is unbounded", async () => {
    const FLAG_OFF_CONCURRENCY = 6;
    startAgent(false);

    // Nothing is awaited before the concurrency check, so a capped mutant
    // fails on the assertion below rather than by a test timeout.
    const pendingMessages: Promise<Response>[] = [];
    const pendingResponses: Promise<Response>[] = [];
    for (let i = 0; i < FLAG_OFF_CONCURRENCY / 2; i += 1) {
      const message = postMessages(messagesBody());
      void message.catch(() => undefined);
      pendingMessages.push(message);
      const response = postResponses(responsesBody());
      void response.catch(() => undefined);
      pendingResponses.push(response);
    }
    expect(await waitFor(() => upstream.gates.length === FLAG_OFF_CONCURRENCY)).toBe(true);
    expect(upstream.hits()).toBe(FLAG_OFF_CONCURRENCY);

    const messageReaders: AgentReader[] = [];
    for (const pending of pendingMessages) {
      const res = await pending;
      expect(res.status).toBe(200);
      messageReaders.push(await firstChunk(res));
    }
    for (const gate of [...upstream.gates]) gate.release();
    for (const reader of messageReaders) await drain(reader);
    for (const pending of pendingResponses) {
      const res = await pending;
      expect(res.status).toBe(200);
      const body = (await res.json()) as { object?: unknown };
      expect(body.object).toBe("response");
    }
  }, 15_000);

  // Pin: auth runs before admission on this ingress. Kills: admitting before
  // authGateReject.
  test("(p2) pin: a /v1/messages request without a bearer gets 401 before admission", async () => {
    const counted = countedAdmission(admission);
    startAgent(true, counted.admission);

    const res = await postMessages(messagesBody(), { bearer: false });
    expect(res.status).toBe(401);
    expect(counted.acquires()).toBe(0);
    expect(counted.releases()).toBe(0);
  }, 15_000);
});
