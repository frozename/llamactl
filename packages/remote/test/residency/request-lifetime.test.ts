/**
 * #278 DF-05 — request-lifetime residency leases across every inference
 * ingress. Each of POST /v1/chat/completions, POST /v1/messages,
 * POST /v1/responses and the legacy local executor must acquire one lease
 * keyed by the routed workload, hold it for the whole response-body
 * lifetime, and release it exactly once when the body ends, is cancelled,
 * the client aborts, or the upstream errors.
 *
 * The three HTTP ingresses run through a real `startAgentServer` with
 * `residencyLeases: true`, so the process-wide seam is the one the agent
 * publishes (a no-op publish fails the very first hold assertion). A gated
 * loopback fake engine parks each response after its first byte, so a lease
 * is observably held while the stream is open and released only when it
 * settles. A counting wrapper over the published registry proves the release
 * happens exactly once per request. /v1/responses is non-streaming by
 * contract (the proxy 501s a streaming Responses request), so it is pinned
 * as a buffered JSON body held across the full upstream read.
 *
 * The legacy-local-executor cases and the "nobody-reads-then-abort" case
 * drive `proxyOpenAI` without a socket; the abort case is what pins the
 * req.signal backstop in `attachLeaseAbortRelease` — the body is bound but
 * never read, so only that listener can release the lease.
 *
 * Every wait is bounded by `waitFor`, so a regression fails by assertion
 * rather than by a bun test timeout.
 */
import type { AcquireResult, Lease, ResidencyLeases } from "@llamactl/core/residency/leases";
import type { ResolvedEnv } from "@llamactl/core/types";
import type { ReadableStreamDefaultReader as WebStreamReader } from "node:stream/web";

import { inferenceContracts, openaiProxy } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import {
  bindLeaseToBody,
  createResidencyLeases,
  getResidencyLeaseRegistry,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BackendExecutionContext } from "../../src/proxy/create-proxy.js";

import { createLegacyLocalExecutor } from "../../src/inference/legacy-local-executor.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { generateToken } from "../../src/server/auth.js";
import { type RunningAgent, startAgentServer } from "../../src/server/serve.js";

const ENV_KEYS = [
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMA_CPP_MODELS",
  "LLAMA_CPP_HOST",
  "LLAMA_CPP_PORT",
  "LLAMACTL_RESIDENCY_STORE",
  "LLAMACTL_RESIDENCY_LEASES",
  "LLAMACTL_UNIFIED_PROXY",
] as const;

// The platform `Response.body` reader typed against `node:stream/web`, matching
// the repo convention that avoids a lib.dom/Bun reader variance clash.
type BodyReader = WebStreamReader;

/** Poll `pred` every 10ms until it holds or the deadline passes. */
async function waitFor(pred: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(10);
  }
}

// ── Gated fake engine ─────────────────────────────────────────────────────

interface EngineGate {
  release: () => void;
  fail: () => void;
}

interface FakeEngine {
  readonly port: number;
  hits(): number;
  readonly gates: readonly EngineGate[];
  stop(): Promise<void>;
}

const ENC = new TextEncoder();
const SSE_FIRST =
  'data: {"id":"cmpl-rl","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n';
const SSE_DONE = "data: [DONE]\n\n";
const JSON_COMPLETION =
  '{"id":"cmpl-rl","object":"chat.completion","created":0,"model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}]}';

/**
 * A llama-server stand-in. POST /v1/chat/completions inspects the request's
 * `stream` flag: a streaming request answers an SSE stream that emits one
 * chunk then parks; a non-streaming request parks an empty JSON body. In both
 * cases `release()` finishes the body and `fail()` errors it, so a lease is
 * provably held while the gate is shut. GET /v1/models is answered; other
 * paths 404.
 */
