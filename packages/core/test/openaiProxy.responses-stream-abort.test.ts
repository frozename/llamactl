import { afterAll, afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PeerNode } from "../src/config/peers.js";
import type { ResolvedEnv } from "../src/types.js";
import type { PeerSnapshot } from "../src/workloadRuntime.js";

import { resolveEnv } from "../src/env.js";
import { openaiProxy } from "../src/index.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

/**
 * #316: a /v1/responses stream:true request is forwarded upstream with
 * stream:true intact (the translated chat-completions body keeps the
 * flag), then refused with the 501 responses_translation_error envelope
 * when the upstream answers SSE. The refused upstream stream must be
 * torn down promptly — at base maybeTranslateResponse drops the Response
 * without cancelling upstream.body, so the engine keeps producing chunks
 * until the runtime's unread-body cleanup reaps it hundreds of ms later.
 *
 * The fake engine is a loopback Bun.serve streaming one SSE chunk every
 * 10ms forever; it records the first moment its request signal aborts or
 * its response body is cancelled — whichever lands first.
 */

const ENGINE_CHUNK_INTERVAL_MS = 10;
const ENGINE_MODEL = "abort-engine/stream.gguf";
// Post-fix the upstream body is cancelled inside maybeTranslateResponse
// before the 501 is returned, so the engine observes the teardown within
// a few ms and at most one in-flight 10ms tick. At base the dropped
// upstream Response is only reaped by the runtime's unread-body cleanup
// hundreds of ms later — tens of chunks past the refusal.
const ABORT_PROPAGATION_BUDGET_MS = 100;
const MAX_ENGINE_CHUNKS_DURING_ABORT = 10;

interface AbortEngineStats {
  requests: number;
  chunksEnqueued: number;
  abortedAtMs: number | null;
  chunksAtAbort: number;
  paths: string[];
  models: (string | null)[];
}

interface AbortEngine {
  readonly url: string;
  readonly port: number;
  readonly stats: AbortEngineStats;
  nextAbort(timeoutMs: number): Promise<boolean>;
  reset(): void;
  stop(): Promise<void>;
}

