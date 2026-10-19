/**
 * P4.1 (#139) BOUNDARY — the gateway–worker InferenceRpcV1 round trip.
 * A real agent (random port, self-signed certificate) serves the worker
 * RPC on its tRPC route, backed by the shared fake engine. The producer
 * is driven over the wire with certificate-pinned fetch, then again
 * through the P0.2 unified proxy with a `worker-rpc` candidate — owned by
 * the gateway itself (embedded), and by a remote worker reached over its
 * declared transport: direct pinned TLS, or the reverse tunnel through a
 * central agent's relay. Every emitted stream is checked against the
 * consumer's real schema: Nova's `ExecutionEventV1Schema` and
 * `validateExecutionEventSequence`.
 */
import type { routingCatalog } from "@llamactl/core";
import type { PeerNode } from "@llamactl/core/config/peers";
import type { ClusterNode } from "@llamactl/core/config/schema";

import { resolveEnv } from "@llamactl/core/env";
import {
  type ExecutionEventV1,
  ExecutionEventV1Schema,
  validateExecutionEventSequence,
} from "@novaproto/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { ClientWebSocketConstructor } from "../src/tunnel/tunnel-client.js";

import { envForTemp, makeTempRuntime } from "../../core/test/helpers.js";
import { makePinnedFetch, type PinnedFetch } from "../src/client/links.js";
import { auth, config as kubecfg, type RunningAgent, startAgentServer, tls } from "../src/index.js";
import { createProxy, type UnifiedProxy } from "../src/proxy/create-proxy.js";
import { mkdirSync, writeFileSync } from "../src/safe-fs.js";
import { type FakeEngine, startFakeEngine } from "./fixtures/inference-rpc-v1/fake-engine.js";
import {
  type Cluster,
  type ControllerClosedGuard,
  installControllerClosedGuard,
  makeCluster,
} from "./helpers.js";

// Loaded lazily so this boundary test still runs against a base without the
// worker RPC module: there its RED is an assertion failure on the wire, not
// a missing-module error.
const procedures = await import("../src/inference/procedures.js").catch(() => null);

const WORKER_ID = "node1";
const LOCAL_MODEL = "rpc/model.gguf";
const LOCAL_DEPLOYMENT = `deploy/${WORKER_ID}/wl-rpc`;
const AD_ALIAS = "rpc-alias";
const AD_UPSTREAM = "rpc-upstream";
const AD_DEPLOYMENT = `deploy/${WORKER_ID}/rpc-ad`;
const TUNNEL_NODE = `${WORKER_ID}-tunnel`;
const TENANT = "local";
const ENV_KEYS = [
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMA_CPP_MODELS",
  "LLAMA_CPP_HOST",
  "LLAMA_CPP_PORT",
  "LLAMACTL_CONFIG",
  "LLAMACTL_UNIFIED_PROXY",
] as const;

let temp: ReturnType<typeof makeTempRuntime>;
let engine: FakeEngine;
let cluster: Cluster | undefined;
let pinned: PinnedFetch;
let bearer = "";
let guard: ControllerClosedGuard;
let restoreHost: (() => void) | undefined;
let workerNode: ClusterNode;
let central: RunningAgent | undefined;
let dialer: RunningAgent | undefined;
let centralTrust: { url: string; certificate: string; fingerprint: string; token: string };
const envBackup: Record<string, string | undefined> = {};
const recordedSubmitFrames: unknown[][] = [];
const recordedStreamFrames: unknown[][] = [];

function writeLlamaServerWorkload(runtimeRoot: string, workload: string, port: number): void {
  const dir = join(runtimeRoot, "workloads", workload);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server.pid"), `${String(process.pid)}\n`);
  writeFileSync(
    join(dir, "llama-server.state"),
    JSON.stringify({
      rel: LOCAL_MODEL,
      extraArgs: [],
      host: "127.0.0.1",
      port,
      binary: "/x/llama-server",
      pid: process.pid,
      startedAt: "2026-10-19T00:00:00.000Z",
      tunedProfile: null,
    }),
  );
}

function workerAdvertisement(): routingCatalog.RouteAdvertisementV1 {
  return {
    schemaVersion: 1,
    routeId: `route/${WORKER_ID}/rpc-ad`,
    deploymentId: AD_DEPLOYMENT,
    backendId: `backend/${WORKER_ID}/rpc-ad`,
    ownerNodeId: WORKER_ID,
    publicModelIds: [AD_ALIAS],
    upstreamModelId: AD_UPSTREAM,
    backendKind: "local-model",
    transport: "worker-rpc",
    endpoint: engine.url,
    capabilities: {
      operations: ["generate"],
      protocols: ["openai-chat"],
      streaming: "sse",
      modalities: ["text"],
      tools: true,
      structuredOutput: true,
      tokenCounting: false,
      cancellation: true,
      sessions: false,
    },
    modelRevision: { status: "known", value: "rev-1" },
    deploymentEpoch: { status: "known", value: "epoch-1" },
    adapterRevision: { status: "unknown" },
    policyRevision: { status: "unknown" },
    weight: 1,
    draining: false,
  };
}

