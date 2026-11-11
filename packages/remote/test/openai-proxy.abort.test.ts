import { openaiProxy } from "@llamactl/core";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
 * Root cause (#316, Bun-version honest). The original incident needs two
 * ingredients: an `agent serve` running on a Bun 1.3.x runtime, and the
 * req.signal that the chat/completions fallback dropped before #602. On
 * Bun 1.3.14 a fetch client's `reader.cancel()` neither closes the
 * connection nor propagates a passthrough-body cancel, so a body-reader
 * hangup is never observed at the far agent and the engine is never torn
 * down. On Bun 1.4.3 both happen at 0ms, so the same code propagates the
 * abort. There is no defect in the passthrough path reproducible on the
 * CI-pinned 1.4.3 — this file is the regression pin, not a fix.
 *
 * The chat/completions path (handleRagChatCompletions →
 * dispatchPlainOpenAiRequest) now carries req.signal into the rebuilt
 * Request (#602), so a client abort before response headers cancels the
 * upstream fetch. Once a streamed response has been returned, req.signal
 * never fires for that returned response, so post-header teardown rides
 * each hop's abortUpstreamOnBodyCancel (#321), the only disconnect signal
 * Bun.serve exposes on a returned body. The /v1/completions path skips the
 * RAG endpoint (handleOpenAIRoute → dispatchProxyRequest hands proxyOpenAI
 * the original request) so req.signal survives into forward()'s composed
 * upstream signal directly.
 *
 * Case 1 exercises the body-reader cancel and is therefore gated to
 * Bun >= 1.4. Cases B and C hang up with an AbortController, which closes
 * the socket on every supported runtime, so they pin the same
 * chat/completions teardown on both Bun lines. Case 2 is the
 * signal-preserving /v1/completions control.
 *
 * The discriminator is the engine's view: with a cancel-swallowing
 * abortUpstreamOnBodyCancel and req.signal dropped from the chat
 * fallback, the engine keeps producing for ~0.8-1s and 74+ chunks past
 * the client hangup; at base it observes the abort in ~0-1ms. Cases B and
 * C assert both a propagation budget and a bounded chunk count in the
 * abort window so that mutation of either teardown path fails loudly.
 */

const PEER_ID = "agent-b";
const PEER_MODEL = "abort-peer/engine-model.gguf";
const ENGINE_CHUNK_INTERVAL_MS = 10;
const ABORT_OBSERVE_TIMEOUT_MS = 4_000;
const ABORT_PROPAGATION_BUDGET_MS = 500;
const MAX_ENGINE_CHUNKS_DURING_ABORT = 10;
const AGENT_B_URL_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 30_000;

const ENV_KEYS = [
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMA_CPP_HOST",
  "LLAMA_CPP_PORT",
] as const;

/**
 * On Bun < 1.4 the fetch client's `reader.cancel()` neither closes the
 * connection nor propagates a passthrough-body cancel, so a body-reader
 * hangup never reaches the engine and case 1 cannot hold. Bun >= 1.4 does
 * both at 0ms. Version-gate only that case; the AbortController cases (B,
 * C) close the socket on every supported runtime and run everywhere.
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

function agentFetch(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${agentAToken}`);
  return fetch(`${agent!.url}${path}`, {
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

  // Mutation-measured abort latency for this case (and case C) when both
  // teardown paths are neutered (signal dropped from dispatchPlainOpenAiRequest
  // and abortUpstreamOnBodyCancel.cancel() made a no-op): the engine only
  // tears down via socket backpressure once the gone-client send buffer
  // fills. Observed engine abort latency (engine abortedAtMs - test
  // cancelAtMs) on the pinned Bun 1.4.3 over 3 runs: case B ≈875–883 ms,
  // case C ≈975–977 ms — always past ABORT_PROPAGATION_BUDGET_MS, so the
  // kill never tears down inside the budget. At base the same delta is
  // ~0–1 ms.
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
