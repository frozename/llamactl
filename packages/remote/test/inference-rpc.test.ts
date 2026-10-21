/**
 * P4.1 (#139) — InferenceRpcV1 worker semantics through the embedded
 * client: golden exchanges, negotiation and the N-1 rolling-upgrade
 * window, acceptance fencing (X1/X2), non-model refusals (A4), no cache
 * semantics (A5), duplicate attempts and unknown outcomes (A3), and
 * in-process cancellation. Every emitted stream is checked with Nova's
 * `validateExecutionEventSequence`.
 */
import type { ResolvedEnv } from "@llamactl/core/types";

import { inferenceContracts, inferenceRpc, routingCatalog } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { type ExecutionEventV1, validateExecutionEventSequence } from "@novaproto/contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { envForTemp, makeTempRuntime } from "../../core/test/helpers.js";
import { configSchema, config as kubecfg } from "../src/index.js";
import {
  createEmbeddedInferenceRpcClient,
  createWorkerRpcExecutor,
  type InferenceRpcClient,
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
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "../src/safe-fs.js";
import { type FakeEngine, startFakeEngine } from "./fixtures/inference-rpc-v1/fake-engine.js";

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

describe("golden exchanges", () => {
  const goldenClaims = claims({
    serviceId: "svc-golden",
    deployments: [LOCAL, "deploy/worker-a/cli"],
  });

  async function record(): Promise<unknown[]> {
    useHost({
      incarnation: "inc-golden",
      now: () => GOLDEN_NOW,
      advertisements: () => [
        ad(LOCAL),
        ad("deploy/worker-a/cli", { backendKind: "cli", bindingId: "fakecli" }),
      ],
    });
    const client = createEmbeddedInferenceRpcClient(goldenClaims);
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

  test("the embedded exchanges match golden.json by value", async () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as { exchanges: unknown[] };
    expect(await record()).toEqual(golden.exchanges);
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
      workerId: WORKER,
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
    expect(rejectionCode(await submit(client, "att-x1"))).toBe("accepted");
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
    expect(rejectionCode(await submit(client, "att-cli-registered", { deploymentId: CLI }))).toBe(
      "accepted",
    );
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
    for (const exact of ["default", "refresh"] as const) {
      const attemptId = `att-cache-${exact}`;
      const env = envelope(attemptId, { cachePolicy: { exact, semantic: "off" } });
      expect(rejectionCode(await submit(client, attemptId, { envelope: env }))).toBe("accepted");
      expectValidStream(await collect(client.stream({ attemptId })));
    }
    expect(engine.requests).toHaveLength(2);
    expect(before).toBe(false);
    expect(existsSync(cacheDir)).toBe(false);
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
