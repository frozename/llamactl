import type { RequestQueueLimits } from "@llamactl/core/residency/queue-policy";

import { openaiProxy } from "@llamactl/core";
import { saveConfig } from "@llamactl/core/config/kubeconfig";
import { freshConfig } from "@llamactl/core/config/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __setSharedUnifiedProxyForTests } from "../src/proxy/create-proxy.js";
import {
  createRequestAdmission,
  type RequestAdmission,
} from "../src/residency/request-admission.js";
import { mkdirSync, mkdtempSync, rmSync } from "../src/safe-fs.js";
import { generateToken } from "../src/server/auth.js";
import { type RunningAgent, startAgentServer } from "../src/server/serve.js";
import { generateSelfSignedCert } from "../src/server/tls.js";
import { type ControllerClosedGuard, installControllerClosedGuard } from "./helpers.js";

/**
 * #316 (B-7): a client abort must reach the engine at the end of a
 * two-agent chain — client → agent A → agent B → fake engine.
 *
 *   fake engine (Bun.serve SSE, in this process)
 *     ↑ plain HTTP loopback
 *   agent B — test/fixtures/abort-peer-agent.ts, a real startAgentServer
 *     in a subprocess: TLS + bearer, full /v1/* dispatch, its own
 *     sandboxed DEV_STORAGE and LLAMA_CPP_* pointed at the engine
 *     ↑ HTTPS + bearer (peer route: clusterPeers + peerSnapshots)
 *   agent A — startAgentServer in this process, TLS + bearer
 *     ↑ HTTPS + bearer
 *   test client (Bun fetch, tls.ca pinned)
 *
 * Both agent hops are the production dispatch. Agent B being a real
 * startAgentServer in a subprocess makes the chain production-shaped
 * over TLS — but it all runs on loopback, not between machines.
 *
 * Two teardown paths are under test, both in the production dispatch:
 *
 *   #602  dispatchPlainOpenAiRequest (rag-chat-endpoint.ts) carries
 *         req.signal into the Request it rebuilds for the fallback, so a
 *         client hangup reaches forward()'s composed upstream signal.
 *   #321  forward() returns abortUpstreamOnBodyCancel(upstream, ...), so a
 *         cancel of the returned body aborts the upstream fetch explicitly.
 *
 * The cases cover these paths unevenly, and on Bun 1.4.3 the native
 * runtime covers most of what the two paths do. The figures below come
 * from mutation runs on Bun 1.4.3 (CI-pinned) and 1.3.14: each path was
 * removed alone, then both together. The #602 mutation deletes
 * `signal: req.signal`. The #321 mutation makes forward() return
 * `upstream`.
 *
 *   - Case D (a hangup during a held prefill, before any hop has response
 *     headers) is the only case that fails when ONLY #602 is removed, on
 *     both Bun lines. No body exists yet, so nothing but the signal can
 *     reach the engine before its hold ends.
 *   - Case E (an in-process consumer cancels the body it got from
 *     handleRequest, with no socket and so no req.signal) fails when ONLY
 *     #321 is removed on Bun 1.3.14. On Bun 1.4.3, cancelling a native
 *     fetch body closes the upstream socket by itself at ~0ms, so removing
 *     the wrapper is NOT detectable at this integration level on 1.4.3.
 *     Case E does catch a wrapper that stays in place but swallows cancel()
 *     on 1.4.3, because the JS stream then hides the native body. The
 *     wrapper's own contract (a body cancel aborts the upstream fetch
 *     signal) is pinned on every Bun by packages/core/test/
 *     openaiProxy.abort.test.ts, which fails on either Bun line when
 *     forward() returns `upstream`.
 *   - Cases 1, B and C (post-header hangups over a real socket) do not
 *     discriminate either path alone on either Bun line. Agent A's
 *     req.signal fires on socket close even after a streamed response is
 *     returned, so #602 alone covers them. Native body-cancel propagation
 *     (Bun 1.4.3) or the wrapper (either Bun) covers them without #602. On
 *     Bun 1.3.14 they fail only with both paths removed. On Bun 1.4.3 they
 *     pass even then, and fail only when #602 is removed and the wrapper's
 *     cancel() is a no-op. They are regression pins for the end-to-end
 *     behavior, not discriminators.
 *   - Case F is the non-aborted control: a finite stream reaches the client
 *     byte-for-byte through both hops and the engine never sees an abort.
 *   - Case G runs agent A with the chat-completions admission. The abort
 *     must reach the engine and release the ingress slot exactly once
 *     (admitChatCompletions → responseHoldingSlot plus the signal listener
 *     in acquireChatSlot must not double-fire).
 *   - Case U runs agent A on the unified ingress (LLAMACTL_UNIFIED_PROXY=1):
 *     create-proxy's rebuildRequest carries req.signal, and the legacy local
 *     executor composes it into the Request it hands proxyOpenAI, whose
 *     forward() composes it into the peer fetch. The catalog has no entry
 *     for PEER_MODEL here, so gatedExecute falls through to the default
 *     executor — the same executor a selected local-http candidate uses.
 *   - Case 2 is the /v1/completions control. handleOpenAIRoute →
 *     dispatchProxyRequest hands proxyOpenAI the original request, so
 *     req.signal reaches forward() without the RAG endpoint's rebuild.
 *
 * Root cause of the original incident: an `agent serve` on Bun 1.3.x,
 * where neither a cancelled fetch body nor a fetch client's
 * `reader.cancel()` closes the connection, combined with the req.signal
 * that the chat/completions fallback dropped before #602. Neither
 * ingredient reproduces as a passthrough defect on the CI-pinned 1.4.3.
 * This file is a regression pin, not a fix.
 *
 * Every case asserts on the engine's view: the abort must land within
 * ABORT_PROPAGATION_BUDGET_MS of the hangup, with a bounded chunk count.
 */