function startFakeEngine(): FakeEngine {
  const gates: (EngineGate & { settled: boolean })[] = [];
  let hits = 0;
  const drop = (gate: EngineGate & { settled: boolean }): void => {
    const at = gates.indexOf(gate);
    if (at !== -1) gates.splice(at, 1);
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
      const body = (await req.json().catch((): Record<string, unknown> => ({}))) as {
        stream?: unknown;
      };
      const wantsStream = body.stream === true;
      const cell: { gate: (EngineGate & { settled: boolean }) | null } = { gate: null };
      const stream = new ReadableStream<Uint8Array>({
        start(controller): void {
          if (wantsStream) controller.enqueue(ENC.encode(SSE_FIRST));
          const gate: EngineGate & { settled: boolean } = {
            settled: false,
            release(): void {
              if (gate.settled) return;
              gate.settled = true;
              drop(gate);
              try {
                controller.enqueue(ENC.encode(wantsStream ? SSE_DONE : JSON_COMPLETION));
                controller.close();
              } catch {
                // The consumer already tore the stream down.
              }
            },
            fail(): void {
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
      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": wantsStream ? "text/event-stream" : "application/json",
        },
      });
    },
  });
  return {
    port: server.port ?? 0,
    hits: (): number => hits,
    gates,
    stop: (): Promise<void> => server.stop(true),
  };
}

function latestGate(engine: FakeEngine): EngineGate {
  const gate = engine.gates.at(-1);
  if (gate === undefined) throw new Error("engine never saw a request");
  return gate;
}

function writeWorkload(runtimeRoot: string, workload: string, port: number, rel: string): void {
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

// ── Counting wrapper over the registry ──────────────────────────────────────

interface CountingRegistry {
  registry: ResidencyLeases;
  releases(): number;
}

/** Wraps a registry so each truthy `lease.release()` result is counted once. */
function wrapCounting(inner: ResidencyLeases): CountingRegistry {
  let releases = 0;
  const registry: ResidencyLeases = {
    ...inner,
    acquire(workload: string): AcquireResult {
      const result = inner.acquire(workload);
      if (!result.ok) return result;
      const lease: Lease = result.lease;
      return {
        ok: true,
        lease: {
          ...lease,
          release(): boolean {
            const released = lease.release();
            if (released) releases += 1;
            return released;
          },
        },
      };
    },
  };
  return { registry, releases: (): number => releases };
}

// ── Shared per-test harness ───────────────────────────────────────────────

let seq = 0;
let dir: string;
let engine: FakeEngine;
let workload = "";
let modelRel = "";
let token = "";
let tokenHash = "";
const savedEnv = new Map<string, string | undefined>();
const readers: BodyReader[] = [];

async function readAll(reader: BodyReader): Promise<void> {
  for (;;) {
    const next = await reader.read();
    if (next.done) return;
  }
}

function firstChunk(res: Response): Promise<BodyReader> {
  const reader = res.body!.getReader();
  readers.push(reader);
  return reader.read().then((first): BodyReader => {
    expect(first.done).toBe(false);
    return reader;
  });
}

beforeEach(() => {
  seq += 1;
  workload = `rl-wl-${String(seq)}`;
  modelRel = `rl/model-${String(seq)}.gguf`;
  dir = mkdtempSync(join(tmpdir(), "llamactl-rl-"));
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  engine = startFakeEngine();
  process.env["DEV_STORAGE"] = dir;
  process.env["LOCAL_AI_RUNTIME_DIR"] = dir;
  process.env["LLAMA_CPP_MODELS"] = join(dir, "models");
  process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
  process.env["LLAMA_CPP_PORT"] = String(engine.port);
  process.env["LLAMACTL_RESIDENCY_STORE"] = join(dir, "residency-store.json");
  Reflect.deleteProperty(process.env, "LLAMACTL_RESIDENCY_LEASES");
  Reflect.deleteProperty(process.env, "LLAMACTL_UNIFIED_PROXY");
  writeWorkload(dir, workload, engine.port, modelRel);
  const generated = generateToken();
  token = generated.token;
  tokenHash = generated.hash;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

afterEach(async () => {
  for (const gate of [...engine.gates]) gate.release();
  for (const reader of readers.splice(0)) {
    await reader.cancel("cleanup").catch((): void => undefined);
  }
  await activeAgent?.stop();
  activeAgent = null;
  setResidencyLeaseRegistry(null);
  await engine.stop();
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  savedEnv.clear();
});

let activeAgent: RunningAgent | null = null;

/**
 * Starts a residency-lease agent and wraps its published registry with a
 * release counter. The `not.toBeNull()` guard is what a no-op publish fails.
 */
function startLeaseAgent(): CountingRegistry {
  activeAgent = startAgentServer({
    tokenHash,
    advertiseMdns: false,
    residencyLeases: true,
  });
  const inner = getResidencyLeaseRegistry();
  expect(inner).not.toBeNull();
  if (inner === null) {
    throw new Error("agent did not publish a residency lease registry");
  }
  const counting = wrapCounting(inner);
  setResidencyLeaseRegistry(counting.registry);
  return counting;
}

function bearer(): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

// ── POST /v1/chat/completions ─────────────────────────────────────────────

describe("#278 DF-05: /v1/chat/completions request-lifetime lease", () => {
  function postChat(signal?: AbortSignal): Promise<Response> {
    return fetch(`${activeAgent!.url}/v1/chat/completions`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        model: modelRel,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  test("holds the lease across the body and releases once when the stream ends", async () => {
    const counting = startLeaseAgent();
    const res = await postChat();
    expect(res.status).toBe(200);
    const reader = await firstChunk(res);
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 1)).toBe(
      true,
    );
    expect(engine.hits()).toBeGreaterThanOrEqual(1);
    expect(counting.releases()).toBe(0);

    latestGate(engine).release();
    await readAll(reader);
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 0)).toBe(
      true,
    );
    expect(counting.releases()).toBe(1);
  }, 15_000);

  test("releases once when the response body is cancelled mid-stream", async () => {
    const counting = startLeaseAgent();
    const res = await postChat();
    expect(res.status).toBe(200);
    const reader = await firstChunk(res);
    expect(counting.registry.active(workload)).toHaveLength(1);

    await reader.cancel("bye");
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 0)).toBe(
      true,
    );
    expect(counting.releases()).toBe(1);
  }, 15_000);

  test("releases once when the client aborts mid-stream", async () => {
    const counting = startLeaseAgent();
    const ac = new AbortController();
    const res = await postChat(ac.signal);
    expect(res.status).toBe(200);
    await firstChunk(res);
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 1)).toBe(
      true,
    );

    ac.abort();
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 0)).toBe(
      true,
    );
    expect(counting.releases()).toBe(1);
  }, 15_000);

  test("releases once when the upstream stream errors", async () => {
    const counting = startLeaseAgent();
    const res = await postChat();
    expect(res.status).toBe(200);
    const reader = await firstChunk(res);
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 1)).toBe(
      true,
    );

    latestGate(engine).fail();
    try {
      await readAll(reader);
    } catch {
      // The upstream error surfaces to the client as a read failure.
    }
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 0)).toBe(
      true,
    );
    expect(counting.releases()).toBe(1);
  }, 15_000);
});

