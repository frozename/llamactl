/**
 * Part of #281 (DF-08): Worker RPC slice; create-proxy.ts ingress is a later slice.
 *
 * The host-level cases pin the shared request-admission cap on Worker RPC
 * inference: an accepted attempt counts against the same RequestAdmission
 * the chat-completions ingress holds, the 'accepted' event is emitted
 * before the queue wait resolves, a queued attempt survives until a slot
 * frees, the slot is released exactly once on every terminal path, a
 * queued cancel leaves no orphan, an immediate overload refusal is a
 * first-frame typed rejection, a queue-wait expiry after 'accepted' is a
 * failed terminal (never a late 'rejected' frame — the protocol cannot
 * reject after it accepted), and the embedded unified-proxy client is
 * not counted a second time. `WorkerRpcHostOptions.admission` lands with
 * the fix, so it rides a conditional spread on a widened options type
 * and every RED case fails by assertion — never by a type or import
 * error. The host is driven in-process: no agent server, no TLS, no real
 * network. The injected `local-model` backend records each attempt and
 * holds until the test releases it or the signal aborts.
 */
import type { ResolvedEnv } from "@llamactl/core/types";
import type { ExecutionEventV1 } from "@novaproto/contracts";
import type { ReadableStreamDefaultReader as WebStreamReader } from "node:stream/web";

import { inferenceContracts, inferenceRpc, routingCatalog } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { modelKeyOf, type RequestQueueLimits } from "@llamactl/core/residency/queue-policy";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { envForTemp, makeTempRuntime } from "../../../core/test/helpers.js";
import { createEmbeddedInferenceRpcClient } from "../../src/inference/client.js";
import {
  createWorkerRpcHost,
  publishWorkerRpcHost,
  type WorkerRpcBackend,
  type WorkerRpcBackendEvent,
  type WorkerRpcHost,
  type WorkerRpcHostOptions,
} from "../../src/inference/procedures.js";
import {
  createRequestAdmission,
  type RequestAdmission,
} from "../../src/residency/request-admission.js";
import {
  admitChatCompletions,
  CHAT_INGRESS_MODEL,
  createChatCompletionsAdmission,
} from "../../src/server/chat-admission.js";

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
const UPSTREAM = "upstream-model";
const V1_0 = { major: 1, minor: 0 };
const ALL_OPERATIONS = [...inferenceRpc.InferenceRpcOperationSchema.options];
const ENV_KEYS = ["DEV_STORAGE", "LOCAL_AI_RUNTIME_DIR", "LLAMACTL_CONFIG"] as const;

let temp: ReturnType<typeof makeTempRuntime>;
let resolved: ResolvedEnv;
const hosts: WorkerRpcHost[] = [];
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
      id: "chatcmpl-adm-1",
      object: "chat.completion.chunk",
      model: UPSTREAM,
      created: 1_700_000_000,
      choices: [{ index: 0, delta: { content: "adm" } }],
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

// ---- the shared admission ---------------------------------------------------

/**
 * Wraps a RequestAdmission so every acquire() call and every release()
 * invocation of a granted closure is recorded by requestId. The
 * 'worker-rpc:' prefix is what the host's admission requests carry, so
 * rpcAcquires()/rpcReleases() count only Worker RPC traffic — the
 * 'http-hold' request the tests inject is filtered out.
 */
interface CountedAdmission extends RequestAdmission {
  acquired: string[];
  released: string[];
  rpcAcquires(): string[];
  rpcReleases(): string[];
}

function countedAdmission(inner: RequestAdmission): CountedAdmission {
  const acquired: string[] = [];
  const released: string[] = [];
  return {
    acquired,
    released,
    acquire: async (request, options) => {
      acquired.push(request.requestId);
      const release = await inner.acquire(request, options);
      return () => {
        released.push(request.requestId);
        release();
      };
    },
    snapshot: () => inner.snapshot(),
    rpcAcquires: () => acquired.filter((id) => id.startsWith("worker-rpc:")),
    rpcReleases: () => released.filter((id) => id.startsWith("worker-rpc:")),
  };
}

