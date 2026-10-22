import type * as agentConfigMod from "@llamactl/core/config/agent-config";
/**
 * P4.1 (#139) — InferenceRpcV1 worker semantics through the embedded
 * client: golden exchanges, negotiation and the N-1 rolling-upgrade
 * window, acceptance fencing (X1/X2), non-model refusals (A4), no cache
 * semantics (A5), duplicate attempts and unknown outcomes (A3), and
 * in-process cancellation. Every emitted stream is checked with Nova's
 * `validateExecutionEventSequence`.
 *
 * The remote transports run against real agents: the worker serves the
 * RPC over pinned HTTPS (direct) and dials a central agent whose relay
 * reaches it over the reverse tunnel (A2 golden equivalence, transport
 * by declared owner, disconnect at each acceptance point, X3 bounded
 * streaming, X4 cancellation, client call timeouts).
 */
import type { PeerNode } from "@llamactl/core/config/peers";
import type { ClusterNode } from "@llamactl/core/config/schema";
import type { ResolvedEnv } from "@llamactl/core/types";

import { inferenceContracts, inferenceRpc, openaiProxy, routingCatalog } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { type ExecutionEventV1, validateExecutionEventSequence } from "@novaproto/contracts";
import { initTRPC } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";

import type { ClientWebSocketConstructor } from "../src/tunnel/tunnel-client.js";

import { envForTemp, makeTempRuntime } from "../../core/test/helpers.js";
import { makePinnedFetch, type PinnedFetch } from "../src/client/links.js";
import {
  auth,
  configSchema,
  config as kubecfg,
  type RunningAgent,
  startAgentServer,
  tls,
} from "../src/index.js";
import {
  acquireWorkerRpcExecutor,
  createDirectInferenceRpcClient,
  createEmbeddedInferenceRpcClient,
  createTunnelInferenceRpcClient,
  createWorkerRpcExecutor,
  type DirectInferenceRpcClientOptions,
  type InferenceRpcClient,
  InferenceRpcStreamOverflowError,
  type TunnelInferenceRpcClientOptions,
  type WorkerRpcExecutorOptions,
} from "../src/inference/client.js";
import {
  createWorkerRpcHost,
  currentWorkerRpcHost,
  publishWorkerRpcHost,
  type WorkerRpcBackendEvent,
  type WorkerRpcHost,
  type WorkerRpcHostOptions,
} from "../src/inference/procedures.js";
import { type BackendExecutor, createProxy } from "../src/proxy/create-proxy.js";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "../src/safe-fs.js";
import {
  createTunnelClient,
  createTunnelRouterHandler,
  type TunnelReq,
} from "../src/tunnel/index.js";
import { INFERENCE_RPC_STREAM_LIMITS } from "../src/tunnel/messages.js";
import { type FakeEngine, startFakeEngine } from "./fixtures/inference-rpc-v1/fake-engine.js";
import { type ControllerClosedGuard, installControllerClosedGuard } from "./helpers.js";

type Claims = inferenceRpc.InferenceServiceClaimsV1;
type Ad = routingCatalog.RouteAdvertisementV1;
type StreamFrame = inferenceRpc.InferenceRpcStreamFrameV1;

const WORKER = "worker-a";
const TENANT = "tenant-a";
const SCOPE = "scope-a";
const LOCAL = "deploy/worker-a/local";
const UPSTREAM = "upstream-model";
const ALL_OPERATIONS = [...inferenceRpc.InferenceRpcOperationSchema.options];
const V1_0 = { major: 1, minor: 0 };
const GOLDEN_NOW = Date.parse("2026-10-19T12:00:00.000Z");
const GOLDEN_PATH = join(import.meta.dir, "fixtures", "inference-rpc-v1", "golden.json");
const ENV_KEYS = ["DEV_STORAGE", "LOCAL_AI_RUNTIME_DIR", "LLAMACTL_CONFIG", "PATH"] as const;

let temp: ReturnType<typeof makeTempRuntime>;
let resolved: ResolvedEnv;
let engine: FakeEngine;
let restore: (() => void) | undefined;
let host: WorkerRpcHost | undefined;
const envBackup: Record<string, string | undefined> = {};

function ad(deploymentId: string, overrides: Partial<Ad> = {}): Ad {
  return {
    schemaVersion: 1,
    routeId: `route/${deploymentId}`,
    deploymentId,
    backendId: `backend/${deploymentId}`,
    ownerNodeId: WORKER,
    publicModelIds: [`public/${deploymentId}`],
    upstreamModelId: UPSTREAM,
    backendKind: "local-model",
    transport: "worker-rpc",
    endpoint: engine.url,
    capabilities: routingCapabilitiesForChat(),
    modelRevision: routingCatalog.knownRevision("rev-1"),
    deploymentEpoch: routingCatalog.knownRevision("epoch-1"),
    adapterRevision: routingCatalog.UNKNOWN_REVISION,
    policyRevision: routingCatalog.UNKNOWN_REVISION,
    weight: 1,
    draining: false,
    ...overrides,
  };
}

function routingCapabilitiesForChat(): Ad["capabilities"] {
  return {
    operations: ["generate"],
    protocols: ["openai-chat"],
    streaming: "sse",
    modalities: ["text"],
    tools: true,
    structuredOutput: true,
    tokenCounting: false,
    cancellation: true,
    sessions: false,
  };
}

function claims(overrides: Partial<Claims> = {}): Claims {
  return {
    serviceId: "svc-a",
    operations: ALL_OPERATIONS,
    deployments: [LOCAL],
    models: [],
    tenants: [TENANT],
    credentialScopeId: SCOPE,
    ...overrides,
  };
}

function envelope(
  attemptId: string,
  overrides: Record<string, unknown> = {},
  deadline = Date.now() + 60_000,
): inferenceContracts.InferenceEnvelopeV1 {
  return inferenceContracts.parseInferenceEnvelope({
    requestId: `req-${attemptId}`,
    attemptId,
    deadline,
    tenantId: TENANT,
    projectId: TENANT,
    credentialScopeId: SCOPE,
    operation: "generate",
    ingressProtocol: "openai-chat",
    publicModelId: `public/${LOCAL}`,
    features: routingCapabilitiesFeatures(),
    stream: true,
    nativeBody: {
      model: `public/${LOCAL}`,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    },
    headerFingerprint: { allowlist: ["content-type"], fingerprint: "test" },
    ...overrides,
  });
}

function routingCapabilitiesFeatures(): inferenceContracts.InferenceEnvelopeV1["features"] {
  return {
    operation: "generate",
    protocol: "openai-chat",
    stream: true,
    modalities: ["text"],
    tools: false,
    structuredOutput: false,
    session: false,
    cancellation: true,
  };
}

function useHost(opts: Partial<WorkerRpcHostOptions> = {}): WorkerRpcHost {
  host = createWorkerRpcHost({
    workerId: WORKER,
    versions: [V1_0],
    resolved: () => resolved,
    advertisements: () => [ad(LOCAL)],
    ...opts,
  });
  restore = publishWorkerRpcHost(host);
  return host;
}

function wrapHost(overrides: Partial<WorkerRpcHost>): WorkerRpcHost {
  const base = host;
  if (base === undefined) throw new Error("no host to wrap");
  const undo = publishWorkerRpcHost({ ...base, ...overrides });
  const prior = restore;
  restore = (): void => {
    undo();
    prior?.();
  };
  return base;
}

async function target(
  client: InferenceRpcClient,
  deploymentId = LOCAL,
): Promise<inferenceRpc.InferenceRpcTargetV1> {
  const listing = await client.catalog();
  if (listing.outcome !== "catalog") throw new Error("catalog rejected");
  return {
    deploymentId,
    expectedDeploymentEpoch:
      listing.deployments.find((d) => d.deploymentId === deploymentId)?.deploymentEpoch ??
      "epoch-1",
    catalogGeneration: listing.catalogGeneration,
    workerIncarnation: listing.workerIncarnation,
  };
}

async function submit(
  client: InferenceRpcClient,
  attemptId: string,
  opts: {
    deploymentId?: string;
    envelope?: inferenceContracts.InferenceEnvelopeV1;
    target?: Partial<inferenceRpc.InferenceRpcTargetV1>;
  } = {},
): Promise<inferenceRpc.InferenceRpcSubmitResultV1> {
  return await client.submit({
    version: V1_0,
    envelope: opts.envelope ?? envelope(attemptId),
    target: { ...(await target(client, opts.deploymentId)), ...opts.target },
    cancelId: `cancel-${attemptId}`,
  });
}

async function collect(frames: AsyncIterable<StreamFrame>): Promise<StreamFrame[]> {
  const out: StreamFrame[] = [];
  for await (const frame of frames) out.push(frame);
  return out;
}

function eventsOf(frames: readonly StreamFrame[]): ExecutionEventV1[] {
  return frames.flatMap((f) => (f.frame === "event" ? [f.event] : []));
}

function terminalOf(frames: readonly StreamFrame[]): unknown {
  const last = eventsOf(frames).at(-1);
  return last?.type === "terminal" ? last.terminal : undefined;
}

function expectValidStream(frames: readonly StreamFrame[]): void {
  const validation = validateExecutionEventSequence(eventsOf(frames));
  expect(validation.violations).toEqual([]);
  expect(validation.ok).toBe(true);
}

function rejectionCode(result: {
  outcome: string;
  rejection?: { code: string };
}): string | undefined {
  return result.outcome === "rejected" ? result.rejection?.code : result.outcome;
}

function ctxFor(env: inferenceContracts.InferenceEnvelopeV1): {
  req: Request;
  resolved: ResolvedEnv;
  attemptId: string;
  deadline: number;
} {
  return {
    req: new Request("http://127.0.0.1/v1/chat/completions", { method: "POST" }),
    resolved,
    attemptId: env.attemptId,
    deadline: env.deadline,
  };
}

function recordingFallback(calls: string[]): BackendExecutor {
  return {
    describe: () => ({ id: "fallback", backendKinds: [], transports: [] }),
    execute: (): Promise<Response> => {
      calls.push("fallback");
      return Promise.resolve(Response.json({ path: "fallback" }));
    },
    cancel: () => false,
    drain: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

interface CacheFileSnapshot {
  size: number;
  mtimeMs: number;
  sha256: string;
}

function snapshotCacheDir(dir: string): Record<string, CacheFileSnapshot> {
  const out: Record<string, CacheFileSnapshot> = {};
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (!stat.isFile()) continue;
    out[name] = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: createHash("sha256").update(readFileSync(full)).digest("hex"),
    };
  }
  return out;
}

function responseCacheCounters(env: ResolvedEnv): { hit: number; miss: number; evict: number } {
  return {
    hit: openaiProxy.__getOpenAIProxyResponseCacheHitTotalForTests(env),
    miss: openaiProxy.__getOpenAIProxyResponseCacheMissTotalForTests(env),
    evict: openaiProxy.__getOpenAIProxyResponseCacheEvictTotalForTests(env),
  };
}

beforeAll(() => {
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];
  temp = makeTempRuntime();
  const tempEnv = envForTemp(temp);
  process.env["DEV_STORAGE"] = tempEnv["DEV_STORAGE"];
  process.env["LOCAL_AI_RUNTIME_DIR"] = tempEnv["LOCAL_AI_RUNTIME_DIR"];
  resolved = resolveEnv({ ...tempEnv, LLAMA_CPP_HOST: "127.0.0.1", LLAMA_CPP_PORT: "1" });
  engine = startFakeEngine();
});

beforeEach(() => {
  engine.reset();
});

afterEach(() => {
  host?.close();
  host = undefined;
  restore?.();
  restore = undefined;
});

afterAll(async () => {
  try {
    await engine.stop();
    temp.cleanup();
  } finally {
    for (const key of ENV_KEYS) {
      const prev = envBackup[key];
      if (prev === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = prev;
    }
  }
});

const GOLDEN_CLAIMS = claims({
  serviceId: "svc-golden",
  deployments: [LOCAL, "deploy/worker-a/cli"],
});

/** Replays the golden script through `makeClient`, recording each exchange by value. */
async function recordGolden(makeClient: () => InferenceRpcClient): Promise<unknown[]> {
  useHost({
    incarnation: "inc-golden",
    now: () => GOLDEN_NOW,
    advertisements: () => [
      ad(LOCAL),
      ad("deploy/worker-a/cli", { backendKind: "cli", bindingId: "fakecli" }),
    ],
  });
  const client = makeClient();
  const exchanges: unknown[] = [];
  const call = async (
    procedure: string,
    input: unknown,
    run: () => Promise<unknown>,
  ): Promise<unknown> => {
    const output = await run();
    exchanges.push({ procedure, input, output });
    return output;
  };
  const negotiate = {
    versions: [V1_0],
    requiredFeatures: ["execution-event-v1"],
    optionalFeatures: ["attempt-status", "x-future"],
  };
  await call("negotiate", negotiate, () => client.negotiate(negotiate));
  const tooNew = {
    versions: [{ major: 2, minor: 0 }],
    requiredFeatures: [],
    optionalFeatures: [],
  };
  await call("negotiate", tooNew, () => client.negotiate(tooNew));
  await call("catalog", null, () => client.catalog());
  const listing = await client.catalog();
  const generation = listing.outcome === "catalog" ? listing.catalogGeneration : "";
  const submitInput = (
    attemptId: string,
    deploymentId: string,
  ): inferenceRpc.InferenceRpcSubmitInputV1 => ({
    version: V1_0,
    envelope: envelope(attemptId, {}, GOLDEN_NOW + 60_000),
    target: {
      deploymentId,
      expectedDeploymentEpoch: "epoch-1",
      catalogGeneration: generation,
      workerIncarnation: "inc-golden",
    },
    cancelId: `cancel-${attemptId}`,
  });
  const first = submitInput("att-golden-1", LOCAL);
  await call("submit", first, () => client.submit(first));
  await call("stream", { attemptId: "att-golden-1" }, () =>
    collect(client.stream({ attemptId: "att-golden-1" })),
  );
  await call("status", { attemptId: "att-golden-1" }, () =>
    client.status({ attemptId: "att-golden-1" }),
  );
  await call("submit", first, () => client.submit(first));
  await call("stream", { attemptId: "att-golden-1" }, () =>
    collect(client.stream({ attemptId: "att-golden-1" })),
  );
  const cli = submitInput("att-golden-cli", "deploy/worker-a/cli");
  await call("submit", cli, () => client.submit(cli));
  await call("cancel", { attemptId: "att-golden-none" }, () =>
    client.cancel({ attemptId: "att-golden-none" }),
  );
  return JSON.parse(JSON.stringify(exchanges)) as unknown[];
}

function goldenExchanges(): unknown[] {
  return (JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as { exchanges: unknown[] }).exchanges;
}

describe("golden exchanges", () => {
  test("the embedded exchanges match golden.json by value", async () => {
    expect(await recordGolden(() => createEmbeddedInferenceRpcClient(GOLDEN_CLAIMS))).toEqual(
      goldenExchanges(),
    );
  });

  test("every golden stream is a valid ExecutionEventV1 attempt or a status, never a replay", () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as {
      exchanges: { procedure: string; output: StreamFrame[] }[];
    };
    const streams = golden.exchanges.filter((e) => e.procedure === "stream");
    expect(streams).toHaveLength(2);
    expectValidStream(streams[0]?.output ?? []);
    expect(streams[1]?.output.map((f) => f.frame)).toEqual(["unavailable"]);
  });
});

describe("negotiation and the rolling-upgrade window", () => {
  test("a worker that lists no versions positively reports the RPC as not advertised", async () => {
    expect(
      currentWorkerRpcHost().negotiate(claims(), {
        versions: [V1_0],
        requiredFeatures: [],
        optionalFeatures: [],
      }).outcome,
    ).toBe("not-advertised");
    useHost({ versions: [] });
    const client = createEmbeddedInferenceRpcClient(claims());
    expect(await client.negotiate({ versions: [V1_0] })).toEqual({
      outcome: "not-advertised",
    });
    expect(rejectionCode(await submit(client, "att-unadvertised"))).toBe("unsupported-version");
  });

  test("a gateway and a worker one minor apart interoperate; further apart is a typed refusal", async () => {
    const at = (minor: number): inferenceRpc.InferenceRpcVersion[] =>
      inferenceRpc.inferenceRpcVersionsSpokenAt({ major: 1, minor });
    useHost({ versions: at(1) });
    const client = createEmbeddedInferenceRpcClient(claims());
    const negotiate = async (versions: inferenceRpc.InferenceRpcVersion[]): Promise<unknown> => {
      const result = await client.negotiate({ versions });
      return result.outcome === "negotiated" ? result.version : rejectionCode(result);
    };
    expect(await negotiate(at(0))).toEqual({ major: 1, minor: 0 });
    expect(await negotiate(at(1))).toEqual({ major: 1, minor: 1 });
    expect(await negotiate(at(2))).toEqual({ major: 1, minor: 1 });
    expect(await negotiate(at(3))).toBe("unsupported-version");
    expect(await negotiate([{ major: 2, minor: 0 }])).toBe("unsupported-version");
    // A caller claiming every minor is still judged by its newest version.
    expect(await negotiate([...at(3), ...at(1)])).toBe("unsupported-version");
    const refused = await client.negotiate({ versions: at(3) });
    expect(refused.outcome === "rejected" ? refused.rejection.supportedVersions : null).toEqual(
      at(1),
    );
  });

  test("selectInferenceRpcVersion is the pure N-1 window", () => {
    const v = (minor: number, major = 1): inferenceRpc.InferenceRpcVersion => ({ major, minor });
    expect(inferenceRpc.selectInferenceRpcVersion([v(4), v(3)], [v(3), v(2)])).toEqual(v(3));
    expect(inferenceRpc.selectInferenceRpcVersion([v(2), v(1)], [v(3), v(2)])).toEqual(v(2));
    expect(inferenceRpc.selectInferenceRpcVersion([v(1), v(0)], [v(3), v(2)])).toBeNull();
    expect(inferenceRpc.selectInferenceRpcVersion([v(0, 2)], [v(0)])).toBeNull();
    expect(inferenceRpc.selectInferenceRpcVersion([], [v(0)])).toBeNull();
  });

  test("an unknown required feature fails closed; unknown optional features are ignored", async () => {
    useHost();
    const client = createEmbeddedInferenceRpcClient(claims());
    const refused = await client.negotiate({ versions: [V1_0], requiredFeatures: ["sessions-v9"] });
    expect(refused).toMatchObject({
      outcome: "rejected",
      rejection: { code: "unsupported-feature", unsupportedFeatures: ["sessions-v9"] },
    });
    const ok = await client.negotiate({
      versions: [V1_0],
      requiredFeatures: ["execution-event-v1"],
      optionalFeatures: ["cancel-ack", "x-later"],
    });
    expect(ok).toMatchObject({
      outcome: "negotiated",
      features: ["cancel-ack", "execution-event-v1"],
    });
  });
});