// ── POST /v1/messages (Anthropic; upstream forwards as buffered JSON) ────────

describe("#278 DF-05: /v1/messages request-lifetime lease", () => {
  function postMessages(signal?: AbortSignal): Promise<Response> {
    return fetch(`${activeAgent!.url}/v1/messages`, {
      method: "POST",
      headers: { ...bearer(), "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: modelRel,
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  test("holds the lease across the buffered body and releases once at the end", async () => {
    const counting = startLeaseAgent();
    const pending = postMessages();
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 1)).toBe(
      true,
    );
    expect(await waitFor((): boolean => engine.gates.length >= 1)).toBe(true);

    latestGate(engine).release();
    const res = await pending;
    expect(res.status).toBe(200);
    await res.text();
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 0)).toBe(
      true,
    );
    expect(counting.releases()).toBe(1);
  }, 15_000);

  test("releases once when the response body is cancelled before reading", async () => {
    const counting = startLeaseAgent();
    const pending = postMessages();
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 1)).toBe(
      true,
    );
    expect(await waitFor((): boolean => engine.gates.length >= 1)).toBe(true);
    latestGate(engine).release();
    const res = await pending;
    expect(res.status).toBe(200);

    await res.body!.cancel("bye");
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 0)).toBe(
      true,
    );
    expect(counting.releases()).toBe(1);
  }, 15_000);

  test("releases once when the client aborts during the buffered read", async () => {
    const counting = startLeaseAgent();
    const ac = new AbortController();
    const pending = postMessages(ac.signal);
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 1)).toBe(
      true,
    );
    expect(await waitFor((): boolean => engine.gates.length >= 1)).toBe(true);

    ac.abort();
    await pending.then(
      (): void => undefined,
      (): void => undefined,
    );
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 0)).toBe(
      true,
    );
    expect(counting.releases()).toBe(1);
  }, 15_000);

  test("releases once when the upstream errors during the buffered read", async () => {
    const counting = startLeaseAgent();
    const pending = postMessages();
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 1)).toBe(
      true,
    );
    expect(await waitFor((): boolean => engine.gates.length >= 1)).toBe(true);

    latestGate(engine).fail();
    const res = await pending.then(
      (r): Response => r,
      (): null => null,
    );
    if (res !== null) await res.text().catch((): void => undefined);
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 0)).toBe(
      true,
    );
    expect(counting.releases()).toBe(1);
  }, 15_000);
});

