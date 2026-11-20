import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PeerNode } from "../src/config/peers.js";
import type {
  SessionRefcounts,
  SessionReleaseResult,
  SessionSnapshot,
} from "../src/residency/sessions.js";
import type { ResolvedEnv } from "../src/types.js";
import type { PeerSnapshot } from "../src/workloadRuntime.js";
import type { ConditionalUpstream } from "./conditionalUpstream.js";

import { resolveEnv } from "../src/env.js";
import { openaiProxy } from "../src/index.js";
import { createResidencyLeases, setResidencyLeaseRegistry } from "../src/residency/leases.js";
import { createSessionRefcounts, setSessionRefcountRegistry } from "../src/residency/sessions.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { installConditionalChatUpstream } from "./conditionalUpstream.js";

// #520: a response-cache hit returns before session acquisition, so the
// session binding a hit serves is never refreshed and idle-expires under a
// warm cache. These cases pin the touch-on-hit contract: the hit refreshes
// the binding for the workload that served it, takes no ref and no lease,
// leaves sessions bound elsewhere alone, and survives a throwing registry.

const SESSION_HEADER = "x-llamactl-session";
const KV_MODEL = "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf";
const OTHER_MODEL = "Other-GGUF/other-Q4_K_M.gguf";
const IDLE_TIMEOUT_MS = 10_000;
const WL_A_PORT = 19731;
const WL_B_PORT = 19732;
const PEER_NODE_ID = "mac-mini";
const PEER_MODEL = "peer/granite-3b.gguf";
const PEER_PORT = 19733;
// listClusterRoutes synthesises a peer route's workload as `<node>:<model>`.
const PEER_WORKLOAD = `${PEER_NODE_ID}:${PEER_MODEL}`;

const originalFetch = globalThis.fetch;

afterEach(() => {
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  globalThis.fetch = originalFetch;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

interface TempRuntime {
  root: string;
  env: ResolvedEnv;
  cleanup: () => void;
}

function makeTempRuntime(): TempRuntime {
  const root = mkdtempSync(join(tmpdir(), "llamactl-session-cache-hit-"));
  return {
    root,
    env: resolveEnv({
      DEV_STORAGE: root,
      LOCAL_AI_RUNTIME_DIR: root,
      LLAMA_CPP_MODELS: join(root, "models"),
      LLAMA_CPP_MACHINE_PROFILE: "balanced",
      LLAMA_CPP_QWEN_CTX_SIZE: "32768",
    }),
    cleanup: (): void => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeModelRunWorkload(
  runtimeRoot: string,
  workload: string,
  port: number,
  rel: string,
): void {
  const dir = join(runtimeRoot, "workloads", workload);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server.pid"), `${String(process.pid)}\n`);
  writeFileSync(
    join(dir, "llama-server.state"),
    JSON.stringify({
      rel,
      extraArgs: [],
      host: "127.0.0.1",
      port,
      binary: "/x/llama-server",
      pid: process.pid,
      startedAt: "2026-05-24T00:00:00.000Z",
      tunedProfile: null,
    }),
  );
}

function chatBody(model: string): string {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: `session cache hit ${model}` }],
    temperature: 0,
  });
}

function chatRequest(body: string, sessionId?: string): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(sessionId === undefined ? {} : { [SESSION_HEADER]: sessionId }),
    },
    body,
  });
}

function chatCompletionCalls(upstream: ConditionalUpstream): number {
  return upstream.calls.filter(
    (call) => call.method === "POST" && new URL(call.url).pathname === "/v1/chat/completions",
  ).length;
}

function sessionSnapshot(registry: SessionRefcounts): SessionSnapshot {
  if (registry.snapshot === undefined) {
    throw new Error("session registry has no snapshot");
  }
  return registry.snapshot();
}

function touchThrowingRegistry(real: SessionRefcounts): SessionRefcounts {
  return {
    acquire: (sessionId, workload) => real.acquire(sessionId, workload),
    release: (sessionId, generation): void => {
      real.release(sessionId, generation);
    },
    cancelAcquire: (sessionId, generation): void => {
      real.cancelAcquire?.(sessionId, generation);
    },
    touch: (): void => {
      throw new Error("boom touch");
    },
    forceRelease: (workload) => real.forceRelease(workload),
    activeSessions: (workload) => real.activeSessions(workload),
    checkUnload: (workload, opts) => real.checkUnload(workload, opts),
    snapshot: (): SessionSnapshot => {
      const snap = real.snapshot?.();
      if (snap === undefined) {
        throw new Error("session registry has no snapshot");
      }
      return snap;
    },
    releaseSession: (sessionId, opts): SessionReleaseResult =>
      real.releaseSession?.(sessionId, opts) ?? {
        ok: false,
        reason: "SessionNotFound",
        sessionId,
      },
  };
}

