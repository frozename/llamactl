/**
 * Part of #281, DF-08 follow-up to #699/#704.
 *
 * #699 wired the RequestAdmission slot into POST /v1/chat/completions,
 * /v1/messages and /v1/responses at the agent ingress. This slice pins
 * the LAST uncounted ingresses against the SAME
 * opts.chatCompletionsAdmission instance — three things counted
 * against one cap:
 *
 *   1. router.ts chatComplete on its inproc://local branch, which
 *      reaches packages/remote/src/proxy/create-proxy.ts
 *      dispatchProxyRequest (the legacy openaiProxy.proxyOpenAI call
 *      unless LLAMACTL_UNIFIED_PROXY=1, in which case the shared
 *      unified proxy);
 *   2. router.ts chatStream on its inproc://local branch, which
 *      drives the local OpenAI-compat provider straight at
 *      LLAMA_CPP_HOST:PORT (llama-server directly);
 *   3. generic POST /v1/completions on the agent — the same
 *      dispatchProxyRequest path every other /v1/* route takes.
 *
 * Every RED case fails by assertion on the base: the router local
 * branches never acquire, requestContext never injects the admission,
 * and isAdmittedProxyIngress does not name /v1/completions, so both
 * bypass the shared cap today. The guard cases pin the scope the fix
 * must NOT widen: embeddings and rerank stay unadmitted (admitting
 * embeddings would self-deadlock RAG embedders), and the RAG via:local
 * in-process createCaller must not inherit the admission — a nested
 * acquire inside the outer HTTP slot would die QueueWaitExceeded.
 *
 * admissionTrpcError is imported through a namespace seam so the
 * missing export fails by assertion (typeof check) instead of a
 * module-load error that would break the whole file.
 */
import type { RequestQueueLimits } from "@llamactl/core/residency/queue-policy";
import type { UnifiedStreamEvent } from "@novaproto/contracts";
import type { ReadableStreamDefaultReader as WebStreamReader } from "node:stream/web";

import { saveConfig } from "@llamactl/core/config/kubeconfig";
import { freshConfig } from "@llamactl/core/config/schema";
import { TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config as kubecfg } from "../../src/index.js";
import { __setSharedUnifiedProxyForTests } from "../../src/proxy/create-proxy.js";
import {
  createRequestAdmission,
  type RequestAdmission,
  RequestAdmissionError,
} from "../../src/residency/request-admission.js";
import { type AgentRouterContext, router as appRouter } from "../../src/router.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { generateToken } from "../../src/server/auth.js";
import * as chatAdmissionModule from "../../src/server/chat-admission.js";
import { type RunningAgent, startAgentServer } from "../../src/server/serve.js";

