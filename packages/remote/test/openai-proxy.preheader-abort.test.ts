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
 * #316 (pre-header): a client abort must reach the peer engine while the
 * upstream fetch is still waiting on response headers — the long-prefill /
 * non-streaming decode window where body-cancel propagation (#321) cannot
 * help because no Response exists yet to cancel.
 *
 *   fake peer engine (Bun.serve, in this process — holds ~10s pre-headers)
 *     ↑ plain HTTP loopback
 *   llamactl agent — startAgentServer in this process, TLS + bearer,
 *     its own sandboxed DEV_STORAGE / LOCAL_AI_RUNTIME_DIR and
 *     LLAMA_CPP_* pointed at a dead port so only the peer route resolves
 *     ↑ HTTPS + bearer
 *   test client (Bun fetch, tls.ca pinned, AbortController)
 *
 * POST /v1/chat/completions goes through handleRagChatCompletions, whose
 * plain-OpenAI fallback rebuilds the Request WITHOUT req.signal — at base
 * the client abort dies there and the engine holds to its 10s timer.
 * POST /v1/completions skips that endpoint: handleOpenAIRoute →
 * dispatchProxyRequest hands proxyOpenAI the original Request, so the
 * signal survives into forward()'s composed upstream signal — the control
 * that must stay green.
 */

const PEER_ID = "engine";
const MODEL = "preheader-abort/engine-model.gguf";
const ENGINE_HOLD_MS = 10_000;
const ABORT_OBSERVE_TIMEOUT_MS = 2_000;
const ABORT_PROPAGATION_BUDGET_MS = 1_000;
const TEST_TIMEOUT_MS = 15_000;

const ENV_KEYS = [
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMA_CPP_HOST",
  "LLAMA_CPP_PORT",
] as const;

interface PreHeaderEngineStats {
  requests: number;
  abortedAtMs: number | null;
  paths: string[];
}

interface PreHeaderEngine {
  readonly url: string;
  readonly port: number;
  readonly stats: PreHeaderEngineStats;
  waitForRequest(): Promise<void>;
  nextAbort(timeoutMs: number): Promise<boolean>;
  reset(): void;
  stop(): Promise<void>;
}

/**
 * Fake peer engine: records each request, wakes waitForRequest, then holds
 * the response for ENGINE_HOLD_MS — or until the request signal aborts —
 * before returning headers. Sending no headers early simulates a long
 * prefill or a non-streaming decode, the window where only req.signal
 * (not body cancel) can carry the client abort upstream.
 */
function startPreHeaderEngine(): PreHeaderEngine {
  const stats: PreHeaderEngineStats = {
    requests: 0,
    abortedAtMs: null,
    paths: [],
  };
  let abortWaiters: (() => void)[] = [];
  let receivedWaiters: (() => void)[] = [];

  const markAborted = (): void => {
    if (stats.abortedAtMs !== null) return;
    stats.abortedAtMs = performance.now();
    const waiters = abortWaiters;
    abortWaiters = [];
    for (const wake of waiters) wake();
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      stats.requests += 1;
      stats.paths.push(new URL(req.url).pathname);
      const received = receivedWaiters;
      receivedWaiters = [];
      for (const wake of received) wake();

      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          clearTimeout(timer);
          markAborted();
          resolve();
        };
        const timer = setTimeout(() => {
          req.signal.removeEventListener("abort", onAbort);
          resolve();
        }, ENGINE_HOLD_MS);
        req.signal.addEventListener("abort", onAbort, { once: true });
      });
      return Response.json({ ok: true });
    },
  });

  const port = server.port ?? 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    port,
    stats,
    waitForRequest(): Promise<void> {
      if (stats.requests > 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        receivedWaiters.push(resolve);
      });
    },
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
      stats.abortedAtMs = null;
      stats.paths.length = 0;
      abortWaiters = [];
      receivedWaiters = [];
    },
    async stop(): Promise<void> {
      await server.stop(true);
    },
  };
}

let sandbox = "";
let engine: PreHeaderEngine | null = null;
let agent: RunningAgent | null = null;
let agentToken = "";
let certPem = "";
let envBackup: Record<string, string | undefined> = {};
let controllerGuard: ControllerClosedGuard;

/**
 * Point the agent's route map at the fake engine for MODEL. Called inside
 * each test: the snapshot's fetchedAt goes stale after 30s and the override
 * must be re-armed per case.
 */
function advertiseEngineModel(): void {
  openaiProxy.__setOpenAIProxyClusterRoutingForTests({
    clusterPeers: [{ id: PEER_ID, endpoint: engine!.url }],
    peerSnapshots: new Map([
      [
        PEER_ID,
        {
          workloads: [{ modelId: MODEL, port: 1 }],
          pressure: "NORMAL" as const,
          fetchedAt: Date.now(),
        },
      ],
    ]),
  });
}

