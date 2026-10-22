/**
 * #192 — agent stop() keeps the worker's outbound tunnel up through the
 * terminal-flush window. The worker is reachable only through central's
 * relay, and its backend holds its unwind after a cancel, so the stream's
 * terminal is still unsent when the drain's own flush window ends.
 */
import type * as agentConfigMod from "@llamactl/core/config/agent-config";

import { inferenceContracts, inferenceRpc } from "@llamactl/core";
import { Bonjour } from "bonjour-service";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { join } from "node:path";

import type { ClientWebSocketConstructor } from "../src/tunnel/tunnel-client.js";

import { envForTemp, makeTempRuntime } from "../../core/test/helpers.js";
import { auth, type RunningAgent, startAgentServer, tls } from "../src/index.js";
import {
  createTunnelInferenceRpcClient,
  type InferenceRpcClient,
} from "../src/inference/client.js";
import {
  currentWorkerRpcHost,
  type WorkerRpcBackend,
  type WorkerRpcBackendEvent,
} from "../src/inference/procedures.js";
import { mkdirSync, writeFileSync } from "../src/safe-fs.js";
import { TERMINAL_FLUSH_MS } from "../src/server/serve.js";
import { type ControllerClosedGuard, installControllerClosedGuard } from "./helpers.js";

type StreamFrame = inferenceRpc.InferenceRpcStreamFrameV1;

const WORKER = "worker-192";
const TUNNEL_NODE = `${WORKER}-tunnel`;
const TENANT = "tenant-192";
const WORKLOAD = "wl-192";
const MODEL = "flush/model.gguf";
const DEPLOYMENT = `deploy/${WORKER}/${WORKLOAD}`;
const V1_0 = { major: 1, minor: 0 };
const DRAIN_MS = 200;
const ENV_KEYS = ["DEV_STORAGE", "LOCAL_AI_RUNTIME_DIR", "LLAMA_CPP_MODELS"] as const;

let temp: ReturnType<typeof makeTempRuntime>;
let guard: ControllerClosedGuard;
let seq = 0;
const envBackup: Record<string, string | undefined> = {};
const agents: RunningAgent[] = [];
const releases: (() => void)[] = [];

interface Central {
  agent: RunningAgent;
  certPem: string;
  fingerprint: string;
  tunnelBearer: string;
  relayToken: string;
}

interface Harness {
  worker: RunningAgent;
  client: InferenceRpcClient;
}

interface HeldBackend {
  backend: WorkerRpcBackend;
  started: Promise<void>;
  aborted: Promise<void>;
  release: () => void;
}

function writeWorkload(): void {
  const dir = join(temp.runtimeDir, "workloads", WORKLOAD);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server.pid"), `${String(process.pid)}\n`);
  writeFileSync(
    join(dir, "llama-server.state"),
    JSON.stringify({
      rel: MODEL,
      extraArgs: [],
      host: "127.0.0.1",
      port: 1,
      binary: "/x/llama-server",
      pid: process.pid,
      startedAt: "2026-10-22T00:00:00.000Z",
      tunedProfile: null,
    }),
  );
}

/** An engine slow to honour a cancel: it ends only once the test releases it. */
function heldBackend(): HeldBackend {
  let markStarted = (): void => undefined;
  let markAborted = (): void => undefined;
  let release = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    markAborted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return {
    backend: {
      execute: async function* (
        _deployment,
        _envelope,
        signal,
      ): AsyncGenerator<WorkerRpcBackendEvent> {
        markStarted();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          signal.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });
        markAborted();
        await released;
        yield {
          type: "end",
          result: { ok: true, finishReason: "stop" },
          usage: { source: "unknown" },
        } as const;
      },
    },
    started,
    aborted,
    release,
  };
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