describe("acceptance fencing before any engine request (X1, X2, X5)", () => {
  test("a foreign deployment is not-owner and a stale epoch, generation or incarnation is stale-generation", async () => {
    const foreign = "deploy/worker-b/local";
    useHost({ advertisements: () => [ad(LOCAL), ad(foreign, { ownerNodeId: "worker-b" })] });
    const client = createEmbeddedInferenceRpcClient(claims({ deployments: [LOCAL, foreign] }));
    expect(rejectionCode(await submit(client, "att-foreign", { deploymentId: foreign }))).toBe(
      "not-owner",
    );
    const staleEpoch = await submit(client, "att-epoch", {
      target: { expectedDeploymentEpoch: "epoch-0" },
    });
    expect(rejectionCode(staleEpoch)).toBe("stale-generation");
    const staleGen = await submit(client, "att-gen", { target: { catalogGeneration: "gen-old" } });
    expect(staleGen).toMatchObject({
      rejection: {
        code: "stale-generation",
        catalogGeneration: expect.stringMatching(/^gen-/) as unknown,
      },
    });
    const restarted = await submit(client, "att-inc", { target: { workerIncarnation: "inc-old" } });
    expect(rejectionCode(restarted)).toBe("stale-generation");
    for (const attemptId of ["att-foreign", "att-epoch", "att-gen", "att-inc"]) {
      expect(await collect(client.stream({ attemptId }))).toEqual([
        { frame: "unavailable", status: { attemptId, state: "unknown" } },
      ]);
    }
    expect(engine.requests).toHaveLength(0);
  });

  test("an unknown deployment epoch cannot be fenced and is target-unavailable", async () => {
    useHost({
      advertisements: () => [ad(LOCAL, { deploymentEpoch: routingCatalog.UNKNOWN_REVISION })],
    });
    const client = createEmbeddedInferenceRpcClient(claims());
    expect(rejectionCode(await submit(client, "att-noepoch"))).toBe("target-unavailable");
    expect(engine.requests).toHaveLength(0);
  });

  test("claims are checked first: operation, tenant, credential scope and deployment ACL", async () => {
    useHost({
      advertisements: () => [ad(LOCAL), ad("deploy/worker-b/x", { ownerNodeId: "worker-b" })],
    });
    const scoped = async (
      c: Claims,
      attemptId: string,
      deploymentId = LOCAL,
    ): Promise<string | undefined> =>
      rejectionCode(await submit(createEmbeddedInferenceRpcClient(c), attemptId, { deploymentId }));
    expect(await scoped(claims({ operations: ["negotiate", "catalog"] }), "att-op")).toBe(
      "unauthorized-scope",
    );
    expect(await scoped(claims({ tenants: ["tenant-b"] }), "att-tenant")).toBe(
      "unauthorized-scope",
    );
    expect(await scoped(claims({ credentialScopeId: "scope-b" }), "att-scope")).toBe(
      "unauthorized-scope",
    );
    // Revoking the deployment from the binding takes effect on the next submit.
    expect(await scoped(claims({ deployments: [] }), "att-revoked")).toBe("unauthorized-scope");
    expect(await scoped(claims(), "att-foreign-acl", "deploy/worker-b/x")).toBe(
      "unauthorized-scope",
    );
    expect(await scoped(claims({ deployments: [], models: [UPSTREAM] }), "att-by-model")).toBe(
      "accepted",
    );
    const anonymous = currentWorkerRpcHost();
    expect(rejectionCode(anonymous.catalog(undefined))).toBe("unauthorized-scope");
    expect(engine.requests).toHaveLength(0);
  });

  test("an expired deadline, a spent hop budget and a visited-node loop are refused", async () => {
    useHost();
    const client = createEmbeddedInferenceRpcClient(claims());
    const late = envelope("att-late", {}, Date.now() - 1);
    expect(rejectionCode(await submit(client, "att-late", { envelope: late }))).toBe(
      "deadline-exceeded",
    );
    const hops = envelope("att-hops", { internal: { hopCount: 2 } });
    expect(rejectionCode(await submit(client, "att-hops", { envelope: hops }))).toBe("hop-limit");
    const loop = envelope("att-loop", { internal: { hopCount: 1, visitedNodes: ["gw", "gw"] } });
    expect(rejectionCode(await submit(client, "att-loop", { envelope: loop }))).toBe("hop-limit");
    const ok = envelope("att-hop-ok", { internal: { hopCount: 1, visitedNodes: ["gw"] } });
    expect(rejectionCode(await submit(client, "att-hop-ok", { envelope: ok }))).toBe("accepted");
    expect(engine.requests).toHaveLength(0);
  });

  test("the worker caps unsettled attempts with a typed overloaded refusal", async () => {
    useHost({ maxActiveAttempts: 1 });
    const client = createEmbeddedInferenceRpcClient(claims());
    expect(rejectionCode(await submit(client, "att-cap-1"))).toBe("accepted");
    expect(rejectionCode(await submit(client, "att-cap-2"))).toBe("overloaded");
  });

  test("execution runs exactly the fixed deployment and reports what executed, with no credential", async () => {
    useHost({ advertisements: () => [ad(LOCAL, { publicModelIds: ["friendly-alias"] })] });
    const client = createEmbeddedInferenceRpcClient(claims());
    expect(
      rejectionCode(
        await submit(client, "att-x1", {
          envelope: envelope("att-x1", {
            publicModelId: "friendly-alias",
            nativeBody: {
              model: "friendly-alias",
              stream: true,
              messages: [{ role: "user", content: "hi" }],
            },
          }),
        }),
      ),
    ).toBe("accepted");
    const frames = await collect(client.stream({ attemptId: "att-x1" }));
    expectValidStream(frames);
    expect(terminalOf(frames)).toMatchObject({
      outcome: "completed",
      completion: "upstream",
      model: UPSTREAM,
      deployment: LOCAL,
      usage: { source: "observed", input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    });
    expect(engine.requests).toHaveLength(1);
    expect(engine.requests[0]?.body?.["model"]).toBe(UPSTREAM);
    expect(engine.requests[0]?.authorization).toBeNull();
  });

  test("a model the target deployment does not serve is refused typed, before any engine request (X1)", async () => {
    useHost();
    const client = createEmbeddedInferenceRpcClient(claims());
    const asked = (attemptId: string, model: string): inferenceContracts.InferenceEnvelopeV1 =>
      envelope(attemptId, {
        publicModelId: model,
        nativeBody: { model, stream: true, messages: [{ role: "user", content: "hi" }] },
      });
    expect(
      await submit(client, "att-x1-other", { envelope: asked("att-x1-other", "other-model") }),
    ).toMatchObject({
      outcome: "rejected",
      rejection: {
        code: "target-unavailable",
        message: expect.stringContaining("other-model") as unknown,
      },
    });
    expect(await collect(client.stream({ attemptId: "att-x1-other" }))).toEqual([
      { frame: "unavailable", status: { attemptId: "att-x1-other", state: "unknown" } },
    ]);
    expect(
      rejectionCode(
        await submit(client, "att-x1-upstream", {
          envelope: asked("att-x1-upstream", UPSTREAM),
        }),
      ),
    ).toBe("accepted");
    expect(
      rejectionCode(
        await submit(client, "att-x1-public", {
          envelope: asked("att-x1-public", `public/${LOCAL}`),
        }),
      ),
    ).toBe("accepted");
    expect(engine.requests).toHaveLength(0);
  });

  test("a deployment that restarted between acceptance and the stream is never dialled (X2)", async () => {
    let epoch = "epoch-1";
    useHost({
      advertisements: () => [ad(LOCAL, { deploymentEpoch: routingCatalog.knownRevision(epoch) })],
    });
    const client = createEmbeddedInferenceRpcClient(claims());
    expect(rejectionCode(await submit(client, "att-restarted"))).toBe("accepted");
    epoch = "epoch-2";
    const frames = await collect(client.stream({ attemptId: "att-restarted" }));
    expectValidStream(frames);
    expect(terminalOf(frames)).toMatchObject({
      outcome: "failed",
      started: false,
      error: { code: "target-unavailable" },
    });
    expect(await client.status({ attemptId: "att-restarted" })).toMatchObject({
      state: "terminal",
      terminal: { outcome: "failed", started: false },
    });
    expect(rejectionCode(await submit(client, "att-same-epoch"))).toBe("accepted");
    expectValidStream(await collect(client.stream({ attemptId: "att-same-epoch" })));
    expect(engine.requests).toHaveLength(1);
  });

  test("a deployment the worker no longer owns at the stream is never dialled (X2)", async () => {
    let owner = WORKER;
    useHost({ advertisements: () => [ad(LOCAL, { ownerNodeId: owner })] });
    const client = createEmbeddedInferenceRpcClient(claims());
    expect(rejectionCode(await submit(client, "att-moved-away"))).toBe("accepted");
    owner = "worker-b";
    const frames = await collect(client.stream({ attemptId: "att-moved-away" }));
    expectValidStream(frames);
    expect(terminalOf(frames)).toMatchObject({
      outcome: "failed",
      started: false,
      error: {
        code: "target-unavailable",
        message: expect.stringContaining("no longer owns") as unknown,
      },
    });
    expect(engine.requests).toHaveLength(0);
  });

  test("a deployment whose epoch became unknown at the stream is refused with that reason (X2)", async () => {
    let known = true;
    useHost({
      advertisements: () => [
        ad(LOCAL, {
          deploymentEpoch: known
            ? routingCatalog.knownRevision("epoch-1")
            : routingCatalog.UNKNOWN_REVISION,
        }),
      ],
    });
    const client = createEmbeddedInferenceRpcClient(claims());
    expect(rejectionCode(await submit(client, "att-epoch-unknown"))).toBe("accepted");
    known = false;
    const frames = await collect(client.stream({ attemptId: "att-epoch-unknown" }));
    expectValidStream(frames);
    expect(terminalOf(frames)).toMatchObject({
      outcome: "failed",
      started: false,
      error: { code: "target-unavailable", message: "the deployment epoch is unknown" },
    });
    expect(engine.requests).toHaveLength(0);
  });
});

describe("non-model targets (A4) and no cache semantics (A5)", () => {
  let binDir = "";
  let cliMarker = "";
  let acpMarker = "";

  beforeAll(() => {
    binDir = join(temp.devStorage, "fake-bin");
    mkdirSync(binDir, { recursive: true });
    cliMarker = join(temp.devStorage, "fake-cli.invocations");
    acpMarker = join(temp.devStorage, "fake-acp.invocations");
    const script = (marker: string): string => `#!/bin/sh\necho "$*" >> '${marker}'\necho fake\n`;
    writeFileSync(join(binDir, "fake-cli"), script(cliMarker));
    writeFileSync(join(binDir, "fake-acp"), script(acpMarker));
    chmodSync(join(binDir, "fake-cli"), 0o755);
    chmodSync(join(binDir, "fake-acp"), 0o755);
    // The CLI is bound in the node's cli: array; the ACP executable is only on PATH.
    let cfg = configSchema.freshConfig();
    cfg = kubecfg.upsertNode(cfg, "home", {
      name: WORKER,
      endpoint: "https://127.0.0.1:1",
      cli: [
        configSchema.CliBindingSchema.parse({
          name: "fakecli",
          preset: "custom",
          command: join(binDir, "fake-cli"),
          args: ["{{prompt}}"],
        }),
      ],
    });
    const configPath = join(temp.devStorage, "kubeconfig");
    kubecfg.saveConfig(cfg, configPath);
    process.env["LLAMACTL_CONFIG"] = configPath;
    process.env["PATH"] = `${binDir}:${envBackup["PATH"] ?? ""}`;
  });

  afterAll(() => {
    process.env["PATH"] = envBackup["PATH"];
    Reflect.deleteProperty(process.env, "LLAMACTL_CONFIG");
  });

  const CLI = "deploy/worker-a/cli";
  const ACP = "deploy/worker-a/acp";
  const CLOUD = "deploy/worker-a/cloud";
  const targets = (): Ad[] => [
    ad(LOCAL),
    ad(CLI, { backendKind: "cli", bindingId: "fakecli", providerKind: "custom" }),
    ad(ACP, { backendKind: "acp", bindingId: "fake-acp" }),
    ad(CLOUD, {
      backendKind: "cloud-api",
      transport: "cloud-direct",
      endpoint: "https://api.invalid/v1",
    }),
  ];

  test("cli, acp and cloud-api targets are target-unavailable and nothing is spawned", async () => {
    useHost({ advertisements: targets });
    const client = createEmbeddedInferenceRpcClient(
      claims({ deployments: [LOCAL, CLI, ACP, CLOUD] }),
    );
    const listing = await client.catalog();
    expect(
      listing.outcome === "catalog"
        ? listing.deployments.map((d) => [d.deploymentId, d.availability])
        : [],
    ).toEqual([
      [ACP, "unavailable"],
      [CLI, "unavailable"],
      [CLOUD, "unavailable"],
      [LOCAL, "available"],
    ]);
    for (const deploymentId of [CLI, ACP, CLOUD]) {
      const attemptId = `att-${deploymentId}`;
      expect(rejectionCode(await submit(client, attemptId, { deploymentId }))).toBe(
        "target-unavailable",
      );
      expect(await collect(client.stream({ attemptId }))).toHaveLength(1);
    }
    expect(existsSync(cliMarker)).toBe(false);
    expect(existsSync(acpMarker)).toBe(false);
    expect(engine.requests).toHaveLength(0);
  });

  test("the backend-kind registration point is closed by default and opens only by registration", async () => {
    let executed = 0;
    const stub: WorkerRpcHostOptions["backends"] = new Map([
      [
        "cli",
        {
          execute: async function* (): AsyncGenerator<WorkerRpcBackendEvent> {
            executed += 1;
            await Promise.resolve();
            yield {
              type: "end",
              result: { ok: true, finishReason: "stop" },
              usage: { source: "unknown" },
            } as const;
          },
        },
      ],
    ]);
    useHost({ advertisements: targets, backends: stub });
    const client = createEmbeddedInferenceRpcClient(claims({ deployments: [LOCAL, CLI] }));
    expect(rejectionCode(await submit(client, "att-local-unregistered"))).toBe(
      "target-unavailable",
    );
    expect(
      rejectionCode(
        await submit(client, "att-cli-registered", {
          deploymentId: CLI,
          envelope: envelope("att-cli-registered", { publicModelId: `public/${CLI}` }),
        }),
      ),
    ).toBe("accepted");
    expectValidStream(await collect(client.stream({ attemptId: "att-cli-registered" })));
    expect(executed).toBe(1);
    expect(existsSync(cliMarker)).toBe(false);
  });

  test("session and semantic-cache requests are unsupported; other protocols are refused", async () => {
    useHost();
    const client = createEmbeddedInferenceRpcClient(claims());
    const refused = async (
      attemptId: string,
      overrides: Record<string, unknown>,
    ): Promise<string | undefined> =>
      rejectionCode(await submit(client, attemptId, { envelope: envelope(attemptId, overrides) }));
    expect(
      await refused("att-session", { session: { sessionId: "s1", ownerNodeId: WORKER } }),
    ).toBe("unsupported-feature");
    expect(
      await refused("att-semantic", { cachePolicy: { exact: "default", semantic: "read" } }),
    ).toBe("unsupported-feature");
    expect(await refused("att-embed", { operation: "embed" })).toBe("unsupported-feature");
    expect(await refused("att-anthropic", { ingressProtocol: "anthropic-messages" })).toBe(
      "unsupported-feature",
    );
    expect(engine.requests).toHaveLength(0);
  });

  test("an RPC execution never reads or writes the embedded exact response cache", async () => {
    useHost();
    const client = createEmbeddedInferenceRpcClient(claims());
    const cacheDir = join(temp.devStorage, "responsecache");
    const before = existsSync(cacheDir);
    // The embedded exact cache is rooted at LOCAL_AI_RUNTIME_DIR (resolveKvDataRoot), not DEV_STORAGE. responseCacheCounters opens it through the proxy's own runtime, which creates an empty responses.db; it holds no entry, so a read-path regression shows only in the hit and miss counters.
    const dataRoot = resolved.LOCAL_AI_RUNTIME_DIR;
    const seededCacheDir = join(dataRoot, "responsecache");
    const countersBefore = responseCacheCounters(resolved);
    expect(existsSync(join(seededCacheDir, "responses.db"))).toBe(true);
    const snapshotBefore = snapshotCacheDir(seededCacheDir);
    expect("responses.db" in snapshotBefore).toBe(true);
    for (const exact of ["default", "refresh"] as const) {
      const attemptId = `att-cache-${exact}`;
      const env = envelope(attemptId, { cachePolicy: { exact, semantic: "off" } });
      expect(rejectionCode(await submit(client, attemptId, { envelope: env }))).toBe("accepted");
      expectValidStream(await collect(client.stream({ attemptId })));
    }
    expect(engine.requests).toHaveLength(2);
    expect(before).toBe(false);
    expect(existsSync(cacheDir)).toBe(false);
    expect(snapshotCacheDir(seededCacheDir)).toEqual(snapshotBefore);
    expect(responseCacheCounters(resolved)).toEqual(countersBefore);
  });
});

describe("attempt records: duplicates, status and unknown outcomes (A3)", () => {
  test("a duplicate attemptId returns the existing record and never executes twice", async () => {
    useHost();
    const client = createEmbeddedInferenceRpcClient(claims());
    expect(rejectionCode(await submit(client, "att-dup"))).toBe("accepted");
    expect(await client.status({ attemptId: "att-dup" })).toMatchObject({
      outcome: "status",
      state: "accepted",
    });
    const again = await submit(client, "att-dup");
    expect(again).toMatchObject({
      outcome: "existing",
      status: { attemptId: "att-dup", state: "accepted" },
    });
    expectValidStream(await collect(client.stream({ attemptId: "att-dup" })));
    expect(await submit(client, "att-dup")).toMatchObject({
      outcome: "existing",
      status: { state: "terminal" },
    });
    const replay = await collect(client.stream({ attemptId: "att-dup" }));
    expect(replay).toMatchObject([
      { frame: "unavailable", status: { state: "terminal", terminal: { outcome: "completed" } } },
    ]);
    // Another service cannot see or reuse the attempt.
    const other = createEmbeddedInferenceRpcClient(claims({ serviceId: "svc-b" }));
    expect(rejectionCode(await submit(other, "att-dup"))).toBe("unauthorized-scope");
    expect(await other.status({ attemptId: "att-dup" })).toMatchObject({ state: "unknown" });
    expect(engine.requests).toHaveLength(1);
  });

  test("a duplicate is the existing record while the worker drains or after its deployment ACL is revoked", async () => {
    const worker = useHost();
    const client = createEmbeddedInferenceRpcClient(claims());
    expect(rejectionCode(await submit(client, "att-dup-drain"))).toBe("accepted");
    const drained = worker.drain();
    expect(rejectionCode(await submit(client, "att-dup-new"))).toBe("unsupported-version");
    expect(await submit(client, "att-dup-drain")).toMatchObject({
      outcome: "existing",
      status: { attemptId: "att-dup-drain", state: "accepted" },
    });
    const revoked = createEmbeddedInferenceRpcClient(claims({ deployments: [] }));
    expect(await submit(revoked, "att-dup-drain")).toMatchObject({ outcome: "existing" });
    const other = createEmbeddedInferenceRpcClient(claims({ serviceId: "svc-b" }));
    expect((await submit(other, "att-dup-drain")).outcome).toBe("rejected");
    worker.close();
    await drained;
    expect(engine.requests).toHaveLength(0);
  });

  test("a resubmit after 1100 other attempts settled is still the existing record, never a second run", async () => {
    let clock = Date.now();
    let mono = 0;
    const worker = useHost({ now: () => clock, monotonicNow: () => mono });
    const owner = claims();
    const client = createEmbeddedInferenceRpcClient(owner);
    const original = envelope("att-evicted");
    expect(rejectionCode(await submit(client, "att-evicted", { envelope: original }))).toBe(
      "accepted",
    );
    expectValidStream(await collect(client.stream({ attemptId: "att-evicted" })));
    expect(engine.requests).toHaveLength(1);
    const fenced = await target(client);
    for (let i = 0; i < 1100; i++) {
      const attemptId = `att-filler-${String(i)}`;
      const filler = {
        version: V1_0,
        envelope: envelope(attemptId),
        target: fenced,
        cancelId: `cancel-${attemptId}`,
      };
      expect(worker.submit(owner, filler).outcome).toBe("accepted");
      expect(worker.cancel(owner, { attemptId }).outcome).toBe("cancelled");
    }
    // Later, well inside the deadline.
    clock += 5_000;
    mono += 5_000;
    expect(await submit(client, "att-evicted", { envelope: original })).toMatchObject({
      outcome: "existing",
      status: { state: "terminal", terminal: { outcome: "completed" } },
    });
    expect(await collect(client.stream({ attemptId: "att-evicted" }))).toMatchObject([
      { frame: "unavailable", status: { state: "terminal" } },
    ]);
    // Past the horizon and the grace period the record goes; the same
    // submit is then refused by its own deadline, so it still never runs.
    clock = original.deadline + 120_000;
    mono += inferenceRpc.INFERENCE_RPC_MAX_DEADLINE_MS + 60_000;
    expect(rejectionCode(await submit(client, "att-evicted", { envelope: original }))).toBe(
      "deadline-exceeded",
    );
    expect(worker.status(owner, { attemptId: "att-evicted" })).toMatchObject({ state: "unknown" });
    expect(engine.requests).toHaveLength(1);
  });

  test("a settled attempt keeps only its status: no envelope, no request body", async () => {
    const worker = useHost();
    const owner = claims();
    const fenced = await target(createEmbeddedInferenceRpcClient(owner));
    const bodies: WeakRef<object>[] = [];
    const submitAndSettle = (i: number): void => {
      const env = envelope(`att-memory-${String(i)}`, {
        nativeBody: {
          model: `public/${LOCAL}`,
          messages: [{ role: "user", content: "x".repeat(16 * 1024) }],
        },
      });
      bodies.push(new WeakRef(env.nativeBody));
      const cancelId = `cancel-memory-${String(i)}`;
      worker.submit(owner, { version: V1_0, envelope: env, target: fenced, cancelId });
      worker.cancel(owner, { attemptId: env.attemptId });
    };
    for (let i = 0; i < 200; i++) submitAndSettle(i);
    for (let round = 0; round < 2; round++) {
      await new Promise((r) => setTimeout(r, 0));
      Bun.gc(true);
    }
    // A conservative collector may keep a stray few; a record would keep them all.
    expect(bodies.filter((ref) => ref.deref() !== undefined).length).toBeLessThan(20);
    expect(worker.status(owner, { attemptId: "att-memory-0" })).toMatchObject({
      state: "terminal",
      deploymentId: LOCAL,
      terminal: { outcome: "cancelled", started: false },
    });
  });

  test("an attempt belongs to its service and credential scope, within its tenant", async () => {
    const worker = useHost();
    const owner = claims();
    const fenced = await target(createEmbeddedInferenceRpcClient(owner));
    const accepted = worker.submit(owner, {
      version: V1_0,
      envelope: envelope("att-scoped"),
      target: fenced,
      cancelId: "cancel-scoped",
    });
    expect(accepted.outcome).toBe("accepted");
    for (const other of [
      claims({ credentialScopeId: "scope-b" }),
      claims({ credentialScopeId: "scope-b", tenants: ["tenant-b"] }),
      claims({ tenants: ["tenant-b"] }),
    ]) {
      const frames = await collect(
        worker.stream(other, { attemptId: "att-scoped" }, new AbortController().signal),
      );
      expect(frames).toEqual([
        { frame: "unavailable", status: { attemptId: "att-scoped", state: "unknown" } },
      ]);
      expect(worker.status(other, { attemptId: "att-scoped" })).toMatchObject({
        state: "unknown",
      });
      expect(worker.cancel(other, { attemptId: "att-scoped" })).toEqual({ outcome: "unknown" });
      expect(worker.cancel(other, { cancelId: "cancel-scoped" })).toEqual({ outcome: "unknown" });
    }
    // A resubmit from another scope is refused, never attached to the attempt.
    const otherScope = claims({ credentialScopeId: "scope-b" });
    const resubmitted = worker.submit(otherScope, {
      version: V1_0,
      envelope: envelope("att-scoped", { credentialScopeId: "scope-b" }),
      target: fenced,
      cancelId: "cancel-other",
    });
    expect(rejectionCode(resubmitted)).toBe("unauthorized-scope");
    expect(worker.status(owner, { attemptId: "att-scoped" })).toMatchObject({
      state: "accepted",
    });
    expect(engine.requests).toHaveLength(0);
  });

  test("a deadline beyond the horizon is refused typed, by the worker and before a caller sends anything", async () => {
    const worker = useHost();
    const owner = claims();
    const client = createEmbeddedInferenceRpcClient(owner);
    const far = Date.now() + 30 * 24 * 3600 * 1000;
    const env = envelope("att-far", {}, far);
    expect(rejectionCode(await submit(client, "att-far", { envelope: env }))).toBe(
      "deadline-exceeded",
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(worker.status(owner, { attemptId: "att-far" })).toMatchObject({ state: "unknown" });
    let negotiations = 0;
    const counting: InferenceRpcClient = {
      ...client,
      negotiate: async (input) => {
        negotiations += 1;
        return await client.negotiate(input);
      },
    };
    const res = await createWorkerRpcExecutor({
      client: counting,
      deploymentId: LOCAL,
      fallback: recordingFallback([]),
      nodeId: "gw",
    }).execute(env, ctxFor(env));
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: { code: "deadline-exceeded" } });
    expect(negotiations).toBe(0);
    expect(engine.requests).toHaveLength(0);
  });

  test("an existing record for another request is never attached", async () => {
    const worker = useHost();
    const owner = claims();
    const fenced = await target(createEmbeddedInferenceRpcClient(owner));
    const accepted = worker.submit(owner, {
      version: V1_0,
      envelope: envelope("att-shared"),
      target: fenced,
      cancelId: "cancel-shared",
    });
    expect(accepted.outcome).toBe("accepted");
    const env = envelope("att-shared", { requestId: "req-another" });
    const res = await createWorkerRpcExecutor({
      client: createEmbeddedInferenceRpcClient(owner),
      deploymentId: LOCAL,
      fallback: recordingFallback([]),
      nodeId: "gw",
    }).execute(env, ctxFor(env));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "target-unavailable" } });
    expect(worker.status(owner, { attemptId: "att-shared" })).toMatchObject({
      state: "accepted",
      requestId: "req-att-shared",
    });
    expect(engine.requests).toHaveLength(0);
  });

  test("a lost submit acknowledgement is resolved through status and run exactly once", async () => {
    useHost();
    const real = createEmbeddedInferenceRpcClient(claims());
    let submits = 0;
    const lossy: InferenceRpcClient = {
      ...real,
      submit: async (input) => {
        submits += 1;
        await real.submit(input);
        throw new Error("connection reset before the acknowledgement");
      },
    };
    const calls: string[] = [];
    const executor = createWorkerRpcExecutor({
      client: lossy,
      deploymentId: LOCAL,
      fallback: recordingFallback(calls),
      nodeId: "gw",
    });
    const env = envelope("att-lost-ack");
    const res = await executor.execute(env, ctxFor(env));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"content":"Hel"');
    expect(submits).toBe(1);
    expect(calls).toEqual([]);
    expect(engine.requests).toHaveLength(1);
  });

  test("an unknown outcome is surfaced and never replayed", async () => {
    useHost();
    const real = createEmbeddedInferenceRpcClient(claims());
    let submits = 0;
    const broken: InferenceRpcClient = {
      ...real,
      submit: async (input) => {
        submits += 1;
        return await real.submit(input);
      },
      // The transport drops after the first content event, and the worker
      // can no longer be asked about the attempt.
      stream: async function* (input, signal) {
        let seen = 0;
        for await (const frame of real.stream(input, signal)) {
          yield frame;
          if (frame.frame === "event" && frame.event.type === "content" && ++seen === 1) {
            throw new Error("tunnel closed");
          }
        }
      },
      status: (input) =>
        Promise.resolve({ outcome: "status", attemptId: input.attemptId, state: "unknown" }),
    };
    const executor = createWorkerRpcExecutor({
      client: broken,
      deploymentId: LOCAL,
      fallback: recordingFallback([]),
      nodeId: "gw",
    });
    const env = envelope("att-unknown");
    const res = await executor.execute(env, ctxFor(env));
    const body = await res.text();
    expect(body).toContain('"content":"Hel"');
    expect(body).toContain('"code":"unknown-outcome"');
    expect(body).not.toContain("[DONE]");
    expect(submits).toBe(1);
    expect(engine.requests).toHaveLength(1);
  });

  test("a submit lost with no record on the worker is unknown-outcome, not a retry", async () => {
    useHost();
    const real = createEmbeddedInferenceRpcClient(claims());
    let submits = 0;
    const dead: InferenceRpcClient = {
      ...real,
      submit: () => {
        submits += 1;
        return Promise.reject(new Error("timeout"));
      },
    };
    const executor = createWorkerRpcExecutor({
      client: dead,
      deploymentId: LOCAL,
      fallback: recordingFallback([]),
      nodeId: "gw",
    });
    const env = envelope("att-never");
    const res = await executor.execute(env, ctxFor(env));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: "unknown-outcome" } });
    expect(submits).toBe(1);
    expect(engine.requests).toHaveLength(0);
  });
});

