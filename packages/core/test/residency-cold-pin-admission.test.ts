import { expect, test } from "bun:test";

import type {
  CancelResult,
  EnqueueResult,
  QueueAction,
  QueueRequest,
  QueueSnapshot,
  RequestQueueLimits,
  RequestQueuePolicy,
} from "../src/residency/queue-policy.js";

import { createRequestQueuePolicy } from "../src/residency/queue-policy.js";

// #281 DF-08: the typed cold-pin queue probe lands with the fix. A variable
// specifier keeps tsc from resolving the not-yet-existing module, so each
// case fails by assertion at the pinned base rather than by a resolution
// error.
const MODULE = "../src/residency/cold-pin-admission.js";

type DeclaredState = "cold" | "draining" | "disabled" | "loading" | "ready" | "unavailable";

type DeclaredEntry = {
  id: string;
  workload: string;
  kind: "ModelHost" | "ModelRun";
  ownerNodeId: string;
  state: DeclaredState;
  autoLoadEligible: boolean;
  reason?: string;
};

type ProbeRefuseReason =
  | "ContextLimitExceeded"
  | "DeadlineExceeded"
  | "InvalidRequest"
  | "NotLoadable"
  | "PrincipalShareExceeded"
  | "QueueBytesExceeded"
  | "QueueFull"
  | "RequestIdConflict";

type ProbeResult =
  | { kind: "would_queue"; queueDepth: number; maxWaitMs: number }
  | { kind: "would_refuse"; reason: ProbeRefuseReason; retryAfterMs: number | null };

type ProbeInput = {
  entry: DeclaredEntry;
  policy: RequestQueuePolicy;
  probeId: string;
  bytes: number;
  maxCompletionTokens: number;
};

type ProbeOver = {
  entry?: DeclaredEntry;
  probeId?: string;
  bytes?: number;
  maxCompletionTokens?: number;
};

type Mod = {
  probeColdPinQueue: (input: ProbeInput) => ProbeResult;
};

let mod: Mod | undefined;

async function load(): Promise<Mod> {
  mod = (await import(MODULE).catch(() => undefined)) as Mod | undefined;
  expect(typeof mod?.probeColdPinQueue).toBe("function");
  return mod!;
}

const entry = (over: Partial<DeclaredEntry> = {}): DeclaredEntry => ({
  id: "cold/model-a.gguf",
  workload: "wl-declared",
  kind: "ModelRun",
  ownerNodeId: "local",
  state: "cold",
  autoLoadEligible: true,
  ...over,
});

const lim = (over: Partial<RequestQueueLimits> = {}): RequestQueueLimits => ({
  maxExecutions: over.maxExecutions ?? 2,
  maxQueued: over.maxQueued ?? 8,
  maxQueuedBytes: over.maxQueuedBytes ?? 1_000_000,
  maxQueueWaitMs: over.maxQueueWaitMs ?? 30_000,
  maxPerPrincipal: over.maxPerPrincipal ?? 100,
  starvationBoundMs: over.starvationBoundMs ?? 10_000_000,
  maxContextTokens: over.maxContextTokens ?? 100_000,
  retryAfterMs: over.retryAfterMs ?? 250,
});

const policy = (over: Partial<RequestQueueLimits> = {}): RequestQueuePolicy =>
  createRequestQueuePolicy({ limits: lim(over), now: () => 1_000, resident: [] });

const fill = (target: RequestQueuePolicy, n: number): void => {
  for (const i of Array.from({ length: n }, (_, index) => index)) {
    const request: QueueRequest = {
      requestId: `fill-${String(i)}`,
      principal: `fill-principal-${String(i)}`,
      priority: "background",
      model: { name: "other", revision: "1" },
      bytes: 1,
      promptTokens: 0,
      maxCompletionTokens: 0,
      deadlineMs: Number.POSITIVE_INFINITY,
    };
    expect(target.enqueue(request)).toEqual({ kind: "queued", requestId: request.requestId });
  }
};

const probe = (target: RequestQueuePolicy, over: ProbeOver = {}): ProbeResult => {
  if (mod === undefined) {
    throw new Error("probe() before load()");
  }
  return mod.probeColdPinQueue({
    entry: entry(),
    policy: target,
    probeId: "p1",
    bytes: 10,
    maxCompletionTokens: 0,
    ...over,
  });
};

const untouchableQueuePolicy = (): RequestQueuePolicy => {
  const touch = (): never => {
    throw new Error("cold-pin probe touched the queue policy for a non-loadable entry");
  };
  return {
    enqueue: touch,
    schedule: touch,
    loadSettled: touch,
    markEvicted: touch,
    cancel: touch,
    finishExecution: touch,
    snapshot: touch,
    queueLimits: touch,
  };
};

const spyPolicy = (
  inner: RequestQueuePolicy,
): { policy: RequestQueuePolicy; principals: string[] } => {
  const principals: string[] = [];
  return {
    principals,
    policy: {
      enqueue: (request): EnqueueResult => {
        principals.push(request.principal);
        return inner.enqueue(request);
      },
      schedule: (): QueueAction[] => inner.schedule(),
      loadSettled: (loadId, outcome): QueueAction[] => inner.loadSettled(loadId, outcome),
      markEvicted: (modelKey): void => {
        inner.markEvicted(modelKey);
      },
      cancel: (requestId): CancelResult => inner.cancel(requestId),
      finishExecution: (requestId): boolean => inner.finishExecution(requestId),
      snapshot: (): QueueSnapshot => inner.snapshot(),
      queueLimits: (): RequestQueueLimits => inner.queueLimits(),
    },
  };
};