async function certIn(name: string): Promise<ReturnType<typeof tls.generateSelfSignedCert>> {
  seq += 1;
  const dir = join(temp.devStorage, `${name}-${String(seq)}`);
  mkdirSync(dir, { recursive: true });
  return await tls.generateSelfSignedCert({
    dir,
    commonName: "127.0.0.1",
    hostnames: ["127.0.0.1", "localhost"],
  });
}

async function startCentral(): Promise<Central> {
  const cert = await certIn("central");
  const operator = auth.generateToken();
  const tunnelBearer = auth.generateToken();
  const relay = auth.generateToken();
  const agent = startAgentServer({
    bindHost: "127.0.0.1",
    port: 0,
    tokenHash: operator.hash,
    tls: { certPath: cert.certPath, keyPath: cert.keyPath },
    advertiseMdns: false,
    tunnelJournalPath: join(temp.devStorage, "tunnel-journal.jsonl"),
    tunnelCentral: {
      expectedBearerHash: tunnelBearer.hash,
      workerRpcRelay: () => ({ tokenHashes: [relay.hash] }),
    },
  });
  agents.push(agent);
  return {
    agent,
    certPem: cert.certPem,
    fingerprint: cert.fingerprint,
    tunnelBearer: tunnelBearer.token,
    relayToken: relay.token,
  };
}

/** The worker, dialing central; `around` wraps its synchronous start. */
async function startWorker(
  central: Central,
  backend: WorkerRpcBackend,
  around: (start: () => RunningAgent) => RunningAgent = (start) => start(),
  advertiseMdns = false,
): Promise<Harness> {
  const cert = await certIn("worker");
  const operator = auth.generateToken();
  const service = auth.generateToken();
  const binding: agentConfigMod.AgentWorkerRpcCredential = {
    serviceId: "svc-192",
    operations: [...inferenceRpc.InferenceRpcOperationSchema.options],
    deployments: [DEPLOYMENT],
    models: [],
    tenants: [TENANT],
    credentialScopeId: TENANT,
    tokenHash: service.hash,
    tunnelKey: createHmac("sha256", service.token)
      .update(`llamactl-worker-rpc-token\0${TUNNEL_NODE}`)
      .digest("hex"),
  };
  let markReady = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const worker = around(() =>
    startAgentServer({
      bindHost: "127.0.0.1",
      port: 0,
      tokenHash: operator.hash,
      tls: { certPath: cert.certPath, keyPath: cert.keyPath },
      advertiseMdns,
      workerRpc: {
        workerId: WORKER,
        settings: () => ({ versions: [V1_0], serviceCredentials: [{ ...binding }] }),
        drainTimeoutMs: DRAIN_MS,
        backends: new Map([["local-model", backend]]),
      },
      tunnelDial: {
        url: `wss://127.0.0.1:${String(central.agent.port)}/tunnel`,
        bearer: central.tunnelBearer,
        nodeName: TUNNEL_NODE,
        WebSocketCtor: pinnedWebSocket(central.certPem),
        onStateChange: (state) => {
          if (state === "ready") markReady();
        },
      },
    }),
  );
  agents.push(worker);
  await ready;
  return {
    worker,
    client: createTunnelInferenceRpcClient({
      centralUrl: central.agent.url,
      centralCertificate: central.certPem,
      centralFingerprint: central.fingerprint,
      nodeName: TUNNEL_NODE,
      bearer: central.relayToken,
      serviceCredential: service.token,
    }),
  };
}

async function stopWorker(harness: Harness): Promise<void> {
  agents.splice(agents.indexOf(harness.worker), 1);
  await harness.worker.stop();
}

function envelope(attemptId: string): inferenceContracts.InferenceEnvelopeV1 {
  return inferenceContracts.parseInferenceEnvelope({
    requestId: `req-${attemptId}`,
    attemptId,
    deadline: Date.now() + 60_000,
    tenantId: TENANT,
    projectId: TENANT,
    credentialScopeId: TENANT,
    operation: "generate",
    ingressProtocol: "openai-chat",
    publicModelId: MODEL,
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
    nativeBody: { model: MODEL, stream: true, messages: [{ role: "user", content: "hi" }] },
    headerFingerprint: { allowlist: ["content-type"], fingerprint: "flush" },
  });
}