const PEER_ID = "agent-b";
const PEER_MODEL = "abort-peer/engine-model.gguf";
const ENGINE_CHUNK_INTERVAL_MS = 10;
const ABORT_OBSERVE_TIMEOUT_MS = 4_000;
const ABORT_PROPAGATION_BUDGET_MS = 500;
const MAX_ENGINE_CHUNKS_DURING_ABORT = 10;
const AGENT_B_URL_TIMEOUT_MS = 20_000;
/** Simulated prefill for case D; well past ABORT_PROPAGATION_BUDGET_MS. */
const ENGINE_PREFILL_HOLD_MS = 3_000;
const TEST_TIMEOUT_MS = 30_000;

const ENV_KEYS = [
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMA_CPP_HOST",
  "LLAMA_CPP_PORT",
  "LLAMACTL_UNIFIED_PROXY",
  "LLAMACTL_CONFIG",
] as const;

/** Chunks a finite (case F) engine stream emits before `data: [DONE]`. */
const FINITE_STREAM_CHUNKS = 5;

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

/**
 * Gate for case 1 only. On Bun < 1.4 a fetch client's `reader.cancel()`
 * neither closes the connection nor sends anything to the server, so no
 * server-side code can observe the hangup. Case 1 fails at base on 1.3.14
 * (measured), which makes the gate a client-runtime limitation, not a
 * masked server defect. Bun >= 1.4 closes the socket at ~0ms. The
 * AbortController cases (B, C, D) and the in-process case E reach the
 * server on every supported runtime, so they run ungated.
 */
function supportsBodyReaderCancelAbort(): boolean {
  const [major = 0, minor = 0] = Bun.version
    .split(".")
    .map((part): number => Number.parseInt(part, 10) || 0);
  return major > 1 || (major === 1 && minor >= 4);
}

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
  /**
   * Hold the response (headers and first byte) for this long after the
   * request arrives — a simulated prefill. The hold ends early if the
   * engine's request signal aborts. Reset to 0 between cases.
   */
  holdFirstByteMs: number;
  /**
   * When > 0, stream this many chunks then `data: [DONE]` and close
   * (case F). 0 streams forever. Reset to 0 between cases.
   */
  finiteChunks: number;
  nextAbort(timeoutMs: number): Promise<boolean>;
  reset(): void;
  stop(): Promise<void>;
}