test("#281: an empty queue would queue a cold-pin probe at depth 1", async () => {
  await load();
  const target = policy();
  expect(probe(target)).toEqual({ kind: "would_queue", queueDepth: 1, maxWaitMs: 30_000 });
  expect(target.snapshot()).toEqual({
    queued: 0,
    queuedBytes: 0,
    executing: 0,
    loading: null,
    resident: [],
    byPrincipal: {},
  });
});

test("#281: queueDepth counts depth not schedule order and the probe retains nothing", async () => {
  await load();
  const target = policy();
  fill(target, 2);
  const before = target.snapshot();
  expect(probe(target)).toEqual({ kind: "would_queue", queueDepth: 3, maxWaitMs: 30_000 });
  expect(target.snapshot()).toEqual(before);
});

test("#281: a full queue refuses the probe with QueueFull and its retry hint", async () => {
  await load();
  const target = policy({ maxQueued: 2, retryAfterMs: 400 });
  fill(target, 2);
  const before = target.snapshot();
  expect(probe(target)).toEqual({
    kind: "would_refuse",
    reason: "QueueFull",
    retryAfterMs: 400,
  });
  expect(target.snapshot()).toEqual(before);
});

test("#281: solo byte oversize refuses without retry while aggregate overflow retries", async () => {
  await load();
  const solo = policy({ maxQueuedBytes: 100 });
  expect(probe(solo, { bytes: 101 })).toEqual({
    kind: "would_refuse",
    reason: "QueueBytesExceeded",
    retryAfterMs: null,
  });
  const aggregate = policy({ maxQueuedBytes: 100 });
  fill(aggregate, 1);
  expect(probe(aggregate, { bytes: 100 })).toEqual({
    kind: "would_refuse",
    reason: "QueueBytesExceeded",
    retryAfterMs: 250,
  });
});

test("#281: completion tokens over maxContextTokens refuse ContextLimitExceeded", async () => {
  await load();
  const target = policy({ maxContextTokens: 1_000 });
  expect(probe(target, { maxCompletionTokens: 1_001 })).toEqual({
    kind: "would_refuse",
    reason: "ContextLimitExceeded",
    retryAfterMs: null,
  });
});

test("#281: non-loadable declared entries refuse NotLoadable before touching the policy", async () => {
  await load();
  const cases: DeclaredEntry[] = [
    entry({ state: "disabled", autoLoadEligible: false }),
    entry({ state: "unavailable", autoLoadEligible: false }),
    entry({ state: "loading" }),
    entry({ state: "draining" }),
    entry({ state: "ready" }),
    entry({ state: "cold", autoLoadEligible: false }),
  ];
  for (const declared of cases) {
    expect(probe(untouchableQueuePolicy(), { entry: declared })).toEqual({
      kind: "would_refuse",
      reason: "NotLoadable",
      retryAfterMs: null,
    });
  }
});

test("#281: loadability is checked before queue capacity", async () => {
  await load();
  const target = policy({ maxQueued: 1, retryAfterMs: 400 });
  fill(target, 1);
  expect(probe(target, { entry: entry({ state: "disabled", autoLoadEligible: false }) })).toEqual({
    kind: "would_refuse",
    reason: "NotLoadable",
    retryAfterMs: null,
  });
});

test("#281: repeated probeIds do not accumulate queue state", async () => {
  await load();
  const target = policy();
  const expected: ProbeResult = { kind: "would_queue", queueDepth: 1, maxWaitMs: 30_000 };
  expect(probe(target)).toEqual(expected);
  expect(probe(target)).toEqual(expected);
  expect(target.snapshot()).toEqual({
    queued: 0,
    queuedBytes: 0,
    executing: 0,
    loading: null,
    resident: [],
    byPrincipal: {},
  });
});

test("#281: the probe passes a probeId-derived principal, not a fixed one", async () => {
  await load();
  const inner = policy({ maxPerPrincipal: 1 });
  fill(inner, 1);
  const { policy: spied, principals } = spyPolicy(inner);
  expect(probe(spied, { probeId: "unique-principal-9" })).toEqual({
    kind: "would_queue",
    queueDepth: 2,
    maxWaitMs: 30_000,
  });
  expect(principals).toEqual(["cold-pin-probe:unique-principal-9"]);
});

test("#281: a pre-existing entry with the probe's id is neither cancelled nor reported as would_queue", async () => {
  await load();
  const target = createRequestQueuePolicy({
    limits: lim(),
    now: () => 1_000,
    resident: ["other@1"],
  });
  const preexisting: QueueRequest = {
    requestId: "cold-pin-probe:collision",
    principal: "someone-else",
    priority: "background",
    model: { name: "other", revision: "1" },
    bytes: 1,
    promptTokens: 0,
    maxCompletionTokens: 0,
    deadlineMs: Number.POSITIVE_INFINITY,
  };
  expect(target.enqueue(preexisting)).toEqual({
    kind: "queued",
    requestId: preexisting.requestId,
  });
  target.schedule();
  expect(target.snapshot()).toMatchObject({ queued: 0, executing: 1 });

  expect(probe(target, { probeId: "collision", bytes: 1e9, maxCompletionTokens: 1e9 })).toEqual({
    kind: "would_refuse",
    reason: "RequestIdConflict",
    retryAfterMs: null,
  });
  expect(target.snapshot()).toMatchObject({ queued: 0, executing: 1 });
});

test("#281: would_queue reports the policy limits' maxQueueWaitMs as its single source", async () => {
  await load();
  const target = policy({ maxQueueWaitMs: 12_345 });
  expect(probe(target)).toEqual({ kind: "would_queue", queueDepth: 1, maxWaitMs: 12_345 });
});
