/**
 * #278 (DF-05) — opt-in residency leases on Worker RPC submit, released in
 * settle(). `WorkerRpcHostOptions.residencyLeases` lands with the fix, so
 * the option rides a conditional spread that bypasses excess-property
 * checks, and every RED case fails by assertion — never by a type or
 * import error. The host is driven in-process: no agent server, no TLS,
 * no real network. The
 * injected `local-model` backend records the attempt's AbortSignal,
 * yields one content event, then holds until the test releases it or the
 * signal aborts.
 */
import type { ResolvedEnv } from "@llamactl/core/types";
import type { ExecutionEventV1 } from "@novaproto/contracts";

import { inferenceContracts, inferenceRpc, routingCatalog } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import {
  type AcquireResult,
  createResidencyLeases,
  type ResidencyLeases,
} from "@llamactl/core/residency/leases";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { envForTemp, makeTempRuntime } from "../../core/test/helpers.js";
import {
  createWorkerRpcHost,
  type WorkerRpcBackend,
  type WorkerRpcBackendEvent,
  type WorkerRpcHost,
  type WorkerRpcHostOptions,
} from "../src/inference/procedures.js";

type Claims = inferenceRpc.InferenceServiceClaimsV1;
type Ad = routingCatalog.RouteAdvertisementV1;
type Envelope = inferenceContracts.InferenceEnvelopeV1;
type StreamFrame = inferenceRpc.InferenceRpcStreamFrameV1;
type SubmitResult = inferenceRpc.InferenceRpcSubmitResultV1;
type StatusResult = inferenceRpc.InferenceRpcStatusResultV1;

const WORKER = "worker-a";
const TENANT = "tenant-a";
const SCOPE = "scope-a";
const LOCAL = "deploy/worker-a/local";
const WORKLOAD = "local";
const UNSHAPED = "custom/no-workload-shape";
const UPSTREAM = "upstream-model";
const V1_0 = { major: 1, minor: 0 };
const ALL_OPERATIONS = [...inferenceRpc.InferenceRpcOperationSchema.options];
const ENV_KEYS = ["DEV_STORAGE", "LOCAL_AI_RUNTIME_DIR", "LLAMACTL_CONFIG"] as const;

let temp: ReturnType<typeof makeTempRuntime>;
let resolved: ResolvedEnv;
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
    endpoint: "http://127.0.0.1:9/v1",
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
    modelRevision: routingCatalog.knownRevision("rev-1"),
    deploymentEpoch: routingCatalog.knownRevision("epoch-1"),
    adapterRevision: routingCatalog.UNKNOWN_REVISION,
    policyRevision: routingCatalog.UNKNOWN_REVISION,
    weight: 1,
    draining: false,
    ...overrides,
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
): Envelope {
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
    nativeBody: {
      model: `public/${LOCAL}`,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    },
    headerFingerprint: { allowlist: ["content-type"], fingerprint: "test" },
    ...overrides,
  });
}

const CLAIMS = claims();

// ---- the injected backend ---------------------------------------------------

interface RecordedRun {
  signal: AbortSignal;
  /** Resolves the hold gate: the backend then yields its `end` event. */
  release: () => void;
}

