/**
 * #278 DF-05 S8-agent-leases-flag.
 *
 * The RED cases fail by assertion at 09ded7b2: `LLAMACTL_RESIDENCY_LEASES`
 * and the `residencyLeases` agent option do not exist yet, so the
 * process-wide lease seam reads null where the fix installs one registry
 * at agent start and shares it with the Worker RPC host. Cases (j) and
 * (k) fail by assertion at 71db682e (#278 DF-05 startup rollback): a
 * throw after `maybePublishWorkerRpc` leaves the host published, the
 * seam unrestored, and — for the post-bind throw — the listener
 * answering. Case (n) pins the #278 review regression: the banner is
 * guarded by `if (noAuth)`, so a fully authenticated start prints
 * nothing. Cases (o) and (p) pin the remaining rollback steps on the
 * same post-bind tunnel throw: the declared-model source registered by
 * `declaredModels` is unset, and a published mDNS service is stopped
 * (the publish is spied, so no Bonjour traffic leaves the test). The
 * inert-default cases pass at base and must keep passing.
 *
 * Agents are real `startAgentServer` instances on loopback with no TLS;
 * the Worker RPC host is driven in-process through
 * `currentWorkerRpcHost()` — no kubeconfig, no service credential, no
 * upstream beyond the fake engine on 127.0.0.1. The opt-in reaches
 * `startAgentServer` only through a conditional `residencyLeases` spread
 * on a widened options type, so the file typechecks at base.
 */
import { inferenceContracts, inferenceRpc, openaiProxy } from "@llamactl/core";
import {
  createResidencyLeases,
  getResidencyLeaseRegistry,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { envForTemp, makeTempRuntime } from "../../../core/test/helpers.js";
import {
  currentWorkerRpcHost,
  publishWorkerRpcHost,
  type WorkerRpcBackend,
  type WorkerRpcBackendEvent,
  type WorkerRpcBackendKind,
  type WorkerRpcHost,
} from "../../src/inference/procedures.js";
import { listDeclaredModels } from "../../src/residency/catalog.js";
import { mkdirSync, writeFileSync } from "../../src/safe-fs.js";
import { generateToken } from "../../src/server/auth.js";
import * as mdnsModule from "../../src/server/mdns.js";
import { type RunningAgent, startAgentServer } from "../../src/server/serve.js";
import { ModelRunSchema } from "../../src/workload/schema.js";
import { type FakeEngine, startFakeEngine } from "../fixtures/inference-rpc-v1/fake-engine.js";

type Claims = inferenceRpc.InferenceServiceClaimsV1;
type Envelope = inferenceContracts.InferenceEnvelopeV1;
type StreamFrame = inferenceRpc.InferenceRpcStreamFrameV1;
type SubmitInput = inferenceRpc.InferenceRpcSubmitRequestV1;

const WORKER = "worker-i6";
const TENANT = "local";
const WORKLOAD = "wl-rpc";
const MODEL = "rpc/model.gguf";
const DEPLOYMENT = `deploy/${WORKER}/${WORKLOAD}`;
const COLD_PIN = "cold/model-a.gguf";
const V1_0 = { major: 1, minor: 0 };
const ENV_KEYS = [
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMACTL_CONFIG",
  "LLAMACTL_RESIDENCY_LEASES",
] as const;

let temp: ReturnType<typeof makeTempRuntime>;
let engine: FakeEngine;
const envBackup: Record<string, string | undefined> = {};
const agents: RunningAgent[] = [];

interface HeldRun {
  signal: AbortSignal;
  /** Resolves the hold gate: the backend then yields its `end` event. */
  release: () => void;
}

const heldRuns: HeldRun[] = [];

function claims(): Claims {
  return {
    serviceId: "svc-leases",
    operations: [...inferenceRpc.InferenceRpcOperationSchema.options],
    deployments: [DEPLOYMENT],
    models: [],
    tenants: [TENANT],
    credentialScopeId: TENANT,
  };
}

const CLAIMS = claims();

function envelope(attemptId: string): Envelope {
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
    headerFingerprint: { allowlist: ["content-type"], fingerprint: "install" },
  });
}

