// Part of #520.
import { openaiProxy, routingCapabilities, routingCatalog } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLegacyLocalExecutor } from "../../src/inference/legacy-local-executor.js";
import {
  type BackendExecutor,
  type BackendExecutorDescription,
  createProxy,
} from "../../src/proxy/create-proxy.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

const SESSION_HEADER = "x-llamactl-session";

const CAPABILITIES = routingCapabilities.RouteCapabilitiesSchema.parse({
  operations: ["generate"],
  protocols: ["openai-chat", "openai-responses", "anthropic-messages"],
  streaming: "sse",
  modalities: ["text"],
  tools: true,
  structuredOutput: true,
  tokenCounting: true,
  cancellation: true,
  sessions: true,
});

function sessionAd(input: {
  model: string;
  transport: routingCatalog.RouteTransport;
  ownerNodeId: string;
  workload: string;
}): routingCatalog.RouteAdvertisementV1 {
  const { model, transport, ownerNodeId, workload } = input;
  return {
    schemaVersion: 1,
    routeId: `route/${ownerNodeId}/${workload}`,
    deploymentId: `deploy/${ownerNodeId}/${workload}`,
    backendId: `backend/${ownerNodeId}/${workload}`,
    ownerNodeId,
    publicModelIds: [model],
    upstreamModelId: model,
    backendKind: "local-model",
    transport,
    endpoint: "http://127.0.0.1:1",
    capabilities: CAPABILITIES,
    modelRevision: routingCatalog.knownRevision(`${model}-model`),
    deploymentEpoch: routingCatalog.knownRevision(`${model}-epoch`),
    adapterRevision: routingCatalog.UNKNOWN_REVISION,
    policyRevision: routingCatalog.UNKNOWN_REVISION,
    weight: 1,
    draining: false,
  };
}

const PEER_AD = sessionAd({
  model: "peer-model",
  transport: "worker-rpc",
  ownerNodeId: "peer1",
  workload: "peer-wl",
});
const SELF_WORKER_AD = sessionAd({
  model: "self-model",
  transport: "worker-rpc",
  ownerNodeId: "node1",
  workload: "self-wl",
});
const LOCAL_AD = sessionAd({
  model: "local-model",
  transport: "local-http",
  ownerNodeId: "node1",
  workload: "wl-x",
});

let sandbox = "";
let resolved: ReturnType<typeof resolveEnv>;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "llamactl-unified-session-worker-rpc-"));
  resolved = resolveEnv({
    DEV_STORAGE: sandbox,
    LOCAL_AI_RUNTIME_DIR: sandbox,
    LLAMA_CPP_MODELS: join(sandbox, "models"),
    LLAMA_CPP_PORT: "18989",
  });
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

interface Harness {
  proxy: ReturnType<typeof createProxy>;
  calls: string[];
  legacySessionHeaders: (string | null)[];
}

function buildHarness(): Harness {
  const catalog = routingCatalog.buildRouteCatalog({ routes: [], nodeId: "node1" });
  for (const ad of [PEER_AD, SELF_WORKER_AD, LOCAL_AD]) {
    expect(routingCatalog.addCatalogAdvertisement(catalog, ad).accepted).toBe(true);
  }

  const calls: string[] = [];
  const legacySessionHeaders: (string | null)[] = [];
  const legacyProxy = (req: Request): Promise<Response> => {
    calls.push("legacy");
    legacySessionHeaders.push(req.headers.get(SESSION_HEADER));
    return Promise.resolve(Response.json({ via: "legacy" }));
  };
  const executor = createLegacyLocalExecutor({ resolved, proxy: legacyProxy });
  const workerExecutor: BackendExecutor = {
    describe: (): BackendExecutorDescription => ({
      id: "recording-worker",
      backendKinds: ["local-model"],
      transports: ["worker-rpc"],
    }),
    execute: (): Promise<Response> => {
      calls.push("worker");
      return Promise.resolve(Response.json({ via: "worker" }));
    },
    cancel: (): boolean => false,
    drain: (): Promise<void> => Promise.resolve(),
    close: (): Promise<void> => Promise.resolve(),
  };
  const proxy = createProxy({
    env: { LLAMACTL_UNIFIED_PROXY: "1" },
    nodeId: "node1",
    resolved,
    catalog: () => catalog,
    executor,
    resolveCredentials: () => {
      calls.push("credentials");
      return Promise.resolve(null);
    },
    acquireExecutor: () => {
      calls.push("acquire");
      return workerExecutor;
    },
  });
  return { proxy, calls, legacySessionHeaders };
}

function chatRequest(model: string, session?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (session !== undefined) headers.set(SESSION_HEADER, session);
  return new Request("http://x/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
}

test("R1: a session request for a peer-owned worker-rpc pick uses the legacy session path", async () => {
  // Kills: no session/worker-rpc guard in gatedExecute, so acquireExecutor always runs.
  const harness = buildHarness();
  const res = await harness.proxy.handleRequest(chatRequest("peer-model", "sess-a"));

  expect(res.status).toBe(200);
  expect(harness.calls).toEqual(["credentials", "legacy"]);
  expect(harness.legacySessionHeaders).toEqual(["sess-a"]);
  expect(await res.json()).toEqual({ via: "legacy" });
});

test("R2: a session request for a self-owned worker-rpc pick uses the legacy session path", async () => {
  // Kills: a guard keyed on remote owner instead of transport. The embedded worker RPC
  // skips the local proxyOpenAI session acquire.
  const harness = buildHarness();
  const res = await harness.proxy.handleRequest(chatRequest("self-model", "sess-b"));

  expect(res.status).toBe(200);
  expect(harness.calls).toEqual(["credentials", "legacy"]);
  expect(harness.legacySessionHeaders).toEqual(["sess-b"]);
  expect(await res.json()).toEqual({ via: "legacy" });
});

test("G1: a sessionless worker-rpc pick keeps the worker RPC", async () => {
  // Kills: bypassing the worker RPC for every worker-rpc pick.
  const harness = buildHarness();
  const res = await harness.proxy.handleRequest(chatRequest("peer-model"));

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ via: "worker" });
  expect(harness.calls).toEqual(["credentials", "acquire", "worker"]);
  expect(harness.legacySessionHeaders).toEqual([]);
});

test("G2: empty and whitespace-only session headers do not count as sessions", async () => {
  // Kills: a guard that treats header !== null as a session.
  for (const header of ["", "   "]) {
    const harness = buildHarness();
    const res = await harness.proxy.handleRequest(chatRequest("peer-model", header));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: "worker" });
    expect(harness.calls).toEqual(["credentials", "acquire", "worker"]);
    expect(harness.legacySessionHeaders).toEqual([]);
  }
});

test("G3: a session header on a local-http pick keeps the acquired executor", async () => {
  // Kills: a guard that ignores the transport.
  const harness = buildHarness();
  const res = await harness.proxy.handleRequest(chatRequest("local-model", "sess-c"));

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ via: "worker" });
  expect(harness.calls).toEqual(["credentials", "acquire", "worker"]);
  expect(harness.legacySessionHeaders).toEqual([]);
});