const CONTENT: WorkerRpcBackendEvent = {
  type: "content",
  payload: {
    type: "chunk",
    chunk: {
      id: "chatcmpl-lease-1",
      object: "chat.completion.chunk",
      model: UPSTREAM,
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
 * A backend that records each attempt's signal, yields one content event,
 * then waits on the test-held release or the signal abort. `fail` throws
 * instead of waiting, after the content event.
 */
function controllableBackend(opts: { fail?: boolean } = {}): {
  backend: WorkerRpcBackend;
  runs: RecordedRun[];
} {
  const runs: RecordedRun[] = [];
  const backend: WorkerRpcBackend = {
    execute: (_deployment, _envelope, signal) => {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      runs.push({ signal, release: open });
      return (async function* (): AsyncGenerator<WorkerRpcBackendEvent> {
        yield CONTENT;
        if (opts.fail === true) throw new Error("backend failure");
        await Promise.race([gate, aborted(signal)]);
        if (signal.aborted) return;
        yield END;
      })();
    },
  };
  return { backend, runs };
}

function onlyRun(runs: readonly RecordedRun[]): RecordedRun {
  expect(runs).toHaveLength(1);
  const run = runs[0];
  if (run === undefined) throw new Error("backend never ran");
  return run;
}

// ---- the lease registry spy -------------------------------------------------

interface LeaseSpy {
  registry: ResidencyLeases;
  acquireCalls: string[];
  releaseCalls: number;
  addedAbortListeners: unknown[];
  removedAbortListeners: unknown[];
}

function spySignal(signal: AbortSignal, spy: LeaseSpy): void {
  const methods = signal as unknown as {
    addEventListener: (type: string, listener: unknown, options?: unknown) => void;
    removeEventListener: (type: string, listener: unknown, options?: unknown) => void;
  };
  const add = methods.addEventListener;
  const remove = methods.removeEventListener;
  methods.addEventListener = (type: string, listener: unknown, options?: unknown): void => {
    if (type === "abort" && listener !== null && listener !== undefined) {
      spy.addedAbortListeners.push(listener);
    }
    add.call(signal, type, listener, options);
  };
  methods.removeEventListener = (type: string, listener: unknown, options?: unknown): void => {
    if (type === "abort" && listener !== null && listener !== undefined) {
      spy.removedAbortListeners.push(listener);
    }
    remove.call(signal, type, listener, options);
  };
}

/** A real registry whose acquire wraps each lease: counted release, spied signal. */
function spyLeases(): LeaseSpy {
  const real = createResidencyLeases();
  const spy: LeaseSpy = {
    registry: real,
    acquireCalls: [],
    releaseCalls: 0,
    addedAbortListeners: [],
    removedAbortListeners: [],
  };
  const innerAcquire = real.acquire;
  real.acquire = (workload: string): AcquireResult => {
    spy.acquireCalls.push(workload);
    const result = innerAcquire(workload);
    if (!result.ok) return result;
    const lease = result.lease;
    spySignal(lease.signal, spy);
    return {
      ok: true,
      lease: {
        ...lease,
        release: (): boolean => {
          spy.releaseCalls += 1;
          return lease.release();
        },
      },
    };
  };
  return spy;
}

// ---- host + RPC driving -----------------------------------------------------

interface HostOpts {
  backend: WorkerRpcBackend;
  advertisements?: Ad[];
  leases?: ResidencyLeases;
  maxActiveAttempts?: number;
  streamAttachTimeoutMs?: number;
}

function hostWith(opts: HostOpts): WorkerRpcHost {
  const ads = opts.advertisements ?? [ad(LOCAL)];
  const backends: WorkerRpcHostOptions["backends"] = new Map([["local-model", opts.backend]]);
  host = createWorkerRpcHost({
    workerId: WORKER,
    versions: [V1_0],
    resolved: () => resolved,
    advertisements: () => ads,
    backends,
    ...(opts.leases !== undefined ? { residencyLeases: opts.leases } : {}),
    ...(opts.maxActiveAttempts !== undefined ? { maxActiveAttempts: opts.maxActiveAttempts } : {}),
    ...(opts.streamAttachTimeoutMs !== undefined
      ? { streamAttachTimeoutMs: opts.streamAttachTimeoutMs }
      : {}),
  });
  return host;
}

function fencedTarget(
  h: WorkerRpcHost,
  claimsIn: Claims,
  deploymentId: string,
): inferenceRpc.InferenceRpcTargetV1 {
  const listing = h.catalog(claimsIn);
  if (listing.outcome !== "catalog") throw new Error("catalog rejected");
  const epoch = listing.deployments.find((d) => d.deploymentId === deploymentId)?.deploymentEpoch;
  return {
    deploymentId,
    expectedDeploymentEpoch: epoch ?? "epoch-1",
    catalogGeneration: listing.catalogGeneration,
    workerIncarnation: listing.workerIncarnation,
  };
}

function submitTo(
  h: WorkerRpcHost,
  attemptId: string,
  opts: {
    claims?: Claims;
    deploymentId?: string;
    envelope?: Envelope;
    deadline?: number;
  } = {},
): SubmitResult {
  const claimsIn = opts.claims ?? CLAIMS;
  return h.submit(claimsIn, {
    version: V1_0,
    envelope: opts.envelope ?? envelope(attemptId, {}, opts.deadline),
    target: fencedTarget(h, claimsIn, opts.deploymentId ?? LOCAL),
    cancelId: `cancel-${attemptId}`,
  });
}

function streamIterator(
  h: WorkerRpcHost,
  attemptId: string,
  opts: { claims?: Claims; signal?: AbortSignal } = {},
): AsyncIterator<StreamFrame> {
  return h
    .stream(opts.claims ?? CLAIMS, { attemptId }, opts.signal ?? new AbortController().signal)
    [Symbol.asyncIterator]();
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

async function startStreaming(
  h: WorkerRpcHost,
  attemptId: string,
  opts: { claims?: Claims; signal?: AbortSignal } = {},
): Promise<AsyncIterator<StreamFrame>> {
  const it = streamIterator(h, attemptId, opts);
  await readUntilContent(it);
  return it;
}

async function collectFrames(
  it: AsyncIterator<StreamFrame>,
  boundMs = 5_000,
): Promise<StreamFrame[]> {
  const frames: StreamFrame[] = [];
  const draining = (async (): Promise<StreamFrame[]> => {
    for (;;) {
      const next = await it.next();
      if (next.done) return frames;
      frames.push(next.value);
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("stream did not reach its terminal"));
    }, boundMs);
  });
  try {
    return await Promise.race([draining, bound]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function eventsOf(frames: readonly StreamFrame[]): ExecutionEventV1[] {
  return frames.flatMap((f) => (f.frame === "event" ? [f.event] : []));
}

function terminalOutcomeOf(frames: readonly StreamFrame[]): string | undefined {
  const last = eventsOf(frames).at(-1);
  return last?.type === "terminal" ? last.terminal.outcome : undefined;
}

type TerminalStatus = Extract<StatusResult, { outcome: "status" }>;

/** Polls status until the attempt settles; bounded so a missing settle fails, not hangs. */
async function waitForTerminal(
  h: WorkerRpcHost,
  attemptId: string,
  opts: { claims?: Claims; boundMs?: number } = {},
): Promise<TerminalStatus> {
  const claimsIn = opts.claims ?? CLAIMS;
  const until = Date.now() + (opts.boundMs ?? 3_000);
  for (;;) {
    const status = h.status(claimsIn, { attemptId });
    if (status.outcome === "status" && status.state === "terminal") return status;
    if (Date.now() >= until) throw new Error(`attempt '${attemptId}' never settled`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function expectLeaseReleasedOnce(spy: LeaseSpy): void {
  expect(spy.releaseCalls).toBe(1);
  expect(spy.registry.active(WORKLOAD)).toEqual([]);
  expect(spy.addedAbortListeners).toHaveLength(1);
  expect(spy.removedAbortListeners).toContain(spy.addedAbortListeners[0]);
}

// ---- lifecycle ----------------------------------------------------------------

beforeAll(() => {
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];
  temp = makeTempRuntime();
  const tempEnv = envForTemp(temp);
  process.env["DEV_STORAGE"] = tempEnv["DEV_STORAGE"];
  process.env["LOCAL_AI_RUNTIME_DIR"] = tempEnv["LOCAL_AI_RUNTIME_DIR"];
  process.env["LLAMACTL_CONFIG"] = join(temp.devStorage, "llamactl-config.json");
  resolved = resolveEnv({ ...tempEnv, LLAMA_CPP_HOST: "127.0.0.1", LLAMA_CPP_PORT: "1" });
});

afterEach(async () => {
  const h = host;
  host = undefined;
  h?.close();
  if (h !== undefined) {
    await Promise.race([h.drain(), new Promise((resolve) => setTimeout(resolve, 500))]);
  }
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
  }
});

// ---- cases ---------------------------------------------------------------------

describe("worker RPC residency leases (#278)", () => {
  test("inert by default: an unconnected draining registry changes nothing", async () => {
    const registry = createResidencyLeases();
    const { backend, runs } = controllableBackend();
    const h = hostWith({ backend });
    expect(registry.beginDrain(WORKLOAD).ok).toBe(true);
    const result = submitTo(h, "att-inert");
    expect(result.outcome).toBe("accepted");
    const it = await startStreaming(h, "att-inert");
    onlyRun(runs).release();
    const frames = await collectFrames(it);
    expect(terminalOutcomeOf(frames)).toBe("completed");
  });

  test("a deployment id with no workload shape is accepted and holds no lease", async () => {
    const spy = spyLeases();
    const { backend, runs } = controllableBackend();
    const h = hostWith({
      backend,
      leases: spy.registry,
      advertisements: [ad(LOCAL), ad(UNSHAPED)],
    });
    const owner = claims({ deployments: [UNSHAPED] });
    const result = submitTo(h, "att-unshaped", {
      claims: owner,
      deploymentId: UNSHAPED,
      envelope: envelope("att-unshaped", { publicModelId: `public/${UNSHAPED}` }),
    });
    expect(result.outcome).toBe("accepted");
    expect(spy.acquireCalls).toEqual([]);
    expect(spy.registry.active(WORKLOAD)).toEqual([]);
    expect(spy.registry.snapshot(WORKLOAD).active).toEqual([]);
    const it = await startStreaming(h, "att-unshaped", { claims: owner });
    onlyRun(runs).release();
    const frames = await collectFrames(it);
    expect(terminalOutcomeOf(frames)).toBe("completed");
    expect(spy.releaseCalls).toBe(0);
  });

  test("an accepted submit holds one lease until its stream completes", async () => {
    const registry = createResidencyLeases();
    const { backend, runs } = controllableBackend();
    const h = hostWith({ backend, leases: registry });
    const result = submitTo(h, "att-lease");
    expect(result.outcome).toBe("accepted");
    expect(registry.active(WORKLOAD)).toHaveLength(1);
    const it = await startStreaming(h, "att-lease");
    onlyRun(runs).release();
    const frames = await collectFrames(it);
    expect(terminalOutcomeOf(frames)).toBe("completed");
    expect(registry.active(WORKLOAD)).toEqual([]);
  });

  test("a draining or unloaded workload refuses submit as target-unavailable", () => {
    const registry = createResidencyLeases();
    const { backend } = controllableBackend();
    const h = hostWith({ backend, leases: registry });
    const drain = registry.beginDrain(WORKLOAD);
    if (!drain.ok) throw new Error("beginDrain refused");
    const refused = submitTo(h, "att-drain");
    expect(refused).toMatchObject({
      outcome: "rejected",
      rejection: { code: "target-unavailable", message: "residency Draining" },
    });
    expect(h.status(CLAIMS, { attemptId: "att-drain" })).toMatchObject({
      outcome: "status",
      state: "unknown",
    });
    expect(registry.active(WORKLOAD)).toEqual([]);
    const commit = registry.commitUnload(drain.token);
    if (!commit.ok) throw new Error("commitUnload refused");
    const unloaded = submitTo(h, "att-unloaded");
    expect(unloaded).toMatchObject({
      outcome: "rejected",
      rejection: { code: "target-unavailable", message: "residency Unloaded" },
    });
    expect(h.status(CLAIMS, { attemptId: "att-unloaded" })).toMatchObject({
      outcome: "status",
      state: "unknown",
    });
  });

  test("a duplicate submit returns existing and holds no second lease", () => {
    const registry = createResidencyLeases();
    const { backend } = controllableBackend();
    const h = hostWith({ backend, leases: registry });
    const input = {
      version: V1_0,
      envelope: envelope("att-dup"),
      target: fencedTarget(h, CLAIMS, LOCAL),
      cancelId: "cancel-att-dup",
    };
    expect(h.submit(CLAIMS, input).outcome).toBe("accepted");
    expect(registry.active(WORKLOAD)).toHaveLength(1);
    const again = h.submit(CLAIMS, input);
    expect(again.outcome).toBe("existing");
    expect(registry.active(WORKLOAD)).toHaveLength(1);
  });

  test("a forced unload revokes the lease and cancels the attempt", async () => {
    const registry = createResidencyLeases();
    const { backend, runs } = controllableBackend();
    const h = hostWith({ backend, leases: registry });
    expect(submitTo(h, "att-revoke").outcome).toBe("accepted");
    const it = await startStreaming(h, "att-revoke");
    expect(h.status(CLAIMS, { attemptId: "att-revoke" })).toMatchObject({
      outcome: "status",
      state: "emitting",
    });
    const drain = registry.beginDrain(WORKLOAD);
    if (!drain.ok) throw new Error("beginDrain refused");
    const commit = registry.commitUnload(drain.token, { force: true, reason: "test" });
    if (!commit.ok) throw new Error("commitUnload refused");
    expect(commit.revoked).toHaveLength(1);
    expect(h.status(CLAIMS, { attemptId: "att-revoke" })).toMatchObject({
      outcome: "status",
      state: "terminal",
      terminal: { outcome: "cancelled" },
    });
    const run = onlyRun(runs);
    expect(run.signal.aborted).toBe(true);
    expect(run.signal.reason).toBe("revoked");
    const rest = await collectFrames(it);
    const events = eventsOf(rest);
    expect(events.at(-1)?.type).toBe("terminal");
    expect(terminalOutcomeOf(rest)).toBe("cancelled");
    expect(registry.audit()).toHaveLength(1);
    expect(registry.audit()[0]).toMatchObject({
      workload: WORKLOAD,
      forced: true,
      reason: "test",
    });
  });

  describe("the lease is released exactly once on every terminal path", () => {
    test("normal completion", async () => {
      const spy = spyLeases();
      const { backend, runs } = controllableBackend();
      const h = hostWith({ backend, leases: spy.registry });
      expect(submitTo(h, "att-f-done").outcome).toBe("accepted");
      const it = await startStreaming(h, "att-f-done");
      onlyRun(runs).release();
      const frames = await collectFrames(it);
      expect(terminalOutcomeOf(frames)).toBe("completed");
      expectLeaseReleasedOnce(spy);
    });

    test("host.cancel by attemptId", async () => {
      const spy = spyLeases();
      const { backend, runs } = controllableBackend();
      const h = hostWith({ backend, leases: spy.registry });
      expect(submitTo(h, "att-f-cancel").outcome).toBe("accepted");
      const it = await startStreaming(h, "att-f-cancel");
      expect(onlyRun(runs).signal.aborted).toBe(false);
      expect(h.cancel(CLAIMS, { attemptId: "att-f-cancel" }).outcome).toBe("cancelled");
      const frames = await collectFrames(it);
      expect(terminalOutcomeOf(frames)).toBe("cancelled");
      expectLeaseReleasedOnce(spy);
    });

    test("client disconnect", async () => {
      const spy = spyLeases();
      const { backend, runs } = controllableBackend();
      const h = hostWith({ backend, leases: spy.registry });
      expect(submitTo(h, "att-f-disconnect").outcome).toBe("accepted");
      const client = new AbortController();
      const it = await startStreaming(h, "att-f-disconnect", { signal: client.signal });
      client.abort();
      const frames = await collectFrames(it);
      expect(terminalOutcomeOf(frames)).toBe("cancelled");
      expect(onlyRun(runs).signal.aborted).toBe(true);
      expectLeaseReleasedOnce(spy);
    });

    test("attach-timeout", async () => {
      const spy = spyLeases();
      const { backend, runs } = controllableBackend();
      const h = hostWith({
        backend,
        leases: spy.registry,
        streamAttachTimeoutMs: 20,
      });
      expect(submitTo(h, "att-f-attach").outcome).toBe("accepted");
      const status = await waitForTerminal(h, "att-f-attach");
      expect(status.terminal?.outcome).toBe("cancelled");
      expect(runs).toHaveLength(0);
      expectLeaseReleasedOnce(spy);
    });

    test("deadline", async () => {
      const spy = spyLeases();
      const { backend, runs } = controllableBackend();
      const h = hostWith({ backend, leases: spy.registry });
      const deadline = Date.now() + 80;
      expect(submitTo(h, "att-f-deadline", { deadline }).outcome).toBe("accepted");
      const it = await startStreaming(h, "att-f-deadline");
      const frames = await collectFrames(it);
      expect(terminalOutcomeOf(frames)).toBe("failed");
      expect(onlyRun(runs).signal.aborted).toBe(true);
      expectLeaseReleasedOnce(spy);
    });

    test("host.close()", async () => {
      const spy = spyLeases();
      const { backend, runs } = controllableBackend();
      const h = hostWith({ backend, leases: spy.registry });
      expect(submitTo(h, "att-f-close").outcome).toBe("accepted");
      const it = await startStreaming(h, "att-f-close");
      h.close();
      const frames = await collectFrames(it);
      expect(terminalOutcomeOf(frames)).toBe("cancelled");
      expect(onlyRun(runs).signal.aborted).toBe(true);
      expectLeaseReleasedOnce(spy);
    });

    test("a backend that throws", async () => {
      const spy = spyLeases();
      const { backend, runs } = controllableBackend({ fail: true });
      const h = hostWith({ backend, leases: spy.registry });
      expect(submitTo(h, "att-f-throw").outcome).toBe("accepted");
      const it = await startStreaming(h, "att-f-throw");
      const frames = await collectFrames(it);
      expect(terminalOutcomeOf(frames)).toBe("failed");
      expectLeaseReleasedOnce(spy);
    });

    test("forced revoke", async () => {
      const spy = spyLeases();
      const { backend, runs } = controllableBackend();
      const h = hostWith({ backend, leases: spy.registry });
      expect(submitTo(h, "att-f-revoke").outcome).toBe("accepted");
      const it = await startStreaming(h, "att-f-revoke");
      const drain = spy.registry.beginDrain(WORKLOAD);
      if (!drain.ok) throw new Error("beginDrain refused");
      const commit = spy.registry.commitUnload(drain.token, {
        force: true,
        reason: "test",
      });
      if (!commit.ok) throw new Error("commitUnload refused");
      expect(commit.revoked).toHaveLength(1);
      const frames = await collectFrames(it);
      expect(terminalOutcomeOf(frames)).toBe("cancelled");
      expect(onlyRun(runs).signal.aborted).toBe(true);
      expectLeaseReleasedOnce(spy);
    });

    test("a capacity refusal acquires nothing", () => {
      const spy = spyLeases();
      const { backend } = controllableBackend();
      const h = hostWith({ backend, leases: spy.registry, maxActiveAttempts: 1 });
      expect(submitTo(h, "att-f-cap-1").outcome).toBe("accepted");
      expect(spy.registry.active(WORKLOAD)).toHaveLength(1);
      const refused = submitTo(h, "att-f-cap-2");
      expect(refused).toMatchObject({ outcome: "rejected", rejection: { code: "overloaded" } });
      expect(spy.registry.active(WORKLOAD)).toHaveLength(1);
      expect(spy.acquireCalls).toEqual([WORKLOAD]);
      expect(h.cancel(CLAIMS, { attemptId: "att-f-cap-1" }).outcome).toBe("cancelled");
      expect(spy.releaseCalls).toBe(1);
      expect(spy.registry.active(WORKLOAD)).toEqual([]);
    });
  });
});