function writeWorkload(): void {
  const dir = join(temp.runtimeDir, "workloads", WORKLOAD);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server.pid"), `${String(process.pid)}\n`);
  writeFileSync(
    join(dir, "llama-server.state"),
    JSON.stringify({
      rel: MODEL,
      // A slot save path makes the route KV-eligible for every case in this file; only the fake
      // engine's SSE answers keep KV persistence off (maybePersistKv skips event streams). The I5
      // rollback test relies on it to open the KV registry inside the snapshot roots below.
      extraArgs: ["--slot-save-path", join(temp.runtimeDir, "kvstore", "slots", WORKLOAD)],
      host: "127.0.0.1",
      port: Number(new URL(engine.url).port),
      binary: "/x/llama-server",
      pid: process.pid,
      startedAt: "2026-10-19T00:00:00.000Z",
      tunedProfile: null,
    }),
  );
}

const CONTENT: WorkerRpcBackendEvent = {
  type: "content",
  payload: {
    type: "chunk",
    chunk: {
      id: "chatcmpl-lease-1",
      object: "chat.completion.chunk",
      model: MODEL,
      created: 1_700_000_000,
      choices: [{ index: 0, delta: { content: "lease" } }],
    },
  },
};

const END: WorkerRpcBackendEvent = {
  type: "end",
  result: { ok: true, finishReason: "stop" },
  usage: { source: "unknown" },
};

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * A backend that records each attempt's run in `heldRuns`, yields one
 * content event, then waits on the test-held release or the signal
 * abort, after which it yields its `end` event.
 */
function controllableBackend(): WorkerRpcBackend {
  const backend: WorkerRpcBackend = {
    execute: (_deployment, _envelope, signal) => {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      heldRuns.push({ signal, release: open });
      return (async function* (): AsyncGenerator<WorkerRpcBackendEvent> {
        yield CONTENT;
        await Promise.race([gate, aborted(signal)]);
        if (signal.aborted) return;
        yield END;
      })();
    },
  };
  return backend;
}

function onlyHeldRun(): HeldRun {
  expect(heldRuns).toHaveLength(1);
  const run = heldRuns[0];
  if (run === undefined) throw new Error("backend never ran");
  return run;
}

type ServeOpts = Parameters<typeof startAgentServer>[0] & { residencyLeases?: boolean };

function workerRpcFor(backend: WorkerRpcBackend | undefined): NonNullable<ServeOpts["workerRpc"]> {
  return {
    workerId: WORKER,
    settings: () => ({ versions: [V1_0], serviceCredentials: [] }),
    drainTimeoutMs: 1_000,
    ...(backend !== undefined
      ? {
          backends: new Map<WorkerRpcBackendKind, WorkerRpcBackend>([["local-model", backend]]),
        }
      : {}),
  };
}

function startAgent(
  flag: boolean,
  opts: { backend?: WorkerRpcBackend; workerRpc?: boolean } = {},
): RunningAgent {
  const options: ServeOpts = {
    bindHost: "127.0.0.1",
    port: 0,
    tokenHash: generateToken().hash,
    advertiseMdns: false,
    ...(opts.workerRpc === false ? {} : { workerRpc: workerRpcFor(opts.backend) }),
    ...(flag ? { residencyLeases: true } : {}),
  };
  const agent = startAgentServer(options);
  agents.push(agent);
  return agent;
}

function submitInput(host: WorkerRpcHost, attemptId: string): SubmitInput {
  const listing = host.catalog(CLAIMS);
  if (listing.outcome !== "catalog") throw new Error("catalog rejected");
  const deployment = listing.deployments.find((d) => d.deploymentId === DEPLOYMENT);
  return {
    version: V1_0,
    envelope: envelope(attemptId),
    target: {
      deploymentId: DEPLOYMENT,
      expectedDeploymentEpoch: deployment?.deploymentEpoch ?? "",
      catalogGeneration: listing.catalogGeneration,
      workerIncarnation: listing.workerIncarnation,
    },
    cancelId: `cancel-${attemptId}`,
  };
}

function streamIterator(host: WorkerRpcHost, attemptId: string): AsyncIterator<StreamFrame> {
  return host.stream(CLAIMS, { attemptId }, new AbortController().signal)[Symbol.asyncIterator]();
}

async function nextFrame(it: AsyncIterator<StreamFrame>): Promise<StreamFrame> {
  const next = await it.next();
  if (next.done) throw new Error("stream ended before the expected frame");
  return next.value;
}

