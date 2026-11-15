/**
 * #278 DF-05 — drain and forced-unload semantics for request-lifetime
 * residency leases. A draining workload refuses new admission with a typed
 * `model_draining` 503 *before* the request is forwarded (the engine is never
 * touched), while an unrelated workload keeps serving. `whenIdle` reports
 * honestly: it never claims idle while a lease is held, a deadline expires to
 * `{ idle: false, reason: "Aborted" }` with the active set intact, and an
 * unforced commit refuses with `LeasesActive`. A forced commitUnload revokes
 * every lease before the engine stops, so an in-flight stream is errored with
 * "forced unload" rather than hanging or ending cleanly, and the revocation is
 * audited.
 *
 * Everything runs through `proxyOpenAI` / `forceUnloadWorkload` without a
 * socket, against a gated loopback fake engine, so each invariant is asserted
 * directly. Lease-count predicates are polled with `waitFor` and the drain's
 * idle promise is raced against a 1s timer, so a lease that never settles
 * fails by assertion. The proxy calls and body reads are awaited unbounded;
 * a hang there surfaces as the per-test timeout instead.
 * The fake engine parks a streaming response until released, which keeps a
 * lease observably held across the whole body lifetime.
 */
import type { AcquireResult, Lease, ResidencyLeases } from "@llamactl/core/residency/leases";
import type { DrainToken } from "@llamactl/core/residency/types";
import type { ReadableStreamDefaultReader as WebStreamReader } from "node:stream/web";

import { openaiProxy } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { createResidencyLeases, setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { forceUnloadWorkload } from "../../src/residency/force-unload.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

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

async function waitFor(pred: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(10);
  }
}

// The platform `Response.body` reader typed against `node:stream/web`, matching
// the repo convention that avoids a lib.dom/Bun reader variance clash.
type BodyReader = WebStreamReader;

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
  'data: {"id":"cmpl-dn","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n';
const SSE_DONE = "data: [DONE]\n\n";

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
    fetch(req: Request): Response {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/v1/models") {
        return Response.json({ object: "list", data: [] });
      }
      if (req.method !== "POST" || path !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 });
      }
      hits += 1;
      const cell: { gate: (EngineGate & { settled: boolean }) | null } = { gate: null };
      const stream = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(ENC.encode(SSE_FIRST));
          const gate: EngineGate & { settled: boolean } = {
            settled: false,
            release(): void {
              if (gate.settled) return;
              gate.settled = true;
              drop(gate);
              try {
                controller.enqueue(ENC.encode(SSE_DONE));
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
        headers: { "content-type": "text/event-stream" },
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

// ── Counting wrapper over a standalone registry ─────────────────────────────

interface CountingRegistry {
  registry: ResidencyLeases;
  releases(): number;
}

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

// ── Socketless chat request helper ──────────────────────────────────────────

function chatRequest(model: string, signal?: AbortSignal): Request {
  const base = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hi" }] }),
  };
  if (signal !== undefined)
    return new Request("http://localhost/v1/chat/completions", { ...base, signal });
  return new Request("http://localhost/v1/chat/completions", base);
}

async function firstChunk(res: Response): Promise<BodyReader> {
  const reader = res.body!.getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);
  return reader;
}

// ── Harness ───────────────────────────────────────────────────────────────

let seq = 0;
let dir: string;
let engine: FakeEngine;
let workloadA = "";
let modelRelA = "";
let workloadB = "";
let modelRelB = "";
let counting: CountingRegistry;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  seq += 1;
  workloadA = `drn-a-${String(seq)}`;
  modelRelA = `drn/a-${String(seq)}.gguf`;
  workloadB = `drn-b-${String(seq)}`;
  modelRelB = `drn/b-${String(seq)}.gguf`;
  dir = mkdtempSync(join(tmpdir(), "llamactl-drn-"));
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
  writeWorkload(dir, workloadA, engine.port, modelRelA);
  writeWorkload(dir, workloadB, engine.port, modelRelB);
  counting = wrapCounting(createResidencyLeases());
  setResidencyLeaseRegistry(counting.registry);
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

afterEach(async () => {
  for (const gate of [...engine.gates]) gate.release();
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

// ── beginDrain refuses new admission before forwarding ───────────────────────

describe("#278 DF-05: draining a workload refuses new admission", () => {
  test("a draining workload answers 503 model_draining without touching the engine", async () => {
    const held = await openaiProxy.proxyOpenAI(chatRequest(modelRelA), resolveEnv());
    expect(held.status).toBe(200);
    const reader = await firstChunk(held);
    expect(await waitFor((): boolean => counting.registry.active(workloadA).length === 1)).toBe(
      true,
    );
    expect(engine.hits()).toBe(1);

    const drain = counting.registry.beginDrain(workloadA);
    expect(drain.ok).toBe(true);
    if (!drain.ok) return;
    const token: DrainToken = drain.token;
    const idle = counting.registry.whenIdle(token);

    const refused = await openaiProxy.proxyOpenAI(chatRequest(modelRelA), resolveEnv());
    expect(refused.status).toBe(503);
    const body = (await refused.json()) as { error?: { type?: string } };
    expect(body.error?.type).toBe("model_draining");
    // Refused before the forward: the engine never saw the second request.
    expect(engine.hits()).toBe(1);
    // The held lease is untouched; the drain has not gone idle yet.
    expect(counting.registry.active(workloadA)).toHaveLength(1);
    let settled = false;
    void idle.then((): void => {
      settled = true;
    });
    await Bun.sleep(20);
    expect(settled).toBe(false);

    latestGate(engine).release();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
    }
    // Bounded so a dropped release-notification fails by assertion, not timeout.
    const idleResult = await Promise.race([
      idle,
      Bun.sleep(1_000).then((): "still-pending" => "still-pending"),
    ]);
    expect(idleResult).toEqual({ idle: true });
    expect(await waitFor((): boolean => counting.registry.active(workloadA).length === 0)).toBe(
      true,
    );
  }, 15_000);

  test("an unrelated workload keeps serving while another drains", async () => {
    const drain = counting.registry.beginDrain(workloadA);
    expect(drain.ok).toBe(true);

    const res = await openaiProxy.proxyOpenAI(chatRequest(modelRelB), resolveEnv());
    expect(res.status).toBe(200);
    const reader = await firstChunk(res);
    expect(await waitFor((): boolean => counting.registry.active(workloadB).length === 1)).toBe(
      true,
    );
    expect(counting.registry.snapshot(workloadA).phase).toBe("draining");

    latestGate(engine).release();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
    }
  }, 15_000);
});

// ── whenIdle reports honestly under a deadline ──────────────────────────────

describe("#278 DF-05: whenIdle under a deadline frees nothing", () => {
  test("a deadline expiry returns Aborted with the active set intact", async () => {
    const held = await openaiProxy.proxyOpenAI(chatRequest(modelRelA), resolveEnv());
    const reader = await firstChunk(held);
    expect(await waitFor((): boolean => counting.registry.active(workloadA).length === 1)).toBe(
      true,
    );

    const drain = counting.registry.beginDrain(workloadA);
    expect(drain.ok).toBe(true);
    if (!drain.ok) return;

    const result = await counting.registry.whenIdle(drain.token, {
      signal: AbortSignal.timeout(150),
    });
    expect(result.idle).toBe(false);
    if (result.idle) return;
    expect(result.reason).toBe("Aborted");
    expect(result.active).toHaveLength(1);

    // Still draining, still holding the lease, engine still parked.
    expect(counting.registry.snapshot(workloadA).phase).toBe("draining");
    expect(counting.registry.active(workloadA)).toHaveLength(1);
    expect(engine.gates.length).toBeGreaterThanOrEqual(1);

    latestGate(engine).release();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
    }
  }, 15_000);
});