const ENV_KEYS = [
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMA_CPP_MODELS",
  "LLAMA_CPP_HOST",
  "LLAMA_CPP_PORT",
  "LLAMACTL_UNIFIED_PROXY",
  "LLAMACTL_CONFIG",
  "LLAMACTL_USAGE_DIR",
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
// A monotonic counter keeps every message/prompt/input unique so no
// deterministic cache can ever answer a repeat; temperature is never
// sent for the same reason.

let bodySeq = 0;

function nextText(): string {
  bodySeq += 1;
  return `hi ${String(bodySeq)}`;
}

function chatRequest(): { model: string; messages: { role: string; content: string }[] } {
  return {
    model: "no-such-model",
    messages: [{ role: "user", content: nextText() }],
  };
}

function chatStreamBody(): string {
  return JSON.stringify({
    model: "no-such-model",
    stream: true,
    messages: [{ role: "user", content: nextText() }],
  });
}

function completionsBody(): string {
  return JSON.stringify({ model: "no-such-model", prompt: nextText() });
}

function embeddingsBody(): string {
  return JSON.stringify({ model: "no-such-model", input: nextText() });
}

function rerankBody(): string {
  return JSON.stringify({
    model: "no-such-model",
    query: nextText(),
    documents: [nextText()],
  });
}

function viaLocalBody(): string {
  return JSON.stringify({
    model: "no-such-model",
    via: "local",
    messages: [{ role: "user", content: nextText() }],
  });
}

function trpcChatInput(): { node: string; request: ReturnType<typeof chatRequest> } {
  return { node: "local", request: chatRequest() };
}

// ── Fake upstream ─────────────────────────────────────────────────────────

interface UpstreamGate {
  release: () => void;
  fail: () => void;
}

interface FakeUpstream {
  readonly port: number;
  hits(path: string): number;
  /** Live per-request gates, oldest first; released/failed/cancelled ones drop out. */
  readonly gates: readonly UpstreamGate[];
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
const TEXT_COMPLETION_JSON = JSON.stringify({
  id: "cmpl-admission",
  object: "text_completion",
  created: 0,
  model: "no-such-model",
  choices: [{ text: "hi", index: 0, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 1 },
});
const EMBEDDINGS_JSON = JSON.stringify({
  object: "list",
  data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
  model: "no-such-model",
  usage: { prompt_tokens: 1, total_tokens: 1 },
});
const RERANK_JSON = JSON.stringify({
  results: [{ index: 0, relevance_score: 0.9 }],
});
const UPSTREAM_500_JSON = JSON.stringify({
  error: { message: "upstream boom", type: "server_error" },
});

const UPSTREAM_PATHS = new Set([
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/embeddings",
  "/v1/rerank",
]);
const JSON_BODY: Record<string, string> = {
  "/v1/chat/completions": COMPLETION_JSON,
  "/v1/completions": TEXT_COMPLETION_JSON,
  "/v1/embeddings": EMBEDDINGS_JSON,
  "/v1/rerank": RERANK_JSON,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fake llama-server: counts hits per served path and parks every request
 * body on a per-request gate. stream===true answers SSE — one
 * chat.completion.chunk immediately, then the body parks: release()
 * enqueues [DONE] and closes, fail() errors the stream mid-flight.
 * Everything else answers application/json through a deferred gate:
 * release() resolves the path's JSON body at 200, fail() resolves a 500,
 * and a client abort resolves 499 so the gate never leaks.
 */
function startFakeUpstream(): FakeUpstream {
  const hits = new Map<string, number>();
  const gates: (UpstreamGate & { settled: boolean })[] = [];
  const drop = (gate: UpstreamGate & { settled: boolean }): void => {
    const at = gates.indexOf(gate);
    if (at !== -1) gates.splice(at, 1);
  };

  const sseGate = (): Response => {
    const cell: { gate: (UpstreamGate & { settled: boolean }) | null } = { gate: null };
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(encoder.encode(FIRST_CHUNK));
        const gate: UpstreamGate & { settled: boolean } = {
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
      cancel(): void {
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
  };

  const jsonGate = (path: string, signal: AbortSignal): Promise<Response> =>
    new Promise<Response>((resolve) => {
      const gate: UpstreamGate & { settled: boolean } = {
        settled: false,
        release: () => undefined,
        fail: () => undefined,
      };
      const finish = (res: Response): void => {
        if (gate.settled) return;
        gate.settled = true;
        drop(gate);
        resolve(res);
      };
      gate.release = (): void => {
        finish(
          new Response(JSON_BODY[path] ?? "{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      };
      gate.fail = (): void => {
        finish(
          new Response(UPSTREAM_500_JSON, {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
        );
      };
      signal.addEventListener(
        "abort",
        () => {
          finish(new Response(null, { status: 499 }));
        },
        {
          once: true,
        },
      );
      gates.push(gate);
    });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/v1/models") {
        return Response.json({ object: "list", data: [] });
      }
      if (req.method !== "POST" || !UPSTREAM_PATHS.has(path)) {
        return new Response("not found", { status: 404 });
      }
      hits.set(path, (hits.get(path) ?? 0) + 1);
      const parsed: unknown = await req.json().catch(() => null);
      const wantsStream = isRecord(parsed) && parsed["stream"] === true;
      if (wantsStream) return sseGate();
      return await jsonGate(path, req.signal);
    },
  });
  return {
    port: server.port ?? 0,
    hits: (path: string) => hits.get(path) ?? 0,
    gates,
    stop: () => server.stop(true),
  };
}

function latestGate(upstream: FakeUpstream): UpstreamGate {
  const gate = upstream.gates.at(-1);
  if (gate === undefined) throw new Error("upstream never saw a request");
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

type Opts = Parameters<typeof startAgentServer>[0];
type AgentReader = WebStreamReader;

interface PostOpts {
  signal?: AbortSignal;
}

describe("#281 DF-08: router local branches + /v1/completions share the chat cap", () => {
  let dir = "";
  let upstream: FakeUpstream;
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

  function callerWith(counted: { admission: RequestAdmission }): AgentRouterContext {
    return { chatAdmission: counted.admission };
  }

  function authedHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    };
  }

  function postChatStream(opts?: PostOpts): Promise<Response> {
    return fetch(`${agent!.url}/v1/chat/completions`, {
      method: "POST",
      headers: authedHeaders(),
      body: chatStreamBody(),
      ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    });
  }

  function postCompletions(): Promise<Response> {
    return fetch(`${agent!.url}/v1/completions`, {
      method: "POST",
      headers: authedHeaders(),
      body: completionsBody(),
    });
  }

  function postEmbeddings(): Promise<Response> {
    return fetch(`${agent!.url}/v1/embeddings`, {
      method: "POST",
      headers: authedHeaders(),
      body: embeddingsBody(),
    });
  }

  function postRerank(): Promise<Response> {
    return fetch(`${agent!.url}/v1/rerank`, {
      method: "POST",
      headers: authedHeaders(),
      body: rerankBody(),
    });
  }

  function postViaLocal(): Promise<Response> {
    return fetch(`${agent!.url}/v1/chat/completions`, {
      method: "POST",
      headers: authedHeaders(),
      body: viaLocalBody(),
    });
  }

  function postTrpcChatComplete(body: unknown, opts?: PostOpts): Promise<Response> {
    return fetch(`${agent!.url}/trpc/chatComplete`, {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify(body),
      ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
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
    dir = mkdtempSync(join(tmpdir(), "llamactl-ingress-admission-proxy-"));
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    upstream = startFakeUpstream();
    process.env["DEV_STORAGE"] = join(dir, "dev-storage");
    process.env["LOCAL_AI_RUNTIME_DIR"] = join(dir, "runtime");
    process.env["LLAMA_CPP_MODELS"] = join(dir, "models");
    process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
    process.env["LLAMA_CPP_PORT"] = String(upstream.port);
    process.env["LLAMACTL_USAGE_DIR"] = join(dir, "usage");
    const configPath = join(dir, "config.yaml");
    process.env["LLAMACTL_CONFIG"] = configPath;
    saveConfig(freshConfig(), configPath);
    Reflect.deleteProperty(process.env, "LLAMACTL_UNIFIED_PROXY");
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

  // ── fixture pin ────────────────────────────────────────────────────────

  // Pin: the temp kubeconfig's "local" node resolves to the in-process
  // endpoint, so every router case below exercises the inproc://local
  // branch rather than a remote provider.
  test("(v0) pin: node 'local' resolves to inproc://local", () => {
    const resolved = kubecfg.resolveNode(kubecfg.loadConfig(), "local");
    expect(resolved.node.endpoint).toBe("inproc://local");
  });

  // ── (p1)/(p2) shared cap across ingresses, end to end ──────────────────

  // Kills: chatComplete's inproc://local branch dispatching without
  // acquiring the shared admission (via ctx.chatAdmission), and
  // requestContext dropping opts.chatCompletionsAdmission before
  // createCaller sees it.
  test("(p1) a held chat stream queues a concurrent /trpc/chatComplete", async () => {
    const counted = countedAdmission(admission);
    startAgent(true, counted.admission);
    const res = await postChatStream();
    expect(res.status).toBe(200);
    const reader = await firstChunk(res);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);
    const streamGate = latestGate(upstream);

    const trpcPending = postTrpcChatComplete(trpcChatInput());
    void trpcPending.catch(() => undefined);
    await Bun.sleep(300);
    expect(upstream.hits("/v1/chat/completions")).toBe(1);
    expect(admission.snapshot().queued).toBe(1);

    streamGate.release();
    await drain(reader);
    expect(
      await waitFor(() => upstream.hits("/v1/chat/completions") === 2 && upstream.gates.length > 0),
    ).toBe(true);
    latestGate(upstream).release();
    const trpcRes = await trpcPending;
    expect(trpcRes.status).toBe(200);
    await trpcRes.json().catch(() => undefined);
    expect(
      await waitFor(
        () => admission.snapshot().executing === 0 && admission.snapshot().queued === 0,
      ),
    ).toBe(true);
  }, 15_000);

  // Kills: isAdmittedProxyIngress not naming /v1/completions — the
  // generic completions ingress bypasses the shared cap entirely.
  test("(p2) a held chat stream queues a concurrent /v1/completions", async () => {
    const counted = countedAdmission(admission);
    startAgent(true, counted.admission);
    const res = await postChatStream();
    expect(res.status).toBe(200);
    const reader = await firstChunk(res);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);
    const streamGate = latestGate(upstream);

    const pending = postCompletions();
    void pending.catch(() => undefined);
    await Bun.sleep(300);
    expect(upstream.hits("/v1/completions")).toBe(0);
    expect(upstream.hits("/v1/chat/completions")).toBe(1);

    streamGate.release();
    await drain(reader);
    expect(
      await waitFor(() => upstream.hits("/v1/completions") === 1 && upstream.gates.length > 0),
    ).toBe(true);
    latestGate(upstream).release();
    const completionsRes = await pending;
    expect(completionsRes.status).toBe(200);
    await completionsRes.json().catch(() => undefined);
    expect(
      await waitFor(
        () => admission.snapshot().executing === 0 && admission.snapshot().queued === 0,
      ),
    ).toBe(true);
  }, 15_000);

  // ── (p3) chatComplete local release accounting ─────────────────────────

  // Kills: acquire without release on the success path, or a double
  // release.
  test("(p3i) chatComplete releases the slot exactly once on success", async () => {
    const counted = countedAdmission(admission);
    const caller = appRouter.createCaller(callerWith(counted));
    const pending = caller.chatComplete({ node: "local", request: chatRequest() });
    void pending.catch(() => undefined);
    expect(await waitFor(() => upstream.gates.length > 0)).toBe(true);
    latestGate(upstream).release();
    const res = await pending;
    expect(res.choices).toHaveLength(1);
    expect(counted.acquires()).toBe(1);
    expect(counted.releases()).toBe(1);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // Kills: a missing release on the !res.ok path.
  test("(p3ii) chatComplete releases the slot exactly once on upstream 500", async () => {
    const counted = countedAdmission(admission);
    const caller = appRouter.createCaller(callerWith(counted));
    const pending = caller.chatComplete({ node: "local", request: chatRequest() });
    void pending.catch(() => undefined);
    expect(await waitFor(() => upstream.gates.length > 0)).toBe(true);
    latestGate(upstream).fail();
    const err = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TRPCError);
    const trpcErr = err as TRPCError;
    expect(trpcErr.code).toBe("INTERNAL_SERVER_ERROR");
    expect(trpcErr.message).toContain("local chat 500");
    expect(counted.acquires()).toBe(1);
    expect(counted.releases()).toBe(1);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // Kills: a missing finally on the forward-throw path. The throwing
  // unified proxy never reaches the upstream, so the hit count pins
  // that the rejection came from dispatch, not the fake server.
  test("(p3iii) chatComplete releases the slot exactly once when dispatch throws", async () => {
    process.env["LLAMACTL_UNIFIED_PROXY"] = "1";
    __setSharedUnifiedProxyForTests({
      unifiedEnabled: true,
      describe: () => ({ unified: true, executors: [] }),
      shadowCatalog: () => Promise.reject(new Error("unused")),
      handleRequest: () => Promise.reject(new Error("boom")),
    });
    const counted = countedAdmission(admission);
    const caller = appRouter.createCaller(callerWith(counted));
    const err = await caller.chatComplete({ node: "local", request: chatRequest() }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("boom");
    expect(upstream.hits("/v1/chat/completions")).toBe(0);
    expect(counted.acquires()).toBe(1);
    expect(counted.releases()).toBe(1);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // Kills: no release wired to the request abort — the slot would leak
  // for the whole queue-wait window.
  test("(p3iv) chatComplete releases the slot exactly once on client abort", async () => {
    const counted = countedAdmission(admission);
    startAgent(true, counted.admission);
    const ac = new AbortController();
    const pending = postTrpcChatComplete(trpcChatInput(), { signal: ac.signal });
    void pending.catch(() => undefined);
    expect(await waitFor(() => upstream.gates.length > 0)).toBe(true);

    ac.abort();
    const outcome = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    expect(outcome).not.toBeNull();
    expect(await waitFor(() => counted.releases() === 1)).toBe(true);
    expect(counted.acquires()).toBe(1);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // ── (p4) chatStream local holds the slot for the stream lifetime ───────

  // Kills: no acquire in chatStream's inproc://local branch, or a
  // release that fires before the iterator finishes.
  test("(p4a) chatStream holds the slot until the stream completes", async () => {
    const counted = countedAdmission(admission);
    const caller = appRouter.createCaller(callerWith(counted));
    const gen = (await caller.chatStream({
      node: "local",
      request: chatRequest(),
    })) as AsyncIterable<UnifiedStreamEvent>;
    const it = gen[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);
    const streamGate = latestGate(upstream);

    const comp = caller.chatComplete({ node: "local", request: chatRequest() });
    void comp.catch(() => undefined);
    await Bun.sleep(300);
    expect(upstream.hits("/v1/chat/completions")).toBe(1);

    streamGate.release();
    for (;;) {
      const next = await it.next();
      if (next.done) break;
    }
    expect(counted.releases()).toBe(1);
    expect(
      await waitFor(() => upstream.hits("/v1/chat/completions") === 2 && upstream.gates.length > 0),
    ).toBe(true);
    latestGate(upstream).release();
    const compRes = await comp;
    expect(compRes.choices).toHaveLength(1);
    expect(counted.releases()).toBe(2);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // Kills: a missing finally in chatStream — breaking the iterator early
  // must still release exactly once.
  test("(p4b) chatStream releases the slot when the consumer breaks early", async () => {
    const counted = countedAdmission(admission);
    const caller = appRouter.createCaller(callerWith(counted));
    const gen = (await caller.chatStream({
      node: "local",
      request: chatRequest(),
    })) as AsyncIterable<UnifiedStreamEvent>;
    for await (const event of gen) {
      expect(event).toBeDefined();
      break;
    }
    expect(await waitFor(() => counted.releases() === 1)).toBe(true);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // Kills: a missing finally in chatStream — an upstream error mid-stream
  // must still release exactly once.
  test("(p4c) chatStream releases the slot when the upstream fails mid-stream", async () => {
    const counted = countedAdmission(admission);
    const caller = appRouter.createCaller(callerWith(counted));
    const gen = (await caller.chatStream({
      node: "local",
      request: chatRequest(),
    })) as AsyncIterable<UnifiedStreamEvent>;
    const it = gen[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);

    latestGate(upstream).fail();
    let threw = false;
    try {
      await it.next();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(await waitFor(() => counted.releases() === 1)).toBe(true);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // ── (p5) typed refusal ─────────────────────────────────────────────────

  // Kills: QueueFull surfacing as an untyped INTERNAL_SERVER_ERROR (or a
  // bare 500/503) instead of TOO_MANY_REQUESTS carrying the
  // RequestAdmissionError as cause — and the same refusal over the wire.
  test("(p5) a full queue refuses chatComplete with TOO_MANY_REQUESTS", async () => {
    const counted = countedAdmission(admission);
    startAgent(true, counted.admission);
    const caller = appRouter.createCaller(callerWith(counted));

    const res = await postChatStream();
    expect(res.status).toBe(200);
    const reader = await firstChunk(res);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);

    const filler = caller.chatComplete({ node: "local", request: chatRequest() });
    void filler.catch(() => undefined);
    expect(await waitFor(() => admission.snapshot().queued === 1)).toBe(true);

    const thirdErr = await caller.chatComplete({ node: "local", request: chatRequest() }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thirdErr).toBeInstanceOf(TRPCError);
    const trpcErr = thirdErr as TRPCError;
    expect(trpcErr.code).toBe("TOO_MANY_REQUESTS");
    expect(trpcErr.message).toContain("chat admission refused: QueueFull");
    expect(trpcErr.message).toContain("retryAfterMs=2500");
    expect(trpcErr.cause).toBeInstanceOf(RequestAdmissionError);
    const cause = trpcErr.cause as RequestAdmissionError;
    expect(cause.code).toBe("QueueFull");
    expect(cause.retryAfterMs).toBe(2500);
    expect(upstream.hits("/v1/chat/completions")).toBe(1);

    const wire = await postTrpcChatComplete(trpcChatInput());
    expect(wire.status).toBe(429);
    const wireBody = (await wire.json()) as { error?: { message?: unknown } };
    expect(JSON.stringify(wireBody)).toContain("chat admission refused: QueueFull");

    latestGate(upstream).release();
    await drain(reader);
    expect(
      await waitFor(() => upstream.hits("/v1/chat/completions") === 2 && upstream.gates.length > 0),
    ).toBe(true);
    latestGate(upstream).release();
    const fillerRes = await filler;
    expect(fillerRes.choices).toHaveLength(1);
    expect(
      await waitFor(
        () => admission.snapshot().executing === 0 && admission.snapshot().queued === 0,
      ),
    ).toBe(true);
  }, 15_000);

  // Kills: an untyped or INTERNAL_SERVER_ERROR mapping, and mapping
  // DeadlineExceeded to TIMEOUT/408 instead of GATEWAY_TIMEOUT/504.
  // The namespace seam makes the missing export fail by assertion.
  test("(p5u) admissionTrpcError maps refusal codes to typed TRPC errors", async () => {
    const seam = (chatAdmissionModule as { admissionTrpcError?: unknown }).admissionTrpcError;
    expect(typeof seam).toBe("function");
    const map = seam as (err: RequestAdmissionError) => TRPCError;

    const bytesErr = await admission
      .acquire({
        requestId: "unit-bytes",
        principal: "agent",
        priority: "interactive",
        model: { name: "chat-completions", revision: "agent" },
        bytes: ADMISSION_LIMITS.maxQueuedBytes + 1,
        promptTokens: 0,
        maxCompletionTokens: 0,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(bytesErr).toBeInstanceOf(RequestAdmissionError);
    const bytesTrpc = map(bytesErr as RequestAdmissionError);
    expect(bytesTrpc).toBeInstanceOf(TRPCError);
    expect(bytesTrpc.code).toBe("PAYLOAD_TOO_LARGE");
    expect(getHTTPStatusCodeFromError(bytesTrpc)).toBe(413);
    expect(bytesTrpc.cause).toBeInstanceOf(RequestAdmissionError);
    expect((bytesTrpc.cause as RequestAdmissionError).code).toBe("QueueBytesExceeded");

    const deadlineTrpc = map(new RequestAdmissionError("DeadlineExceeded", null, "unit-deadline"));
    expect(deadlineTrpc).toBeInstanceOf(TRPCError);
    expect(deadlineTrpc.code).toBe("GATEWAY_TIMEOUT");
    expect(getHTTPStatusCodeFromError(deadlineTrpc)).toBe(504);
  }, 15_000);

  // ── guards (pass at base) ──────────────────────────────────────────────

  // Guard: with no chatCompletionsAdmission on the agent and no
  // chatAdmission on the caller ctx, nothing acquires — two parked
  // chatComplete calls and two parked /v1/completions calls all reach
  // the upstream concurrently. Kills: unconditional admission, or a
  // process-global default admission instance.
  test("(g1) flag off: router and /v1/completions bypass admission entirely", async () => {
    const spy = countedAdmission(admission);
    startAgent(false);
    const caller = appRouter.createCaller({});

    const c1 = caller.chatComplete({ node: "local", request: chatRequest() });
    const c2 = caller.chatComplete({ node: "local", request: chatRequest() });
    const p1 = postCompletions();
    const p2 = postCompletions();
    for (const p of [c1, c2, p1, p2]) void p.catch(() => undefined);

    expect(
      await waitFor(
        () => upstream.hits("/v1/chat/completions") === 2 && upstream.hits("/v1/completions") === 2,
      ),
    ).toBe(true);

    for (const gate of [...upstream.gates]) gate.release();
    const [r1, r2] = await Promise.all([c1, c2]);
    expect(r1.choices).toHaveLength(1);
    expect(r2.choices).toHaveLength(1);
    const [resp1, resp2] = await Promise.all([p1, p2]);
    expect(resp1.status).toBe(200);
    expect(resp2.status).toBe(200);
    expect(spy.acquires()).toBe(0);
    expect(spy.releases()).toBe(0);
  }, 15_000);

  // Guard: embeddings are NOT admitted — admitting them would
  // self-deadlock RAG embedders queued behind chat. Kills: an
  // over-broad admitted-ingress set.
  test("(g2) /v1/embeddings bypasses admission while the chat slot is held", async () => {
    const counted = countedAdmission(admission);
    startAgent(true, counted.admission);
    const res = await postChatStream();
    expect(res.status).toBe(200);
    const reader = await firstChunk(res);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);
    const streamGate = latestGate(upstream);

    const emb = postEmbeddings();
    void emb.catch(() => undefined);
    expect(await waitFor(() => upstream.hits("/v1/embeddings") === 1, 1_000)).toBe(true);
    expect(admission.snapshot().executing).toBe(1);

    latestGate(upstream).release();
    const embRes = await emb;
    expect(embRes.status).toBe(200);
    await embRes.json().catch(() => undefined);

    streamGate.release();
    await drain(reader);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // Guard: the RAG via:local path runs chatComplete through an
  // in-process createCaller({}) — it must NOT inherit the admission, or
  // the inner call nests inside the outer HTTP slot and dies
  // QueueWaitExceeded. Kills: ctx inheritance or a module-global
  // admission seam.
  test("(g3) via:local chat completes without a nested admission acquire", async () => {
    const fast = createRequestAdmission({
      limits: { ...ADMISSION_LIMITS, maxQueueWaitMs: 500 },
      load: () => Promise.resolve(),
    });
    startAgent(true, fast);
    const pending = postViaLocal();
    void pending.catch(() => undefined);
    expect(await waitFor(() => upstream.gates.length > 0)).toBe(true);
    latestGate(upstream).release();
    const res = await pending;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices?: unknown };
    expect(body.choices).toBeDefined();
    expect(upstream.hits("/v1/chat/completions")).toBe(1);
    expect(await waitFor(() => fast.snapshot().executing === 0)).toBe(true);
  }, 15_000);

  // Guard: /v1/rerank is deferred — it must NOT join the admitted set.
  // Kills: an over-broad isAdmittedProxyIngress that silently changes
  // the endpoint's scope.
  test("(g4) /v1/rerank bypasses admission while the chat slot is held", async () => {
    const counted = countedAdmission(admission);
    startAgent(true, counted.admission);
    const res = await postChatStream();
    expect(res.status).toBe(200);
    const reader = await firstChunk(res);
    expect(await waitFor(() => admission.snapshot().executing === 1)).toBe(true);
    const streamGate = latestGate(upstream);

    const rerank = postRerank();
    void rerank.catch(() => undefined);
    expect(await waitFor(() => upstream.hits("/v1/rerank") === 1, 1_000)).toBe(true);
    expect(admission.snapshot().executing).toBe(1);

    latestGate(upstream).release();
    const rerankRes = await rerank;
    expect(rerankRes.status).toBe(200);
    await rerankRes.json().catch(() => undefined);

    streamGate.release();
    await drain(reader);
    expect(await waitFor(() => admission.snapshot().executing === 0)).toBe(true);
  }, 15_000);
});