/** Pulls frames until the first content event: the attempt is then `emitting`. */
async function readUntilContent(it: AsyncIterator<StreamFrame>): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    const frame = await nextFrame(it);
    if (frame.frame === "event" && frame.event.type === "content") return;
  }
  throw new Error("stream ended before its first content event");
}

async function drainFrames(it: AsyncIterator<StreamFrame>): Promise<StreamFrame[]> {
  const frames: StreamFrame[] = [];
  for (;;) {
    const next = await it.next();
    if (next.done) return frames;
    frames.push(next.value);
  }
}

async function consumeToTerminal(host: WorkerRpcHost, attemptId: string): Promise<StreamFrame[]> {
  return await drainFrames(streamIterator(host, attemptId));
}

function terminalOutcomeOf(frames: readonly StreamFrame[]): string | undefined {
  const events = frames.flatMap((f) => (f.frame === "event" ? [f.event] : []));
  const last = events.at(-1);
  return last?.type === "terminal" ? last.terminal.outcome : undefined;
}

beforeAll(() => {
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];
  temp = makeTempRuntime();
  const tempEnv = envForTemp(temp);
  process.env["DEV_STORAGE"] = tempEnv["DEV_STORAGE"];
  process.env["LOCAL_AI_RUNTIME_DIR"] = tempEnv["LOCAL_AI_RUNTIME_DIR"];
  process.env["LLAMACTL_CONFIG"] = join(temp.devStorage, "llamactl-config.json");
  // #240: the flag is saved above and deleted here so no case inherits a
  // developer's live setting; afterAll restores it.
  Reflect.deleteProperty(process.env, "LLAMACTL_RESIDENCY_LEASES");
  engine = startFakeEngine();
  writeWorkload();
});

afterEach(async () => {
  for (const run of heldRuns.splice(0)) run.release();
  for (const agent of agents.splice(0)) await agent.stop();
  setResidencyLeaseRegistry(null);
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
    setResidencyLeaseRegistry(null);
  }
});

/** A tunnelDial whose nodeName getter throws inside maybeStartTunnelClient,
 * i.e. after the declared source and mDNS are already up. */
function throwingTunnelDial(): NonNullable<ServeOpts["tunnelDial"]> {
  return {
    url: "ws://127.0.0.1:9/tunnel",
    bearer: "x",
    get nodeName(): string {
      throw new Error("tunnel-boom");
    },
  };
}

function declaredIds(): string[] {
  return openaiProxy.listOpenAIModels().declared.map((entry) => entry.id);
}