function sseChunkFrame(seq: number): string {
  const chunk = {
    id: "chatcmpl-abort-engine",
    object: "chat.completion.chunk",
    created: 0,
    model: ENGINE_MODEL,
    choices: [{ index: 0, delta: { content: `chunk-${String(seq)}` }, finish_reason: null }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Fake llama-server: streams one SSE chunk every ENGINE_CHUNK_INTERVAL_MS
 * forever (never [DONE]) and records the moment its response body is
 * cancelled or its request signal aborts — whichever lands first. The
 * abort timestamp shares this process's performance.now() clock with
 * the test's respondedAt timestamp, so the propagation delta is
 * measurable. Pattern copied from the remote-package abort engine; not
 * imported across packages.
 */
function startAbortEngine(): AbortEngine {
  const encoder = new TextEncoder();
  const stats: AbortEngineStats = {
    requests: 0,
    chunksEnqueued: 0,
    abortedAtMs: null,
    chunksAtAbort: 0,
    paths: [],
    models: [],
  };
  let abortWaiters: (() => void)[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req: Request): Promise<Response> {
      stats.requests += 1;
      stats.paths.push(new URL(req.url).pathname);
      let model: string | null = null;
      try {
        const parsed = (await req.json()) as { model?: unknown };
        model = typeof parsed.model === "string" ? parsed.model : null;
      } catch {
        model = null;
      }
      stats.models.push(model);

      let timer: ReturnType<typeof setInterval> | undefined;
      const markAborted = (): void => {
        if (stats.abortedAtMs !== null) return;
        stats.abortedAtMs = performance.now();
        stats.chunksAtAbort = stats.chunksEnqueued;
        if (timer !== undefined) clearInterval(timer);
        const waiters = abortWaiters;
        abortWaiters = [];
        for (const wake of waiters) wake();
      };
      req.signal.addEventListener("abort", markAborted, { once: true });

      const body = new ReadableStream<Uint8Array>({
        start(controller): void {
          const push = (): void => {
            stats.chunksEnqueued += 1;
            try {
              controller.enqueue(encoder.encode(sseChunkFrame(stats.chunksEnqueued)));
            } catch {
              // enqueue after close/cancel — the interval is cleared on cancel
            }
          };
          push();
          timer = setInterval(push, ENGINE_CHUNK_INTERVAL_MS);
        },
        cancel(): void {
          markAborted();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const port = server.port ?? 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    port,
    stats,
    nextAbort(timeoutMs: number): Promise<boolean> {
      if (stats.abortedAtMs !== null) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          abortWaiters = abortWaiters.filter((w) => w !== wake);
          resolve(false);
        }, timeoutMs);
        abortWaiters.push(wake);
      });
    },
    reset(): void {
      stats.requests = 0;
      stats.chunksEnqueued = 0;
      stats.abortedAtMs = null;
      stats.chunksAtAbort = 0;
      stats.paths.length = 0;
      stats.models.length = 0;
    },
    async stop(): Promise<void> {
      await server.stop(true);
    },
  };
}

const engine = startAbortEngine();
const tempDirs: string[] = [];

function tempEnv(): ResolvedEnv {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-openai-proxy-responses-abort-"));
  tempDirs.push(dir);
  return resolveEnv({
    DEV_STORAGE: dir,
    LOCAL_AI_RUNTIME_DIR: dir,
    LLAMA_CPP_MODELS: join(dir, "models"),
    LLAMA_CPP_HOST: "127.0.0.1",
    LLAMA_CPP_PORT: String(engine.port),
  });
}

afterEach(() => {
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
  engine.reset();
});

afterAll(async () => {
  await engine.stop();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function expectResponsesStream501TearsDownUpstream(model: string): Promise<void> {
  const res = await openaiProxy.proxyOpenAI(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: "stream me", stream: true }),
    }),
    tempEnv(),
  );

  expect(res.status).toBe(501);
  expect(await res.json()).toEqual({
    error: {
      message: "streaming is not supported for /v1/responses",
      type: "responses_translation_error",
    },
  });
  expect(engine.stats.paths).toEqual(["/v1/chat/completions"]);

  const respondedAtMs = performance.now();
  const chunksAtResponse = engine.stats.chunksEnqueued;
  expect(await engine.nextAbort(2000)).toBe(true);
  const abortedAtMs = engine.stats.abortedAtMs;
  expect(abortedAtMs).not.toBeNull();
  expect(abortedAtMs! - respondedAtMs).toBeLessThan(ABORT_PROPAGATION_BUDGET_MS);
  expect(engine.stats.chunksAtAbort - chunksAtResponse).toBeLessThanOrEqual(
    MAX_ENGINE_CHUNKS_DURING_ABORT,
  );
}

test("a /v1/responses stream:true 501 tears down the peer upstream stream (#316)", async () => {
  const peers: PeerNode[] = [{ id: "peer-r", endpoint: `http://127.0.0.1:${String(engine.port)}` }];
  const peerSnapshots = new Map<string, PeerSnapshot>([
    [
      "peer-r",
      {
        workloads: [{ modelId: "responses-peer/stream.gguf", port: 1 }],
        pressure: "NORMAL",
        fetchedAt: Date.now(),
      },
    ],
  ]);
  openaiProxy.__setOpenAIProxyClusterRoutingForTests({ clusterPeers: peers, peerSnapshots });

  await expectResponsesStream501TearsDownUpstream("responses-peer/stream.gguf");
}, 10_000);

test("a /v1/responses stream:true 501 tears down the local upstream stream (#316)", async () => {
  // No cluster routing override: "local-default/stream.gguf" matches no
  // route, so the request falls through to LLAMA_CPP_HOST:PORT — the
  // fake engine — via the default endpoint.
  await expectResponsesStream501TearsDownUpstream("local-default/stream.gguf");
}, 10_000);
