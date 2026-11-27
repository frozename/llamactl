import type { PeerSnapshot } from "@llamactl/core/workloadRuntime";

import { openaiProxy, routingCapabilities, routingCatalog } from "@llamactl/core";
import { writeModelHostState } from "@llamactl/core/engines/state";
import { resolveEnv } from "@llamactl/core/env";
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProxy } from "../../src/proxy/create-proxy.js";
import { createColdOwnerAdmission } from "../../src/residency/cold-owner-admission.js";
import { createOwnerAdmission } from "../../src/residency/owner-admission.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

const FALLBACK = "fixture-default";
const MODEL = "org/fixture-cold.gguf";
const LOCAL: routingCatalog.DeclaredModelEntryV1 = {
  id: MODEL,
  ownerNodeId: "local",
  workload: "fixture-cold",
  kind: "ModelRun",
  state: "cold",
  autoLoadEligible: true,
};
const NOW = 100_000;

function catalog(
  advertisements: routingCatalog.RouteAdvertisementV1[] = [],
): routingCatalog.RouteCatalog {
  return routingCatalog.buildRouteCatalog({ routes: [], advertisements, now: NOW });
}

function provider(): routingCatalog.RouteAdvertisementV1 {
  return routingCatalog.RouteAdvertisementV1Schema.parse({
    schemaVersion: 1,
    routeId: "route/provider",
    deploymentId: "deploy/provider",
    backendId: "backend/provider",
    ownerNodeId: "provider",
    publicModelIds: [MODEL],
    upstreamModelId: MODEL,
    backendKind: "cloud-api",
    transport: "cloud-direct",
    endpoint: "https://provider.invalid/v1",
    capabilities: routingCapabilities.RouteCapabilitiesSchema.parse({
      operations: ["generate"],
      protocols: ["openai-chat"],
      streaming: "sse",
      modalities: ["text"],
      tools: false,
      structuredOutput: false,
      tokenCounting: false,
      cancellation: false,
      sessions: false,
    }),
    modelRevision: routingCatalog.knownRevision("provider-model"),
    deploymentEpoch: routingCatalog.knownRevision("provider-epoch"),
    adapterRevision: routingCatalog.UNKNOWN_REVISION,
    policyRevision: routingCatalog.UNKNOWN_REVISION,
    weight: 1,
    draining: false,
  });
}

async function withProxy(
  run: (fixture: {
    state: {
      rows: routingCatalog.DeclaredModelEntryV1[];
      readCatalog: () => routingCatalog.RouteCatalog;
    };
    post: (params?: {
      path?: string;
      model?: string;
      extra?: Record<string, unknown>;
    }) => Promise<Response>;
    snapshots: Map<string, PeerSnapshot>;
    engineCalls: { path: string; authorization: string | null; body: unknown }[];
    counters: { loads: number; executor: number; credentials: number };
    resolved: ReturnType<typeof resolveEnv>;
  }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-unified-cold-"));
  const resolved = resolveEnv({
    DEV_STORAGE: dir,
    LOCAL_AI_RUNTIME_DIR: dir,
    LLAMA_CPP_MODELS: join(dir, "models"),
    LLAMA_CPP_SERVER_ALIAS: FALLBACK,
  });
  const engineCalls: { path: string; authorization: string | null; body: unknown }[] = [];
  const engine = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      engineCalls.push({
        path: new URL(req.url).pathname,
        authorization: req.headers.get("authorization"),
        body: await req.json(),
      });
      return Response.json({ model: MODEL, choices: [{ text: "local engine completion" }] });
    },
  });
  const enginePort = Number(engine.url.port);
  const counters = { loads: 0, executor: 0, credentials: 0 };
  const pin = {
    model: MODEL,
    workload: LOCAL.workload,
    ownerNodeId: "local",
    deploymentId: "deploy/local/fixture-cold",
    artifactRevision: "fixture-artifact",
    policyRevision: "fixture-policy",
    endpoint: engine.url.origin,
    pretokenizedCompletion: true as const,
  };
  const limits = {
    maxQueued: 4,
    maxQueuedBytes: 4096,
    maxQueueWaitMs: 1000,
    maxPerPrincipal: 4,
    starvationBoundMs: 1000,
    maxContextTokens: 8,
  };
  const warm = createOwnerAdmission([
    {
      ...limits,
      name: "fixture",
      foregroundPorts: [enginePort],
      backgroundPorts: [1],
      foregroundConcurrency: 1,
      maxCompletionTokens: 3,
    },
  ]);
  const cold = createColdOwnerAdmission({
    ownerNodeId: "local",
    limits: { ...limits, maxExecutions: 1, retryAfterMs: 100 },
    warm,
    owner: {
      pin: () => pin,
      activate: (): Promise<"ready"> => {
        counters.loads++;
        return Promise.resolve("ready");
      },
      ready: () =>
        Promise.resolve(
          counters.loads === 0 ? undefined : { pin, runtimeGeneration: "fixture-generation" },
        ),
      stillOwns: () => true,
    },
  });
  const state = { rows: [LOCAL], readCatalog: (): routingCatalog.RouteCatalog => catalog() };
  const snapshots = new Map<string, PeerSnapshot>();
  openaiProxy.setDeclaredModelSource(() => state.rows);
  const proxy = createProxy({
    env: { LLAMACTL_UNIFIED_PROXY: "1" },
    resolved,
    now: () => NOW,
    catalog: () => state.readCatalog(),
    peerSnapshots: snapshots,
    peers: [{ id: "peer", endpoint: "https://peer.invalid", certificate: "fixture-pinned" }],
    executor: {
      describe: () => ({ id: "fallback", backendKinds: [], transports: [] }),
      execute: () => {
        counters.executor++;
        return Promise.resolve(Response.json({ model: FALLBACK }));
      },
      cancel: () => false,
      drain: () => Promise.resolve(),
      close: () => Promise.resolve(),
    },
    resolveCredentials: () => {
      counters.credentials++;
      return Promise.resolve(undefined);
    },
  });
  const ingress = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => proxy.handleRequest(req, cold.forward),
  });
  try {
    await run({
      state,
      post: (params = {}) =>
        fetch(new URL(params.path ?? "/v1/completions", ingress.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer fixture-client",
          },
          body: JSON.stringify({
            model: params.model ?? MODEL,
            prompt: [1, 2],
            max_tokens: 3,
            ...params.extra,
          }),
        }),
      snapshots,
      engineCalls,
      counters,
      resolved,
    });
  } finally {
    cold.stop();
    warm.stop();
    await Promise.all([cold.whenIdle(), ingress.stop(true), engine.stop(true)]);
    openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function expectNotLoaded(res: Response, reason?: string): Promise<void> {
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({
    error: { code: "model_not_loaded", ...(reason === undefined ? {} : { reason }) },
  });
}

test("exact unified local completion reaches the bounded cold owner and local engine", () =>
  withProxy(async ({ post, counters, engineCalls }) => {
    expect((await post({ extra: { max_tokens: 4 } })).status).toBe(400);
    expect((await post({ extra: { prompt: [1, 2, 3, 4, 5, 6] } })).status).toBe(400);
    expect(counters).toEqual({ loads: 0, executor: 0, credentials: 0 });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      model: MODEL,
      choices: [{ text: "local engine completion" }],
    });
    expect(counters).toEqual({ loads: 1, executor: 0, credentials: 0 });
    expect(engineCalls).toEqual([
      {
        path: "/v1/completions",
        authorization: null,
        body: { model: MODEL, prompt: [1, 2], max_tokens: 3 },
      },
    ]);
  }));