// ── commitUnload refuses to drop live leases unless forced ───────────────────

describe("#278 DF-05: unforced commitUnload refuses live leases", () => {
  test("commitUnload with a held lease returns LeasesActive", () => {
    const acquired = counting.registry.acquire(workloadA);
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    const drain = counting.registry.beginDrain(workloadA);
    expect(drain.ok).toBe(true);
    if (!drain.ok) return;

    const refused = counting.registry.commitUnload(drain.token);
    expect(refused).toMatchObject({ ok: false, reason: "LeasesActive" });
    // Narrowing only: the assertion above already fails any other shape.
    if (refused.ok || refused.reason !== "LeasesActive") {
      throw new Error(`expected LeasesActive, got ${JSON.stringify(refused)}`);
    }
    expect(refused.active).toEqual([acquired.lease.id]);
    // The refusal frees nothing: the lease is still held and the drain stands.
    expect(counting.registry.active(workloadA)).toEqual([acquired.lease.id]);
    expect(counting.registry.snapshot(workloadA).phase).toBe("draining");
  });
});

// ── Forced unload revokes before stopping and errors the open stream ─────────

describe("#278 DF-05: forced unload revokes before the engine stops", () => {
  test("the stream is revoked at commit, not at stop, and is audited", async () => {
    const held = await openaiProxy.proxyOpenAI(chatRequest(modelRelA), resolveEnv());
    const reader = await firstChunk(held);
    expect(await waitFor((): boolean => counting.registry.active(workloadA).length === 1)).toBe(
      true,
    );

    let leasesAtStop = -1;
    const result = await forceUnloadWorkload({
      workload: workloadA,
      reason: "operator test",
      kind: "modelrun",
      registry: counting.registry,
      stop: (): Promise<{ stopped: boolean }> => {
        // commitUnload must have revoked the lease before stop() is reached.
        leasesAtStop = counting.registry.active(workloadA).length;
        return Promise.resolve({ stopped: true });
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revoked).toHaveLength(1);
    expect(leasesAtStop).toBe(0);
    expect(counting.registry.snapshot(workloadA).phase).toBe("unloaded");

    // The open client stream is errored with the revocation reason, not ended.
    let revokeMessage = "";
    try {
      const next = await reader.read();
      if (next.done) revokeMessage = "ended";
    } catch (error) {
      revokeMessage = error instanceof Error ? error.message : String(error);
    }
    expect(revokeMessage).toContain("forced unload");

    const entries = counting.registry.audit();
    expect(entries.at(-1)?.workload).toBe(workloadA);
    expect(entries.at(-1)?.forced).toBe(true);
    expect(entries.at(-1)?.revoked).toHaveLength(1);
  }, 15_000);

  test("an idle forced unload still commits and stops", async () => {
    const result = await forceUnloadWorkload({
      workload: workloadA,
      reason: "operator idle",
      kind: "modelrun",
      registry: counting.registry,
      stop: (): Promise<{ stopped: boolean }> => Promise.resolve({ stopped: true }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revoked).toHaveLength(0);
    expect(counting.registry.snapshot(workloadA).phase).toBe("unloaded");
  });
});