function peerClusterRouting(): {
  clusterPeers: PeerNode[];
  peerSnapshots: Map<string, PeerSnapshot>;
} {
  const clusterPeers: PeerNode[] = [
    { id: PEER_NODE_ID, endpoint: `http://127.0.0.1:${String(PEER_PORT)}` },
  ];
  const snapshot: PeerSnapshot = {
    workloads: [{ modelId: PEER_MODEL, port: PEER_PORT, revision: null }],
    pressure: "NORMAL",
    fetchedAt: Date.now(),
  };
  return { clusterPeers, peerSnapshots: new Map([[PEER_NODE_ID, snapshot]]) };
}

// Guard notes for touchSessionOnCacheHit (P5, P7): no behavioural tests, as
// both guards are equivalent to proxyOpenAI's acquire gate for every
// proxy-reachable state.
// - `leaseRegistry === null`: the acquire gate skips session acquisition on
//   the same null check, so with no lease registry the proxy never binds a
//   session and the hit has no proxy-made binding to refresh.
// - session-id validation: an id that fails the length/pattern check is
//   refused (400) by acquireProxySession, so it is never bound and
//   activeSessions(...).includes(id) is already false for it.

describe("#520 response-cache hit session refresh", () => {
  test("C1: a warm hit refreshes the binding so it survives the idle timeout", async () => {
    const runtime = makeTempRuntime();
    try {
      writeModelRunWorkload(runtime.root, "wl-a", WL_A_PORT, KV_MODEL);
      const upstream = installConditionalChatUpstream();
      let nowMs = 0;
      const sessions = createSessionRefcounts({
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        now: () => nowMs,
      });
      setSessionRefcountRegistry(sessions);
      setResidencyLeaseRegistry(createResidencyLeases());
      const body = chatBody(KV_MODEL);

      const miss = await openaiProxy.proxyOpenAI(chatRequest(body, "s1"), runtime.env);
      expect(miss.status).toBe(200);
      expect(await miss.text()).toContain("fixture reply");
      expect(chatCompletionCalls(upstream)).toBe(1);

      nowMs = 8_000;
      const hit = await openaiProxy.proxyOpenAI(chatRequest(body, "s1"), runtime.env);
      expect(hit.status).toBe(200);
      expect(await hit.text()).toContain("fixture reply");
      expect(chatCompletionCalls(upstream)).toBe(1);
      expect(openaiProxy.__getOpenAIProxyResponseCacheHitTotalForTests(runtime.env)).toBe(1);

      nowMs = 15_000;
      expect(sessions.activeSessions("wl-a")).toEqual(["s1"]);
      expect(sessions.checkUnload("wl-a")).toEqual({
        ok: false,
        reason: "SessionActive",
        sessions: ["s1"],
      });
    } finally {
      runtime.cleanup();
    }
  });

  test("C2: a warm hit touches the binding without taking a ref or a lease", async () => {
    const runtime = makeTempRuntime();
    try {
      writeModelRunWorkload(runtime.root, "wl-a", WL_A_PORT, KV_MODEL);
      const upstream = installConditionalChatUpstream();
      let nowMs = 0;
      const sessions = createSessionRefcounts({
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        now: () => nowMs,
      });
      setSessionRefcountRegistry(sessions);
      const leases = createResidencyLeases();
      setResidencyLeaseRegistry(leases);
      const body = chatBody(KV_MODEL);

      const miss = await openaiProxy.proxyOpenAI(chatRequest(body, "s1"), runtime.env);
      expect(miss.status).toBe(200);
      expect(await miss.text()).toContain("fixture reply");

      nowMs = 8_000;
      const hit = await openaiProxy.proxyOpenAI(chatRequest(body, "s1"), runtime.env);
      expect(hit.status).toBe(200);
      expect(await hit.text()).toContain("fixture reply");
      expect(chatCompletionCalls(upstream)).toBe(1);

      expect(sessionSnapshot(sessions).sessions).toEqual([
        {
          sessionId: "s1",
          workload: "wl-a",
          refs: 0,
          idleMs: 0,
          expiresInMs: IDLE_TIMEOUT_MS,
        },
      ]);
      expect(leases.snapshot("wl-a").active).toEqual([]);
    } finally {
      runtime.cleanup();
    }
  });

  test("G1: a warm hit leaves a session bound to another workload untouched", async () => {
    const runtime = makeTempRuntime();
    try {
      writeModelRunWorkload(runtime.root, "wl-a", WL_A_PORT, KV_MODEL);
      writeModelRunWorkload(runtime.root, "wl-b", WL_B_PORT, OTHER_MODEL);
      const upstream = installConditionalChatUpstream();
      let nowMs = 0;
      const sessions = createSessionRefcounts({
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        now: () => nowMs,
      });
      setSessionRefcountRegistry(sessions);
      setResidencyLeaseRegistry(createResidencyLeases());
      const body = chatBody(KV_MODEL);

      const bound = sessions.acquire("s1", "wl-b");
      expect(bound.ok).toBe(true);
      if (bound.ok) {
        sessions.release("s1", bound.generation);
      }

      const seed = await openaiProxy.proxyOpenAI(chatRequest(body), runtime.env);
      expect(seed.status).toBe(200);
      const seedText = await seed.text();
      expect(chatCompletionCalls(upstream)).toBe(1);

      nowMs = 8_000;
      const hit = await openaiProxy.proxyOpenAI(chatRequest(body, "s1"), runtime.env);
      expect(hit.status).toBe(200);
      expect(await hit.text()).toBe(seedText);
      expect(chatCompletionCalls(upstream)).toBe(1);
      expect(openaiProxy.__getOpenAIProxyResponseCacheHitTotalForTests(runtime.env)).toBe(1);

      const rows = sessionSnapshot(sessions).sessions;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        sessionId: "s1",
        workload: "wl-b",
        refs: 0,
        idleMs: 8_000,
      });
      expect(sessions.activeSessions("wl-a")).toEqual([]);
    } finally {
      runtime.cleanup();
    }
  });

  test("G2: a warm hit without a session header records nothing", async () => {
    const runtime = makeTempRuntime();
    try {
      writeModelRunWorkload(runtime.root, "wl-a", WL_A_PORT, KV_MODEL);
      const upstream = installConditionalChatUpstream();
      const sessions = createSessionRefcounts({
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        now: () => 0,
      });
      setSessionRefcountRegistry(sessions);
      setResidencyLeaseRegistry(createResidencyLeases());
      const body = chatBody(KV_MODEL);

      const miss = await openaiProxy.proxyOpenAI(chatRequest(body), runtime.env);
      expect(miss.status).toBe(200);
      expect(await miss.text()).toContain("fixture reply");

      const hit = await openaiProxy.proxyOpenAI(chatRequest(body), runtime.env);
      expect(hit.status).toBe(200);
      expect(await hit.text()).toContain("fixture reply");
      expect(chatCompletionCalls(upstream)).toBe(1);
      expect(sessionSnapshot(sessions).sessions).toEqual([]);
    } finally {
      runtime.cleanup();
    }
  });

  test("G3: a registry that throws on touch still serves the cached response", async () => {
    const runtime = makeTempRuntime();
    try {
      writeModelRunWorkload(runtime.root, "wl-a", WL_A_PORT, KV_MODEL);
      const upstream = installConditionalChatUpstream();
      let nowMs = 0;
      const real = createSessionRefcounts({
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        now: () => nowMs,
      });
      setSessionRefcountRegistry(touchThrowingRegistry(real));
      setResidencyLeaseRegistry(createResidencyLeases());
      const body = chatBody(KV_MODEL);

      const miss = await openaiProxy.proxyOpenAI(chatRequest(body, "s1"), runtime.env);
      expect(miss.status).toBe(200);
      const missText = await miss.text();

      nowMs = 8_000;
      const hit = await openaiProxy.proxyOpenAI(chatRequest(body, "s1"), runtime.env);
      expect(hit.status).toBe(200);
      expect(await hit.text()).toBe(missText);
      expect(chatCompletionCalls(upstream)).toBe(1);
    } finally {
      runtime.cleanup();
    }
  });
  test("G4: a warm hit served via a peer route does not refresh a local binding (mutation: drop the isPeer guard)", async () => {
    const runtime = makeTempRuntime();
    try {
      const upstream = installConditionalChatUpstream();
      openaiProxy.__setOpenAIProxyClusterRoutingForTests(peerClusterRouting());
      let nowMs = 0;
      const sessions = createSessionRefcounts({
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        now: () => nowMs,
      });
      setSessionRefcountRegistry(sessions);
      setResidencyLeaseRegistry(createResidencyLeases());
      const body = chatBody(PEER_MODEL);

      // A local binding whose workload id equals the peer route's workload,
      // so only the isPeer guard keeps the peer-served hit from touching it.
      const bound = sessions.acquire("s1", PEER_WORKLOAD);
      expect(bound.ok).toBe(true);
      if (bound.ok) {
        sessions.release("s1", bound.generation);
      }

      const seed = await openaiProxy.proxyOpenAI(chatRequest(body), runtime.env);
      expect(seed.status).toBe(200);
      const seedText = await seed.text();
      expect(chatCompletionCalls(upstream)).toBe(1);

      nowMs = 8_000;
      const hit = await openaiProxy.proxyOpenAI(chatRequest(body, "s1"), runtime.env);
      expect(hit.status).toBe(200);
      expect(await hit.text()).toBe(seedText);
      expect(chatCompletionCalls(upstream)).toBe(1);
      expect(openaiProxy.__getOpenAIProxyResponseCacheHitTotalForTests(runtime.env)).toBe(1);

      expect(sessionSnapshot(sessions).sessions).toEqual([
        {
          sessionId: "s1",
          workload: PEER_WORKLOAD,
          refs: 0,
          idleMs: 8_000,
          expiresInMs: IDLE_TIMEOUT_MS - 8_000,
        },
      ]);

      nowMs = 15_000;
      expect(sessions.activeSessions(PEER_WORKLOAD)).toEqual([]);
    } finally {
      runtime.cleanup();
    }
  });
});