/**
 * B, N1, N2: a settled attempt is kept as a small tombstone for the
 * deadline horizon plus a minute after its acceptance, on the monotonic
 * clock, under its owner's (serviceId, credentialScopeId) quota; the
 * worker-wide cap is only a backstop.
 */
describe("attempt records: per-owner quotas, tombstones and retention (B, N1, N2)", () => {
  /** The documented retention: the deadline horizon plus a minute's grace. */
  const RETENTION_MS = inferenceRpc.INFERENCE_RPC_MAX_DEADLINE_MS + 60_000;

  function clocked(opts: Partial<WorkerRpcHostOptions> = {}): {
    worker: WorkerRpcHost;
    clock: { wall: number; mono: number };
  } {
    const clock = { wall: Date.now(), mono: 0 };
    const worker = useHost({ now: () => clock.wall, monotonicNow: () => clock.mono, ...opts });
    return { worker, clock };
  }

  /** Submits one attempt for `owner` and, unless kept live, cancels it before it streams. */
  function submitFor(
    worker: WorkerRpcHost,
    owner: Claims,
    fenced: inferenceRpc.InferenceRpcTargetV1,
    attemptId: string,
    deadline: number,
    live = false,
  ): inferenceRpc.InferenceRpcSubmitResultV1 {
    const env = envelope(attemptId, { credentialScopeId: owner.credentialScopeId }, deadline);
    const result = worker.submit(owner, {
      version: V1_0,
      envelope: env,
      target: fenced,
      cancelId: `cancel-${attemptId}`,
    });
    if (result.outcome === "accepted" && !live) worker.cancel(owner, { attemptId });
    return result;
  }

  function refusal(result: inferenceRpc.InferenceRpcSubmitResultV1): string {
    return result.outcome === "rejected"
      ? `${result.rejection.code}: ${result.rejection.message}`
      : result.outcome;
  }

  test("one owner's 16,384 settled attempts leave every other owner admitted (the review's repro)", async () => {
    const { worker, clock } = clocked();
    const a = claims();
    const fenced = await target(createEmbeddedInferenceRpcClient(a));
    const deadline = clock.wall + 5 * 60_000;
    for (let i = 0; i < 16_384; i++) {
      const outcome = submitFor(worker, a, fenced, `att-a-${String(i)}`, deadline).outcome;
      if (outcome !== "accepted") throw new Error(`attempt ${String(i)}: ${outcome}`);
    }
    const b = claims({ serviceId: "svc-b" });
    expect(rejectionCode(submitFor(worker, b, fenced, "att-b-0", deadline))).toBe("accepted");
    expect(rejectionCode(submitFor(worker, a, fenced, "att-a-more", deadline))).toBe("accepted");
    expect(engine.requests).toHaveLength(0);
  });

  test("an owner at its quota is refused overloaded; other owners and its own duplicates are not", async () => {
    const { worker, clock } = clocked({ maxAttemptRecordsPerOwner: 8, maxAttemptRecords: 12 });
    const a = claims();
    const fenced = await target(createEmbeddedInferenceRpcClient(a));
    const deadline = clock.wall + 5 * 60_000;
    // Live attempts count against the quota as much as settled ones.
    for (let i = 0; i < 8; i++) {
      const result = submitFor(worker, a, fenced, `att-q-${String(i)}`, deadline, i % 2 === 0);
      expect(rejectionCode(result)).toBe("accepted");
    }
    expect(refusal(submitFor(worker, a, fenced, "att-q-8", deadline))).toBe(
      "overloaded: the service is at its attempt record quota",
    );
    // A full owner's duplicates are still answered from its records.
    expect(submitFor(worker, a, fenced, "att-q-1", deadline)).toMatchObject({
      outcome: "existing",
      status: { state: "terminal", terminal: { outcome: "cancelled" } },
    });
    expect(submitFor(worker, a, fenced, "att-q-0", deadline)).toMatchObject({
      outcome: "existing",
      status: { state: "accepted" },
    });
    // Another service, and another credential scope of the same service,
    // are owners of their own.
    const others = [claims({ serviceId: "svc-b" }), claims({ credentialScopeId: "scope-b" })];
    for (const [n, other] of others.entries()) {
      for (let i = 0; i < 2; i++) {
        const attemptId = `att-other-${String(n)}-${String(i)}`;
        expect(rejectionCode(submitFor(worker, other, fenced, attemptId, deadline))).toBe(
          "accepted",
        );
      }
    }
    // The worker-wide backstop then refuses everyone, without forgetting a record.
    expect(
      refusal(submitFor(worker, claims({ serviceId: "svc-c" }), fenced, "att-c", deadline)),
    ).toBe("overloaded: the worker is at its record limit");
    expect(worker.status(a, { attemptId: "att-q-1" })).toMatchObject({ state: "terminal" });
    expect(engine.requests).toHaveLength(0);
  });

  test("an owner's quota frees as its oldest records reach their retention, and not before", async () => {
    const { worker, clock } = clocked({ maxAttemptRecordsPerOwner: 4 });
    const a = claims();
    const fenced = await target(createEmbeddedInferenceRpcClient(a));
    const admitted = (attemptId: string): string | undefined =>
      rejectionCode(submitFor(worker, a, fenced, attemptId, clock.wall + 60_000));
    expect([admitted("att-old-0"), admitted("att-old-1")]).toEqual(["accepted", "accepted"]);
    clock.wall += 10 * 60_000;
    clock.mono += 10 * 60_000;
    expect([admitted("att-new-0"), admitted("att-new-1")]).toEqual(["accepted", "accepted"]);
    expect(admitted("att-full")).toBe("overloaded");
    clock.wall = clock.wall - 10 * 60_000 + RETENTION_MS - 1;
    clock.mono = RETENTION_MS - 1;
    expect(admitted("att-full")).toBe("overloaded");
    clock.wall += 1;
    clock.mono += 1;
    expect([admitted("att-next-0"), admitted("att-next-1")]).toEqual(["accepted", "accepted"]);
    expect(admitted("att-full")).toBe("overloaded");
    expect(worker.status(a, { attemptId: "att-old-0" })).toMatchObject({ state: "unknown" });
    expect(worker.status(a, { attemptId: "att-new-0" })).toMatchObject({ state: "terminal" });
  });

  test("a wall-clock step back keeps a record until its envelope's deadline has passed (N1)", async () => {
    const { worker, clock } = clocked();
    const a = claims();
    const fenced = await target(createEmbeddedInferenceRpcClient(a));
    const start = clock.wall;
    const original = envelope("att-back", {}, start + inferenceRpc.INFERENCE_RPC_MAX_DEADLINE_MS);
    const resubmit = (): inferenceRpc.InferenceRpcSubmitResultV1 =>
      worker.submit(a, { version: V1_0, envelope: original, target: fenced, cancelId: "c-back" });
    expect(rejectionCode(resubmit())).toBe("accepted");
    worker.cancel(a, { attemptId: "att-back" });
    // Retention passes on the monotonic clock while the wall clock stepped
    // back two minutes: the deadline is still a minute ahead.
    clock.mono = RETENTION_MS;
    clock.wall = start + RETENTION_MS - 2 * 60_000;
    expect(rejectionCode(submitFor(worker, a, fenced, "att-back-sweep", clock.wall + 60_000))).toBe(
      "accepted",
    );
    expect(resubmit()).toMatchObject({
      outcome: "existing",
      status: { state: "terminal", terminal: { outcome: "cancelled" } },
    });
    // Once the deadline is behind the wall clock the record goes, and the same envelope is refused by it.
    clock.wall = original.deadline;
    expect(rejectionCode(submitFor(worker, a, fenced, "att-back-later", clock.wall + 60_000))).toBe(
      "accepted",
    );
    expect(worker.status(a, { attemptId: "att-back" })).toMatchObject({ state: "unknown" });
    expect(rejectionCode(resubmit())).toBe("deadline-exceeded");
    expect(engine.requests).toHaveLength(0);
  });

  test("64 one-second attempts a second at the proxy's 5 min deadline are never refused for retention", async () => {
    const { worker, clock } = clocked();
    const a = claims();
    const fenced = await target(createEmbeddedInferenceRpcClient(a));
    // Past one full retention, so the records reach their steady state.
    const seconds = Math.ceil(RETENTION_MS / 1000) + 60;
    for (let s = 0; s < seconds; s++) {
      for (let i = 0; i < 64; i++) {
        const attemptId = `att-rate-${String(s)}-${String(i)}`;
        const outcome = rejectionCode(
          submitFor(worker, a, fenced, attemptId, clock.wall + 5 * 60_000),
        );
        if (outcome !== "accepted") throw new Error(`second ${String(s)}: ${String(outcome)}`);
      }
      clock.wall += 1_000;
      clock.mono += 1_000;
    }
    expect(worker.status(a, { attemptId: "att-rate-0-0" })).toMatchObject({ state: "unknown" });
    const recent = `att-rate-${String(seconds - 1)}-63`;
    expect(worker.status(a, { attemptId: recent })).toMatchObject({ state: "terminal" });
  }, 60_000);

  test("a resubmit inside the horizon is the existing record, however short its first deadline (N2)", async () => {
    const { worker, clock } = clocked();
    const a = claims();
    const fenced = await target(createEmbeddedInferenceRpcClient(a));
    expect(rejectionCode(submitFor(worker, a, fenced, "att-short", clock.wall + 1_000))).toBe(
      "accepted",
    );
    // Long past that deadline and its grace, well inside the horizon, the
    // same attempt comes back with a fresh deadline.
    clock.wall += 5 * 60_000;
    clock.mono += 5 * 60_000;
    expect(submitFor(worker, a, fenced, "att-short", clock.wall + 60_000)).toMatchObject({
      outcome: "existing",
      status: { state: "terminal", terminal: { outcome: "cancelled" } },
    });
    clock.wall += RETENTION_MS - 5 * 60_000 - 1;
    clock.mono = RETENTION_MS - 1;
    expect(submitFor(worker, a, fenced, "att-short", clock.wall + 60_000).outcome).toBe("existing");
    clock.wall += 1;
    clock.mono += 1;
    expect(rejectionCode(submitFor(worker, a, fenced, "att-sweep", clock.wall + 60_000))).toBe(
      "accepted",
    );
    expect(worker.status(a, { attemptId: "att-short" })).toMatchObject({ state: "unknown" });
    expect(engine.requests).toHaveLength(0);
  });

  test("a wall-clock step back after the sweep cannot re-admit a settled envelope (N1)", async () => {
    const { worker, clock } = clocked();
    const a = claims();
    const fenced = await target(createEmbeddedInferenceRpcClient(a));
    const original = envelope("att-step", {}, clock.wall + 5 * 60_000);
    const resubmit = (): inferenceRpc.InferenceRpcSubmitResultV1 =>
      worker.submit(a, { version: V1_0, envelope: original, target: fenced, cancelId: "c-step" });
    expect(rejectionCode(resubmit())).toBe("accepted");
    worker.cancel(a, { attemptId: "att-step" });
    // The wall clock jumps two hours ahead while a second passes, a submit
    // sweeps, and the wall clock steps back.
    clock.wall += 2 * 3600_000;
    clock.mono += 1_000;
    expect(rejectionCode(submitFor(worker, a, fenced, "att-jump", clock.wall + 60_000))).toBe(
      "accepted",
    );
    clock.wall -= 2 * 3600_000;
    expect(resubmit()).toMatchObject({
      outcome: "existing",
      status: { state: "terminal", terminal: { outcome: "cancelled" } },
    });
    expect(engine.requests).toHaveLength(0);
  });

  test("a record kept for its deadline after a wall-clock step back holds up no other record (N1)", async () => {
    const { worker, clock } = clocked({ maxAttemptRecordsPerOwner: 4 });
    const a = claims();
    const fenced = await target(createEmbeddedInferenceRpcClient(a));
    const admitted = (attemptId: string): string | undefined =>
      rejectionCode(submitFor(worker, a, fenced, attemptId, clock.wall + 60_000));
    expect(admitted("att-step")).toBe("accepted");
    // The wall clock jumps two hours ahead while a second passes, att-jump is
    // accepted with a deadline two hours and a minute out, and the wall clock
    // steps back.
    clock.wall += 2 * 3600_000;
    clock.mono += 1_000;
    const jump = envelope("att-jump", {}, clock.wall + 60_000);
    const resubmit = (): inferenceRpc.InferenceRpcSubmitResultV1 =>
      worker.submit(a, { version: V1_0, envelope: jump, target: fenced, cancelId: "c-jump" });
    expect(rejectionCode(resubmit())).toBe("accepted");
    worker.cancel(a, { attemptId: "att-jump" });
    clock.wall -= 2 * 3600_000;
    // Every 20 minutes the record before is past its retention and its
    // deadline; att-jump, still waiting on its deadline, holds none of them
    // back, so the quota of four never fills.
    for (const attemptId of ["att-c", "att-d", "att-e", "att-f"]) {
      clock.wall += 20 * 60_000;
      clock.mono += 20 * 60_000;
      expect(admitted(attemptId)).toBe("accepted");
    }
    expect(resubmit()).toMatchObject({
      outcome: "existing",
      status: { state: "terminal", terminal: { outcome: "cancelled" } },
    });
    // It still counts against the quota: with att-f, two more fill it.
    expect([admitted("att-g"), admitted("att-h")]).toEqual(["accepted", "accepted"]);
    expect(refusal(submitFor(worker, a, fenced, "att-i", clock.wall + 60_000))).toBe(
      "overloaded: the service is at its attempt record quota",
    );
    // It is the existing record until the wall clock reaches its deadline, and goes then.
    clock.mono += jump.deadline - 1 - clock.wall;
    clock.wall = jump.deadline - 1;
    expect(resubmit()).toMatchObject({ outcome: "existing", status: { state: "terminal" } });
    clock.wall += 1;
    clock.mono += 1;
    expect(rejectionCode(resubmit())).toBe("deadline-exceeded");
    expect(worker.status(a, { attemptId: "att-jump" })).toMatchObject({ state: "unknown" });
    expect(engine.requests).toHaveLength(0);
  });

  test("records kept for their deadlines go as each deadline passes, not in acceptance order (N1)", async () => {
    const { worker, clock } = clocked();
    const a = claims();
    const fenced = await target(createEmbeddedInferenceRpcClient(a));
    const start = clock.wall;
    const admitted = (attemptId: string): string | undefined =>
      rejectionCode(submitFor(worker, a, fenced, attemptId, clock.wall + 60_000));
    // Accepted a second apart with the wall clock 3, 1, 2 and then 4 hours
    // ahead, so each deadline is that many hours and a minute out; once the
    // wall clock has stepped back, att-back is accepted behind them.
    for (const hours of [3, 1, 2, 4]) {
      clock.wall = start + hours * 3600_000;
      clock.mono += 1_000;
      expect(admitted(`att-${String(hours)}h`)).toBe("accepted");
    }
    clock.wall = start;
    clock.mono += 1_000;
    expect(admitted("att-back")).toBe("accepted");
    const stateOf = (attemptId: string): string => {
      const result = worker.status(a, { attemptId });
      return result.outcome === "status" ? result.state : result.outcome;
    };
    const states = (): string[] => [1, 2, 3, 4].map((hours) => stateOf(`att-${String(hours)}h`));
    // Every retention passes and so does att-back's deadline: one sweep sets
    // the four aside to wait on their deadlines and forgets att-back behind them.
    clock.wall = start + 60_000;
    clock.mono += RETENTION_MS;
    expect(admitted("att-tick-0")).toBe("accepted");
    expect(stateOf("att-back")).toBe("unknown");
    expect(states()).toEqual(["terminal", "terminal", "terminal", "terminal"]);
    // Each goes at the first sweep at or after its deadline, and only it; the
    // last sweep comes after two deadlines and forgets both.
    for (const hours of [1, 2, 4]) {
      clock.wall = start + hours * 3600_000 + 60_000;
      clock.mono += 1_000;
      expect(admitted(`att-tick-${String(hours)}`)).toBe("accepted");
      expect(states()).toEqual([1, 2, 3, 4].map((h) => (h <= hours ? "unknown" : "terminal")));
    }
    expect(engine.requests).toHaveLength(0);
  });
});