function agentFetch(
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("authorization", `Bearer ${agentToken}`);
  return fetch(`${agent!.url}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
    ...({ tls: { ca: certPem } } as Record<string, unknown>),
  });
}

beforeAll(async () => {
  controllerGuard = installControllerClosedGuard();
  envBackup = {};
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];

  sandbox = mkdtempSync(join(tmpdir(), "llamactl-openai-proxy-preheader-abort-"));
  const runtimeDir = join(sandbox, "runtime");
  mkdirSync(runtimeDir, { recursive: true });

  // Empty runtime dir → no local routes, so MODEL resolves only through
  // the peer snapshot. LLAMA_CPP_PORT=1 makes a routing miss fail loudly
  // (502 to a dead port) instead of hitting a real server.
  process.env["DEV_STORAGE"] = join(sandbox, "dev-storage");
  process.env["LOCAL_AI_RUNTIME_DIR"] = runtimeDir;
  process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
  process.env["LLAMA_CPP_PORT"] = "1";

  engine = startPreHeaderEngine();

  const cert = await generateSelfSignedCert({
    dir: join(sandbox, "tls"),
    commonName: "127.0.0.1",
    hostnames: ["127.0.0.1", "localhost"],
  });
  certPem = cert.certPem;

  const token = generateToken();
  agentToken = token.token;

  agent = startAgentServer({
    bindHost: "127.0.0.1",
    port: 0,
    tokenHash: token.hash,
    tls: { certPath: cert.certPath, keyPath: cert.keyPath },
    advertiseMdns: false,
  });
});

beforeEach(() => {
  engine?.reset();
});

afterAll(async () => {
  try {
    openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
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

describe("client abort reaches the peer engine before response headers (#316)", () => {
  test(
    "POST /v1/chat/completions stream:false aborts the engine pre-headers",
    async () => {
      advertiseEngineModel();
      const controller = new AbortController();
      const fetchPromise = agentFetch(
        "/v1/chat/completions",
        {
          model: MODEL,
          stream: false,
          messages: [{ role: "user", content: "hang up during prefill" }],
        },
        controller.signal,
      ).catch(() => null);

      await engine!.waitForRequest();
      const t0 = performance.now();
      controller.abort();
      await fetchPromise;

      expect(await engine!.nextAbort(ABORT_OBSERVE_TIMEOUT_MS)).toBe(true);
      const abortedAtMs = engine!.stats.abortedAtMs;
      expect(abortedAtMs).not.toBeNull();
      expect(abortedAtMs! - t0).toBeLessThan(ABORT_PROPAGATION_BUDGET_MS);
      expect(engine!.stats.requests).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "POST /v1/chat/completions stream:true aborts the engine before the first SSE byte",
    async () => {
      advertiseEngineModel();
      const controller = new AbortController();
      const fetchPromise = agentFetch(
        "/v1/chat/completions",
        {
          model: MODEL,
          stream: true,
          messages: [{ role: "user", content: "hang up mid-prefill" }],
        },
        controller.signal,
      ).catch(() => null);

      await engine!.waitForRequest();
      const t0 = performance.now();
      controller.abort();
      await fetchPromise;

      expect(await engine!.nextAbort(ABORT_OBSERVE_TIMEOUT_MS)).toBe(true);
      const abortedAtMs = engine!.stats.abortedAtMs;
      expect(abortedAtMs).not.toBeNull();
      expect(abortedAtMs! - t0).toBeLessThan(ABORT_PROPAGATION_BUDGET_MS);
      expect(engine!.stats.requests).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "POST /v1/completions stream:false aborts the engine pre-headers (control: original Request reaches proxyOpenAI)",
    async () => {
      advertiseEngineModel();
      const controller = new AbortController();
      const fetchPromise = agentFetch(
        "/v1/completions",
        {
          model: MODEL,
          stream: false,
          prompt: "hang up during decode",
        },
        controller.signal,
      ).catch(() => null);

      await engine!.waitForRequest();
      const t0 = performance.now();
      controller.abort();
      await fetchPromise;

      expect(await engine!.nextAbort(ABORT_OBSERVE_TIMEOUT_MS)).toBe(true);
      const abortedAtMs = engine!.stats.abortedAtMs;
      expect(abortedAtMs).not.toBeNull();
      expect(abortedAtMs! - t0).toBeLessThan(ABORT_PROPAGATION_BUDGET_MS);
      expect(engine!.stats.requests).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});