describe("#278 DF-05: the residencyLeases opt-in publishes one registry at agent start", () => {
  test("(a) flag on, no workerRpc: published at start and restored to null on stop", async () => {
    const agent = startAgent(true, { workerRpc: false });
    expect(getResidencyLeaseRegistry()).not.toBeNull();
    await agent.stop();
    expect(getResidencyLeaseRegistry()).toBeNull();
  }, 15_000);

  test("(b) flag on, workerRpc: the host shares the one published registry", async () => {
    const agent = startAgent(true);
    const host = currentWorkerRpcHost();
    const reg = getResidencyLeaseRegistry();
    expect(reg).not.toBeNull();
    const listing = host.catalog(CLAIMS);
    expect(listing.outcome).toBe("catalog");
    if (listing.outcome !== "catalog") throw new Error("catalog rejected");
    expect(listing.deployments.map((d) => d.deploymentId)).toContain(DEPLOYMENT);
    expect(reg!.beginDrain(WORKLOAD).ok).toBe(true);
    const rejected = host.submit(CLAIMS, submitInput(host, "att-drain"));
    expect(rejected).toMatchObject({
      outcome: "rejected",
      rejection: { code: "target-unavailable" },
    });
    if (rejected.outcome !== "rejected") throw new Error("submit was not rejected");
    expect(rejected.rejection.message).toContain("Draining");

    // Control: a fresh agent publishes its own open registry, so the
    // identical submit is accepted and its lease releases at the terminal.
    await agents.splice(agents.indexOf(agent), 1)[0]?.stop();
    const agent2 = startAgent(true);
    const host2 = currentWorkerRpcHost();
    const reg2 = getResidencyLeaseRegistry();
    expect(reg2).not.toBeNull();
    const accepted = host2.submit(CLAIMS, submitInput(host2, "att-accept"));
    expect(accepted.outcome).toBe("accepted");
    expect(reg2!.active(WORKLOAD)).toHaveLength(1);
    const frames = await consumeToTerminal(host2, "att-accept");
    expect(terminalOutcomeOf(frames)).toBe("completed");
    expect(reg2!.active(WORKLOAD)).toEqual([]);
  }, 15_000);

  test("(n) pin: the --no-auth banner prints only when noAuth is on, never on an authenticated start", () => {
    const originalWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    const startCapturingStderr = (): void => {
      captured = "";
      process.stderr.write = (chunk: string | Uint8Array): boolean => {
        captured += chunk.toString();
        return true;
      };
    };
    let authedOut = "";
    let noAuthOut = "";
    let authed: RunningAgent | null = null;
    let noAuthed: RunningAgent | null = null;
    try {
      startCapturingStderr();
      authed = startAgentServer({
        bindHost: "127.0.0.1",
        port: 0,
        tokenHash: generateToken().hash,
        advertiseMdns: false,
      });
      authedOut = captured;
      startCapturingStderr();
      noAuthed = startAgentServer({
        bindHost: "127.0.0.1",
        port: 0,
        tokenHash: generateToken().hash,
        noAuth: true,
        advertiseMdns: false,
      });
      noAuthOut = captured;
    } finally {
      process.stderr.write = originalWrite;
      if (authed !== null) agents.push(authed);
      if (noAuthed !== null) agents.push(noAuthed);
    }
    expect(authedOut).not.toContain("--no-auth");
    expect(noAuthOut).toContain("--no-auth flag enabled");
    expect(noAuthOut).toContain("Serving plain HTTP (no TLS).");
  }, 15_000);

  test("(c) flag on, workerRpc: stop() keeps the registry published through the drain", async () => {
    const agent = startAgent(true, { backend: controllableBackend() });
    const host = currentWorkerRpcHost();
    const submitted = host.submit(CLAIMS, submitInput(host, "att-hold"));
    expect(submitted.outcome).toBe("accepted");
    const it = streamIterator(host, "att-hold");
    await readUntilContent(it);
    const consuming = drainFrames(it);

    const reg = getResidencyLeaseRegistry();
    expect(reg).not.toBeNull();
    expect(reg!.active(WORKLOAD)).toHaveLength(1);

    agents.splice(agents.indexOf(agent), 1);
    const stopping = agent.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getResidencyLeaseRegistry()).toBe(reg);

    onlyHeldRun().release();
    const frames = await consuming;
    expect(terminalOutcomeOf(frames)).toBe("completed");
    await stopping;

    expect(reg!.active(WORKLOAD)).toEqual([]);
    expect(reg!.snapshot(WORKLOAD).active).toEqual([]);
    expect(getResidencyLeaseRegistry()).toBeNull();
  }, 15_000);

  test("(e) pin: no flag leaves the seam null and the host takes no lease", async () => {
    const agent = startAgent(false);
    expect(getResidencyLeaseRegistry()).toBeNull();
    const host = currentWorkerRpcHost();
    const submitted = host.submit(CLAIMS, submitInput(host, "att-plain"));
    expect(submitted.outcome).toBe("accepted");
    const frames = await consumeToTerminal(host, "att-plain");
    expect(terminalOutcomeOf(frames)).toBe("completed");
    await agents.splice(agents.indexOf(agent), 1)[0]?.stop();
    expect(getResidencyLeaseRegistry()).toBeNull();
  }, 15_000);

  test("(f) pin: a sentinel registry installed before start is left alone", async () => {
    const sentinel = createResidencyLeases();
    setResidencyLeaseRegistry(sentinel);
    expect(sentinel.beginDrain(WORKLOAD).ok).toBe(true);
    const agent = startAgent(false);
    expect(getResidencyLeaseRegistry()).toBe(sentinel);
    const host = currentWorkerRpcHost();
    const submitted = host.submit(CLAIMS, submitInput(host, "att-sentinel"));
    expect(submitted.outcome).toBe("accepted");
    const frames = await consumeToTerminal(host, "att-sentinel");
    expect(terminalOutcomeOf(frames)).toBe("completed");
    expect(sentinel.active(WORKLOAD)).toEqual([]);
    await agents.splice(agents.indexOf(agent), 1)[0]?.stop();
    expect(getResidencyLeaseRegistry()).toBe(sentinel);
  }, 15_000);

  test("(h) flag on, missing cert: the throw leaves the seam untouched", () => {
    expect(getResidencyLeaseRegistry()).toBeNull();
    const options: ServeOpts = {
      bindHost: "127.0.0.1",
      port: 0,
      tokenHash: generateToken().hash,
      advertiseMdns: false,
      tls: {
        certPath: join(temp.runtimeDir, "missing-agent.crt"),
        keyPath: join(temp.runtimeDir, "missing-agent.key"),
      },
      residencyLeases: true,
    };
    expect(() => startAgentServer(options)).toThrow("cert not found");
    expect(getResidencyLeaseRegistry()).toBeNull();
  }, 15_000);

  test("(i) pin: stop() restores the seam's previous registry, not null", async () => {
    const sentinel = createResidencyLeases();
    setResidencyLeaseRegistry(sentinel);
    const agent = startAgent(true, { workerRpc: false });
    const published = getResidencyLeaseRegistry();
    expect(published).not.toBeNull();
    expect(published).not.toBe(sentinel);
    await agents.splice(agents.indexOf(agent), 1)[0]?.stop();
    expect(getResidencyLeaseRegistry()).toBe(sentinel);
  }, 15_000);

  test("(j) flag on, workerRpc, missing cert: the throw unpublishes the host and leaves a null seam", () => {
    const before = currentWorkerRpcHost();
    expect(getResidencyLeaseRegistry()).toBeNull();
    const options: ServeOpts = {
      bindHost: "127.0.0.1",
      port: 0,
      tokenHash: generateToken().hash,
      advertiseMdns: false,
      tls: {
        certPath: join(temp.runtimeDir, "missing-agent.crt"),
        keyPath: join(temp.runtimeDir, "missing-agent.key"),
      },
      workerRpc: workerRpcFor(undefined),
      residencyLeases: true,
    };
    try {
      expect(() => startAgentServer(options)).toThrow("cert not found");
      expect(currentWorkerRpcHost()).toBe(before);
      expect(getResidencyLeaseRegistry()).toBeNull();
    } finally {
      // At base the orphan host stays published; put the previous one
      // back so a failed assertion cannot bleed into later cases.
      publishWorkerRpcHost(before);
    }
  }, 15_000);

  test("(k) flag on, workerRpc, post-bind tunnel throw: host unpublished, seam restored, listener stopped", async () => {
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = probe.port ?? 0;
    await probe.stop(true);
    const sentinel = createResidencyLeases();
    setResidencyLeaseRegistry(sentinel);
    const before = currentWorkerRpcHost();
    const options: ServeOpts = {
      bindHost: "127.0.0.1",
      port,
      tokenHash: generateToken().hash,
      advertiseMdns: false,
      workerRpc: workerRpcFor(undefined),
      residencyLeases: true,
      tunnelDial: {
        url: "ws://127.0.0.1:9/tunnel",
        bearer: "x",
        get nodeName(): string {
          throw new Error("tunnel-boom");
        },
      },
    };
    try {
      expect(() => startAgentServer(options)).toThrow("tunnel-boom");
      expect(currentWorkerRpcHost()).toBe(before);
      expect(getResidencyLeaseRegistry()).toBe(sentinel);
      const res = await fetch(`http://127.0.0.1:${String(port)}/healthz`, {
        signal: AbortSignal.timeout(1000),
      }).catch(() => null);
      const answeredByAgent = res !== null && res.status === 200 && (await res.text()) === "ok";
      expect(answeredByAgent).toBe(false);
    } finally {
      publishWorkerRpcHost(before);
    }
  }, 15_000);

  test("(o) declaredModels, post-bind tunnel throw: the declared source is unregistered", () => {
    const workloadsDir = join(temp.runtimeDir, "declared-workloads-o");
    mkdirSync(workloadsDir, { recursive: true });
    writeFileSync(
      join(workloadsDir, "run-cold.yaml"),
      stringifyYaml(
        ModelRunSchema.parse({
          apiVersion: "llamactl/v1",
          kind: "ModelRun",
          metadata: { name: "run-cold" },
          spec: { node: "local", target: { kind: "rel", value: COLD_PIN } },
        }),
      ),
    );
    const prevWorkloadsDir = process.env["LLAMACTL_WORKLOADS_DIR"];
    process.env["LLAMACTL_WORKLOADS_DIR"] = workloadsDir;
    const before = currentWorkerRpcHost();
    const options: ServeOpts = {
      bindHost: "127.0.0.1",
      port: 0,
      tokenHash: generateToken().hash,
      advertiseMdns: false,
      declaredModels: true,
      tunnelDial: throwingTunnelDial(),
    };
    try {
      // Sanity: the manifest projects to a declared cold entry while the
      // source is registered, so an empty listing below means "unregistered",
      // not "nothing to declare".
      openaiProxy.setDeclaredModelSource(() =>
        listDeclaredModels({ nodeName: "local", liveModelIds: new Set<string>() }),
      );
      expect(declaredIds()).toContain(COLD_PIN);
      openaiProxy.setDeclaredModelSource(null);
      expect(() => startAgentServer(options)).toThrow("tunnel-boom");
      expect(declaredIds()).not.toContain(COLD_PIN);
      expect(openaiProxy.listOpenAIModels().declared).toEqual([]);
    } finally {
      openaiProxy.setDeclaredModelSource(null);
      openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
      if (prevWorkloadsDir === undefined)
        Reflect.deleteProperty(process.env, "LLAMACTL_WORKLOADS_DIR");
      else process.env["LLAMACTL_WORKLOADS_DIR"] = prevWorkloadsDir;
      publishWorkerRpcHost(before);
    }
  }, 15_000);

  test("(p) advertiseMdns, post-bind tunnel throw: the published mDNS service is stopped", () => {
    const stop = mock(() => Promise.resolve());
    const publish = spyOn(mdnsModule, "publishAgentMdns").mockImplementation(() => ({
      host: "agent-llamactl",
      stop,
    }));
    const prevDisable = process.env["LLAMACTL_DISABLE_MDNS"];
    Reflect.deleteProperty(process.env, "LLAMACTL_DISABLE_MDNS");
    const before = currentWorkerRpcHost();
    const options: ServeOpts = {
      bindHost: "127.0.0.1",
      port: 0,
      tokenHash: generateToken().hash,
      advertiseMdns: true,
      tunnelDial: throwingTunnelDial(),
    };
    try {
      expect(() => startAgentServer(options)).toThrow("tunnel-boom");
      expect(publish).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      publish.mockRestore();
      if (prevDisable !== undefined) process.env["LLAMACTL_DISABLE_MDNS"] = prevDisable;
      publishWorkerRpcHost(before);
    }
  }, 15_000);

  test("(l) pin: no opt-in, missing cert: the throw touches neither seam nor host", () => {
    const sentinel = createResidencyLeases();
    setResidencyLeaseRegistry(sentinel);
    const before = currentWorkerRpcHost();
    const options: ServeOpts = {
      bindHost: "127.0.0.1",
      port: 0,
      tokenHash: generateToken().hash,
      advertiseMdns: false,
      tls: {
        certPath: join(temp.runtimeDir, "missing-agent.crt"),
        keyPath: join(temp.runtimeDir, "missing-agent.key"),
      },
    };
    try {
      expect(() => startAgentServer(options)).toThrow("cert not found");
      expect(getResidencyLeaseRegistry()).toBe(sentinel);
      expect(currentWorkerRpcHost()).toBe(before);
    } finally {
      publishWorkerRpcHost(before);
    }
  }, 15_000);

  test("(m) pin: default start stays synchronous and stop() keeps its shape", async () => {
    const agent = startAgentServer({
      bindHost: "127.0.0.1",
      port: 0,
      tokenHash: generateToken().hash,
      advertiseMdns: false,
    });
    agents.push(agent);
    expect(agent instanceof Promise).toBe(false);
    expect(typeof agent.port).toBe("number");
    expect(getResidencyLeaseRegistry()).toBeNull();
    agents.splice(agents.indexOf(agent), 1);
    await agent.stop();
    expect(getResidencyLeaseRegistry()).toBeNull();
  }, 15_000);
});