describe("cancellation in process (X4)", () => {
  test("a caller cancel reaches the engine and is acknowledged once", async () => {
    engine.setScript({ holdAfter: 1 });
    useHost();
    const client = createEmbeddedInferenceRpcClient(claims());
    expect(rejectionCode(await submit(client, "att-cancel"))).toBe("accepted");
    const frames: StreamFrame[] = [];
    const aborted = engine.nextAbort();
    for await (const frame of client.stream({ attemptId: "att-cancel" })) {
      frames.push(frame);
      if (frame.frame === "event" && frame.event.type === "content") {
        expect(await client.cancel({ attemptId: "att-cancel" })).toEqual({
          outcome: "cancelled",
          attemptId: "att-cancel",
        });
      }
    }
    await aborted;
    expectValidStream(frames);
    expect(terminalOf(frames)).toMatchObject({
      outcome: "cancelled",
      started: true,
      model: UPSTREAM,
    });
    expect(await client.cancel({ attemptId: "att-cancel" })).toEqual({
      outcome: "already-terminal",
      attemptId: "att-cancel",
    });
    expect(await client.cancel({ attemptId: "att-nope" })).toEqual({ outcome: "unknown" });
    expect(engine.aborts()).toBe(1);
  });

  test("a cancel by cancelId before the stream attaches settles the attempt unstarted", async () => {
    useHost();
    const client = createEmbeddedInferenceRpcClient(claims());
    expect(rejectionCode(await submit(client, "att-early"))).toBe("accepted");
    expect(await client.cancel({ cancelId: "cancel-att-early" })).toEqual({
      outcome: "cancelled",
      attemptId: "att-early",
    });
    expect(await collect(client.stream({ attemptId: "att-early" }))).toMatchObject([
      {
        frame: "unavailable",
        status: { state: "terminal", terminal: { outcome: "cancelled", started: false } },
      },
    ]);
    expect(engine.requests).toHaveLength(0);
  });

  test("a cancelId names the caller's own attempt, even when another service reuses it", async () => {
    useHost();
    const a = createEmbeddedInferenceRpcClient(claims());
    const b = createEmbeddedInferenceRpcClient(claims({ serviceId: "svc-b" }));
    for (const [client, id] of [
      [a, "att-cid-a"],
      [b, "att-cid-b"],
    ] as const) {
      expect(
        rejectionCode(
          await client.submit({
            version: V1_0,
            envelope: envelope(id),
            target: await target(client),
            cancelId: "req-42",
          }),
        ),
      ).toBe("accepted");
    }
    expect(await a.cancel({ cancelId: "req-42" })).toEqual({
      outcome: "cancelled",
      attemptId: "att-cid-a",
    });
    expect(await b.cancel({ cancelId: "req-42" })).toEqual({
      outcome: "cancelled",
      attemptId: "att-cid-b",
    });
    expect(engine.requests).toHaveLength(0);
  });

  test("a consumer that disconnects mid-stream aborts the engine request", async () => {
    engine.setScript({ holdAfter: 1 });
    useHost();
    const client = createEmbeddedInferenceRpcClient(claims());
    expect(rejectionCode(await submit(client, "att-gone"))).toBe("accepted");
    const aborted = engine.nextAbort();
    for await (const frame of client.stream({ attemptId: "att-gone" })) {
      if (frame.frame === "event" && frame.event.type === "content") break;
    }
    await aborted;
    expect(await client.status({ attemptId: "att-gone" })).toMatchObject({
      state: "terminal",
      terminal: { outcome: "cancelled", started: true },
    });
  });

  test("the worker enforces the deadline itself, mid-stream and before attach", async () => {
    engine.setScript({ holdAfter: 1 });
    useHost({ streamAttachTimeoutMs: 20 });
    const client = createEmbeddedInferenceRpcClient(claims());
    const aborted = engine.nextAbort();
    const soon = envelope("att-deadline", {}, Date.now() + 300);
    expect(rejectionCode(await submit(client, "att-deadline", { envelope: soon }))).toBe(
      "accepted",
    );
    const frames = await collect(client.stream({ attemptId: "att-deadline" }));
    expectValidStream(frames);
    expect(terminalOf(frames)).toMatchObject({
      outcome: "failed",
      started: true,
      error: { code: "timeout", retryable: false },
    });
    await aborted;
    expect(engine.aborts()).toBe(1);

    expect(rejectionCode(await submit(client, "att-unattached"))).toBe("accepted");
    await Bun.sleep(60);
    expect(await client.status({ attemptId: "att-unattached" })).toMatchObject({
      state: "terminal",
      terminal: { outcome: "cancelled", started: false },
    });
    expect(engine.requests).toHaveLength(1);
  });

  test("the executor's cancel is acknowledged by the worker and reaches the engine", async () => {
    engine.setScript({ holdAfter: 1 });
    useHost();
    const real = createEmbeddedInferenceRpcClient(claims());
    const acks: unknown[] = [];
    const client: InferenceRpcClient = {
      ...real,
      cancel: async (input) => {
        const ack = await real.cancel(input);
        acks.push(ack);
        return ack;
      },
    };
    const executor = createWorkerRpcExecutor({
      client,
      deploymentId: LOCAL,
      fallback: recordingFallback([]),
      nodeId: "gw",
    });
    const env = envelope("att-exec-cancel");
    const res = await executor.execute(env, ctxFor(env));
    const reader = res.body?.getReader();
    await reader?.read();
    const aborted = engine.nextAbort();
    expect(executor.cancel("att-exec-cancel")).toBe(true);
    await aborted;
    await reader?.cancel();
    expect(acks).toEqual([{ outcome: "cancelled", attemptId: "att-exec-cancel" }]);
    expect(await real.status({ attemptId: "att-exec-cancel" })).toMatchObject({
      terminal: { outcome: "cancelled" },
    });
  });
});

describe("the worker-rpc executor behind the unified proxy", () => {
  function proxyWith(
    fallback: BackendExecutor,
    advertisements: Ad[] = [ad(LOCAL)],
  ): ReturnType<typeof createProxy> {
    return createProxy({
      env: { LLAMACTL_UNIFIED_PROXY: "1" },
      resolved: () => resolved,
      executor: fallback,
      nodeId: WORKER,
      peers: [],
      advertisements,
    });
  }

  function chat(model: string, stream: boolean): Request {
    return new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "hi" }] }),
    });
  }

  test("a worker that does not advertise the RPC keeps the request on the existing path", async () => {
    useHost({ versions: [] });
    const calls: string[] = [];
    const res = await proxyWith(recordingFallback(calls)).handleRequest(
      chat(`public/${LOCAL}`, false),
    );
    expect(await res.json()).toEqual({ path: "fallback" });
    expect(calls).toEqual(["fallback"]);
    expect(res.headers.get("x-llamactl-worker-transport")).toBe("legacy");
    expect(engine.requests).toHaveLength(0);
  });

  test("a negotiation failure fails closed with a typed unavailable result, never the fallback", async () => {
    const calls: string[] = [];
    const executor = createWorkerRpcExecutor({
      client: {
        ...createEmbeddedInferenceRpcClient(claims()),
        negotiate: () => Promise.reject(new Error("unreachable")),
      },
      deploymentId: LOCAL,
      fallback: recordingFallback(calls),
      nodeId: "gw",
    });
    const env = envelope("att-neg-fail");
    const res = await executor.execute(env, ctxFor(env));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "target-unavailable" } });
    expect(calls).toEqual([]);
  });

  test("a non-streaming request is assembled from the event stream with observed usage", async () => {
    useHost();
    const res = await proxyWith(recordingFallback([])).handleRequest(
      chat(`public/${LOCAL}`, false),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-llamactl-worker-transport")).toBe("embedded");
    expect(await res.json()).toMatchObject({
      object: "chat.completion",
      model: UPSTREAM,
      choices: [
        { index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });
    expect(engine.requests).toHaveLength(1);
  });

  test("a non-model worker-rpc candidate is refused by the worker, not rerouted", async () => {
    useHost({
      advertisements: () => [
        ad("deploy/worker-a/cli", { backendKind: "cli", publicModelIds: ["cli-model"] }),
      ],
    });
    const calls: string[] = [];
    const proxy = proxyWith(recordingFallback(calls), [
      ad("deploy/worker-a/cli", { backendKind: "cli", publicModelIds: ["cli-model"] }),
    ]);
    const res = await proxy.handleRequest(chat("cli-model", true));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "target-unavailable" } });
    expect(calls).toEqual([]);
    expect(engine.requests).toHaveLength(0);
  });

  test("a candidate with an unknown epoch resolves on its owner's catalog by model, never by a guess", async () => {
    const served = "deploy/worker-a/served";
    useHost({
      advertisements: () => [
        ad(served, { publicModelIds: ["model-one"], upstreamModelId: "model-one-upstream" }),
        ad("deploy/worker-a/dup-a", { publicModelIds: ["model-dup"] }),
        // A priority admits a second deployment for the same public model.
        ad("deploy/worker-a/dup-b", { publicModelIds: ["model-dup"], priority: 1 }),
      ],
    });
    const client = createEmbeddedInferenceRpcClient(
      claims({ deployments: [served, "deploy/worker-a/dup-a", "deploy/worker-a/dup-b"] }),
    );
    // Named the way listClusterRoutes names a peer's model: deploy/<peer>/<peer>:<model>.
    const run = async (
      model: string,
      ownerNodeId = WORKER,
    ): Promise<{ status: number; body: string }> => {
      const executor = createWorkerRpcExecutor({
        client,
        deploymentId: `deploy/${ownerNodeId}/${ownerNodeId}:${model}`,
        ownerNodeId,
        models: [model],
        fallback: recordingFallback([]),
        nodeId: "gw",
      });
      const env = envelope(`att-resolve-${model}-${ownerNodeId}`, { publicModelId: model });
      const res = await executor.execute(env, ctxFor(env));
      return { status: res.status, body: await res.text() };
    };
    const ok = await run("model-one");
    expect(ok.status).toBe(200);
    expect(ok.body).toContain("[DONE]");
    expect(engine.requests).toHaveLength(1);
    expect(engine.requests[0]?.body?.["model"]).toBe("model-one-upstream");
    for (const refused of [
      await run("model-dup"),
      await run("model-unlisted"),
      await run("model-one", "worker-b"),
    ]) {
      expect(refused.status).toBe(503);
      expect(JSON.parse(refused.body)).toMatchObject({ error: { code: "target-unavailable" } });
    }
    expect(engine.requests).toHaveLength(1);
  });

  test("a violation on the stream's first event ends it typed protocol-error, like any other", async () => {
    useHost();
    const real = createEmbeddedInferenceRpcClient(claims());
    // Every event one sequence late: only the first event is out of order.
    const shifted: InferenceRpcClient = {
      ...real,
      stream: async function* (input, signal): AsyncGenerator<StreamFrame> {
        for await (const frame of real.stream(input, signal)) {
          yield frame.frame === "event"
            ? { frame: "event", event: { ...frame.event, sequence: frame.event.sequence + 1 } }
            : frame;
        }
      },
    };
    const env = envelope("att-first-event");
    const res = await createWorkerRpcExecutor({
      client: shifted,
      deploymentId: LOCAL,
      fallback: recordingFallback([]),
      nodeId: "gw",
    }).execute(env, ctxFor(env));
    const body = await res.text();
    expect(body).toContain('"code":"protocol-error"');
    expect(body).toContain("sequence 1 where 0 was expected");
    expect(body).not.toContain("[DONE]");
  });

  test("the resolve window is hard: a status call that hangs gets only what is left of it", async () => {
    useHost();
    const real = createEmbeddedInferenceRpcClient(claims());
    const hanging: InferenceRpcClient = {
      ...real,
      submit: () => Promise.reject(new Error("connection reset before the acknowledgement")),
      status: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({ outcome: "status", attemptId: "att-hard-window", state: "unknown" });
          }, 3_000);
        }),
    };
    const env = envelope("att-hard-window");
    const started = Date.now();
    const res = await createWorkerRpcExecutor({
      client: hanging,
      deploymentId: LOCAL,
      fallback: recordingFallback([]),
      nodeId: "gw",
      resolveTimeoutMs: 200,
    }).execute(env, ctxFor(env));
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: "unknown-outcome" } });
  });

  test("an outcome that may have run tells client SDKs not to retry it", async () => {
    useHost();
    const client = createEmbeddedInferenceRpcClient(claims());
    const executor = createWorkerRpcExecutor({
      client,
      deploymentId: LOCAL,
      fallback: recordingFallback([]),
      nodeId: "gw",
    });
    const env = envelope("att-no-retry");
    expect(await (await executor.execute(env, ctxFor(env))).text()).toContain("[DONE]");
    // The same attempt again: it completed on another stream.
    const again = await executor.execute(env, ctxFor(env));
    expect(again.status).toBe(409);
    expect(again.headers.get("x-should-retry")).toBe("false");
    const lost: InferenceRpcClient = {
      ...client,
      submit: () => Promise.reject(new Error("connection reset")),
      status: () => Promise.reject(new Error("connection reset")),
    };
    const env2 = envelope("att-no-retry-unknown");
    const unknown = await createWorkerRpcExecutor({
      client: lost,
      deploymentId: LOCAL,
      fallback: recordingFallback([]),
      nodeId: "gw",
      resolveTimeoutMs: 100,
    }).execute(env2, ctxFor(env2));
    expect(unknown.status).toBe(502);
    expect(await unknown.json()).toMatchObject({ error: { code: "unknown-outcome" } });
    expect(unknown.headers.get("x-should-retry")).toBe("false");
    // A refusal before anything ran keeps the SDK's own retry rules, same status or not.
    const env3 = envelope("att-no-retry-refused");
    const refused = await createWorkerRpcExecutor({
      client: createEmbeddedInferenceRpcClient(
        claims({ deployments: [LOCAL, "deploy/worker-a/not-here"] }),
      ),
      deploymentId: "deploy/worker-a/not-here",
      expectedEpoch: "epoch-1",
      fallback: recordingFallback([]),
      nodeId: "gw",
    }).execute(env3, ctxFor(env3));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "not-owner" } });
    expect(refused.headers.get("x-should-retry")).toBeNull();
    expect(engine.requests).toHaveLength(1);
  });

  test("every non-streaming failure after acceptance tells client SDKs not to retry it", async () => {
    const jsonEnvelope = (
      attemptId: string,
      deadline?: number,
    ): inferenceContracts.InferenceEnvelopeV1 =>
      envelope(
        attemptId,
        {
          stream: false,
          features: { ...routingCapabilitiesFeatures(), stream: false },
          nativeBody: {
            model: `public/${LOCAL}`,
            stream: false,
            messages: [{ role: "user", content: "hi" }],
          },
        },
        deadline,
      );
    const run = async (
      client: InferenceRpcClient,
      env: inferenceContracts.InferenceEnvelopeV1,
    ): Promise<{ status: number; retry: string | null; body: unknown }> => {
      const res = await createWorkerRpcExecutor({
        client,
        deploymentId: LOCAL,
        fallback: recordingFallback([]),
        nodeId: "gw",
      }).execute(env, ctxFor(env));
      return {
        status: res.status,
        retry: res.headers.get("x-should-retry"),
        body: await res.json(),
      };
    };
    const failed = (code: string): unknown => ({ error: { code } });
    const workerHost = useHost();
    const real = createEmbeddedInferenceRpcClient(claims());

    // The worker completed, but the stream lost its last content and terminal.
    const lossy: InferenceRpcClient = {
      ...real,
      stream: async function* (input, signal): AsyncGenerator<StreamFrame> {
        const frames = await collect(real.stream(input, signal));
        yield* frames.slice(0, -2);
      },
    };
    const lost = await run(lossy, jsonEnvelope("att-json-lost"));
    expect(lost).toMatchObject({ status: 502, retry: "false", body: failed("incomplete") });
    expect(await real.status({ attemptId: "att-json-lost" })).toMatchObject({
      terminal: { outcome: "completed" },
    });

    engine.setScript({ status: 500 });
    const upstream = await run(real, jsonEnvelope("att-json-upstream"));
    expect(upstream).toMatchObject({ status: 502, retry: "false", body: failed("upstream-error") });
    expect(await real.status({ attemptId: "att-json-upstream" })).toMatchObject({
      terminal: { outcome: "failed", started: true },
    });

    engine.setScript({ holdAfter: 1 });
    const late = await run(real, jsonEnvelope("att-json-timeout", Date.now() + 300));
    expect(late).toMatchObject({ status: 504, retry: "false", body: failed("timeout") });
    expect(await real.status({ attemptId: "att-json-timeout" })).toMatchObject({
      terminal: { outcome: "failed", started: true },
    });

    const overflowing: InferenceRpcClient = {
      ...real,
      stream: async function* (input, signal): AsyncGenerator<StreamFrame> {
        for await (const frame of real.stream(input, signal)) {
          yield frame;
          if (frame.frame === "event" && frame.event.type === "content") {
            throw new InferenceRpcStreamOverflowError("the stream outran its consumer");
          }
        }
      },
    };
    const overflow = await run(overflowing, jsonEnvelope("att-json-overflow"));
    expect(overflow).toMatchObject({
      status: 502,
      retry: "false",
      body: failed("stream-overflow"),
    });

    const draining = run(real, jsonEnvelope("att-json-drain"));
    await until(() => engine.requests.length === 5);
    const aborted = engine.nextAbort();
    const drained = workerHost.drain();
    workerHost.close();
    await drained;
    await aborted;
    expect(await draining).toMatchObject({
      status: 503,
      retry: "false",
      body: failed("cancelled"),
    });
    expect(await real.status({ attemptId: "att-json-drain" })).toMatchObject({
      terminal: { outcome: "cancelled", started: true },
    });

    // A refusal with the same status as the cancel, before anything was accepted.
    const unreachable: InferenceRpcClient = {
      ...real,
      negotiate: () => Promise.reject(new Error("unreachable")),
    };
    const refused = await run(unreachable, jsonEnvelope("att-json-refused"));
    expect(refused).toMatchObject({ status: 503, retry: null, body: failed("target-unavailable") });
    expect(engine.requests).toHaveLength(5);
  });

  test("an accepted attempt cancelled before it started still tells client SDKs not to retry it", async () => {
    useHost();
    const real = createEmbeddedInferenceRpcClient(claims());
    // Cancelled between acceptance and the stream: the worker proves nothing ran.
    const cancelledFirst: InferenceRpcClient = {
      ...real,
      submit: async (input) => {
        const answer = await real.submit(input);
        await real.cancel({ attemptId: input.envelope.attemptId });
        return answer;
      },
    };
    const env = envelope("att-unstarted-cancel");
    const res = await createWorkerRpcExecutor({
      client: cancelledFirst,
      deploymentId: LOCAL,
      fallback: recordingFallback([]),
      nodeId: "gw",
    }).execute(env, ctxFor(env));
    expect(res.status).toBe(503);
    expect(res.headers.get("x-should-retry")).toBe("false");
    expect(await res.json()).toMatchObject({ error: { code: "cancelled" } });
    expect(await real.status({ attemptId: "att-unstarted-cancel" })).toMatchObject({
      terminal: { outcome: "cancelled", started: false },
    });
    expect(engine.requests).toHaveLength(0);
  });

  test("a public error names no secret reference or path; the log keeps the detail", async () => {
    useHost();
    const secretPath = join(temp.devStorage, "secrets", "worker-b.token");
    const logged: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      logged.push(String(chunk));
      return true;
    };
    let body = "";
    try {
      const executor = acquireWorkerRpcExecutor(
        {
          advertisement: ad(LOCAL, { ownerNodeId: "worker-b" }),
          alias: `public/${LOCAL}`,
          source: "advertised",
          legacyWinner: false,
        },
        {
          nodeId: "gw",
          scope: TENANT,
          fallback: recordingFallback([]),
          peers: () => [{ id: "worker-b", endpoint: "https://127.0.0.1:1", certificate: "pem" }],
          serviceCredentialRef: () => `file:${secretPath}`,
        },
      );
      const env = envelope("att-redacted");
      const res = await executor!.execute(env, ctxFor(env));
      expect(res.status).toBe(503);
      body = await res.text();
    } finally {
      process.stderr.write = write;
    }
    expect(body).toContain("target-unavailable");
    expect(body).not.toContain("worker-b.token");
    expect(body).not.toContain(temp.devStorage);
    expect(logged.join("")).toContain("worker-b.token");
  });

  test("a stale generation refreshes the catalog exactly once, then returns the typed rejection", async () => {
    useHost();
    const real = createEmbeddedInferenceRpcClient(claims());
    const counts = { catalog: 0, submit: 0 };
    const staleAlways: InferenceRpcClient = {
      ...real,
      catalog: async () => {
        counts.catalog += 1;
        const listing = await real.catalog();
        return listing.outcome === "catalog"
          ? { ...listing, catalogGeneration: "gen-stale" }
          : listing;
      },
      submit: async (input) => {
        counts.submit += 1;
        return await real.submit(input);
      },
    };
    const executor = createWorkerRpcExecutor({
      client: staleAlways,
      deploymentId: LOCAL,
      fallback: recordingFallback([]),
      nodeId: "gw",
    });
    const env = envelope("att-stale");
    const res = await executor.execute(env, ctxFor(env));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "stale-generation" } });
    expect(counts).toEqual({ catalog: 2, submit: 2 });

    let first = true;
    const staleOnce: InferenceRpcClient = {
      ...real,
      catalog: async () => {
        const listing = await real.catalog();
        const stale = first;
        first = false;
        return stale && listing.outcome === "catalog"
          ? { ...listing, catalogGeneration: "gen-stale" }
          : listing;
      },
    };
    const recovered = createWorkerRpcExecutor({
      client: staleOnce,
      deploymentId: LOCAL,
      fallback: recordingFallback([]),
      nodeId: "gw",
    });
    const env2 = envelope("att-stale-once");
    const ok = await recovered.execute(env2, ctxFor(env2));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("[DONE]");
    expect(engine.requests).toHaveLength(1);
  });
});