function envelope(attemptId: string, model: string): Record<string, unknown> {
  return {
    requestId: `req-${attemptId}`,
    attemptId,
    deadline: Date.now() + 60_000,
    tenantId: TENANT,
    projectId: TENANT,
    credentialScopeId: TENANT,
    operation: "generate",
    ingressProtocol: "openai-chat",
    publicModelId: model,
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
    nativeBody: { model, stream: true, messages: [{ role: "user", content: "hi" }] },
    headerFingerprint: { allowlist: ["content-type"], fingerprint: "contract" },
  };
}

function trpcUrl(path: string, input?: unknown): string {
  const base = `${cluster?.nodes[0]?.url ?? ""}/trpc/${path}`;
  return input === undefined ? base : `${base}?input=${encodeURIComponent(JSON.stringify(input))}`;
}

async function trpcCall(
  path: string,
  method: "GET" | "POST",
  input?: unknown,
): Promise<{ status: number; data: unknown }> {
  const res = await pinned(method === "GET" ? trpcUrl(path, input) : trpcUrl(path), {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(input ?? null) } : {}),
  });
  const json = (await res.json()) as { result?: { data?: unknown } };
  return { status: res.status, data: json.result?.data };
}

/** Read a tRPC SSE subscription to its end, returning each data payload. */
async function trpcStream(path: string, input: unknown): Promise<unknown[]> {
  const res = await pinned(trpcUrl(path, input), {
    headers: { authorization: `Bearer ${bearer}`, accept: "text/event-stream" },
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  const payloads: unknown[] = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n");
    const event = lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const data = lines
      .find((line) => line.startsWith("data:"))
      ?.slice(5)
      .trim();
    if (event !== undefined || data === undefined || data === "") continue;
    payloads.push(JSON.parse(data));
  }
  return payloads;
}

function eventsOf(frames: readonly unknown[]): ExecutionEventV1[] {
  return frames.flatMap((frame) => {
    const typed = frame as { frame?: string; event?: unknown };
    return typed.frame === "event" ? [typed.event as ExecutionEventV1] : [];
  });
}

function expectOneValidAttempt(frames: readonly unknown[]): ExecutionEventV1[] {
  const events = eventsOf(frames);
  for (const event of events) {
    expect(ExecutionEventV1Schema.safeParse(event).success).toBe(true);
  }
  const validation = validateExecutionEventSequence(events);
  expect(validation.violations).toEqual([]);
  expect(validation.ok).toBe(true);
  expect(events[0]?.type).toBe("accepted");
  expect(events.map((event) => event.sequence)).toEqual(events.map((_, i) => i));
  expect(events.filter((event) => event.type === "terminal")).toHaveLength(1);
  return events;
}

function publishRecordingHost(): void {
  if (procedures === null) return;
  const host = procedures.createWorkerRpcHost({
    workerId: WORKER_ID,
    versions: [{ major: 1, minor: 0 }],
    advertisements: () => [workerAdvertisement()],
    // Service-credential claims arrive with the auth stage; until then the
    // test stands in for the authenticator with fixed server-side claims.
    resolveClaims: () => ({
      serviceId: "contract-test",
      operations: ["negotiate", "catalog", "submit", "stream", "status", "cancel"],
      deployments: [LOCAL_DEPLOYMENT, AD_DEPLOYMENT],
      models: [],
      tenants: [TENANT],
      credentialScopeId: TENANT,
    }),
  });
  const recording: typeof host = {
    ...host,
    submit: (claims, input) => {
      const result = host.submit(claims, input);
      recordedSubmitFrames.push([result]);
      return result;
    },
    stream: async function* (claims, input, signal) {
      const frames: unknown[] = [];
      recordedStreamFrames.push(frames);
      for await (const frame of host.stream(claims, input, signal)) {
        frames.push(frame);
        yield frame;
      }
    },
  };
  restoreHost = procedures.publishWorkerRpcHost(recording);
}

/**
 * A WebSocket constructor that trusts only `ca`. Bun's WebSocket takes TLS
 * options as its second argument; the DOM typings know only protocols.
 */
function pinnedWebSocket(ca: string): ClientWebSocketConstructor {
  const BunWebSocket = WebSocket as unknown as new (
    url: string,
    options: { tls: { ca: string } },
  ) => WebSocket;
  return class extends BunWebSocket {
    constructor(url: string) {
      super(url, { tls: { ca } });
    }
  } as unknown as ClientWebSocketConstructor;
}

/**
 * A central agent (pinned TLS) and a second agent that dials it as
 * `TUNNEL_NODE`. Both agents serve the process's one published worker
 * host, so the tunnel reaches the same worker as the direct dial.
 */
async function startTunnel(dir: string): Promise<void> {
  const cert = await tls.generateSelfSignedCert({
    dir,
    commonName: "127.0.0.1",
    hostnames: ["127.0.0.1", "localhost"],
  });
  const relay = auth.generateToken();
  const tunnelBearer = auth.generateToken();
  const started = startAgentServer({
    bindHost: "127.0.0.1",
    port: 0,
    tokenHash: relay.hash,
    tls: { certPath: cert.certPath, keyPath: cert.keyPath },
    advertiseMdns: false,
    tunnelCentral: { expectedBearerHash: tunnelBearer.hash },
  });
  central = started;
  let markReady = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  dialer = startAgentServer({
    bindHost: "127.0.0.1",
    port: 0,
    tokenHash: auth.generateToken().hash,
    advertiseMdns: false,
    tunnelDial: {
      url: `wss://127.0.0.1:${String(started.port)}/tunnel`,
      bearer: tunnelBearer.token,
      nodeName: TUNNEL_NODE,
      WebSocketCtor: pinnedWebSocket(cert.certPem),
      onStateChange: (state) => {
        if (state === "ready") markReady();
      },
    },
  });
  await ready;
  centralTrust = {
    url: started.url,
    certificate: cert.certPem,
    fingerprint: cert.fingerprint,
    token: relay.token,
  };
}

beforeAll(async () => {
  guard = installControllerClosedGuard();
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];
  temp = makeTempRuntime();
  const tempEnv = envForTemp(temp);
  for (const key of ["DEV_STORAGE", "LOCAL_AI_RUNTIME_DIR", "LLAMA_CPP_MODELS"] as const) {
    process.env[key] = tempEnv[key];
  }
  process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
  process.env["LLAMA_CPP_PORT"] = "1";
  Reflect.deleteProperty(process.env, "LLAMACTL_UNIFIED_PROXY");

  engine = startFakeEngine();
  writeLlamaServerWorkload(temp.runtimeDir, "wl-rpc", Number(new URL(engine.url).port));
  cluster = await makeCluster({ nodes: [{ name: WORKER_ID }] });
  process.env["LLAMACTL_CONFIG"] = cluster.clusterConfigPath;
  const cfg = kubecfg.loadConfig(cluster.clusterConfigPath);
  const node = cfg.clusters.flatMap((c) => c.nodes).find((n) => n.name === WORKER_ID);
  if (node === undefined) throw new Error("cluster node missing from kubeconfig");
  pinned = makePinnedFetch(node);
  workerNode = node;
  bearer = cfg.users.find((u) => u.name === "me")?.token ?? "";
  publishRecordingHost();
  await startTunnel(join(temp.devStorage, "tunnel-central"));
});