// ── POST /v1/responses (non-streaming, buffered JSON) ─────────────────────

describe("#278 DF-05: /v1/responses request-lifetime lease", () => {
  function postResponses(signal?: AbortSignal): Promise<Response> {
    return fetch(`${activeAgent!.url}/v1/responses`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ model: modelRel, input: "hi" }),
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  test("holds the lease across the buffered body and releases once at the end", async () => {
    const counting = startLeaseAgent();
    const pending = postResponses();
    // The lease is acquired before the upstream forward, so it is observable
    // while the request is still being issued; the engine hit follows it.
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 1)).toBe(
      true,
    );
    expect(await waitFor((): boolean => engine.hits() >= 1)).toBe(true);

    latestGate(engine).release();
    const res = await pending;
    expect(res.status).toBe(200);
    await res.text();
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 0)).toBe(
      true,
    );
    expect(counting.releases()).toBe(1);
  }, 15_000);

  test("releases once when the response body is cancelled before reading", async () => {
    const counting = startLeaseAgent();
    const pending = postResponses();
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 1)).toBe(
      true,
    );
    expect(await waitFor((): boolean => engine.gates.length >= 1)).toBe(true);
    latestGate(engine).release();
    const res = await pending;
    expect(res.status).toBe(200);

    await res.body!.cancel("bye");
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 0)).toBe(
      true,
    );
    expect(counting.releases()).toBe(1);
  }, 15_000);

  test("releases once when the client aborts during the buffered read", async () => {
    const counting = startLeaseAgent();
    const ac = new AbortController();
    const pending = postResponses(ac.signal);
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 1)).toBe(
      true,
    );
    expect(await waitFor((): boolean => engine.gates.length >= 1)).toBe(true);

    ac.abort();
    await pending.then(
      (): void => undefined,
      (): void => undefined,
    );
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 0)).toBe(
      true,
    );
    expect(counting.releases()).toBe(1);
  }, 15_000);

  test("releases once when the upstream errors during the buffered read", async () => {
    const counting = startLeaseAgent();
    const pending = postResponses();
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 1)).toBe(
      true,
    );
    expect(await waitFor((): boolean => engine.gates.length >= 1)).toBe(true);

    latestGate(engine).fail();
    const res = await pending.then(
      (r): Response => r,
      (): null => null,
    );
    if (res !== null) await res.text().catch((): void => undefined);
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 0)).toBe(
      true,
    );
    expect(counting.releases()).toBe(1);
  }, 15_000);
});

// ── Legacy local executor ─────────────────────────────────────────────────