describe("hop limits through the executor (embedded)", () => {
  test("withHop takes hopCount past the limit; the worker refuses before any engine request", async () => {
    useHost();
    const client = createEmbeddedInferenceRpcClient(claims());
    const env = envelope("att-exec-hop", { internal: { hopCount: 1, visitedNodes: ["edge"] } });
    const res = await createWorkerRpcExecutor({
      client,
      deploymentId: LOCAL,
      fallback: recordingFallback([]),
      nodeId: "gw",
    }).execute(env, ctxFor(env));
    expect(res.status).toBe(508);
    expect(await res.json()).toMatchObject({ error: { code: "hop-limit" } });
    expect(engine.requests).toHaveLength(0);
  });

  test("withHop appends the caller's nodeId, creating a visited-node loop", async () => {
    useHost();
    const client = createEmbeddedInferenceRpcClient(claims());
    const env = envelope("att-exec-loop", { internal: { visitedNodes: ["gw"] } });
    const res = await createWorkerRpcExecutor({
      client,
      deploymentId: LOCAL,
      fallback: recordingFallback([]),
      nodeId: "gw",
    }).execute(env, ctxFor(env));
    expect(res.status).toBe(508);
    expect(await res.json()).toMatchObject({ error: { code: "hop-limit" } });
    expect(engine.requests).toHaveLength(0);
  });

  test("MAX_VISITED_NODES distinct visitedNodes plus withHop's nodeId are refused; one fewer is admitted", async () => {
    useHost();
    const client = createEmbeddedInferenceRpcClient(claims());
    const max = inferenceRpc.INFERENCE_RPC_MAX_VISITED_NODES;
    const run = async (attemptId: string, distinct: number): Promise<Response> => {
      const visitedNodes = Array.from({ length: distinct }, (_, i) => `n-${String(i)}`);
      const env = envelope(attemptId, { internal: { visitedNodes } });
      return await createWorkerRpcExecutor({
        client,
        deploymentId: LOCAL,
        fallback: recordingFallback([]),
        nodeId: "gw",
      }).execute(env, ctxFor(env));
    };
    const over = await run("att-exec-visited-over", max);
    expect(over.status).toBe(508);
    expect(await over.json()).toMatchObject({ error: { code: "hop-limit" } });
    expect(engine.requests).toHaveLength(0);
    const at = await run("att-exec-visited-at", max - 1);
    expect(at.status).toBe(200);
    expect(await at.text()).toContain("[DONE]");
    expect(engine.requests).toHaveLength(1);
  });

  test("the worker receives internal with hopCount 1 and visitedNodes ['gw'] after one hop", async () => {
    const received: inferenceContracts.InferenceEnvelopeV1[] = [];
    const base = useHost();
    wrapHost({
      submit: (claimsIn: Claims | undefined, input: inferenceRpc.InferenceRpcSubmitRequestV1) => {
        received.push(input.envelope);
        return base.submit(claimsIn, input);
      },
    });
    const env = envelope("att-exec-hop-record");
    const res = await createWorkerRpcExecutor({
      client: createEmbeddedInferenceRpcClient(claims()),
      deploymentId: LOCAL,
      fallback: recordingFallback([]),
      nodeId: "gw",
    }).execute(env, ctxFor(env));
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.internal?.hopCount).toBe(1);
    expect(received[0]?.internal?.visitedNodes).toEqual(["gw"]);
  });
});

// ---- remote transports ------------------------------------------------------

const TUNNEL_NODE = "worker-a-tunnel";

/** A binding's per-worker tunnel key: HMAC-SHA256(credential, label + tunnel node name). */
function tunnelKeyOf(credential: string, node = TUNNEL_NODE): string {
  return createHmac("sha256", credential)
    .update(`llamactl-worker-rpc-token\0${node}`)
    .digest("hex");
}