async function submit(
  client: InferenceRpcClient,
  attemptId: string,
): Promise<inferenceRpc.InferenceRpcSubmitResultV1> {
  const listing = await client.catalog();
  if (listing.outcome !== "catalog") throw new Error(`catalog: ${listing.outcome}`);
  const epoch = listing.deployments.find((d) => d.deploymentId === DEPLOYMENT)?.deploymentEpoch;
  if (epoch === undefined || epoch === null) throw new Error(`no epoch for ${DEPLOYMENT}`);
  return await client.submit({
    version: V1_0,
    envelope: envelope(attemptId),
    target: {
      deploymentId: DEPLOYMENT,
      expectedDeploymentEpoch: epoch,
      catalogGeneration: listing.catalogGeneration,
      workerIncarnation: listing.workerIncarnation,
    },
    cancelId: `cancel-${attemptId}`,
  });
}

beforeAll(() => {
  guard = installControllerClosedGuard();
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];
  temp = makeTempRuntime();
  const tempEnv = envForTemp(temp);
  for (const key of ENV_KEYS) process.env[key] = tempEnv[key];
  writeWorkload();
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const agent of agents.splice(0).reverse()) await agent.stop();
});

afterAll(() => {
  try {
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

describe("agent stop() and the worker's tunnel (#192)", () => {
  test("a stream stop() cancels delivers its terminal and stream-done over the tunnel, and a status in the flush window is answered", async () => {
    const held = heldBackend();
    const harness = await startWorker(await startCentral(), held.backend);
    expect(await submit(harness.client, "att-flush")).toMatchObject({ outcome: "accepted" });
    const frames: StreamFrame[] = [];
    const streamed = (async (): Promise<void> => {
      for await (const frame of harness.client.stream({ attemptId: "att-flush" })) {
        frames.push(frame);
      }
    })();
    await held.started;
    const stopping = stopWorker(harness);
    await held.aborted;
    // Past the drain's own flush window, inside the shared one.
    await new Promise((resolve) => setTimeout(resolve, TERMINAL_FLUSH_MS + 250));
    expect(await harness.client.status({ attemptId: "att-flush" })).toMatchObject({
      outcome: "status",
      attemptId: "att-flush",
      state: "terminal",
      terminal: { outcome: "cancelled", started: true },
    });
    held.release();
    await streamed;
    await stopping;
    expect(frames.at(-1)).toMatchObject({
      frame: "event",
      event: { type: "terminal", terminal: { outcome: "cancelled", started: true } },
    });
    expect(harness.worker.tunnelClient?.state()).toBe("stopped");
  }, 20_000);

  test("when the tunnel never goes idle, stop() returns within the drain timeout plus two flush windows", async () => {
    const held = heldBackend();
    const harness = await startWorker(await startCentral(), held.backend);
    expect(await submit(harness.client, "att-stuck")).toMatchObject({ outcome: "accepted" });
    const streamed = (async (): Promise<void> => {
      for await (const _ of harness.client.stream({ attemptId: "att-stuck" })) {
        // Only the stream's end matters here.
      }
    })().catch(() => undefined);
    await held.started;
    const startedAt = performance.now();
    await stopWorker(harness);
    expect(performance.now() - startedAt).toBeLessThan(DRAIN_MS + 2 * TERMINAL_FLUSH_MS + 750);
    expect(harness.worker.tunnelClient?.state()).toBe("stopped");
    held.release();
    await streamed;
  }, 20_000);

  test("when the HTTP stop and the tunnel both stay busy, they share one flush window", async () => {
    const held = heldBackend();
    const realServe = Bun.serve;
    let closeConnection = (): void => undefined;
    const harness = await startWorker(await startCentral(), held.backend, (start) => {
      Reflect.set(Bun, "serve", ((options: Parameters<typeof Bun.serve>[0]) => {
        const server = realServe(options);
        const stop = server.stop.bind(server);
        Reflect.set(server, "stop", (force?: boolean) => {
          if (force === true) {
            closeConnection();
            return stop(true);
          }
          // A connection that only the forced stop closes.
          return new Promise<void>((resolve) => {
            closeConnection = resolve;
          });
        });
        return server;
      }) as typeof Bun.serve);
      try {
        return start();
      } finally {
        Reflect.set(Bun, "serve", realServe);
      }
    });
    expect(await submit(harness.client, "att-busy")).toMatchObject({ outcome: "accepted" });
    const streamed = (async (): Promise<void> => {
      for await (const _ of harness.client.stream({ attemptId: "att-busy" })) {
        // Only the stream's end matters here.
      }
    })().catch(() => undefined);
    await held.started;
    const startedAt = performance.now();
    await stopWorker(harness);
    // The drain's window, then one shared window; a second would cost a whole one more.
    expect(performance.now() - startedAt).toBeLessThan(
      DRAIN_MS + 2 * TERMINAL_FLUSH_MS + TERMINAL_FLUSH_MS / 2,
    );
    expect(harness.worker.tunnelClient?.state()).toBe("stopped");
    held.release();
    await streamed;
  }, 20_000);

  test("a hung mDNS teardown starts once the tunnel is down and holds stop() one flush window at most", async () => {
    const realPublish: unknown = Reflect.get(Bonjour.prototype, "publish");
    let worker: RunningAgent | undefined;
    const tunnelAtTeardown: (string | undefined)[] = [];
    const harness = await startWorker(
      await startCentral(),
      heldBackend().backend,
      (start) => {
        Reflect.set(Bonjour.prototype, "publish", () => ({
          on: (): undefined => undefined,
          stop: (done: () => void): void => {
            tunnelAtTeardown.push(worker?.tunnelClient?.state());
            releases.push(done);
          },
        }));
        try {
          worker = start();
          return worker;
        } finally {
          Reflect.set(Bonjour.prototype, "publish", realPublish);
        }
      },
      true,
    );
    const startedAt = performance.now();
    await stopWorker(harness);
    expect(performance.now() - startedAt).toBeLessThan(TERMINAL_FLUSH_MS + 750);
    expect(tunnelAtTeardown).toEqual(["stopped"]);
  });

  test("a failing HTTP stop still stops the tunnel, then the server, then unpublishes the host", async () => {
    const realServe = Bun.serve;
    let worker: RunningAgent | undefined;
    const atForcedStop: { tunnel: string | undefined; host: string }[] = [];
    const harness = await startWorker(await startCentral(), heldBackend().backend, (start) => {
      Reflect.set(Bun, "serve", ((options: Parameters<typeof Bun.serve>[0]) => {
        const server = realServe(options);
        const stop = server.stop.bind(server);
        Reflect.set(server, "stop", (force?: boolean) => {
          if (force !== true) return Promise.reject(new Error("graceful stop failed"));
          atForcedStop.push({
            tunnel: worker?.tunnelClient?.state(),
            host: currentWorkerRpcHost().workerId,
          });
          return stop(true);
        });
        return server;
      }) as typeof Bun.serve);
      try {
        worker = start();
        return worker;
      } finally {
        Reflect.set(Bun, "serve", realServe);
      }
    });
    const published = currentWorkerRpcHost();
    expect(published.workerId).toBe(WORKER);
    expect(await stopWorker(harness).catch((err: unknown) => err)).toMatchObject({
      message: "graceful stop failed",
    });
    expect(atForcedStop).toEqual([{ tunnel: "stopped", host: WORKER }]);
    expect(currentWorkerRpcHost()).not.toBe(published);
  });
});