function sseChunkFrame(seq: number): string {
  const chunk = {
    id: "chatcmpl-abort-engine",
    object: "chat.completion.chunk",
    created: 0,
    model: PEER_MODEL,
    choices: [{ index: 0, delta: { content: `chunk-${String(seq)}` }, finish_reason: null }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Fake llama-server: streams one SSE chunk every ENGINE_CHUNK_INTERVAL_MS
 * forever (never [DONE]) and records the moment its response body is
 * cancelled or its request signal aborts — whichever lands first. The
 * abort timestamp shares this process's performance.now() clock with
 * the test's cancel timestamp, so the propagation delta is measurable.
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
  // Every live chunk timer, so reset()/stop() can clear any a test leaves.
  const timers = new Set<ReturnType<typeof setInterval>>();
  const clearTimer = (t: ReturnType<typeof setInterval> | undefined): void => {
    if (t === undefined) return;
    clearInterval(t);
    timers.delete(t);
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
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
        // Clear this request's timer even when an earlier abort already
        // recorded the stats, so no interval outlives its stream.
        clearTimer(timer);
        if (stats.abortedAtMs !== null) return;
        stats.abortedAtMs = performance.now();
        stats.chunksAtAbort = stats.chunksEnqueued;
        const waiters = abortWaiters;
        abortWaiters = [];
        for (const wake of waiters) wake();
      };
      req.signal.addEventListener("abort", markAborted, { once: true });

      if (engine.holdFirstByteMs > 0) {
        await Promise.race([
          Bun.sleep(engine.holdFirstByteMs),
          new Promise<void>((resolve) => {
            if (req.signal.aborted) {
              resolve();
            } else {
              req.signal.addEventListener(
                "abort",
                () => {
                  resolve();
                },
                { once: true },
              );
            }
          }),
        ]);
        // Aborted during the held prefill: never start the chunk stream.
        if (req.signal.aborted) return new Response(null, { status: 499 });
      }

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
          if (engine.finiteChunks > 0) {
            for (let i = 0; i < engine.finiteChunks; i += 1) push();
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          }
          push();
          timer = setInterval(push, ENGINE_CHUNK_INTERVAL_MS);
          timers.add(timer);
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
  const engine: AbortEngine = {
    url: `http://127.0.0.1:${String(port)}`,
    port,
    stats,
    holdFirstByteMs: 0,
    finiteChunks: 0,
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
      for (const t of [...timers]) clearTimer(t);
      engine.holdFirstByteMs = 0;
      engine.finiteChunks = 0;
      stats.requests = 0;
      stats.chunksEnqueued = 0;
      stats.abortedAtMs = null;
      stats.chunksAtAbort = 0;
      stats.paths.length = 0;
      stats.models.length = 0;
    },
    async stop(): Promise<void> {
      for (const t of [...timers]) clearTimer(t);
      await server.stop(true);
    },
  };
  return engine;
}

type AgentBProc = Bun.Subprocess<"ignore", "pipe", "pipe">;

let sandbox = "";
let engine: AbortEngine | null = null;
let enginePort = 0;
let agent: RunningAgent | null = null;
let agentTlsCertPath = "";
let agentTlsKeyPath = "";
/** Throwaway loopback cert shared by both agents, generated per run in the sandbox. */
let testCertPem = "";
let agentAToken = "";
let agentAHash = "";
let agentBToken = "";
let agentBHash = "";
let peerAgentUrl = "";
let agentBProc: AgentBProc | null = null;
let agentBStderrDone: Promise<void> = Promise.resolve();
let agentBUrlReady: Promise<string> | null = null;
let envBackup: Record<string, string | undefined> = {};
let controllerGuard: ControllerClosedGuard;

const agentBStderrChunks: string[] = [];

function agentBStderrText(): string {
  return agentBStderrChunks.join("");
}

function drainAgentBStderr(proc: AgentBProc): void {
  agentBStderrChunks.length = 0;
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  agentBStderrDone = (async (): Promise<void> => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        agentBStderrChunks.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // stderr drain is diagnostics only — never fail the suite on it
    } finally {
      reader.releaseLock();
    }
  })();
}

/**
 * Read the fixture's first stdout line — a single {"url": ...} JSON
 * document — with an overall deadline. The losing side of the race is
 * left pending; killing the proc in afterAll closes its streams.
 */
async function readAgentBUrl(proc: AgentBProc): Promise<string> {
  const collect = (async (): Promise<string | null> => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return null;
        buffered += decoder.decode(value, { stream: true });
        const newline = buffered.indexOf("\n");
        if (newline >= 0) return buffered.slice(0, newline);
      }
    } finally {
      reader.releaseLock();
    }
  })();
  const timeout = Bun.sleep(AGENT_B_URL_TIMEOUT_MS).then(() => {
    throw new Error(
      `abort-peer-agent did not report its url within ${String(AGENT_B_URL_TIMEOUT_MS)}ms; stderr: ${agentBStderrText()}`,
    );
  });
  const line = await Promise.race([collect, timeout]);
  if (line === null) {
    throw new Error(
      `abort-peer-agent exited before reporting its url; stderr: ${agentBStderrText()}`,
    );
  }
  const parsed = JSON.parse(line) as { url?: unknown };
  if (typeof parsed.url !== "string" || parsed.url === "") {
    throw new Error(`abort-peer-agent reported a non-url line: ${line}`);
  }
  return parsed.url;
}