interface Transports {
  worker: RunningAgent;
  workerNode: ClusterNode;
  /**
   * The worker's service-credential bindings, as agent.yaml holds them;
   * read on every call, so a test rotates or revokes by editing them.
   */
  bindings: agentConfigMod.AgentWorkerRpcCredential[];
  /** Bound to `claims()`. */
  serviceCredential: string;
  /** Bound to GOLDEN_CLAIMS. */
  goldenCredential: string;
  /** The worker's operator bearer: the base release's caller credential. */
  operatorToken: string;
  central: RunningAgent;
  /** The bearer a node presents in its hello to dial central. */
  tunnelBearer: string;
  centralCertificate: string;
  centralFingerprint: string;
  centralToken: string;
  /** Central's relay-only credential: it relays the worker-RPC procedures and nothing else. */
  relayCredential: string;
  /** Every /tunnel-relay path central has been asked for, in order. */
  relayRequests: string[];
  stop: () => Promise<void>;
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
 * The worker agent serves the RPC over pinned HTTPS and dials the central
 * agent over a pinned wss tunnel; central's relay is the tunnel transport.
 * Both agents serve the one published worker host, so either transport
 * reaches the same attempts.
 */
async function startTransports(): Promise<Transports> {
  const dir = mkdtempSync(join(tmpdir(), "p41-transports-"));
  const certFor = (name: string): ReturnType<typeof tls.generateSelfSignedCert> =>
    tls.generateSelfSignedCert({
      dir: join(dir, name),
      commonName: "127.0.0.1",
      hostnames: ["127.0.0.1", "localhost"],
    });
  const centralCert = await certFor("central");
  const workerCert = await certFor("worker");
  const centralToken = auth.generateToken();
  const relayCredential = auth.generateToken();
  const workerToken = auth.generateToken();
  const tunnelBearer = auth.generateToken();
  const service = auth.generateToken();
  const golden = auth.generateToken();
  const bindings: agentConfigMod.AgentWorkerRpcCredential[] = [
    { ...claims(), tokenHash: service.hash, tunnelKey: tunnelKeyOf(service.token) },
    { ...GOLDEN_CLAIMS, tokenHash: golden.hash, tunnelKey: tunnelKeyOf(golden.token) },
  ];
  const relayRequests: string[] = [];
  const central = startAgentServer({
    bindHost: "127.0.0.1",
    port: 0,
    tokenHash: centralToken.hash,
    tls: { certPath: centralCert.certPath, keyPath: centralCert.keyPath },
    advertiseMdns: false,
    onRequest: (url) => {
      if (url.pathname.startsWith("/tunnel-relay")) relayRequests.push(url.pathname);
    },
    tunnelCentral: {
      expectedBearerHash: tunnelBearer.hash,
      workerRpcRelay: () => ({ tokenHashes: [relayCredential.hash] }),
    },
  });
  let markReady = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const worker = startAgentServer({
    bindHost: "127.0.0.1",
    port: 0,
    tokenHash: workerToken.hash,
    tls: { certPath: workerCert.certPath, keyPath: workerCert.keyPath },
    advertiseMdns: false,
    workerRpc: {
      workerId: WORKER,
      // A fresh copy per call, as agent.yaml is re-read on every call.
      settings: () => ({
        versions: [V1_0],
        serviceCredentials: bindings.map((binding) => ({ ...binding })),
      }),
    },
    tunnelDial: {
      url: `wss://127.0.0.1:${String(central.port)}/tunnel`,
      bearer: tunnelBearer.token,
      nodeName: TUNNEL_NODE,
      WebSocketCtor: pinnedWebSocket(centralCert.certPem),
      onStateChange: (state) => {
        if (state === "ready") markReady();
      },
    },
  });
  await ready;
  return {
    worker,
    workerNode: {
      name: WORKER,
      endpoint: worker.url,
      certificate: workerCert.certPem,
      certificateFingerprint: workerCert.fingerprint,
    },
    bindings,
    serviceCredential: service.token,
    goldenCredential: golden.token,
    operatorToken: workerToken.token,
    central,
    tunnelBearer: tunnelBearer.token,
    centralCertificate: centralCert.certPem,
    centralFingerprint: centralCert.fingerprint,
    centralToken: centralToken.token,
    relayCredential: relayCredential.token,
    relayRequests,
    stop: async (): Promise<void> => {
      await worker.stop();
      await central.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function frameKind(frame: string): string | undefined {
  return /"type":"(accepted|content|terminal)"/.exec(frame)?.[1];
}

/**
 * A worker stream response whose transport breaks at the first SSE frame
 * `at` matches: frames before it pass through (and the matching one too
 * when `forward` is set), then the read side fails and the real body is
 * cancelled, so the worker sees the disconnect.
 */
function cutStream(
  res: Response,
  at: (frame: string) => boolean,
  opts: { forward?: boolean; before?: () => Promise<void> } = {},
): Response {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let failure: Error | null = null;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      if (failure !== null) {
        controller.error(failure);
        return;
      }
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      pending += decoder.decode(value, { stream: true });
      let out = "";
      for (let end = pending.indexOf("\n\n"); end !== -1; end = pending.indexOf("\n\n")) {
        const frame = pending.slice(0, end + 2);
        pending = pending.slice(end + 2);
        if (at(frame)) {
          if (opts.forward === true) out += frame;
          await opts.before?.();
          failure = new Error("connection reset by peer");
          await reader.cancel();
          break;
        }
        out += frame;
      }
      if (out !== "") controller.enqueue(encoder.encode(out));
      else if (failure !== null) controller.error(failure);
    },
    async cancel(reason): Promise<void> {
      await reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, headers: res.headers });
}

function queueSampler(): {
  sample: (attemptId: string, queuedBytes: number) => void;
  max: () => number;
} {
  let max = 0;
  return {
    sample: (_attemptId, queuedBytes): void => {
      max = Math.max(max, queuedBytes);
    },
    max: () => max,
  };
}

function recordingCancels(client: InferenceRpcClient, acks: unknown[]): InferenceRpcClient {
  return {
    ...client,
    cancel: async (input): Promise<inferenceRpc.InferenceRpcCancelResultV1> => {
      const ack = await client.cancel(input);
      acks.push(ack);
      return ack;
    },
  };
}

describe("remote transports: direct (pinned TLS) and tunnel (central relay)", () => {
  let transports: Transports;
  let guard: ControllerClosedGuard;

  beforeAll(async () => {
    guard = installControllerClosedGuard();
    transports = await startTransports();
  }, 30_000);

  afterAll(async () => {
    await transports.stop();
    guard.dispose();
  });

  function tunnelUp(): boolean {
    return (
      transports.central.tunnelServer?.registry().some((e) => e.nodeName === TUNNEL_NODE) === true
    );
  }

  beforeEach(async () => {
    // A test that dropped the tunnel leaves the worker reconnecting.
    await until(tunnelUp, 10_000);
  });

  /** Drop the worker's tunnel from central's side; resolves once central let go of it. */
  async function dropTunnel(): Promise<void> {
    expect(transports.central.tunnelServer?.disconnect(TUNNEL_NODE)).toBe(true);
    await until(() => !tunnelUp());
  }

  function directClient(extra: Partial<DirectInferenceRpcClientOptions> = {}): InferenceRpcClient {
    return createDirectInferenceRpcClient({
      node: transports.workerNode,
      serviceCredential: transports.serviceCredential,
      ...extra,
    });
  }

  function tunnelClient(extra: Partial<TunnelInferenceRpcClientOptions> = {}): InferenceRpcClient {
    return createTunnelInferenceRpcClient({
      centralUrl: transports.central.url,
      centralCertificate: transports.centralCertificate,
      centralFingerprint: transports.centralFingerprint,
      nodeName: TUNNEL_NODE,
      bearer: transports.relayCredential,
      serviceCredential: transports.serviceCredential,
      ...extra,
    });
  }

  const clientFor = {
    direct: (extra: Partial<RemoteExtra> = {}): InferenceRpcClient => directClient(extra),
    tunnel: (extra: Partial<RemoteExtra> = {}): InferenceRpcClient => tunnelClient(extra),
  };
  type RemoteExtra = Pick<
    DirectInferenceRpcClientOptions,
    "limits" | "onStreamQueue" | "serviceCredential"
  >;
  const TRANSPORTS: ("direct" | "tunnel")[] = ["direct", "tunnel"];

  /** The worker host for remote callers; serve.ts derives their claims from the credential. */
  function useRemoteHost(opts: Partial<WorkerRpcHostOptions> = {}): WorkerRpcHost {
    return useHost(opts);
  }

  function statusNow(attemptId: string): inferenceRpc.InferenceRpcStatusResultV1 {
    return currentWorkerRpcHost().status(claims(), { attemptId });
  }

  function executorOver(
    client: InferenceRpcClient,
    extra: Partial<WorkerRpcExecutorOptions> = {},
  ): BackendExecutor {
    return createWorkerRpcExecutor({
      client,
      deploymentId: LOCAL,
      fallback: recordingFallback([]),
      nodeId: "gw",
      ...extra,
    });
  }

  async function execute(
    client: InferenceRpcClient,
    attemptId: string,
  ): Promise<{ res: Response; env: inferenceContracts.InferenceEnvelopeV1 }> {
    const env = envelope(attemptId);
    return { res: await executorOver(client).execute(env, ctxFor(env)), env };
  }

  describe("golden equivalence (A2)", () => {
    test.each(TRANSPORTS)("the %s exchanges match golden.json by value", async (transport) => {
      const golden = (): InferenceRpcClient =>
        clientFor[transport]({ serviceCredential: transports.goldenCredential });
      expect(await recordGolden(golden)).toEqual(goldenExchanges());
    });
  });

  describe("transport by declared owner", () => {
    function candidate(
      ownerNodeId: string,
      overrides: Partial<Ad> = {},
    ): routingCatalog.RouteCandidate {
      return {
        advertisement: ad(LOCAL, { ownerNodeId, ...overrides }),
        alias: `public/${LOCAL}`,
        source: "advertised",
        legacyWinner: false,
      };
    }

    test("the owner's kubeconfig node selects embedded, direct or tunnel; an undeclared or unpinned owner fails closed", async () => {
      useRemoteHost();
      const fallback: string[] = [];
      const credentialFile = join(temp.devStorage, "svc-owner.token");
      writeFileSync(credentialFile, transports.serviceCredential);
      const ref = `file:${credentialFile}`;
      const relayFile = join(temp.devStorage, "relay-owner.token");
      writeFileSync(relayFile, transports.relayCredential);
      const peers: PeerNode[] = [
        {
          id: "worker-direct",
          endpoint: transports.worker.url,
          certificate: transports.workerNode.certificate ?? "",
          fingerprint: transports.workerNode.certificateFingerprint ?? "",
        },
        {
          id: "worker-tunnel",
          endpoint: "https://127.0.0.1:1",
          tunnelPreferred: true,
          tunnelCentralUrl: transports.central.url,
          tunnelCentralCertificate: transports.centralCertificate,
          tunnelCentralFingerprint: transports.centralFingerprint,
          tunnelRelayToken: transports.centralToken,
          tunnelNodeName: TUNNEL_NODE,
        },
        { id: "worker-unpinned", endpoint: "https://192.0.2.1:7843" },
        {
          id: "worker-optout",
          endpoint: transports.worker.url,
          certificate: transports.workerNode.certificate ?? "",
        },
      ];
      // The worker-RPC block a kubeconfig node declares, per owner.
      const refs: Record<string, string> = {
        "worker-direct": ref,
        "worker-tunnel": ref,
        "worker-unpinned": ref,
        "worker-undeclared": ref,
      };
      const acquire = (owner: string, overrides: Partial<Ad> = {}): BackendExecutor | null =>
        acquireWorkerRpcExecutor(candidate(owner, overrides), {
          nodeId: "gw",
          scope: TENANT,
          fallback: recordingFallback(fallback),
          peers: () => peers,
          serviceCredentialRef: (id) => refs[id],
          relayCredentialRef: (id) => (id === "worker-tunnel" ? `file:${relayFile}` : undefined),
        });
      expect(acquire("gw")?.describe().id).toBe("worker-rpc-executor:embedded");
      for (const [owner, transport] of [
        ["worker-direct", "direct"],
        ["worker-tunnel", "tunnel"],
      ] as const) {
        const executor = acquire(owner);
        expect(executor?.describe().id).toBe(`worker-rpc-executor:${transport}`);
        const env = envelope(`att-owner-${transport}`);
        const res = await executor!.execute(env, ctxFor(env));
        expect(res.status).toBe(200);
        expect(res.headers.get("x-llamactl-worker-transport")).toBe(transport);
        expect(await res.text()).toContain("[DONE]");
      }
      for (const owner of ["worker-unpinned", "worker-undeclared"]) {
        const env = envelope(`att-${owner}`);
        const res = await acquire(owner)!.execute(env, ctxFor(env));
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ error: { code: "target-unavailable" } });
      }
      // A declared owner the caller holds no credential for keeps the existing path.
      expect(acquire("worker-optout")).toBeNull();
      expect(acquire("worker-direct", { transport: "local-http" })).toBeNull();
      expect(fallback).toEqual([]);
      expect(engine.requests).toHaveLength(2);
    });
  });

  describe("disconnect at each acceptance point (A8, A3, X4)", () => {
    test("direct, before the acknowledgement: a lost acknowledgement is resolved through status and runs once; a lost submit is unknown", async () => {
      useRemoteHost();
      const pinned = makePinnedFetch(transports.workerNode);
      let reached = 0;
      const lossy =
        (sendFirst: boolean): PinnedFetch =>
        async (input, init) => {
          if (!urlOf(input).includes("inferenceRpc.submit")) return await pinned(input, init);
          if (!sendFirst) throw new Error("connection refused");
          reached += 1;
          await (await pinned(input, init)).text();
          throw new Error("connection reset before the acknowledgement");
        };
      const queue = queueSampler();
      const lost = await execute(
        directClient({ fetch: lossy(true), onStreamQueue: queue.sample }),
        "att-d-ack",
      );
      expect(lost.res.status).toBe(200);
      const body = await lost.res.text();
      expect(body).toContain('"content":"Hel"');
      expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
      expect(reached).toBe(1);
      expect(engine.requests).toHaveLength(1);
      expect(statusNow("att-d-ack")).toMatchObject({
        state: "terminal",
        terminal: { outcome: "completed" },
      });

      const never = await execute(directClient({ fetch: lossy(false) }), "att-d-never");
      expect(never.res.status).toBe(502);
      expect(await never.res.json()).toMatchObject({ error: { code: "unknown-outcome" } });
      expect(statusNow("att-d-never")).toMatchObject({ state: "unknown" });
      expect(engine.requests).toHaveLength(1);
      expect(queue.max()).toBeLessThanOrEqual(INFERENCE_RPC_STREAM_LIMITS.maxQueuedBytes);
    });

    test("direct, after acceptance before attach: the attempt is cancelled unstarted and nothing runs", async () => {
      useRemoteHost();
      const pinned = makePinnedFetch(transports.workerNode);
      const refusing: PinnedFetch = async (input, init) => {
        if (urlOf(input).includes("inferenceRpc.stream")) throw new Error("connection refused");
        return await pinned(input, init);
      };
      const { res } = await execute(directClient({ fetch: refusing }), "att-d-attach");
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: { code: "cancelled" } });
      expect(statusNow("att-d-attach")).toMatchObject({
        state: "terminal",
        terminal: { outcome: "cancelled", started: false },
      });
      expect(engine.requests).toHaveLength(0);
    });

    test("direct, after acceptance before the first event: the engine request is aborted and resolved through status", async () => {
      engine.setScript({ holdAfter: 0 });
      useRemoteHost();
      const pinned = makePinnedFetch(transports.workerNode);
      const cutting: PinnedFetch = async (input, init) => {
        const res = await pinned(input, init);
        if (!urlOf(input).includes("inferenceRpc.stream")) return res;
        return cutStream(res, (frame) => frameKind(frame) === "accepted", {
          before: () => until(() => engine.requests.length === 1),
        });
      };
      const aborted = engine.nextAbort();
      const { res } = await execute(directClient({ fetch: cutting }), "att-d-first");
      await aborted;
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: { code: "cancelled" } });
      expect(statusNow("att-d-first")).toMatchObject({
        state: "terminal",
        terminal: { outcome: "cancelled", started: true },
      });
      expect(engine.requests).toHaveLength(1);
    });

    test("direct, mid-stream: the engine request is aborted and the cancel follows the relayed output", async () => {
      engine.setScript({ holdAfter: 1 });
      useRemoteHost();
      const pinned = makePinnedFetch(transports.workerNode);
      const cutting: PinnedFetch = async (input, init) => {
        const res = await pinned(input, init);
        if (!urlOf(input).includes("inferenceRpc.stream")) return res;
        return cutStream(res, (frame) => frameKind(frame) === "content", { forward: true });
      };
      const aborted = engine.nextAbort();
      const { res } = await execute(directClient({ fetch: cutting }), "att-d-mid");
      const body = await res.text();
      await aborted;
      expect(body).toContain('"content":"Hel"');
      expect(body).toContain('"code":"cancelled"');
      expect(body).not.toContain("[DONE]");
      expect(statusNow("att-d-mid")).toMatchObject({
        state: "terminal",
        terminal: { outcome: "cancelled", started: true },
      });
      expect(engine.requests).toHaveLength(1);
    });

    test("direct, after the terminal before delivery: status proves completion; lost output is never claimed complete", async () => {
      useRemoteHost();
      const pinned = makePinnedFetch(transports.workerNode);
      const cuttingAt =
        (at: (frame: string) => boolean): PinnedFetch =>
        async (input, init) => {
          const res = await pinned(input, init);
          if (!urlOf(input).includes("inferenceRpc.stream")) return res;
          return cutStream(res, at);
        };
      const onlyTerminal = await execute(
        directClient({ fetch: cuttingAt((f) => frameKind(f) === "terminal") }),
        "att-d-term",
      );
      const complete = await onlyTerminal.res.text();
      expect(complete).toContain('"content":"lo"');
      expect(complete.trimEnd().endsWith("data: [DONE]")).toBe(true);

      const withOutput = await execute(
        directClient({ fetch: cuttingAt((f) => f.includes('"content":"lo"')) }),
        "att-d-term-lost",
      );
      const partial = await withOutput.res.text();
      expect(partial).toContain('"content":"Hel"');
      expect(partial).not.toContain('"content":"lo"');
      expect(partial).toContain('"code":"incomplete"');
      expect(partial).not.toContain("[DONE]");
      for (const attemptId of ["att-d-term", "att-d-term-lost"]) {
        expect(statusNow(attemptId)).toMatchObject({
          state: "terminal",
          terminal: { outcome: "completed" },
        });
      }
      expect(engine.requests).toHaveLength(2);
      expect(engine.aborts()).toBe(0);
    });

    test("tunnel, before the acknowledgement: acceptance survives the reconnect and the attempt runs once", async () => {
      const base = useRemoteHost();
      let submits = 0;
      wrapHost({
        // tRPC awaits the resolver, so the acknowledgement only leaves
        // after central dropped the tunnel: it is lost with the link.
        submit: ((
          claimsIn: Claims | undefined,
          input: inferenceRpc.InferenceRpcSubmitRequestV1,
        ) => {
          submits += 1;
          const result = base.submit(claimsIn, input);
          return dropTunnel().then(() => result);
        }) as unknown as WorkerRpcHost["submit"],
      });
      const { res } = await execute(tunnelClient(), "att-t-ack");
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('"content":"Hel"');
      expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
      expect(submits).toBe(1);
      expect(engine.requests).toHaveLength(1);
    });

    test("tunnel, after acceptance before attach: the attempt is cancelled unstarted across the reconnect", async () => {
      useRemoteHost();
      const real = tunnelClient();
      const client: InferenceRpcClient = {
        ...real,
        stream: async function* (input, signal) {
          await dropTunnel();
          yield* real.stream(input, signal);
        },
      };
      const { res } = await execute(client, "att-t-attach");
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: { code: "cancelled" } });
      expect(statusNow("att-t-attach")).toMatchObject({
        state: "terminal",
        terminal: { outcome: "cancelled", started: false },
      });
      expect(engine.requests).toHaveLength(0);
    });

    test("tunnel, after acceptance before the first event: the drop aborts the engine request", async () => {
      engine.setScript({ holdAfter: 0 });
      const base = useRemoteHost();
      wrapHost({
        stream: async function* (claimsIn, input, signal) {
          const frames = base.stream(claimsIn, input, signal)[Symbol.asyncIterator]();
          await frames.next(); // the acceptance, never forwarded
          const rest = frames.next(); // starts the engine request
          await until(() => engine.requests.length === 1);
          await dropTunnel();
          await rest;
          await frames.return?.(undefined);
          yield* [];
        },
      });
      const aborted = engine.nextAbort();
      const { res } = await execute(tunnelClient(), "att-t-first");
      await aborted;
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: { code: "cancelled" } });
      expect(statusNow("att-t-first")).toMatchObject({
        state: "terminal",
        terminal: { outcome: "cancelled", started: true },
      });
    });

    test("tunnel, mid-stream: the drop aborts the engine request and the terminal arrives across the reconnect", async () => {
      engine.setScript({ holdAfter: 1 });
      useRemoteHost();
      const real = tunnelClient();
      const client: InferenceRpcClient = {
        ...real,
        stream: async function* (input, signal) {
          for await (const frame of real.stream(input, signal)) {
            yield frame;
            if (frame.frame === "event" && frame.event.type === "content") await dropTunnel();
          }
        },
      };
      const aborted = engine.nextAbort();
      const { res } = await execute(client, "att-t-mid");
      const body = await res.text();
      await aborted;
      expect(body).toContain('"content":"Hel"');
      expect(body).toContain('"code":"cancelled"');
      expect(body).not.toContain("[DONE]");
      expect(statusNow("att-t-mid")).toMatchObject({
        state: "terminal",
        terminal: { outcome: "cancelled", started: true },
      });
      expect(engine.requests).toHaveLength(1);
    });

    test("tunnel, after the terminal before delivery: the completed terminal is recovered across the reconnect", async () => {
      const base = useRemoteHost();
      let outputDelivered = (): void => undefined;
      const delivered = new Promise<void>((resolve) => {
        outputDelivered = resolve;
      });
      // The worker holds its terminal until the caller has all the output,
      // then the tunnel drops and the terminal goes out on the dead link.
      wrapHost({
        stream: async function* (claimsIn, input, signal) {
          for await (const frame of base.stream(claimsIn, input, signal)) {
            if (frame.frame === "event" && frame.event.type === "terminal") {
              await delivered;
              await dropTunnel();
            }
            yield frame;
          }
        },
      });
      const real = tunnelClient();
      const client: InferenceRpcClient = {
        ...real,
        stream: async function* (input, signal) {
          for await (const frame of real.stream(input, signal)) {
            if (JSON.stringify(frame).includes('"content":"lo"')) outputDelivered();
            yield frame;
          }
        },
      };
      const { res } = await execute(client, "att-t-term");
      const body = await res.text();
      expect(body).toContain('"content":"lo"');
      expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
      expect(statusNow("att-t-term")).toMatchObject({
        state: "terminal",
        terminal: { outcome: "completed" },
      });
      expect(engine.requests).toHaveLength(1);
      expect(engine.aborts()).toBe(0);
    });

    test("tunnel: a drop settles the attempt through the node's cleanupSocket alone; a caller cancel that never reaches the worker cannot account for the terminal", async () => {
      engine.setScript({ holdAfter: 1 });
      useRemoteHost();
      const real = tunnelClient();
      // Stub cancel so the caller's resolver-lost path cannot settle the
      // worker's attempt: only the node's cleanupSocket can do that here.
      const client: InferenceRpcClient = {
        ...real,
        cancel: () => Promise.resolve({ outcome: "unknown" as const }),
      };
      const attemptId = "att-t-cleanup";
      const env = envelope(attemptId);
      const res = await executorOver(client).execute(env, ctxFor(env));
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("Hel");
      const aborted = engine.nextAbort();
      await dropTunnel();
      await aborted;
      expect(statusNow(attemptId)).toMatchObject({
        state: "terminal",
        terminal: { outcome: "cancelled", started: true },
      });
      expect(engine.requests).toHaveLength(1);
      let rest = "";
      const decoder = new TextDecoder();
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        rest += decoder.decode(r.value, { stream: true });
      }
      // The consumer gets the worker's own terminal, read through status once the tunnel is back.
      expect(rest).toContain('"code":"cancelled"');
      expect(rest).not.toContain("[DONE]");
    });
  });

  describe("bounded streaming toward a slow consumer (X3)", () => {
    const limits = { maxFrameBytes: 8 * 1024, maxQueuedBytes: 16 * 1024 };

    test.each(TRANSPORTS)(
      "%s: queued bytes stay under the cap; overflow ends the stream typed and cancels upstream",
      async (transport) => {
        const pieces = Array.from({ length: 400 }, (_, i) => `p${String(i)}-${"x".repeat(200)}`);
        engine.setScript({ pieces, holdAfter: pieces.length });
        useRemoteHost();
        const queue = queueSampler();
        const acks: unknown[] = [];
        const client = recordingCancels(
          clientFor[transport]({ limits, onStreamQueue: queue.sample }),
          acks,
        );
        const aborted = engine.nextAbort();
        const attemptId = `att-${transport}-slow`;
        const { res } = await execute(client, attemptId);
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        await reader.read();
        // The consumer stalls; the overflow cancels the engine request.
        await aborted;
        expect(queue.max()).toBeGreaterThan(0);
        expect(queue.max()).toBeLessThanOrEqual(limits.maxQueuedBytes);
        let rest = "";
        const decoder = new TextDecoder();
        for (let r = await reader.read(); !r.done; r = await reader.read()) {
          rest += decoder.decode(r.value, { stream: true });
        }
        expect(rest).toContain('"code":"stream-overflow"');
        expect(rest).not.toContain("[DONE]");
        expect(acks).toHaveLength(1);
        expect(statusNow(attemptId)).toMatchObject({
          state: "terminal",
          terminal: { outcome: "cancelled", started: true },
        });
      },
    );

    /**
     * X3 on central: a relay client that stops reading. The relay pulls one
     * event per read, so what the client has not read waits in central's
     * per-stream queue, which holds at most its cap and then ends the stream
     * typed, cancelling the attempt upstream.
     */
    test("tunnel: a relay client that stops reading leaves central's queue bounded; overflow ends it typed and cancels upstream", async () => {
      const cap = INFERENCE_RPC_STREAM_LIMITS.maxQueuedBytes;
      // Several times the cap, in events well under the frame cap; then the
      // engine holds the response open, so the attempt is still running.
      const pieces = Array.from({ length: 300 }, () => "z".repeat(48 * 1024));
      engine.setScript({ pieces, holdAfter: pieces.length });
      useRemoteHost();
      const aborted = engine.nextAbort();
      const attemptId = "att-relay-stalled";
      expect(await submit(tunnelClient(), attemptId)).toMatchObject({ outcome: "accepted" });
      const input = { attemptId };
      const token = auth.mintServiceToken(transports.serviceCredential, {
        node: TUNNEL_NODE,
        method: "inferenceRpc.stream",
        input,
        relayPrincipal: auth.relayPrincipalOf(transports.centralToken),
      });
      // A raw relay stream whose body is never read until the end.
      const res = await fetch(`${transports.central.url}/tunnel-relay/${TUNNEL_NODE}?stream=true`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${transports.centralToken}`,
          "content-type": "application/json",
          [auth.SERVICE_TOKEN_HEADER]: token,
        },
        body: JSON.stringify({ method: "inferenceRpc.stream", type: "subscription", input }),
        tls: { ca: transports.centralCertificate },
      } as RequestInit);
      expect(res.status).toBe(200);
      let maxQueued = 0;
      const deadline = Date.now() + 20_000;
      for (;;) {
        maxQueued = Math.max(
          maxQueued,
          transports.central.tunnelServer?.queuedBytes(TUNNEL_NODE) ?? 0,
        );
        // Past the cap the bound is already broken; no need to wait for more.
        const now = statusNow(attemptId);
        if ((now.outcome === "status" && now.state === "terminal") || maxQueued > cap) break;
        if (Date.now() > deadline) throw new Error("the attempt never ended");
        await new Promise((r) => setTimeout(r, 2));
      }
      // Central held up to its cap, never more, and the overflow cancelled upstream.
      expect(maxQueued).toBeGreaterThan(cap / 2);
      expect(maxQueued).toBeLessThanOrEqual(cap);
      expect(statusNow(attemptId)).toMatchObject({
        state: "terminal",
        terminal: { outcome: "cancelled", started: true },
      });
      await aborted;
      // The late reader gets what central held, then the typed terminal.
      const late = await res.text();
      const delivered = Buffer.byteLength(late);
      expect(late).toContain('"code":"stream-overflow"');
      expect(delivered).toBeLessThan(pieces.length * 48 * 1024);
    }, 30_000);

    test.each(TRANSPORTS)(
      "%s: a terminated frame past the frame cap ends the stream typed, aborts the engine and cancels once",
      async (transport) => {
        engine.setScript({ pieces: ["x".repeat(16 * 1024)], holdAfter: 1 });
        useRemoteHost();
        const acks: unknown[] = [];
        const client = recordingCancels(
          clientFor[transport]({ limits: { maxFrameBytes: 8 * 1024, maxQueuedBytes: 64 * 1024 } }),
          acks,
        );
        const aborted = engine.nextAbort();
        const attemptId = `att-${transport}-frame-overflow`;
        const { res } = await execute(client, attemptId);
        await aborted;
        const body = await res.text();
        expect(body).toContain('"code":"stream-overflow"');
        expect(engine.aborts()).toBe(1);
        expect(acks).toHaveLength(1);
      },
    );

    test("direct: an unterminated frame past the cap ends the stream typed and tears the transport down", async () => {
      useRemoteHost();
      let transportAborted = false;
      const pinned = makePinnedFetch(transports.workerNode);
      const oversized: PinnedFetch = async (input, init) => {
        if (!urlOf(input).includes("inferenceRpc.stream")) return await pinned(input, init);
        init?.signal?.addEventListener("abort", () => {
          transportAborted = true;
        });
        const body = new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(
              new TextEncoder().encode(`data: ${"x".repeat(2 * limits.maxFrameBytes)}`),
            );
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };
      const client = directClient({ fetch: oversized, limits });
      const { res } = await execute(client, "att-d-unterminated");
      const body = await res.text();
      expect(body).toContain('"code":"stream-overflow"');
      expect(res.status).toBe(502);
      expect(transportAborted).toBe(true);
    });
  });

  describe("cancellation end to end (X4)", () => {
    test.each(TRANSPORTS)(
      "%s: a caller cancel reaches the engine request and the worker acknowledges it",
      async (transport) => {
        engine.setScript({ holdAfter: 1 });
        useRemoteHost();
        const acks: unknown[] = [];
        const attemptId = `att-${transport}-cancel`;
        const env = envelope(attemptId);
        const executor = executorOver(recordingCancels(clientFor[transport](), acks));
        const res = await executor.execute(env, ctxFor(env));
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain("Hel");
        const aborted = engine.nextAbort();
        expect(executor.cancel(attemptId)).toBe(true);
        await aborted;
        // The engine stops before the acknowledgement travels back.
        await until(() => acks.length > 0);
        await reader.cancel();
        expect(acks[0]).toEqual({ outcome: "cancelled", attemptId });
        expect(statusNow(attemptId)).toMatchObject({ terminal: { outcome: "cancelled" } });
      },
    );

    test.each(TRANSPORTS)(
      "%s: a client that disconnects mid-stream reaches the engine request, and the worker acknowledges",
      async (transport) => {
        engine.setScript({ holdAfter: 1 });
        useRemoteHost();
        const acks: unknown[] = [];
        const attemptId = `att-${transport}-gone`;
        const env = envelope(attemptId);
        const res = await executorOver(recordingCancels(clientFor[transport](), acks)).execute(
          env,
          ctxFor(env),
        );
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain("Hel");
        const aborted = engine.nextAbort();
        await reader.cancel();
        await aborted;
        await until(() => acks.length > 0);
        expect(acks[0]).toMatchObject({ attemptId });
        expect(statusNow(attemptId)).toMatchObject({
          terminal: { outcome: "cancelled", started: true },
        });
      },
    );

    test.each(TRANSPORTS)(
      "%s: a stream the caller leaves stops the engine through the transport alone",
      async (transport) => {
        engine.setScript({ holdAfter: 1 });
        useRemoteHost();
        const client = clientFor[transport]();
        const attemptId = `att-${transport}-leave`;
        expect(rejectionCode(await submit(client, attemptId))).toBe("accepted");
        const aborted = engine.nextAbort();
        for await (const frame of client.stream({ attemptId })) {
          if (frame.frame === "event" && frame.event.type === "content") break;
        }
        await aborted;
        await until(() => isTerminal(attemptId));
        expect(statusNow(attemptId)).toMatchObject({
          terminal: { outcome: "cancelled", started: true },
        });
      },
    );

    function isTerminal(attemptId: string): boolean {
      const status = statusNow(attemptId);
      return status.outcome === "status" && status.state === "terminal";
    }
  });

  describe("client call timeouts", () => {
    test("direct: a negotiation that times out fails closed with a typed unavailable result", async () => {
      useRemoteHost();
      const pinned = makePinnedFetch(transports.workerNode);
      const stalled: PinnedFetch = async (input, init) => {
        if (!urlOf(input).includes("inferenceRpc.negotiate")) return await pinned(input, init);
        return await new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        });
      };
      const calls: string[] = [];
      const env = envelope("att-d-timeout");
      const started = Date.now();
      const res = await createWorkerRpcExecutor({
        client: directClient({ fetch: stalled, callTimeoutMs: 100 }),
        deploymentId: LOCAL,
        fallback: recordingFallback(calls),
        nodeId: "gw",
      }).execute(env, ctxFor(env));
      expect(Date.now() - started).toBeLessThan(5000);
      expect(res.status).toBe(503);
      // The public body says what failed; the timeout itself goes to the log.
      expect(await res.json()).toMatchObject({
        error: { code: "target-unavailable", message: "worker RPC negotiation failed" },
      });
      expect(calls).toEqual([]);
      expect(engine.requests).toHaveLength(0);
    });

    test("tunnel: a submit that times out is resolved through status; unknown is surfaced, never replayed", async () => {
      useRemoteHost();
      let submits = 0;
      const stalled: PinnedFetch = async (input, init) => {
        const body = typeof init?.body === "string" ? init.body : "";
        if (!body.includes("inferenceRpc.submit")) return await fetch(input, init);
        submits += 1;
        return await new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
          });
        });
      };
      const { res } = await execute(
        tunnelClient({ fetch: stalled, callTimeoutMs: 100 }),
        "att-t-timeout",
      );
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ error: { code: "unknown-outcome" } });
      expect(submits).toBe(1);
      expect(statusNow("att-t-timeout")).toMatchObject({ state: "unknown" });
      expect(engine.requests).toHaveLength(0);
    });
  });
  /**
   * A8 — the rolling-upgrade window over both remote transports. A
   * gateway and a worker one minor apart interoperate; anything further
   * apart, or a different major, is refused typed `unsupported-version`
   * before any engine request. A worker that positively reports no RPC
   * keeps new requests on the existing path; every other negotiation
   * failure fails closed. A downgrade drains or cancels the active
   * stream and never re-submits it through the legacy path.
   */
  describe("rolling-upgrade window (A8)", () => {
    const at = (minor: number, major = 1): inferenceRpc.InferenceRpcVersion => ({ major, minor });
    const spoken = inferenceRpc.inferenceRpcVersionsSpokenAt;
    const WINDOW = [
      { name: "same version", gateway: at(0), worker: spoken(at(0)), runs: at(0) },
      { name: "both one minor on", gateway: at(1), worker: spoken(at(1)), runs: at(1) },
      { name: "the gateway one minor ahead", gateway: at(1), worker: spoken(at(0)), runs: at(0) },
      { name: "the worker one minor ahead", gateway: at(0), worker: spoken(at(1)), runs: at(0) },
      { name: "the gateway two minors ahead", gateway: at(2), worker: spoken(at(0)), runs: null },
      { name: "the worker two minors ahead", gateway: at(0), worker: spoken(at(2)), runs: null },
      {
        name: "the worker two minors ahead, still listing the gateway's version",
        gateway: at(0),
        worker: [at(2), at(1), at(0)],
        runs: null,
      },
      { name: "a different major", gateway: at(0, 2), worker: spoken(at(0)), runs: null },
    ];

    for (const transport of TRANSPORTS) {
      for (const step of WINDOW) {
        const verdict = step.runs === null ? "is refused typed" : "interoperates";
        test(`${transport}: ${step.name} ${verdict}`, async () => {
          useRemoteHost({ versions: step.worker });
          const submitted: inferenceRpc.InferenceRpcVersion[] = [];
          const base = currentWorkerRpcHost();
          wrapHost({
            submit: (claimsIn, input) => {
              submitted.push(input.version);
              return base.submit(claimsIn, input);
            },
          });
          const fallback: string[] = [];
          const env = envelope(`att-window-${transport}-${step.name.replaceAll(" ", "-")}`);
          const res = await executorOver(clientFor[transport](), {
            version: step.gateway,
            fallback: recordingFallback(fallback),
          }).execute(env, ctxFor(env));
          expect(fallback).toEqual([]);
          if (step.runs === null) {
            expect(res.status).toBe(503);
            expect(await res.json()).toMatchObject({ error: { code: "unsupported-version" } });
            expect(submitted).toEqual([]);
            expect(engine.requests).toHaveLength(0);
            return;
          }
          expect(res.status).toBe(200);
          expect(await res.text()).toContain("[DONE]");
          expect(submitted).toEqual([step.runs]);
          expect(engine.requests).toHaveLength(1);
        });
      }

      test(`${transport}: a new worker still serves a caller shaped like the base release`, async () => {
        useRemoteHost();
        // The base release reaches a worker's local model through its legacy
        // surfaces, never the RPC: /v1 directly, chatComplete over the tunnel.
        if (transport === "direct") {
          const pinned = makePinnedFetch(transports.workerNode);
          const res = await pinned(`${transports.worker.url}/v1/models`, {
            headers: { authorization: `Bearer ${transports.operatorToken}` },
          });
          expect(res.status).toBe(200);
          expect(await res.json()).toMatchObject({ object: "list" });
          const trpc = await pinned(`${transports.worker.url}/trpc/env`, {
            headers: { authorization: `Bearer ${transports.operatorToken}` },
          });
          expect(trpc.status).toBe(200);
        } else {
          const res = await fetch(`${transports.central.url}/tunnel-relay/${TUNNEL_NODE}`, {
            method: "POST",
            tls: { ca: transports.centralCertificate },
            headers: {
              authorization: `Bearer ${transports.centralToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ method: "env", type: "query", input: undefined }),
          });
          expect(res.status).toBe(200);
          expect(((await res.json()) as { error?: unknown }).error).toBeUndefined();
        }
        expect(engine.requests).toHaveLength(0);
        expect(statusNow("att-none")).toMatchObject({ state: "unknown" });
      });

      test(`${transport}: a worker that does not advertise the RPC keeps the request on the existing path`, async () => {
        useRemoteHost({ versions: [] });
        const fallback: string[] = [];
        const env = envelope(`att-unadvertised-${transport}`);
        const res = await executorOver(clientFor[transport](), {
          fallback: recordingFallback(fallback),
        }).execute(env, ctxFor(env));
        expect(await res.json()).toEqual({ path: "fallback" });
        expect(fallback).toEqual(["fallback"]);
        expect(engine.requests).toHaveLength(0);
      });

      test(`${transport}: a downgrade drains the active stream, sends new requests down the existing path and never re-submits`, async () => {
        let advertise = true;
        useRemoteHost({ versions: () => (advertise ? [V1_0] : []) });
        let release = (): void => undefined;
        engine.setScript({
          pieces: ["Hel", "lo"],
          holdAfter: 1,
          release: new Promise<void>((resolve) => {
            release = resolve;
          }),
        });
        const fallback: string[] = [];
        const executor = executorOver(clientFor[transport](), {
          fallback: recordingFallback(fallback),
        });
        const env = envelope(`att-downgrade-${transport}`);
        const active = (async (): Promise<string> =>
          await (await executor.execute(env, ctxFor(env))).text())();
        await until(() => engine.requests.length === 1);
        advertise = false;
        const later = envelope(`att-downgrade-later-${transport}`);
        expect(await (await executor.execute(later, ctxFor(later))).json()).toEqual({
          path: "fallback",
        });
        release();
        const body = await active;
        expect(body).toContain('"content":"lo"');
        expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
        expect(engine.requests).toHaveLength(1);
        expect(fallback).toEqual(["fallback"]);
        expect(statusNow(env.attemptId)).toMatchObject({
          state: "terminal",
          terminal: { outcome: "completed" },
        });
      });

      test(`${transport}: a downgrade that cannot wait ends the active stream with an acknowledged cancel, never re-submitted`, async () => {
        const host = useRemoteHost();
        engine.setScript({ pieces: ["Hel", "lo"], holdAfter: 1 });
        const fallback: string[] = [];
        const env = envelope(`att-downgrade-cancel-${transport}`);
        const active = (async (): Promise<string> =>
          await (
            await executorOver(clientFor[transport](), {
              fallback: recordingFallback(fallback),
            }).execute(env, ctxFor(env))
          ).text())();
        await until(() => engine.requests.length === 1);
        const aborted = engine.nextAbort();
        const draining = host.drain();
        host.close();
        await draining;
        await aborted;
        const body = await active;
        expect(body).toContain('"code":"cancelled"');
        expect(statusNow(env.attemptId)).toMatchObject({
          state: "terminal",
          terminal: { outcome: "cancelled" },
        });
        expect(fallback).toEqual([]);
        expect(engine.requests).toHaveLength(1);
      });
    }

    test("tunnel: a node that predates the RPC answers no route, which keeps the existing path", async () => {
      useRemoteHost();
      // The base release serves tunneled calls from its own router caller,
      // which has no inferenceRpc namespace.
      const t = initTRPC.create();
      const baseRouter = t.router({ env: t.procedure.query(() => ({ base: true })) });
      const BunWebSocket = WebSocket as unknown as new (
        url: string,
        options: { tls: { ca: string } },
      ) => WebSocket;
      const ca = transports.centralCertificate;
      let ready = (): void => undefined;
      const up = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const oldNode = createTunnelClient({
        url: `wss://127.0.0.1:${String(transports.central.port)}/tunnel`,
        bearer: transports.tunnelBearer,
        nodeName: "base-release-node",
        handleRequest: createTunnelRouterHandler(baseRouter.createCaller({})),
        WebSocketCtor: class extends BunWebSocket {
          constructor(url: string) {
            super(url, { tls: { ca } });
          }
        } as unknown as ClientWebSocketConstructor,
        onStateChange: (state) => {
          if (state === "ready") ready();
        },
        initialAttemptTimeoutMs: 0,
      });
      void oldNode.start();
      try {
        await up;
        const fallback: string[] = [];
        const env = envelope("att-base-node");
        const res = await executorOver(tunnelClient({ nodeName: "base-release-node" }), {
          fallback: recordingFallback(fallback),
        }).execute(env, ctxFor(env));
        expect(await res.json()).toEqual({ path: "fallback" });
        expect(fallback).toEqual(["fallback"]);
        expect(engine.requests).toHaveLength(0);
      } finally {
        oldNode.stop();
      }
    });

    describe("direct: an owner that predates the RPC", () => {
      /**
       * The base release's /trpc handling: its bearer gate, then tRPC over a
       * router with no inferenceRpc namespace.
       */
      async function startBaseAgent(acceptedHash: string): Promise<{
        node: ClusterNode;
        stop: () => Promise<void>;
      }> {
        const dir = mkdtempSync(join(tmpdir(), "p41-base-agent-"));
        const cert = await tls.generateSelfSignedCert({
          dir,
          commonName: "127.0.0.1",
          hostnames: ["127.0.0.1", "localhost"],
        });
        const t = initTRPC.create();
        const baseRouter = t.router({ env: t.procedure.query(() => ({ base: true })) });
        const server = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          tls: { cert: cert.certPem, key: readFileSync(cert.keyPath, "utf8") },
          fetch: (req) =>
            auth.verifyBearer(req, acceptedHash)
              ? fetchRequestHandler({
                  req,
                  endpoint: "/trpc",
                  router: baseRouter,
                  createContext: () => ({}),
                })
              : auth.unauthorizedResponse(),
        });
        return {
          node: {
            name: "base-release",
            endpoint: `https://127.0.0.1:${String(server.port)}`,
            certificate: cert.certPem,
            certificateFingerprint: cert.fingerprint,
          },
          stop: async (): Promise<void> => {
            await server.stop(true);
            rmSync(dir, { recursive: true, force: true });
          },
        };
      }

      test("a 404 for the route from an owner that authenticated the caller keeps the existing path", async () => {
        const credential = auth.generateToken();
        const base = await startBaseAgent(credential.hash);
        try {
          const fallback: string[] = [];
          const env = envelope("att-base-404");
          const client = createDirectInferenceRpcClient({
            node: base.node,
            serviceCredential: credential.token,
          });
          const res = await executorOver(client, {
            fallback: recordingFallback(fallback),
          }).execute(env, ctxFor(env));
          expect(res.headers.get("x-llamactl-worker-transport")).toBe("legacy");
          expect(await res.json()).toEqual({ path: "fallback" });
          expect(fallback).toEqual(["fallback"]);
        } finally {
          await base.stop();
        }
      });

      test("an owner that refuses the credential (the base release's 401) fails closed, typed", async () => {
        const base = await startBaseAgent(auth.generateToken().hash);
        try {
          const fallback: string[] = [];
          const env = envelope("att-base-401");
          const client = createDirectInferenceRpcClient({
            node: base.node,
            serviceCredential: transports.serviceCredential,
          });
          const res = await executorOver(client, {
            fallback: recordingFallback(fallback),
          }).execute(env, ctxFor(env));
          expect(res.status).toBe(403);
          expect(await res.json()).toMatchObject({ error: { code: "unauthorized-scope" } });
          expect(fallback).toEqual([]);
        } finally {
          await base.stop();
        }
      });

      test("any other negotiation failure fails closed: a 404 that is not tRPC's, a 500, a malformed answer", async () => {
        for (const [status, body] of [
          [404, "not found"],
          [500, JSON.stringify({ error: { message: "boom" } })],
          [200, JSON.stringify({ result: { data: { outcome: "surprise" } } })],
        ] as const) {
          const fallback: string[] = [];
          const env = envelope(`att-negotiate-${String(status)}`);
          const client = createDirectInferenceRpcClient({
            node: transports.workerNode,
            serviceCredential: transports.serviceCredential,
            fetch: () => Promise.resolve(new Response(body, { status })),
          });
          const res = await executorOver(client, {
            fallback: recordingFallback(fallback),
          }).execute(env, ctxFor(env));
          expect(res.status).toBe(503);
          expect(await res.json()).toMatchObject({ error: { code: "target-unavailable" } });
          expect(fallback).toEqual([]);
        }
        expect(engine.requests).toHaveLength(0);
      });
    });
  });

  /**
   * X5 over the tunnel. Central relays a request to whichever node holds
   * the target name, and any node holding the shared tunnel bearer can
   * claim a name. So a tunnel caller never sends its service credential:
   * each call carries a single-use token derived from it, bound to the
   * node, the call and its input, central's relay principal, a nonce and
   * a short expiry.
   */
  describe("derived service tokens on the tunnel (X5)", () => {
    const NEGOTIATE = { versions: [V1_0], requiredFeatures: ["execution-event-v1"] };

    /** One relay call, as a tunnel client makes it, carrying `token`. */
    async function relayCall(
      method: string,
      input: unknown,
      token: string | undefined,
      bearer = transports.relayCredential,
    ): Promise<{ status: number; result: unknown }> {
      const res = await fetch(`${transports.central.url}/tunnel-relay/${TUNNEL_NODE}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          ...(token !== undefined ? { [auth.SERVICE_TOKEN_HEADER]: token } : {}),
        },
        body: JSON.stringify({ method, type: "query", input }),
        tls: { ca: transports.centralCertificate },
      } as RequestInit);
      const body = (await res.json().catch(() => null)) as { result?: unknown } | null;
      return { status: res.status, result: body?.result };
    }

    function tokenFor(
      method: string,
      input: unknown,
      opts: { node?: string; now?: number; bearer?: string } = {},
    ): string {
      return auth.mintServiceToken(
        transports.serviceCredential,
        {
          node: opts.node ?? TUNNEL_NODE,
          method,
          input,
          relayPrincipal: auth.relayPrincipalOf(opts.bearer ?? transports.relayCredential),
        },
        opts.now !== undefined ? { now: opts.now } : {},
      );
    }

    async function negotiatedThroughRelay(): Promise<boolean> {
      const { result } = await relayCall(
        "inferenceRpc.negotiate",
        NEGOTIATE,
        tokenFor("inferenceRpc.negotiate", NEGOTIATE),
      );
      return (result as { outcome?: string } | undefined)?.outcome === "negotiated";
    }

    /** Polls until the real worker holds the tunnel name again. */
    async function realWorkerBack(): Promise<void> {
      const deadline = Date.now() + 10_000;
      while (!(await negotiatedThroughRelay().catch(() => false))) {
        if (Date.now() > deadline) throw new Error("the worker did not reclaim its tunnel name");
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    test("an impersonating node collects no credential and nothing it can reuse", async () => {
      useRemoteHost();
      const captured: TunnelReq[] = [];
      let markReady = (): void => undefined;
      const ready = new Promise<void>((resolve) => {
        markReady = resolve;
      });
      // Any node holding the shared tunnel bearer can register as the worker.
      const rogue = createTunnelClient({
        url: `wss://127.0.0.1:${String(transports.central.port)}/tunnel`,
        bearer: transports.tunnelBearer,
        nodeName: TUNNEL_NODE,
        handleRequest: (req) => {
          captured.push(req);
          return Promise.resolve({ outcome: "not-advertised" });
        },
        handleSubscription: (req) => {
          captured.push(req);
          return {
            subscribe: (handlers): { cancel: () => void } => {
              handlers.onComplete();
              return { cancel: (): void => undefined };
            },
          };
        },
        WebSocketCtor: pinnedWebSocket(transports.centralCertificate),
        onStateChange: (state) => {
          if (state === "ready") markReady();
        },
        initialAttemptTimeoutMs: 0,
        reconnect: { minDelayMs: 60_000, maxDelayMs: 60_000 },
      });
      void rogue.start();
      await ready;
      const client = tunnelClient();
      const env = envelope("att-impersonated");
      const target = {
        deploymentId: LOCAL,
        expectedDeploymentEpoch: "epoch-1",
        catalogGeneration: "gen-x",
        workerIncarnation: "inc-x",
      };
      await client.negotiate(NEGOTIATE);
      const calls: Promise<unknown>[] = [
        client.catalog(),
        client.submit({ version: V1_0, envelope: env, target, cancelId: "cancel-imp" }),
        client.status({ attemptId: env.attemptId }),
        client.cancel({ attemptId: env.attemptId }),
        collect(client.stream({ attemptId: env.attemptId })),
      ];
      await Promise.allSettled(calls);
      rogue.stop();

      expect(captured.length).toBe(6);
      // Nothing that crossed to the node is, or carries, the credential.
      expect(JSON.stringify(captured)).not.toContain(transports.serviceCredential);
      const tokens = captured.map((req) => req.auth?.serviceToken ?? "");
      for (const token of tokens) expect(token.length).toBeGreaterThan(0);

      // What it collected is no credential: the worker refuses it as one.
      const pinned = makePinnedFetch(transports.workerNode);
      for (const token of tokens) {
        const res = await pinned(`${transports.worker.url}/trpc/inferenceRpc.catalog`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(401);
      }
      // Its own credential, the tunnel bearer, does not open central's relay.
      const ownBearer = await relayCall(
        "inferenceRpc.negotiate",
        NEGOTIATE,
        tokens[0],
        transports.tunnelBearer,
      );
      expect(ownBearer.status).toBe(401);

      // Delivered to the real worker, a collected token buys no other call.
      await realWorkerBack();
      const [negotiateToken, catalogToken] = tokens;
      const otherInput = await relayCall(
        "inferenceRpc.negotiate",
        { ...NEGOTIATE, optionalFeatures: ["cancel-ack"] },
        negotiateToken,
      );
      expect(otherInput.result).toMatchObject({
        outcome: "rejected",
        rejection: { code: "unauthorized-scope" },
      });
      const otherCall = await relayCall(
        "inferenceRpc.status",
        { attemptId: "att-x" },
        catalogToken,
      );
      expect(otherCall.result).toMatchObject({
        outcome: "rejected",
        rejection: { code: "unauthorized-scope" },
      });
      // Nor the very call it collected, through any other relay identity.
      const sameCall = await relayCall(
        "inferenceRpc.negotiate",
        NEGOTIATE,
        negotiateToken,
        transports.centralToken,
      );
      expect(sameCall.result).toMatchObject({
        outcome: "rejected",
        rejection: { code: "unauthorized-scope" },
      });
      expect(engine.requests).toHaveLength(0);
    }, 20_000);

    test("each token verifies once, on its node, before it expires", async () => {
      useRemoteHost();
      const logged: string[] = [];
      const write = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk: string | Uint8Array): boolean => {
        logged.push(String(chunk));
        return true;
      };
      const presented: string[] = [];
      try {
        await verifiesOnce(presented);
      } finally {
        process.stderr.write = write;
      }
      // The worker logs why it refused each token, never the token.
      const refusals = logged.filter((line) => line.includes("tunnel token refused"));
      for (const reason of ["replay", "expired", "node", "mac"]) {
        expect(refusals.some((line) => line.includes(`(${reason})`))).toBe(true);
      }
      for (const token of presented) expect(logged.join("")).not.toContain(token);
    });

    async function verifiesOnce(presented: string[]): Promise<void> {
      const fresh = tokenFor("inferenceRpc.negotiate", NEGOTIATE);
      const first = await relayCall("inferenceRpc.negotiate", NEGOTIATE, fresh);
      expect(first.result).toMatchObject({ outcome: "negotiated" });
      const refused = { outcome: "rejected", rejection: { code: "unauthorized-scope" } };
      // Replayed: the worker has seen its nonce.
      const replayed = await relayCall("inferenceRpc.negotiate", NEGOTIATE, fresh);
      expect(replayed.result).toMatchObject(refused);
      // Expired.
      const expired = tokenFor("inferenceRpc.negotiate", NEGOTIATE, {
        now: Date.now() - 2 * auth.SERVICE_TOKEN_TTL_MS,
      });
      expect((await relayCall("inferenceRpc.negotiate", NEGOTIATE, expired)).result).toMatchObject(
        refused,
      );
      // Minted for another node.
      const elsewhere = tokenFor("inferenceRpc.negotiate", NEGOTIATE, { node: "worker-b-tunnel" });
      expect(
        (await relayCall("inferenceRpc.negotiate", NEGOTIATE, elsewhere)).result,
      ).toMatchObject(refused);
      // Bound to another relay principal than the one central stamps.
      const otherRelay = tokenFor("inferenceRpc.negotiate", NEGOTIATE, {
        bearer: auth.generateToken().token,
      });
      expect(
        (await relayCall("inferenceRpc.negotiate", NEGOTIATE, otherRelay)).result,
      ).toMatchObject(refused);
      // A real tunnel client's replayed relay request is refused the same way.
      const sent: { url: string; init: RequestInit }[] = [];
      const recording = tunnelClient({
        fetch: (input, init) => {
          sent.push({ url: urlOf(input), init: init ?? {} });
          return fetch(input, init);
        },
      });
      expect(await recording.negotiate(NEGOTIATE)).toMatchObject({ outcome: "negotiated" });
      const [request] = sent;
      expect(new Headers(request?.init.headers).get(auth.SERVICE_TOKEN_HEADER)).toBeTruthy();
      const { signal: _spent, ...again } = request?.init ?? {};
      const replay = await fetch(request?.url ?? "", again);
      expect(((await replay.json()) as { result?: unknown }).result).toMatchObject(refused);
      presented.push(fresh, expired, elsewhere, otherRelay);
    }

    test("a binding without a tunnelKey refuses tunnel tokens; the direct path still works", async () => {
      useRemoteHost();
      const hashOnly = transports.bindings.map(({ tunnelKey: _key, ...binding }) => binding);
      const prior = transports.bindings.splice(0, transports.bindings.length, ...hashOnly);
      try {
        const tunnel = await execute(tunnelClient(), "att-no-tunnel-key");
        expect(tunnel.res.status).toBe(403);
        expect(await tunnel.res.json()).toMatchObject({ error: { code: "unauthorized-scope" } });
        const direct = await execute(directClient(), "att-no-tunnel-key-direct");
        expect(direct.res.status).toBe(200);
        expect(await direct.res.text()).toContain("[DONE]");
        expect(engine.requests).toHaveLength(1);
      } finally {
        transports.bindings.splice(0, transports.bindings.length, ...prior);
      }
    });
  });

  /**
   * X5 — central's relay-only credential. It admits relaying the
   * worker-RPC procedures to nodes and nothing else: no other relay
   * method, no other route, however the URL is spelled. Callers present it
   * for the relay hop through their kubeconfig node's reference, and fail
   * closed without one rather than present the operator bearer, which
   * central still accepts for any relay.
   */
  describe("the relay-only credential on central (X5)", () => {
    test("a kubeconfig reference to it carries the worker-RPC procedures end to end", async () => {
      useRemoteHost();
      const serviceFile = join(temp.devStorage, "svc-relay-only.token");
      const relayFile = join(temp.devStorage, "relay-only.token");
      writeFileSync(serviceFile, transports.serviceCredential);
      writeFileSync(relayFile, transports.relayCredential);
      // No context token: only the relay-only credential can open the hop.
      const peer: PeerNode = {
        id: "worker-relay-only",
        endpoint: "https://127.0.0.1:1",
        tunnelPreferred: true,
        tunnelNodeName: TUNNEL_NODE,
        tunnelCentralUrl: transports.central.url,
        tunnelCentralCertificate: transports.centralCertificate,
        tunnelCentralFingerprint: transports.centralFingerprint,
      };
      const executor = acquireWorkerRpcExecutor(
        {
          advertisement: ad(LOCAL, { ownerNodeId: peer.id }),
          alias: `public/${LOCAL}`,
          source: "advertised",
          legacyWinner: false,
        },
        {
          nodeId: "gw",
          scope: TENANT,
          fallback: recordingFallback([]),
          peers: () => [peer],
          serviceCredentialRef: () => `file:${serviceFile}`,
          relayCredentialRef: () => `file:${relayFile}`,
        },
      );
      const env = envelope("att-relay-only");
      const res = await executor!.execute(env, ctxFor(env));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-llamactl-worker-transport")).toBe("tunnel");
      expect(await res.text()).toContain("[DONE]");
      expect(engine.requests).toHaveLength(1);
    });

    test("a tunneled owner whose block names no relay-only credential fails closed, never relaying with the operator bearer", async () => {
      useRemoteHost();
      const serviceFile = join(temp.devStorage, "svc-no-relay.token");
      writeFileSync(serviceFile, transports.serviceCredential);
      // The context user's token reaches central as its operator bearer.
      const peer: PeerNode = {
        id: "worker-no-relay",
        endpoint: "https://127.0.0.1:1",
        tunnelPreferred: true,
        tunnelNodeName: TUNNEL_NODE,
        tunnelCentralUrl: transports.central.url,
        tunnelCentralCertificate: transports.centralCertificate,
        tunnelCentralFingerprint: transports.centralFingerprint,
        tunnelRelayToken: transports.centralToken,
      };
      const fallback: string[] = [];
      const executor = acquireWorkerRpcExecutor(
        {
          advertisement: ad(LOCAL, { ownerNodeId: peer.id }),
          alias: `public/${LOCAL}`,
          source: "advertised",
          legacyWinner: false,
        },
        {
          nodeId: "gw",
          scope: TENANT,
          fallback: recordingFallback(fallback),
          peers: () => [peer],
          serviceCredentialRef: () => `file:${serviceFile}`,
          relayCredentialRef: () => undefined,
        },
      );
      const logged: string[] = [];
      const write = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk: string | Uint8Array): boolean => {
        logged.push(String(chunk));
        return true;
      };
      const relayedBefore = transports.relayRequests.length;
      let res: Response;
      try {
        const env = envelope("att-no-relay-credential");
        res = await executor!.execute(env, ctxFor(env));
      } finally {
        process.stderr.write = write;
      }
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: { code: "target-unavailable" } });
      expect(logged.join("")).toContain("names no relayCredentialRef");
      expect(transports.relayRequests.slice(relayedBefore)).toEqual([]);
      expect(fallback).toEqual([]);
      expect(engine.requests).toHaveLength(0);
    });

    test("it reaches no other relay method and no other route, by URL tricks or otherwise", async () => {
      // A node that records every req frame central sends it.
      const received: string[] = [];
      let markReady = (): void => undefined;
      const ready = new Promise<void>((resolve) => {
        markReady = resolve;
      });
      const spy = createTunnelClient({
        url: `wss://127.0.0.1:${String(transports.central.port)}/tunnel`,
        bearer: transports.tunnelBearer,
        nodeName: "spy-node",
        handleRequest: (req) => {
          received.push(req.method);
          return Promise.resolve({ outcome: "not-advertised" });
        },
        handleSubscription: (req) => {
          received.push(req.method);
          return {
            subscribe: (handlers): { cancel: () => void } => {
              handlers.onComplete();
              return { cancel: (): void => undefined };
            },
          };
        },
        WebSocketCtor: pinnedWebSocket(transports.centralCertificate),
        onStateChange: (state) => {
          if (state === "ready") markReady();
        },
        initialAttemptTimeoutMs: 0,
      });
      void spy.start();
      await ready;
      try {
        // A raw request, so the path reaches central exactly as spelled.
        const raw = (
          verb: string,
          path: string,
          bearer: string,
          body = "",
        ): Promise<{ status: number; body: string }> =>
          new Promise((resolve, reject) => {
            const socket = connect(
              {
                host: "127.0.0.1",
                port: transports.central.port,
                ca: transports.centralCertificate,
                checkServerIdentity: () => undefined,
              },
              () => {
                socket.write(
                  `${verb} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${bearer}\r\n` +
                    `Content-Type: application/json\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\n` +
                    `Connection: close\r\n\r\n${body}`,
                );
              },
            );
            let out = "";
            socket.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
            socket.on("end", () => {
              const status = Number(/^HTTP\/1\.1 (\d+)/.exec(out)?.[1] ?? 0);
              resolve({ status, body: out.slice(out.indexOf("\r\n\r\n") + 4) });
            });
            socket.on("error", reject);
          });
        const relay = transports.relayCredential;
        const call = (method: string): string =>
          JSON.stringify({ method, type: "query", input: { versions: [V1_0] } });

        // The one thing it is for, to a node: a worker-RPC procedure.
        expect(
          (await raw("POST", "/tunnel-relay/spy-node", relay, call("inferenceRpc.negotiate")))
            .status,
        ).toBe(200);
        expect(received).toEqual(["inferenceRpc.negotiate"]);

        // Any other relay method, or the right one spelled otherwise, is refused.
        for (const method of [
          "env",
          "nodeList",
          "inferenceRpc",
          "inferenceRpc.",
          "inferenceRpc.x",
          "inferenceRpc.negotiate,env",
          "inferenceRpc.negotiate%2Cenv",
          "inferenceRpc.x/../env",
          "inferenceRpc.catalog.env",
          "inferenceRpcX.negotiate",
          "%69nferenceRpc.catalog",
          " inferenceRpc.catalog",
          "inferenceRpc.catalog ",
          "InferenceRpc.catalog",
        ]) {
          for (const query of ["", "?stream=true"]) {
            const res = await raw("POST", `/tunnel-relay/spy-node${query}`, relay, call(method));
            expect([method, query, res.status]).toEqual([method, query, 403]);
          }
        }
        expect((await raw("GET", "/tunnel-relay/spy-node", relay)).status).toBe(403);
        expect(received).toEqual(["inferenceRpc.negotiate"]);

        // Every other route answers it exactly as it answers a stranger.
        const stranger = auth.generateToken().token;
        for (const path of [
          "/trpc/env",
          "/trpc/nodeList",
          "/trpc/inferenceRpc.catalog",
          "/trpc/inferenceRpc.negotiate,env?batch=1&input=%7B%7D",
          "/trpc/inferenceRpc.negotiate%2Cenv?batch=1&input=%7B%7D",
          "/trpc/inferenceRpc.negotiate%252Cenv?batch=1&input=%7B%7D",
          "/trpc/inferenceRpc.x/../env",
          "/trpc/inferenceRpc.x/%2e%2e/env",
          "/trpc/inferenceRpc.x%2F..%2Fenv",
          "/trpc//env",
          "/trpcXinferenceRpc.negotiate",
          "/trpc/%69nferenceRpc.catalog,env?batch=1&input=%7B%7D",
          "/trpc/inferenceRpc.catalog/",
          "/tunnel-relay/../trpc/env",
          "/tunnel-relay/spy-node/../../trpc/env",
          "/v1/models",
          "/v1/fleet/snapshot",
          "/metrics",
        ]) {
          const asRelay = await raw("GET", path, relay);
          const asStranger = await raw("GET", path, stranger);
          expect([path, asRelay.status]).toEqual([path, asStranger.status]);
          expect(asRelay.status === 200 || asRelay.status === 404).toBe(false);
        }
        for (const path of ["/agent/update", "/agent/rollback", "/trpc/inferenceRpc.submit"]) {
          const asRelay = await raw("POST", path, relay, "{}");
          expect([path, asRelay.status]).toEqual([path, 401]);
        }
        expect(received).toEqual(["inferenceRpc.negotiate"]);
      } finally {
        spy.stop();
      }
    });
  });

  /**
   * X5 — rotation and revocation take effect for new submits over both
   * transports; accepted attempts are not cut off. The worker's bindings
   * are read on every call, as `agent serve` reads agent.yaml.
   */
  describe("service-credential rotation and revocation (X5)", () => {
    function rebind(next: agentConfigMod.AgentWorkerRpcCredential[]): () => void {
      const prior = transports.bindings.splice(0, transports.bindings.length, ...next);
      return () => {
        transports.bindings.splice(0, transports.bindings.length, ...prior);
      };
    }

    for (const transport of TRANSPORTS) {
      test(`${transport}: a rotated-out credential is refused for new submits while its accepted attempt completes`, async () => {
        useRemoteHost();
        const old = auth.generateToken();
        const next = auth.generateToken();
        const undo = rebind([
          { ...claims(), tokenHash: old.hash, tunnelKey: tunnelKeyOf(old.token) },
        ]);
        try {
          let release = (): void => undefined;
          engine.setScript({
            pieces: ["Hel", "lo"],
            holdAfter: 1,
            release: new Promise<void>((resolve) => {
              release = resolve;
            }),
          });
          const env = envelope(`att-rotate-${transport}`);
          const active = (async (): Promise<Response> =>
            await executorOver(clientFor[transport]({ serviceCredential: old.token })).execute(
              env,
              ctxFor(env),
            ))();
          await until(() => engine.requests.length === 1);
          rebind([{ ...claims(), tokenHash: next.hash, tunnelKey: tunnelKeyOf(next.token) }]);
          const refused = await execute(
            clientFor[transport]({ serviceCredential: old.token }),
            `att-rotated-${transport}`,
          );
          expect(refused.res.status).toBe(403);
          expect(await refused.res.json()).toMatchObject({ error: { code: "unauthorized-scope" } });
          release();
          const res = await active;
          expect(res.status).toBe(200);
          expect(await res.text()).toContain("[DONE]");
          engine.setScript({});
          const fresh = await execute(
            clientFor[transport]({ serviceCredential: next.token }),
            `att-fresh-${transport}`,
          );
          expect(fresh.res.status).toBe(200);
          expect(await fresh.res.text()).toContain("[DONE]");
          expect(engine.requests).toHaveLength(2);
        } finally {
          undo();
        }
      });

      test(`${transport}: a revoked deployment ACL refuses new submits before any engine request`, async () => {
        useRemoteHost();
        const undo = rebind([
          {
            ...claims({ deployments: [] }),
            tokenHash: auth.hashToken(transports.serviceCredential),
            tunnelKey: tunnelKeyOf(transports.serviceCredential),
          },
        ]);
        try {
          // The worker's catalog no longer lists the deployment to this caller.
          const { res: unlisted } = await execute(clientFor[transport](), `att-acl-${transport}`);
          expect(unlisted.status).toBe(503);
          expect(await unlisted.json()).toMatchObject({ error: { code: "target-unavailable" } });
          // A caller that knows the epoch submits anyway; the claims fence refuses it.
          const env = envelope(`att-acl-epoch-${transport}`);
          const res = await executorOver(clientFor[transport](), {
            expectedEpoch: "epoch-1",
          }).execute(env, ctxFor(env));
          expect(res.status).toBe(403);
          expect(await res.json()).toMatchObject({ error: { code: "unauthorized-scope" } });
          expect(statusNow(env.attemptId)).toMatchObject({ state: "unknown" });
          expect(engine.requests).toHaveLength(0);
        } finally {
          undo();
        }
      });
    }
  });

  describe("hop limits through the executor (direct and tunnel)", () => {
    test.each(TRANSPORTS)(
      "%s: withHop takes hopCount past the limit; the worker refuses before any engine request",
      async (transport) => {
        useRemoteHost();
        const env = envelope(`att-exec-hop-${transport}`, {
          internal: { hopCount: 1, visitedNodes: ["edge"] },
        });
        const res = await executorOver(clientFor[transport]()).execute(env, ctxFor(env));
        expect(res.status).toBe(508);
        expect(await res.json()).toMatchObject({ error: { code: "hop-limit" } });
        expect(engine.requests).toHaveLength(0);
      },
    );

    test.each(TRANSPORTS)(
      "%s: the worker receives internal with hopCount 1 and visitedNodes ['gw'] after one hop",
      async (transport) => {
        const base = useRemoteHost();
        const received: inferenceContracts.InferenceEnvelopeV1[] = [];
        wrapHost({
          submit: (
            claimsIn: Claims | undefined,
            input: inferenceRpc.InferenceRpcSubmitRequestV1,
          ) => {
            received.push(input.envelope);
            return base.submit(claimsIn, input);
          },
        });
        const env = envelope(`att-exec-hop-record-${transport}`);
        const res = await executorOver(clientFor[transport]()).execute(env, ctxFor(env));
        expect(res.status).toBe(200);
        expect(received).toHaveLength(1);
        expect(received[0]?.internal?.hopCount).toBe(1);
        expect(received[0]?.internal?.visitedNodes).toEqual(["gw"]);
      },
    );
  });
});