beforeEach(() => {
  engine.reset();
  recordedSubmitFrames.length = 0;
  recordedStreamFrames.length = 0;
});

afterAll(async () => {
  try {
    restoreHost?.();
    await dialer?.stop();
    await central?.stop();
    await cluster?.cleanup();
    await engine.stop();
    temp.cleanup();
  } finally {
    for (const key of ENV_KEYS) {
      const prev = envBackup[key];
      if (prev === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = prev;
    }
    guard.dispose();
  }
});

describe("InferenceRpcV1 gateway–worker round trip", () => {
  test("over the wire: negotiate, submit and stream run the fixed deployment once", async () => {
    const negotiated = await trpcCall("inferenceRpc.negotiate", "GET", {
      versions: [{ major: 1, minor: 0 }],
      requiredFeatures: ["execution-event-v1"],
      optionalFeatures: [],
    });
    expect(negotiated.status).toBe(200);
    const negotiation = negotiated.data as {
      outcome: string;
      version: unknown;
      workerIncarnation: string;
    };
    expect(negotiation.outcome).toBe("negotiated");
    expect(negotiation.version).toEqual({ major: 1, minor: 0 });

    const catalog = await trpcCall("inferenceRpc.catalog", "GET");
    expect(catalog.status).toBe(200);
    const listing = catalog.data as {
      catalogGeneration: string;
      deployments: { deploymentId: string; model: string; deploymentEpoch: string }[];
    };
    const deployment = listing.deployments.find((d) => d.deploymentId === LOCAL_DEPLOYMENT);
    expect(deployment?.model).toBe(LOCAL_MODEL);

    const attemptId = "att-wire-1";
    const submitted = await trpcCall("inferenceRpc.submit", "POST", {
      version: negotiation.version,
      envelope: envelope(attemptId, LOCAL_MODEL),
      target: {
        deploymentId: LOCAL_DEPLOYMENT,
        expectedDeploymentEpoch: deployment?.deploymentEpoch,
        catalogGeneration: listing.catalogGeneration,
        workerIncarnation: negotiation.workerIncarnation,
      },
      cancelId: "cancel-wire-1",
    });
    expect(submitted.status).toBe(200);
    expect((submitted.data as { outcome: string }).outcome).toBe("accepted");

    const frames = await trpcStream("inferenceRpc.stream", { attemptId });
    const events = expectOneValidAttempt(frames);
    const terminal = events.at(-1);
    expect(terminal?.type === "terminal" ? terminal.terminal : null).toMatchObject({
      outcome: "completed",
      completion: "upstream",
      model: LOCAL_MODEL,
      deployment: LOCAL_DEPLOYMENT,
    });
    expect(engine.requests).toHaveLength(1);
    expect(engine.requests[0]?.body?.["model"]).toBe(LOCAL_MODEL);
    expect(engine.requests[0]?.authorization).toBeNull();
  });

  test("through the unified proxy: a worker-rpc candidate runs once on its fixed deployment", async () => {
    const proxy = createProxy({
      env: { LLAMACTL_UNIFIED_PROXY: "1" },
      resolved: () => resolveEnv(),
      nodeId: WORKER_ID,
      peers: [],
      advertisements: [workerAdvertisement()],
    });
    const res = await proxy.handleRequest(
      new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: AD_ALIAS,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain('"content":"Hel"');
    expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);

    expect(recordedStreamFrames).toHaveLength(1);
    const events = expectOneValidAttempt(recordedStreamFrames[0] ?? []);
    const terminal = events.at(-1);
    expect(terminal?.type === "terminal" ? terminal.terminal : null).toMatchObject({
      outcome: "completed",
      model: AD_UPSTREAM,
      deployment: AD_DEPLOYMENT,
    });
    expect(engine.requests).toHaveLength(1);
    expect(engine.requests[0]?.body?.["model"]).toBe(AD_UPSTREAM);
  });
});

describe("InferenceRpcV1 through the unified proxy to a remote owner", () => {
  function proxyFor(peer: PeerNode): UnifiedProxy {
    return createProxy({
      env: { LLAMACTL_UNIFIED_PROXY: "1" },
      resolved: () => resolveEnv(),
      nodeId: "gateway",
      peers: [peer],
      advertisements: [workerAdvertisement()],
    });
  }

  async function chat(proxy: UnifiedProxy): Promise<{ res: Response; body: string }> {
    const res = await proxy.handleRequest(
      new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: AD_ALIAS,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    return { res, body: await res.text() };
  }

  function expectOneRemoteRun(res: Response, body: string, transport: string): void {
    expect(res.status).toBe(200);
    expect(res.headers.get("x-llamactl-worker-transport")).toBe(transport);
    expect(body).toContain('"content":"Hel"');
    expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(recordedSubmitFrames).toHaveLength(1);
    expect(recordedStreamFrames).toHaveLength(1);
    const events = expectOneValidAttempt(recordedStreamFrames[0] ?? []);
    const terminal = events.at(-1);
    expect(terminal?.type === "terminal" ? terminal.terminal : null).toMatchObject({
      outcome: "completed",
      model: AD_UPSTREAM,
      deployment: AD_DEPLOYMENT,
    });
    expect(engine.requests).toHaveLength(1);
    expect(engine.requests[0]?.body?.["model"]).toBe(AD_UPSTREAM);
    expect(engine.requests[0]?.authorization).toBeNull();
  }

  test("over the direct transport: the owner's pinned endpoint runs the fixed deployment once", async () => {
    const proxy = proxyFor({
      id: WORKER_ID,
      endpoint: workerNode.endpoint,
      certificate: workerNode.certificate ?? "",
      fingerprint: workerNode.certificateFingerprint ?? "",
      token: bearer,
    });
    const { res, body } = await chat(proxy);
    expectOneRemoteRun(res, body, "direct");
  });

  test("over the tunnel transport: a tunnelPreferred owner runs once through central's relay", async () => {
    const proxy = proxyFor({
      id: WORKER_ID,
      endpoint: "https://192.0.2.1:7843",
      tunnelPreferred: true,
      tunnelNodeName: TUNNEL_NODE,
      tunnelCentralUrl: centralTrust.url,
      tunnelCentralCertificate: centralTrust.certificate,
      tunnelCentralFingerprint: centralTrust.fingerprint,
      tunnelRelayToken: centralTrust.token,
    });
    const { res, body } = await chat(proxy);
    expectOneRemoteRun(res, body, "tunnel");
  });
});