test("unified cold declines other protocols, provider contention, defaults, and dual local claims", () =>
  withProxy(async ({ post, state, counters, engineCalls }) => {
    await expectNotLoaded(await post({ path: "/v1/chat/completions" }));
    await expectNotLoaded(await post({ path: "/v1/completions?cache=1" }));
    state.rows = [{ ...LOCAL, kind: "ModelHost" }];
    await expectNotLoaded(await post());
    state.rows = [LOCAL];
    state.readCatalog = (): routingCatalog.RouteCatalog => catalog([provider()]);
    await expectNotLoaded(await post());
    state.readCatalog = (): routingCatalog.RouteCatalog => {
      throw new Error("no catalog");
    };
    await expectNotLoaded(await post());
    state.readCatalog = (): routingCatalog.RouteCatalog => catalog();
    state.rows = [LOCAL, { ...LOCAL, workload: "second-local-owner" }, { ...LOCAL, id: FALLBACK }];
    await expectNotLoaded(await post());
    expect(await (await post({ model: FALLBACK })).json()).toEqual({ model: FALLBACK });
    expect(counters).toEqual({ loads: 0, executor: 1, credentials: 0 });
    expect(engineCalls).toEqual([]);
  }));

test("unified cold declines fresh peer claims and old-peer warm aliases without remote execution", () =>
  withProxy(async ({ post, state, snapshots, counters, engineCalls }) => {
    const revision = `sha256:${"0".repeat(64)}`;
    snapshots.set("peer", {
      pressure: "NORMAL",
      fetchedAt: NOW,
      workloads: [],
      declaredProvenance: {
        schemaVersion: 1,
        entries: [
          {
            id: MODEL,
            ownerNodeId: "peer",
            workload: "foreign-cold",
            kind: "ModelRun",
            state: "cold",
            artifactRevision: revision,
            policyRevision: revision,
          },
        ],
      },
    });
    await expectNotLoaded(await post());
    openaiProxy.setDeclaredModelSource(() => []);
    await expectNotLoaded(await post(), "peer-owner-required");
    state.rows = [LOCAL];
    openaiProxy.setDeclaredModelSource(() => state.rows);
    snapshots.set("peer", {
      pressure: "HIGH",
      fetchedAt: NOW,
      workloads: [{ modelId: MODEL, port: 19000 }],
    });
    await expectNotLoaded(await post());
    expect(counters).toEqual({ loads: 0, executor: 0, credentials: 0 });
    expect(engineCalls).toEqual([]);
  }));

test("unified cold rechecks its exact owner and core route map after catalog selection", () =>
  withProxy(async ({ post, state, resolved, counters, engineCalls }) => {
    state.readCatalog = (): routingCatalog.RouteCatalog => {
      state.rows = [{ ...LOCAL, workload: "changed-owner" }];
      return catalog();
    };
    await expectNotLoaded(await post());

    openaiProxy.setDeclaredModelSource(() => state.rows);
    state.rows = [LOCAL];
    state.readCatalog = (): routingCatalog.RouteCatalog => {
      writeModelHostState(
        {
          kind: "ModelHost",
          engine: "llamacpp",
          pid: process.pid,
          host: "127.0.0.1",
          port: 19000,
          modelAliases: [MODEL],
          startedAt: "2026-11-15T00:00:00.000Z",
        },
        { name: "live-other-owner" },
        resolved,
      );
      return catalog();
    };
    await expectNotLoaded(await post());
    expect(counters).toEqual({ loads: 0, executor: 0, credentials: 0 });
    expect(engineCalls).toEqual([]);
  }));