/** The raw policy the chat-completions wrapper builds on, with a short queue wait. */
function rawAdmission(overrides: Partial<RequestQueueLimits> = {}): RequestAdmission {
  return createRequestAdmission({
    limits: {
      maxExecutions: 1,
      maxQueued: 1,
      maxQueuedBytes: 1_048_576,
      maxQueueWaitMs: 30_000,
      maxPerPrincipal: Number.MAX_SAFE_INTEGER,
      starvationBoundMs: 30_000,
      maxContextTokens: Number.MAX_SAFE_INTEGER,
      retryAfterMs: 4_321,
      ...overrides,
    },
    resident: [modelKeyOf(CHAT_INGRESS_MODEL)],
    load: () => Promise.resolve(),
  });
}

type SlotReader = WebStreamReader;

/**
 * Admits one chat-completions request and holds its slot: the response
 * body is read once, then the reader is kept so the slot stays held
 * until the test cancels it — reader.cancel() releases the slot through
 * the real response wrapper.
 */
async function holdHttpChat(adm: RequestAdmission): Promise<SlotReader> {
  const res = await admitChatCompletions(
    new Request("http://x/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m", stream: true, messages: [] }),
    }),
    adm,
    () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(c): void {
              c.enqueue(new TextEncoder().encode("data: x\n\n"));
            },
          }),
        ),
      ),
  );
  const body = res.body;
  if (body === null) throw new Error("admission response had no body");
  const reader = body.getReader() as SlotReader;
  const first = await reader.read();
  expect(first.done).toBe(false);
  return reader;
}

async function releaseSlot(reader: SlotReader): Promise<void> {
  await reader.cancel().catch(() => undefined);
}

// ---- host + RPC driving -----------------------------------------------------

type HostOpts = WorkerRpcHostOptions & { admission?: RequestAdmission };