async function startPeerAgent(): Promise<string> {
  const env = { ...process.env };
  env["ABORT_PEER_CERT"] = agentTlsCertPath;
  env["ABORT_PEER_KEY"] = agentTlsKeyPath;
  env["ABORT_PEER_TOKEN_HASH"] = agentBHash;
  env["ABORT_PEER_DEV_STORAGE"] = join(sandbox, "agent-b");
  env["ABORT_PEER_RUNTIME_DIR"] = join(sandbox, "agent-b-runtime");
  env["ABORT_PEER_ENGINE_PORT"] = String(enginePort);
  env["LLAMACTL_DISABLE_MDNS"] = "1";
  Reflect.deleteProperty(env, "LLAMACTL_UNIFIED_PROXY");
  Reflect.deleteProperty(env, "LLAMACTL_CONFIG");
  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, "fixtures", "abort-peer-agent.ts")],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  agentBProc = proc;
  drainAgentBStderr(proc);
  return await readAgentBUrl(proc);
}

async function ensurePeerAgent(): Promise<string> {
  agentBUrlReady ??= startPeerAgent();
  peerAgentUrl = await agentBUrlReady;
  return peerAgentUrl;
}

/**
 * Point agent A's route map at the peer agent for PEER_MODEL. Called
 * inside each test (not once per describe): the snapshot's fetchedAt
 * goes stale after 30s and the override must be re-armed per case.
 */
function advertisePeerModel(): void {
  openaiProxy.__setOpenAIProxyClusterRoutingForTests({
    clusterPeers: [
      {
        id: PEER_ID,
        endpoint: peerAgentUrl,
        certificate: testCertPem,
        token: agentBToken,
      },
    ],
    peerSnapshots: new Map([
      [
        PEER_ID,
        {
          workloads: [{ modelId: PEER_MODEL, port: 1, revision: "peer-rev-1" }],
          pressure: "NORMAL" as const,
          fetchedAt: Date.now(),
        },
      ],
    ]),
  });
}

/** Poll until the engine has seen `count` requests, or the deadline passes. */
async function waitForEngineRequests(count: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (engine!.stats.requests < count) {
    if (performance.now() > deadline) return false;
    await Bun.sleep(5);
  }
  return true;
}