describe("#278 DF-05: legacy local executor request-lifetime lease", () => {
  const envelopeBase = {
    requestId: "req-rl",
    attemptId: "att-rl",
    deadline: 1_900_000_000_000,
    tenantId: "local",
    projectId: "local",
    credentialScopeId: "local",
    operation: "generate",
    ingressProtocol: "openai-chat",
    publicModelId: "rl.gguf",
    features: {
      operation: "generate",
      protocol: "openai-chat",
      stream: true,
      modalities: ["text"],
      tools: false,
      structuredOutput: false,
      session: false,
      cancellation: true,
    },
    stream: true,
    nativeBody: { model: "rl.gguf", messages: [{ role: "user", content: "hi" }] },
    headerFingerprint: { allowlist: ["content-type"], fingerprint: "fp-rl" },
  };

  function executorCtx(attemptId: string, signal?: AbortSignal): BackendExecutionContext {
    const base: BackendExecutionContext = {
      req: new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: modelRel,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      resolved: resolveEnv(),
      attemptId,
      deadline: 1_900_000_000_000,
    };
    if (signal !== undefined) return { ...base, signal };
    return base;
  }

  test("holds the lease across the body and releases once when the stream ends", async () => {
    const counting = createResidencyLeasesStandalone();
    setResidencyLeaseRegistry(counting.registry);
    const exec = createLegacyLocalExecutor({ resolved: (): ResolvedEnv => resolveEnv() });
    const env = inferenceContracts.parseInferenceEnvelope(envelopeBase);
    const res = await exec.execute(env, executorCtx("att-rl"));
    expect(res.status).toBe(200);
    const reader = await firstChunk(res);
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 1)).toBe(
      true,
    );

    latestGate(engine).release();
    await readAll(reader);
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 0)).toBe(
      true,
    );
    expect(counting.releases()).toBe(1);
  }, 15_000);

  test("releases once when the attempt signal aborts mid-stream", async () => {
    const counting = createResidencyLeasesStandalone();
    setResidencyLeaseRegistry(counting.registry);
    const exec = createLegacyLocalExecutor({ resolved: (): ResolvedEnv => resolveEnv() });
    const ac = new AbortController();
    const env = inferenceContracts.parseInferenceEnvelope({ ...envelopeBase, attemptId: "att-c" });
    const res = await exec.execute(env, executorCtx("att-c", ac.signal));
    expect(res.status).toBe(200);
    const reader = await firstChunk(res);
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 1)).toBe(
      true,
    );

    ac.abort();
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 0)).toBe(
      true,
    );
    expect(counting.releases()).toBe(1);
  }, 15_000);
});

// ── Socketless unit pin: req.signal backstop (attachLeaseAbortRelease) ───────

describe("#278 DF-05: req.signal backstop releases a bound-but-unread stream", () => {
  test("an abort with no reader releases the lease exactly once", async () => {
    const counting = createResidencyLeasesStandalone();
    setResidencyLeaseRegistry(counting.registry);
    const ac = new AbortController();
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: modelRel,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: ac.signal,
    });
    const res = await openaiProxy.proxyOpenAI(req, resolveEnv());
    expect(res.status).toBe(200);
    // Never read the body: only the abort listener can settle the lease.
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 1)).toBe(
      true,
    );

    ac.abort();
    expect(await waitFor((): boolean => counting.registry.active(workload).length === 0)).toBe(
      true,
    );
    expect(counting.releases()).toBe(1);
    await res.body?.cancel().catch((): void => undefined);
    expect(counting.releases()).toBe(1);
  }, 10_000);
});

// ── Socketless unit pin: body-cancel settles with no pending read ────────────

describe("#278 DF-05: bindLeaseToBody cancel releases with no read in flight", () => {
  test("cancelling a pre-filled, never-closed bound body releases exactly once", async () => {
    const counting = createResidencyLeasesStandalone();
    const acquired = counting.registry.acquire(workload);
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    // One chunk, never closed: the bound stream pulls it into its queue once and
    // then has no read in flight, so only the cancel handler can settle.
    const upstream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode("x"));
      },
    });
    const bound = bindLeaseToBody(upstream, acquired.lease);
    await Bun.sleep(0);
    expect(counting.registry.active(workload)).toHaveLength(1);

    await bound.cancel();
    expect(counting.registry.active(workload)).toHaveLength(0);
    expect(counting.releases()).toBe(1);
  }, 10_000);
});

// ── Standalone registry helpers (socketless cases) ───────────────────────────

interface StandaloneRegistry extends CountingRegistry {
  inner: ResidencyLeases;
}

function createResidencyLeasesStandalone(): StandaloneRegistry {
  const inner = createResidencyLeases();
  return { ...wrapCounting(inner), inner };
}