function hostWith(opts: {
  backend: WorkerRpcBackend;
  advertisements?: Ad[];
  admission?: RequestAdmission;
  maxActiveAttempts?: number;
  streamAttachTimeoutMs?: number;
}): WorkerRpcHost {
  const ads = opts.advertisements ?? [ad(LOCAL)];
  const backends: WorkerRpcHostOptions["backends"] = new Map([["local-model", opts.backend]]);
  const base: WorkerRpcHostOptions = {
    workerId: WORKER,
    versions: [V1_0],
    resolved: () => resolved,
    advertisements: () => ads,
    backends,
    ...(opts.maxActiveAttempts !== undefined ? { maxActiveAttempts: opts.maxActiveAttempts } : {}),
    ...(opts.streamAttachTimeoutMs !== undefined
      ? { streamAttachTimeoutMs: opts.streamAttachTimeoutMs }
      : {}),
  };
  const adm = opts.admission;
  const h = createWorkerRpcHost({
    ...base,
    ...(adm ? { admission: adm } : {}),
  });
  hosts.push(h);
  return h;
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

/** The next frame, or a thrown bound — a missing frame fails the case, never hangs it. */
async function nextFrameWithin(
  it: AsyncIterator<StreamFrame>,
  boundMs: number,
): Promise<StreamFrame> {
  const next = it.next();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no stream frame within ${String(boundMs)} ms`));
    }, boundMs);
  });
  try {
    const result = await Promise.race([next, bound]);
    if (result.done) throw new Error("stream ended before the expected frame");
    return result.value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `pending` already settled inside the bound; still pending means false. */
async function settledWithin(pending: Promise<unknown>, boundMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, boundMs);
  });
  try {
    return await Promise.race([
      pending.then(
        () => true,
        () => true,
      ),
      elapsed,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Awaits an already-created promise under a bound, so a stall fails the case. */
async function awaitBounded<T>(pending: Promise<T>, boundMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what}: no result within ${String(boundMs)} ms`));
    }, boundMs);
  });
  try {
    return await Promise.race([pending, bound]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Polls `pred` until it holds; throws — failing the case — when the bound passes. */
async function waitFor(pred: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() >= deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

/** The 'accepted' event frame every admitted stream opens with. */
function expectAcceptedFrame(frame: StreamFrame): void {
  expect(frame).toMatchObject({ frame: "event" });
  if (frame.frame === "event") expect(frame.event.type).toBe("accepted");
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
  const hs = hosts.splice(0);
  for (const h of hs) {
    h.close();
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

describe("worker RPC admission (#281)", () => {
  // Kills: the admission option ignored; acquire not awaited before
  // startBackend; the slot taken only after the backend starts.
  test("(a) an accepted attempt counts against the shared cap and waits for a slot", async () => {
    const adm = countedAdmission(
      createChatCompletionsAdmission({ maxExecutions: 1, maxQueued: 4 }),
    );
    const httpReader = await holdHttpChat(adm);
    await waitFor(() => adm.snapshot().executing === 1);
    const { backend, runs } = controllableBackend();
    const h = hostWith({ backend, admission: adm });
    try {
      expect(submitTo(h, "att-a").outcome).toBe("accepted");
      const it = streamIterator(h, "att-a");
      const first = await nextFrameWithin(it, 200);
      expectAcceptedFrame(first);
      // 'accepted' is out; the queue wait holds the second frame and the backend.
      const second = it.next();
      expect(await settledWithin(second, 100)).toBe(false);
      expect(adm.snapshot().queued).toBe(1);
      expect(runs).toHaveLength(0);
      expect(h.status(CLAIMS, { attemptId: "att-a" })).toMatchObject({
        outcome: "status",
        state: "accepted",
      });

      // Freeing the HTTP slot grants the queued attempt: content, one run.
      await releaseSlot(httpReader);
      const granted = await awaitBounded(second, 2_000, "queued attempt content");
      expect(granted.done).toBe(false);
      if (!granted.done) {
        expect(granted.value).toMatchObject({ frame: "event" });
        if (granted.value.frame === "event") {
          expect(granted.value.event.type).toBe("content");
        }
      }
      expect(runs).toHaveLength(1);
      expect(adm.snapshot()).toMatchObject({ executing: 1, queued: 0 });

      onlyRun(runs).release();
      const frames = await collectFrames(it);
      expect(terminalOutcomeOf(frames)).toBe("completed");
      expect(adm.snapshot().executing).toBe(0);
      expect(adm.rpcAcquires()).toHaveLength(1);
      expect(adm.rpcReleases()).toHaveLength(1);
    } finally {
      await releaseSlot(httpReader);
    }
  });

  // Kills: release at acceptance or at the first frame; release never
  // called; release called twice.
  test("(b) a free slot is held for the stream's lifetime", async () => {
    const adm = countedAdmission(
      createChatCompletionsAdmission({ maxExecutions: 2, maxQueued: 4 }),
    );
    const { backend, runs } = controllableBackend();
    const h = hostWith({ backend, admission: adm });
    expect(submitTo(h, "att-b").outcome).toBe("accepted");
    const it = await startStreaming(h, "att-b");
    expect(adm.snapshot().executing).toBe(1);
    expect(adm.rpcReleases()).toHaveLength(0);
    onlyRun(runs).release();
    const frames = await collectFrames(it);
    expect(terminalOutcomeOf(frames)).toBe("completed");
    expect(adm.rpcReleases()).toHaveLength(1);
    expect(adm.snapshot().executing).toBe(0);
  });

  // Kills: settle() skipping the stored release on a stop/throw path;
  // a double release.
  describe("the admission slot is released exactly once on every terminal path", () => {
    // Kills: host.cancel path skipping the stored release.
    test("host.cancel while emitting", async () => {
      const adm = countedAdmission(
        createChatCompletionsAdmission({ maxExecutions: 1, maxQueued: 4 }),
      );
      const { backend } = controllableBackend();
      const h = hostWith({ backend, admission: adm });
      expect(submitTo(h, "att-c-cancel").outcome).toBe("accepted");
      const it = await startStreaming(h, "att-c-cancel");
      expect(h.cancel(CLAIMS, { attemptId: "att-c-cancel" }).outcome).toBe("cancelled");
      const frames = await collectFrames(it);
      expect(terminalOutcomeOf(frames)).toBe("cancelled");
      expect(adm.rpcReleases()).toHaveLength(1);
      expect(adm.snapshot().executing).toBe(0);
    });

    // Kills: the stream-abort path skipping the stored release.
    test("stream AbortSignal abort while emitting", async () => {
      const adm = countedAdmission(
        createChatCompletionsAdmission({ maxExecutions: 1, maxQueued: 4 }),
      );
      const { backend } = controllableBackend();
      const h = hostWith({ backend, admission: adm });
      expect(submitTo(h, "att-c-abort").outcome).toBe("accepted");
      const client = new AbortController();
      const it = await startStreaming(h, "att-c-abort", { signal: client.signal });
      client.abort();
      const frames = await collectFrames(it);
      expect(terminalOutcomeOf(frames)).toBe("cancelled");
      expect(adm.rpcReleases()).toHaveLength(1);
      expect(adm.snapshot().executing).toBe(0);
    });

    // Kills: the backend-throw path skipping the stored release.
    test("a backend that throws after content", async () => {
      const adm = countedAdmission(
        createChatCompletionsAdmission({ maxExecutions: 1, maxQueued: 4 }),
      );
      const { backend } = controllableBackend({ fail: true });
      const h = hostWith({ backend, admission: adm });
      expect(submitTo(h, "att-c-throw").outcome).toBe("accepted");
      const it = await startStreaming(h, "att-c-throw");
      const frames = await collectFrames(it);
      expect(terminalOutcomeOf(frames)).toBe("failed");
      expect(adm.rpcReleases()).toHaveLength(1);
      expect(adm.snapshot().executing).toBe(0);
    });

    // Kills: the deadline path skipping the stored release.
    test("envelope deadline", async () => {
      const adm = countedAdmission(
        createChatCompletionsAdmission({ maxExecutions: 1, maxQueued: 4 }),
      );
      const { backend } = controllableBackend();
      const h = hostWith({ backend, admission: adm });
      expect(submitTo(h, "att-c-deadline", { deadline: Date.now() + 200 }).outcome).toBe(
        "accepted",
      );
      const it = await startStreaming(h, "att-c-deadline");
      const frames = await collectFrames(it);
      expect(terminalOutcomeOf(frames)).toBe("failed");
      expect(adm.rpcReleases()).toHaveLength(1);
      expect(adm.snapshot().executing).toBe(0);
    });

    // Kills: close() skipping the stored release; a double release.
    test("host.close()", async () => {
      const adm = countedAdmission(
        createChatCompletionsAdmission({ maxExecutions: 1, maxQueued: 4 }),
      );
      const { backend } = controllableBackend();
      const h = hostWith({ backend, admission: adm });
      expect(submitTo(h, "att-c-close").outcome).toBe("accepted");
      const it = await startStreaming(h, "att-c-close");
      h.close();
      const frames = await collectFrames(it);
      expect(terminalOutcomeOf(frames)).toBe("cancelled");
      expect(adm.rpcReleases()).toHaveLength(1);
      expect(adm.snapshot().executing).toBe(0);
    });
  });

  // Kills: acquire not given the attempt's abort signal (orphan start or
  // leaked slot); a grant arriving after cancel not released.
  test("(d) host.cancel while queued leaves no orphan", async () => {
    const adm = countedAdmission(
      createChatCompletionsAdmission({ maxExecutions: 1, maxQueued: 4 }),
    );
    const httpReader = await holdHttpChat(adm);
    await waitFor(() => adm.snapshot().executing === 1);
    const { backend, runs } = controllableBackend();
    const h = hostWith({ backend, admission: adm });
    try {
      expect(submitTo(h, "att-d-cancel").outcome).toBe("accepted");
      const it = streamIterator(h, "att-d-cancel");
      expectAcceptedFrame(await nextFrameWithin(it, 500));
      const pending = it.next();
      await waitFor(() => adm.snapshot().queued === 1);
      expect(h.cancel(CLAIMS, { attemptId: "att-d-cancel" }).outcome).toBe("cancelled");
      await waitFor(() => adm.snapshot().queued === 0);
      const status = await waitForTerminal(h, "att-d-cancel");
      expect(status.terminal).toMatchObject({ outcome: "cancelled", started: false });
      expect(adm.rpcReleases()).toHaveLength(0);
      await releaseSlot(httpReader);
      expect(adm.snapshot().executing).toBe(0);
      expect(runs).toHaveLength(0);
      expect(adm.rpcReleases()).toHaveLength(0);
      // The stream still delivers the recorded terminal, then ends.
      const terminalFrame = await awaitBounded(pending, 2_000, "cancelled terminal frame");
      expect(terminalFrame.done).toBe(false);
      if (!terminalFrame.done) {
        expect(terminalFrame.value).toMatchObject({ frame: "event" });
        if (terminalFrame.value.frame === "event") {
          expect(terminalFrame.value.event.type).toBe("terminal");
        }
      }
      await collectFrames(it, 2_000);
    } finally {
      await releaseSlot(httpReader);
    }
  });

  // Kills: acquire not given the stream's abort signal (orphan start or
  // leaked slot); a grant arriving after abort not released.
  test("(d) a stream abort while queued leaves no orphan", async () => {
    const adm = countedAdmission(
      createChatCompletionsAdmission({ maxExecutions: 1, maxQueued: 4 }),
    );
    const httpReader = await holdHttpChat(adm);
    await waitFor(() => adm.snapshot().executing === 1);
    const { backend, runs } = controllableBackend();
    const h = hostWith({ backend, admission: adm });
    const client = new AbortController();
    try {
      expect(submitTo(h, "att-d-abort").outcome).toBe("accepted");
      const it = streamIterator(h, "att-d-abort", { signal: client.signal });
      expectAcceptedFrame(await nextFrameWithin(it, 500));
      const pending = it.next();
      await waitFor(() => adm.snapshot().queued === 1);
      client.abort();
      await waitFor(() => adm.snapshot().queued === 0);
      const status = await waitForTerminal(h, "att-d-abort");
      expect(status.terminal).toMatchObject({ outcome: "cancelled", started: false });
      expect(adm.rpcReleases()).toHaveLength(0);
      await releaseSlot(httpReader);
      expect(adm.snapshot().executing).toBe(0);
      expect(runs).toHaveLength(0);
      expect(adm.rpcReleases()).toHaveLength(0);
      const terminalFrame = await awaitBounded(pending, 2_000, "cancelled terminal frame");
      expect(terminalFrame.done).toBe(false);
      if (!terminalFrame.done) {
        expect(terminalFrame.value).toMatchObject({ frame: "event" });
        if (terminalFrame.value.frame === "event") {
          expect(terminalFrame.value.event.type).toBe("terminal");
        }
      }
      await collectFrames(it, 2_000);
    } finally {
      await releaseSlot(httpReader);
    }
  });

  // Kills: refusal mapped to target-unavailable; retryAfterMs dropped or
  // constant; a refused attempt left unsettled; an immediate refusal sent
  // after 'accepted'.
  test("(e) an immediate overload refusal is a first-frame typed rejection", async () => {
    const adm = rawAdmission();
    const httpReader = await holdHttpChat(adm);
    await waitFor(() => adm.snapshot().executing === 1);
    const { backend, runs } = controllableBackend();
    const h = hostWith({ backend, admission: adm });
    try {
      // Attempt A queues after 'accepted' and takes the one queue slot.
      expect(submitTo(h, "att-e-a").outcome).toBe("accepted");
      const itA = streamIterator(h, "att-e-a");
      expectAcceptedFrame(await nextFrameWithin(itA, 500));
      const pendingA = itA.next();
      await waitFor(() => adm.snapshot().queued === 1);

      // Attempt B's queue is already full: its FIRST frame is the typed refusal.
      expect(submitTo(h, "att-e-b").outcome).toBe("accepted");
      const itB = streamIterator(h, "att-e-b");
      const firstB = await nextFrameWithin(itB, 500);
      const expectedRejection = {
        frame: "rejected" as const,
        rejection: {
          code: "overloaded" as const,
          retryAfterMs: 4_321,
          message: expect.stringContaining("QueueFull") as string,
        },
      };
      expect(firstB).toEqual(expectedRejection);
      const statusB = await waitForTerminal(h, "att-e-b");
      expect(statusB.state).toBe("terminal");
      expect(statusB.terminal).toMatchObject({ outcome: "failed", started: false });
      expect(runs).toHaveLength(0);
      expect(adm.snapshot().queued).toBe(1);

      // Freeing the HTTP slot lets the queued attempt A reach its backend.
      await releaseSlot(httpReader);
      const granted = await awaitBounded(pendingA, 2_000, "attempt A content");
      expect(granted.done).toBe(false);
      if (!granted.done) {
        expect(granted.value).toMatchObject({ frame: "event" });
        if (granted.value.frame === "event") {
          expect(granted.value.event.type).toBe("content");
        }
      }
      expect(runs).toHaveLength(1);
      onlyRun(runs).release();
      const framesA = await collectFrames(itA);
      expect(terminalOutcomeOf(framesA)).toBe("completed");
    } finally {
      await releaseSlot(httpReader);
    }
  });

  // Kills: no typed retryAfterMs field on the rejection.
  test("(f) the rejection schema carries a typed retryAfterMs", () => {
    const rejection = { code: "overloaded" as const, message: "m", retryAfterMs: 1_500 };
    expect(inferenceRpc.InferenceRpcRejectionV1Schema.parse(rejection)).toEqual(rejection);
    expect(
      inferenceRpc.InferenceRpcRejectionV1Schema.safeParse({
        code: "overloaded",
        message: "m",
        retryAfterMs: -1,
      }).success,
    ).toBe(false);
    const rejectedFrame = {
      frame: "rejected" as const,
      rejection: { code: "overloaded" as const, message: "m", retryAfterMs: 1_500 },
    };
    expect(inferenceRpc.InferenceRpcStreamFrameV1Schema.parse(rejectedFrame)).toEqual(
      rejectedFrame,
    );
  });

  // Kills: on half — the option ignored; off half — admission kept in
  // module scope or shared between hosts so an option-less host consults it.
  test("(g) the admission option selects the cap per host", async () => {
    const adm = countedAdmission(
      createChatCompletionsAdmission({ maxExecutions: 1, maxQueued: 4 }),
    );
    const httpReader = await holdHttpChat(adm);
    await waitFor(() => adm.snapshot().executing === 1);
    const onBackend = controllableBackend();
    const h1 = hostWith({ backend: onBackend.backend, admission: adm });
    const offBackend = controllableBackend();
    const h2 = hostWith({ backend: offBackend.backend });
    try {
      expect(submitTo(h1, "att-g-on").outcome).toBe("accepted");
      const it1 = streamIterator(h1, "att-g-on");
      expectAcceptedFrame(await nextFrameWithin(it1, 500));
      const pending1 = it1.next();
      await waitFor(() => adm.snapshot().queued === 1);
      expect(await settledWithin(pending1, 100)).toBe(false);

      // A host without the option streams straight through the saturated cap.
      expect(submitTo(h2, "att-g-off").outcome).toBe("accepted");
      const it2 = streamIterator(h2, "att-g-off");
      expectAcceptedFrame(await nextFrameWithin(it2, 500));
      const content2 = await nextFrameWithin(it2, 200);
      expect(content2).toMatchObject({ frame: "event" });
      if (content2.frame === "event") expect(content2.event.type).toBe("content");
      expect(adm.snapshot().queued).toBe(1);
      onlyRun(offBackend.runs).release();
      const frames2 = await collectFrames(it2);
      expect(terminalOutcomeOf(frames2)).toBe("completed");
    } finally {
      await releaseSlot(httpReader);
    }
  });

  // Kills: the embedded unified-proxy path taking a second slot
  // (self-deadlock at maxExecutions: 1).
  test("(h) embedded unified-proxy attempts are not counted a second time", async () => {
    const adm = countedAdmission(
      createChatCompletionsAdmission({ maxExecutions: 1, maxQueued: 4 }),
    );
    const httpReader = await holdHttpChat(adm);
    await waitFor(() => adm.snapshot().executing === 1);
    const { backend } = controllableBackend();
    const h = hostWith({ backend, admission: adm });
    const restoreHost = publishWorkerRpcHost(h);
    try {
      // The embedded path's own claims and envelope shape, as
      // create-proxy.ts + embeddedClaims() present them: serviceId
      // 'embedded:<node>', tenant and credential scope 'local', one self hop.
      const embeddedClaims = claims({
        serviceId: "embedded:local",
        tenants: ["local"],
        credentialScopeId: "local",
      });
      const client = createEmbeddedInferenceRpcClient(embeddedClaims);
      const listing = await client.catalog();
      if (listing.outcome !== "catalog") throw new Error("catalog rejected");
      const submitted = await client.submit({
        version: V1_0,
        envelope: envelope("att-emb", {
          tenantId: "local",
          projectId: "local",
          credentialScopeId: "local",
          internal: { deploymentId: LOCAL, hopCount: 1, visitedNodes: ["local"] },
        }),
        target: {
          deploymentId: LOCAL,
          expectedDeploymentEpoch:
            listing.deployments.find((d) => d.deploymentId === LOCAL)?.deploymentEpoch ?? "epoch-1",
          catalogGeneration: listing.catalogGeneration,
          workerIncarnation: listing.workerIncarnation,
        },
        cancelId: "cancel-att-emb",
      });
      expect(submitted.outcome).toBe("accepted");
      const it = client.stream({ attemptId: "att-emb" })[Symbol.asyncIterator]();
      expectAcceptedFrame(await nextFrameWithin(it, 2_000));
      const content = await nextFrameWithin(it, 200);
      expect(content).toMatchObject({ frame: "event" });
      if (content.frame === "event") expect(content.event.type).toBe("content");
      expect(adm.rpcAcquires()).toHaveLength(0);

      // Contrast: a remote-shaped attempt on the same host queues.
      expect(submitTo(h, "att-contrast").outcome).toBe("accepted");
      const itC = streamIterator(h, "att-contrast");
      expectAcceptedFrame(await nextFrameWithin(itC, 500));
      const pendingC = itC.next();
      await waitFor(() => adm.snapshot().queued === 1);
      expect(await settledWithin(pendingC, 100)).toBe(false);
    } finally {
      restoreHost();
      await releaseSlot(httpReader);
    }
  });

  // Kills: a late refusal left unsettled or hanging; the backend started
  // after a refusal; a 'rejected' frame emitted after 'accepted'. QueueWaitExceeded
  // is a 503 at the HTTP ingress, but here it lands after 'accepted', so
  // protocol necessity makes it a failed terminal — the client-visible
  // equivalent of the 502 an upstream failure produces.
  test("(j) a queue-wait expiry after 'accepted' is a typed failed terminal", async () => {
    const adm = countedAdmission(rawAdmission({ maxQueueWaitMs: 150 }));
    const httpReader = await holdHttpChat(adm);
    await waitFor(() => adm.snapshot().executing === 1);
    const { backend, runs } = controllableBackend();
    const h = hostWith({ backend, admission: adm });
    try {
      expect(submitTo(h, "att-j").outcome).toBe("accepted");
      const it = streamIterator(h, "att-j");
      expectAcceptedFrame(await nextFrameWithin(it, 500));
      const frames = await collectFrames(it, 2_000);
      expect(frames.filter((f) => f.frame === "rejected")).toHaveLength(0);
      const last = eventsOf(frames).at(-1);
      expect(last?.type).toBe("terminal");
      const terminal = last?.type === "terminal" ? last.terminal : undefined;
      expect(terminal).toMatchObject({ outcome: "failed", started: false });
      if (terminal?.outcome !== "failed") {
        throw new Error("expected a failed terminal");
      }
      expect(terminal.error.code).toBe("target-unavailable");
      expect(terminal.error.message).toContain("QueueWaitExceeded");
      expect(runs).toHaveLength(0);
      expect(adm.snapshot().queued).toBe(0);
      expect(adm.rpcReleases()).toHaveLength(0);
    } finally {
      await releaseSlot(httpReader);
    }
  });
});