function agentFetch(path: string, init: RequestInit, target?: RunningAgent): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${agentAToken}`);
  return fetch(`${(target ?? agent)!.url}${path}`, {
    ...init,
    headers,
    ...({ tls: { ca: testCertPem } } as Record<string, unknown>),
  });
}

beforeAll(async () => {
  controllerGuard = installControllerClosedGuard();
  envBackup = {};
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];

  sandbox = mkdtempSync(join(tmpdir(), "llamactl-openai-proxy-abort-"));
  mkdirSync(join(sandbox, "agent-b"), { recursive: true });
  mkdirSync(join(sandbox, "agent-b-runtime"), { recursive: true });
  mkdirSync(join(sandbox, "agent-a-runtime"), { recursive: true });

  // Agent A's own resolveEnv(): empty runtime dir → no local routes, so
  // PEER_MODEL can only resolve through the peer snapshot. LLAMA_CPP_*
  // points at a dead port so a routing miss fails loudly (502) instead
  // of silently hitting the engine.
  process.env["DEV_STORAGE"] = join(sandbox, "agent-a");
  process.env["LOCAL_AI_RUNTIME_DIR"] = join(sandbox, "agent-a-runtime");
  process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
  process.env["LLAMA_CPP_PORT"] = "1";
  // Agent A's kubeconfig: a fresh sandboxed one, so the unified catalog
  // (case U) never discovers peers from the operator's real config.
  Reflect.deleteProperty(process.env, "LLAMACTL_UNIFIED_PROXY");
  const configPath = join(sandbox, "agent-a-config.yaml");
  saveConfig(freshConfig(), configPath);
  process.env["LLAMACTL_CONFIG"] = configPath;

  engine = startAbortEngine();
  enginePort = engine.port;

  const cert = await generateSelfSignedCert({
    dir: join(sandbox, "tls"),
    commonName: "127.0.0.1",
    hostnames: ["127.0.0.1", "localhost"],
  });
  agentTlsCertPath = cert.certPath;
  agentTlsKeyPath = cert.keyPath;
  testCertPem = cert.certPem;

  const tokenA = generateToken();
  agentAToken = tokenA.token;
  agentAHash = tokenA.hash;
  const tokenB = generateToken();
  agentBToken = tokenB.token;
  agentBHash = tokenB.hash;

  agent = startAgentServer({
    bindHost: "127.0.0.1",
    port: 0,
    tokenHash: tokenA.hash,
    tls: { certPath: agentTlsCertPath, keyPath: agentTlsKeyPath },
    advertiseMdns: false,
  });
});

beforeEach(() => {
  engine?.reset();
});

afterAll(async () => {
  try {
    openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
    if (agentBProc !== null) {
      agentBProc.kill("SIGTERM");
      await agentBProc.exited;
    }
    await agentBStderrDone;
    await agent?.stop();
    await engine?.stop();
    __setSharedUnifiedProxyForTests(null);
    if (sandbox !== "") rmSync(sandbox, { recursive: true, force: true });
  } finally {
    for (const key of ENV_KEYS) {
      const prev = envBackup[key];
      if (prev === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = prev;
    }
    // Dispose last so cleanup runs before any re-thrown non-benign rejection.
    controllerGuard.dispose();
  }
});

describe("client abort propagates through a real two-agent TLS chain to the engine (#316)", () => {
  test.skipIf(!supportsBodyReaderCancelAbort())(
    "case 1: POST /v1/chat/completions aborts the peer engine on a body-reader cancel (Bun >= 1.4)",
    async () => {
      await ensurePeerAgent();
      advertisePeerModel();
      const res = await agentFetch("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: PEER_MODEL,
          stream: true,
          messages: [{ role: "user", content: "hang up mid-stream" }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(new TextDecoder().decode(first.value)).toContain("chunk-");

      const chunksBeforeAbort = engine!.stats.chunksEnqueued;
      const cancelAtMs = performance.now();
      await reader.cancel();

      expect(await engine!.nextAbort(ABORT_OBSERVE_TIMEOUT_MS)).toBe(true);
      const abortedAtMs = engine!.stats.abortedAtMs;
      expect(abortedAtMs).not.toBeNull();
      expect(abortedAtMs! - cancelAtMs).toBeLessThan(ABORT_PROPAGATION_BUDGET_MS);
      expect(engine!.stats.chunksAtAbort - chunksBeforeAbort).toBeLessThanOrEqual(
        MAX_ENGINE_CHUNKS_DURING_ABORT,
      );
      expect(engine!.stats.paths).toEqual(["/v1/chat/completions"]);
      expect(engine!.stats.models).toEqual([PEER_MODEL]);
      expect(engine!.stats.requests).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  // Not a single-path discriminator (see the file header): fails on
  // Bun 1.3.14 only with both #602 and #321 removed. On 1.4.3 it fails only
  // when #602 is removed and the wrapper's cancel() is a no-op. The engine
  // then tears down only by socket backpressure, ~1s after the hangup.
  test(
    "case B: POST /v1/chat/completions aborts the peer engine on an AbortController disconnect (any Bun)",
    async () => {
      await ensurePeerAgent();
      advertisePeerModel();
      const controller = new AbortController();
      const res = await agentFetch("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: PEER_MODEL,
          stream: true,
          messages: [{ role: "user", content: "hang up mid-stream" }],
        }),
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(new TextDecoder().decode(first.value)).toContain("chunk-");

      const chunksBeforeAbort = engine!.stats.chunksEnqueued;
      const cancelAtMs = performance.now();
      controller.abort();

      expect(await engine!.nextAbort(ABORT_OBSERVE_TIMEOUT_MS)).toBe(true);
      const abortedAtMs = engine!.stats.abortedAtMs;
      expect(abortedAtMs).not.toBeNull();
      expect(abortedAtMs! - cancelAtMs).toBeLessThan(ABORT_PROPAGATION_BUDGET_MS);
      expect(engine!.stats.chunksAtAbort - chunksBeforeAbort).toBeLessThanOrEqual(
        MAX_ENGINE_CHUNKS_DURING_ABORT,
      );
      expect(engine!.stats.paths).toEqual(["/v1/chat/completions"]);
      expect(engine!.stats.models).toEqual([PEER_MODEL]);
      expect(engine!.stats.requests).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "case C: POST /v1/chat/completions aborts the peer engine when the client hangs up before reading",
    async () => {
      await ensurePeerAgent();
      advertisePeerModel();
      const controller = new AbortController();
      const res = await agentFetch("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: PEER_MODEL,
          stream: true,
          messages: [{ role: "user", content: "hang up before the first chunk" }],
        }),
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const chunksBeforeAbort = engine!.stats.chunksEnqueued;
      const cancelAtMs = performance.now();
      controller.abort();

      expect(await engine!.nextAbort(ABORT_OBSERVE_TIMEOUT_MS)).toBe(true);
      const abortedAtMs = engine!.stats.abortedAtMs;
      expect(abortedAtMs).not.toBeNull();
      expect(abortedAtMs! - cancelAtMs).toBeLessThan(ABORT_PROPAGATION_BUDGET_MS);
      expect(engine!.stats.chunksAtAbort - chunksBeforeAbort).toBeLessThanOrEqual(
        MAX_ENGINE_CHUNKS_DURING_ABORT,
      );
      expect(engine!.stats.paths).toEqual(["/v1/chat/completions"]);
      expect(engine!.stats.models).toEqual([PEER_MODEL]);
      expect(engine!.stats.requests).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  // #602 discriminator. The engine holds its response for
  // ENGINE_PREFILL_HOLD_MS, so the client hangs up while no response
  // headers exist at any hop and no body exists for a body-cancel wrapper
  // (#321) or native body-cancel propagation to act on. Only req.signal,
  // carried through dispatchPlainOpenAiRequest's rebuilt Request into
  // forward()'s composed upstream signal, can tear the chain down here.
  // With the signal dropped the engine observes the abort only once the
  // hold ends and its response meets a dead socket (≈ENGINE_PREFILL_HOLD_MS),
  // past ABORT_PROPAGATION_BUDGET_MS, on both Bun 1.3.14 and 1.4.3.
  test(
    "case D: POST /v1/chat/completions aborts the peer engine on a hangup during a held prefill (any Bun)",
    async () => {
      await ensurePeerAgent();
      advertisePeerModel();
      engine!.holdFirstByteMs = ENGINE_PREFILL_HOLD_MS;
      const controller = new AbortController();
      const pending = agentFetch("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: PEER_MODEL,
          stream: true,
          messages: [{ role: "user", content: "hang up during prefill" }],
        }),
        signal: controller.signal,
      });
      // Swallow the expected AbortError so it never surfaces as unhandled;
      // the outcome is asserted below.
      const settled = pending.then(
        () => "resolved" as const,
        (error: unknown) => (error instanceof Error ? error.name : "rejected"),
      );

      expect(await waitForEngineRequests(1, AGENT_B_URL_TIMEOUT_MS)).toBe(true);
      expect(engine!.stats.chunksEnqueued).toBe(0);

      const cancelAtMs = performance.now();
      controller.abort();

      expect(await settled).toBe("AbortError");
      expect(await engine!.nextAbort(ABORT_OBSERVE_TIMEOUT_MS)).toBe(true);
      const abortedAtMs = engine!.stats.abortedAtMs;
      expect(abortedAtMs).not.toBeNull();
      expect(abortedAtMs! - cancelAtMs).toBeLessThan(ABORT_PROPAGATION_BUDGET_MS);
      // The abort landed inside the hold: the engine never produced a byte.
      expect(engine!.stats.chunksAtAbort).toBe(0);
      expect(engine!.stats.paths).toEqual(["/v1/chat/completions"]);
      expect(engine!.stats.models).toEqual([PEER_MODEL]);
      expect(engine!.stats.requests).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  // #321 discriminator, on Bun 1.3.x only. The request enters agent A
  // through handleRequest — the socketless path tunneled requests take — so
  // there is no client connection whose close could fire req.signal. The
  // consumer then cancels the response body. Agent A's only teardown is
  // abortUpstreamOnBodyCancel aborting its fetch to agent B; agent B sees
  // that socket close as an ordinary disconnect. With the wrapper removed
  // the cancel hits the native fetch body: Bun 1.4.3 closes the upstream
  // socket natively at ~0ms (so this case still passes there), but Bun
  // 1.3.14 neither closes it nor tells agent B, and the engine streams on.
  test(
    "case E: POST /v1/chat/completions aborts the peer engine when an in-process consumer cancels the body",
    async () => {
      await ensurePeerAgent();
      advertisePeerModel();
      const handleRequest = agent!.handleRequest;
      expect(handleRequest).toBeDefined();
      const res = await handleRequest!(
        new Request(`${agent!.url}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${agentAToken}`,
          },
          body: JSON.stringify({
            model: PEER_MODEL,
            stream: true,
            messages: [{ role: "user", content: "cancel the body in-process" }],
          }),
        }),
        { address: "127.0.0.1", family: "IPv4", port: 0 },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(new TextDecoder().decode(first.value)).toContain("chunk-");

      const chunksBeforeAbort = engine!.stats.chunksEnqueued;
      const cancelAtMs = performance.now();
      await reader.cancel();

      expect(await engine!.nextAbort(ABORT_OBSERVE_TIMEOUT_MS)).toBe(true);
      const abortedAtMs = engine!.stats.abortedAtMs;
      expect(abortedAtMs).not.toBeNull();
      expect(abortedAtMs! - cancelAtMs).toBeLessThan(ABORT_PROPAGATION_BUDGET_MS);
      expect(engine!.stats.chunksAtAbort - chunksBeforeAbort).toBeLessThanOrEqual(
        MAX_ENGINE_CHUNKS_DURING_ABORT,
      );
      expect(engine!.stats.paths).toEqual(["/v1/chat/completions"]);
      expect(engine!.stats.models).toEqual([PEER_MODEL]);
      expect(engine!.stats.requests).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  // Control: a stream nobody aborts is unchanged through both hops — every
  // chunk and the [DONE] sentinel reach the client and the engine never
  // records an abort.
  test(
    "case F: a non-aborted POST /v1/chat/completions stream is delivered intact (any Bun)",
    async () => {
      await ensurePeerAgent();
      advertisePeerModel();
      engine!.finiteChunks = FINITE_STREAM_CHUNKS;
      const res = await agentFetch("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: PEER_MODEL,
          stream: true,
          messages: [{ role: "user", content: "read to the end" }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      for (let i = 1; i <= FINITE_STREAM_CHUNKS; i += 1) {
        expect(text).toContain(`chunk-${String(i)}"`);
      }
      expect(text).toContain("data: [DONE]");
      await Bun.sleep(100);
      expect(engine!.stats.abortedAtMs).toBeNull();
      expect(engine!.stats.chunksEnqueued).toBe(FINITE_STREAM_CHUNKS);
      expect(engine!.stats.requests).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  // Admission: agent A holds a chat-completions slot for the streamed body.
  // A client abort mid-stream must reach the engine within the budget and
  // release that slot exactly once — the body-cancel path
  // (responseHoldingSlot) and the req.signal listener (acquireChatSlot)
  // both fire on a hangup and must not double-release.
  test(
    "case G: an admitted POST /v1/chat/completions abort reaches the engine and releases the slot once",
    async () => {
      await ensurePeerAgent();
      advertisePeerModel();
      const inner = createRequestAdmission({
        limits: ADMISSION_LIMITS,
        load: () => Promise.resolve(),
      });
      const counted = countedAdmission(inner);
      const admitted = startAgentServer({
        bindHost: "127.0.0.1",
        port: 0,
        tokenHash: agentAHash,
        tls: { certPath: agentTlsCertPath, keyPath: agentTlsKeyPath },
        advertiseMdns: false,
        chatCompletionsAdmission: counted.admission,
      });
      try {
        const controller = new AbortController();
        const res = await agentFetch(
          "/v1/chat/completions",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: PEER_MODEL,
              stream: true,
              messages: [{ role: "user", content: "hang up while admitted" }],
            }),
            signal: controller.signal,
          },
          admitted,
        );
        expect(res.status).toBe(200);
        const reader = res.body!.getReader();
        const first = await reader.read();
        expect(first.done).toBe(false);
        expect(counted.acquires()).toBe(1);
        expect(inner.snapshot().executing).toBe(1);
        expect(counted.releases()).toBe(0);

        const chunksBeforeAbort = engine!.stats.chunksEnqueued;
        const cancelAtMs = performance.now();
        controller.abort();

        expect(await engine!.nextAbort(ABORT_OBSERVE_TIMEOUT_MS)).toBe(true);
        expect(engine!.stats.abortedAtMs! - cancelAtMs).toBeLessThan(ABORT_PROPAGATION_BUDGET_MS);
        expect(engine!.stats.chunksAtAbort - chunksBeforeAbort).toBeLessThanOrEqual(
          MAX_ENGINE_CHUNKS_DURING_ABORT,
        );
        const deadline = performance.now() + ABORT_OBSERVE_TIMEOUT_MS;
        while (counted.releases() === 0 && performance.now() < deadline) await Bun.sleep(5);
        expect(counted.releases()).toBe(1);
        expect(inner.snapshot().executing).toBe(0);
        await Bun.sleep(200);
        expect(counted.releases()).toBe(1);
        expect(counted.acquires()).toBe(1);
        expect(engine!.stats.requests).toBe(1);
      } finally {
        await admitted.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // Unified ingress: the same hangup with LLAMACTL_UNIFIED_PROXY=1 on agent A
  // (dispatchProxyRequest reads the flag per request). Agent B stays on the
  // legacy dispatch, which the cases above already pin.
  test(
    "case U: POST /v1/chat/completions on the unified ingress aborts the peer engine (any Bun)",
    async () => {
      await ensurePeerAgent();
      advertisePeerModel();
      process.env["LLAMACTL_UNIFIED_PROXY"] = "1";
      __setSharedUnifiedProxyForTests(null);
      try {
        const controller = new AbortController();
        const res = await agentFetch("/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: PEER_MODEL,
            stream: true,
            messages: [{ role: "user", content: "hang up on the unified ingress" }],
          }),
          signal: controller.signal,
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");
        const reader = res.body!.getReader();
        const first = await reader.read();
        expect(first.done).toBe(false);
        expect(new TextDecoder().decode(first.value)).toContain("chunk-");

        const chunksBeforeAbort = engine!.stats.chunksEnqueued;
        const cancelAtMs = performance.now();
        controller.abort();

        expect(await engine!.nextAbort(ABORT_OBSERVE_TIMEOUT_MS)).toBe(true);
        expect(engine!.stats.abortedAtMs! - cancelAtMs).toBeLessThan(ABORT_PROPAGATION_BUDGET_MS);
        expect(engine!.stats.chunksAtAbort - chunksBeforeAbort).toBeLessThanOrEqual(
          MAX_ENGINE_CHUNKS_DURING_ABORT,
        );
        expect(engine!.stats.paths).toEqual(["/v1/chat/completions"]);
        expect(engine!.stats.models).toEqual([PEER_MODEL]);
        expect(engine!.stats.requests).toBe(1);
      } finally {
        Reflect.deleteProperty(process.env, "LLAMACTL_UNIFIED_PROXY");
        __setSharedUnifiedProxyForTests(null);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // Unified ingress, held prefill: no response headers exist at any hop, so
  // only req.signal — through rebuildRequest and the legacy executor's
  // composed Request — can tear the chain down inside the budget.
  test(
    "case UD: the unified ingress aborts the peer engine on a hangup during a held prefill (any Bun)",
    async () => {
      await ensurePeerAgent();
      advertisePeerModel();
      engine!.holdFirstByteMs = ENGINE_PREFILL_HOLD_MS;
      process.env["LLAMACTL_UNIFIED_PROXY"] = "1";
      __setSharedUnifiedProxyForTests(null);
      try {
        const controller = new AbortController();
        const pending = agentFetch("/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: PEER_MODEL,
            stream: true,
            messages: [{ role: "user", content: "hang up during a unified prefill" }],
          }),
          signal: controller.signal,
        });
        const settled = pending.then(
          () => "resolved" as const,
          (error: unknown) => (error instanceof Error ? error.name : "rejected"),
        );
        expect(await waitForEngineRequests(1, AGENT_B_URL_TIMEOUT_MS)).toBe(true);

        const cancelAtMs = performance.now();
        controller.abort();

        expect(await settled).toBe("AbortError");
        expect(await engine!.nextAbort(ABORT_OBSERVE_TIMEOUT_MS)).toBe(true);
        expect(engine!.stats.abortedAtMs! - cancelAtMs).toBeLessThan(ABORT_PROPAGATION_BUDGET_MS);
        expect(engine!.stats.chunksAtAbort).toBe(0);
        expect(engine!.stats.requests).toBe(1);
      } finally {
        Reflect.deleteProperty(process.env, "LLAMACTL_UNIFIED_PROXY");
        __setSharedUnifiedProxyForTests(null);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "case 2: POST /v1/completions aborts the peer engine via the signal-preserving /v1/* dispatch",
    async () => {
      await ensurePeerAgent();
      advertisePeerModel();
      const controller = new AbortController();
      const res = await agentFetch("/v1/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: PEER_MODEL,
          stream: true,
          prompt: "hang up mid-stream",
        }),
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(new TextDecoder().decode(first.value)).toContain("chunk-");

      const chunksBeforeAbort = engine!.stats.chunksEnqueued;
      const cancelAtMs = performance.now();
      controller.abort();

      expect(await engine!.nextAbort(ABORT_OBSERVE_TIMEOUT_MS)).toBe(true);
      const abortedAtMs = engine!.stats.abortedAtMs;
      expect(abortedAtMs).not.toBeNull();
      expect(abortedAtMs! - cancelAtMs).toBeLessThan(ABORT_PROPAGATION_BUDGET_MS);
      expect(engine!.stats.chunksAtAbort - chunksBeforeAbort).toBeLessThanOrEqual(
        MAX_ENGINE_CHUNKS_DURING_ABORT,
      );
      expect(engine!.stats.paths).toEqual(["/v1/completions"]);
      expect(engine!.stats.models).toEqual([PEER_MODEL]);
      expect(engine!.stats.requests).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});
