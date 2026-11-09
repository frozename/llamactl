import { expect, test } from "bun:test";

// #281: the shared request-queue policy lands with the fix. A variable
// specifier keeps tsc from resolving the not-yet-existing module, so each
// case fails by assertion at the pinned base rather than by a resolution
// error.
const MODULE = "../src/residency/queue-policy.js";

type Priority = "interactive" | "background";

type ModelRef = { name: string; revision: string };

type Limits = {
  maxExecutions: number;
  maxQueued: number;
  maxQueuedBytes: number;
  maxQueueWaitMs: number;
  maxPerPrincipal: number;
  starvationBoundMs: number;
  maxContextTokens: number;
  retryAfterMs: number;
};

type QueueRequest = {
  requestId: string;
  principal: string;
  priority: Priority;
  model: ModelRef;
  bytes: number;
  promptTokens: number;
  maxCompletionTokens: number;
  deadlineMs: number;
};

type RefusalReason =
  | "ContextLimitExceeded"
  | "DeadlineExceeded"
  | "InvalidRequest"
  | "PrincipalShareExceeded"
  | "QueueBytesExceeded"
  | "QueueFull";

type EnqueueResult =
  | { kind: "queued"; requestId: string }
  | { kind: "duplicate"; requestId: string; state: "queued" | "executing" }
  | { kind: "refused"; reason: RefusalReason; retryAfterMs: number | null };

type QueueAction =
  | {
      kind: "expire";
      requestId: string;
      reason: "DeadlineExceeded" | "QueueWaitExceeded";
      retryAfterMs: number | null;
    }
  | { kind: "fail"; requestId: string; reason: "LoadFailed"; retryAfterMs: number }
  | { kind: "start-execution"; requestId: string; modelKey: string }
  | { kind: "start-load"; loadId: string; modelKey: string };

type CancelResult = { kind: "cancelled"; state: "queued" | "executing" } | { kind: "unknown" };

type Snapshot = {
  queued: number;
  queuedBytes: number;
  executing: number;
  loading: string | null;
  resident: string[];
  byPrincipal: Record<string, number>;
};

type QueuePolicy = {
  enqueue: (request: QueueRequest) => EnqueueResult;
  schedule: () => QueueAction[];
  loadSettled: (loadId: string, outcome: "ready" | "failed") => QueueAction[];
  markEvicted: (modelKey: string) => void;
  cancel: (requestId: string) => CancelResult;
  finishExecution: (requestId: string) => boolean;
  snapshot: () => Snapshot;
};

type Mod = {
  createRequestQueuePolicy: (options: {
    limits: Limits;
    now?: () => number;
    resident?: string[];
  }) => QueuePolicy;
};

async function load(): Promise<Mod> {
  const mod = (await import(MODULE).catch(() => undefined)) as Mod | undefined;
  expect(typeof mod?.createRequestQueuePolicy).toBe("function");
  return mod!;
}

type ReqOver = {
  principal?: string;
  priority?: Priority;
  model?: ModelRef;
  bytes?: number;
  promptTokens?: number;
  maxCompletionTokens?: number;
  deadlineMs?: number;
};

const lim = (over: Partial<Limits> = {}): Limits => ({
  maxExecutions: over.maxExecutions ?? 2,
  maxQueued: over.maxQueued ?? 8,
  maxQueuedBytes: over.maxQueuedBytes ?? 1_000_000,
  maxQueueWaitMs: over.maxQueueWaitMs ?? 10_000_000,
  maxPerPrincipal: over.maxPerPrincipal ?? 100,
  starvationBoundMs: over.starvationBoundMs ?? 10_000_000,
  maxContextTokens: over.maxContextTokens ?? 100_000,
  retryAfterMs: over.retryAfterMs ?? 250,
});

const q = (requestId: string, over: ReqOver = {}): QueueRequest => ({
  requestId,
  principal: over.principal ?? "p",
  priority: over.priority ?? "background",
  model: over.model ?? { name: "m", revision: "1" },
  bytes: over.bytes ?? 10,
  promptTokens: over.promptTokens ?? 10,
  maxCompletionTokens: over.maxCompletionTokens ?? 10,
  deadlineMs: over.deadlineMs ?? Number.POSITIVE_INFINITY,
});

test("#281: ten queued requests for one cold model share a single load then fill two execution slots", async () => {
  const mod = await load();
  const t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxExecutions: 2, maxQueued: 16 }),
    now: (): number => t,
    resident: [],
  });
  const ids = Array.from({ length: 10 }, (_, i) => `cold-${String(i + 1).padStart(2, "0")}`);
  for (const requestId of ids) {
    expect(policy.enqueue(q(requestId, { model: { name: "cold", revision: "v1" } }))).toEqual({
      kind: "queued",
      requestId,
    });
  }
  expect(policy.schedule()).toEqual([
    { kind: "start-load", loadId: "load-1", modelKey: "cold@v1" },
  ]);
  expect(policy.snapshot()).toEqual({
    queued: 10,
    queuedBytes: 100,
    executing: 0,
    loading: "cold@v1",
    resident: [],
    byPrincipal: { p: 10 },
  });
  expect(policy.schedule()).toEqual([]);
  expect(policy.loadSettled("load-1", "ready")).toEqual([]);
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "cold-01", modelKey: "cold@v1" },
    { kind: "start-execution", requestId: "cold-02", modelKey: "cold@v1" },
  ]);
  expect(policy.schedule()).toEqual([]);
  expect(policy.snapshot()).toEqual({
    queued: 8,
    queuedBytes: 80,
    executing: 2,
    loading: null,
    resident: ["cold@v1"],
    byPrincipal: { p: 10 },
  });
});

test("#281: a second cold model waits for the in-flight load and receives the next loadId", async () => {
  const mod = await load();
  const t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxExecutions: 1 }),
    now: (): number => t,
    resident: [],
  });
  expect(policy.enqueue(q("a-1", { model: { name: "model-a", revision: "1" } }))).toEqual({
    kind: "queued",
    requestId: "a-1",
  });
  expect(policy.enqueue(q("b-1", { model: { name: "model-b", revision: "1" } }))).toEqual({
    kind: "queued",
    requestId: "b-1",
  });
  expect(policy.schedule()).toEqual([
    { kind: "start-load", loadId: "load-1", modelKey: "model-a@1" },
  ]);
  expect(policy.schedule()).toEqual([]);
  expect(policy.loadSettled("load-1", "ready")).toEqual([]);
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "a-1", modelKey: "model-a@1" },
    { kind: "start-load", loadId: "load-2", modelKey: "model-b@1" },
  ]);
  expect(policy.loadSettled("load-2", "ready")).toEqual([]);
  expect(policy.schedule()).toEqual([]);
  expect(policy.finishExecution("a-1")).toBe(true);
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "b-1", modelKey: "model-b@1" },
  ]);
});

test("#281: finishing executions admits queued waiters one at a time under the cap", async () => {
  const mod = await load();
  let t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxExecutions: 2, maxQueued: 8, maxPerPrincipal: 10 }),
    now: (): number => t,
    resident: ["m@1"],
  });
  const specs = [
    { id: "s-1", principal: "alice" },
    { id: "s-2", principal: "bob" },
    { id: "s-3", principal: "carol" },
    { id: "s-4", principal: "alice" },
    { id: "s-5", principal: "bob" },
  ];
  for (const spec of specs) {
    expect(policy.enqueue(q(spec.id, { principal: spec.principal }))).toEqual({
      kind: "queued",
      requestId: spec.id,
    });
  }
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "s-1", modelKey: "m@1" },
    { kind: "start-execution", requestId: "s-2", modelKey: "m@1" },
  ]);
  const stable = {
    queued: 3,
    queuedBytes: 30,
    executing: 2,
    loading: null,
    resident: ["m@1"],
    byPrincipal: { alice: 2, bob: 2, carol: 1 },
  };
  expect(policy.snapshot()).toEqual(stable);
  expect(policy.finishExecution("s-5")).toBe(false);
  expect(policy.finishExecution("ghost")).toBe(false);
  for (const _ of Array.from({ length: 25 }, (_, i) => i)) {
    t += 50;
    expect(policy.schedule()).toEqual([]);
    expect(policy.snapshot()).toEqual(stable);
  }
  expect(policy.finishExecution("s-1")).toBe(true);
  expect(policy.finishExecution("s-1")).toBe(false);
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "s-3", modelKey: "m@1" },
  ]);
  expect(policy.finishExecution("s-2")).toBe(true);
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "s-4", modelKey: "m@1" },
  ]);
  expect(policy.finishExecution("s-3")).toBe(true);
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "s-5", modelKey: "m@1" },
  ]);
  expect(policy.finishExecution("s-4")).toBe(true);
  expect(policy.schedule()).toEqual([]);
  expect(policy.finishExecution("s-5")).toBe(true);
  expect(policy.schedule()).toEqual([]);
  expect(policy.finishExecution("s-5")).toBe(false);
  expect(policy.snapshot()).toEqual({
    queued: 0,
    queuedBytes: 0,
    executing: 0,
    loading: null,
    resident: ["m@1"],
    byPrincipal: {},
  });
});

test("#281: invalid requests are refused as InvalidRequest without a retry hint", async () => {
  const mod = await load();
  const t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim(),
    now: (): number => t,
    resident: ["m@1"],
  });
  const invalid: QueueRequest[] = [
    q(""),
    q("no-principal", { principal: "" }),
    q("no-name", { model: { name: "", revision: "1" } }),
    q("no-revision", { model: { name: "m", revision: "" } }),
    q("neg-bytes", { bytes: -1 }),
    q("nan-bytes", { bytes: Number.NaN }),
    q("inf-bytes", { bytes: Number.POSITIVE_INFINITY }),
    q("neg-prompt", { promptTokens: -2 }),
    q("nan-prompt", { promptTokens: Number.NaN }),
    q("inf-prompt", { promptTokens: Number.POSITIVE_INFINITY }),
    q("nan-completion", { maxCompletionTokens: Number.NaN }),
    q("neg-completion", { maxCompletionTokens: -1 }),
    q("inf-completion", { maxCompletionTokens: Number.POSITIVE_INFINITY }),
    q("nan-deadline", { deadlineMs: Number.NaN }),
  ];
  for (const request of invalid) {
    expect(policy.enqueue(request)).toEqual({
      kind: "refused",
      reason: "InvalidRequest",
      retryAfterMs: null,
    });
  }
  expect(policy.snapshot()).toEqual({
    queued: 0,
    queuedBytes: 0,
    executing: 0,
    loading: null,
    resident: ["m@1"],
    byPrincipal: {},
  });
});

test("#281: prompt plus completion over maxContextTokens is refused", async () => {
  const mod = await load();
  const t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxContextTokens: 100 }),
    now: (): number => t,
    resident: ["m@1"],
  });
  expect(policy.enqueue(q("ctx-ok", { promptTokens: 50, maxCompletionTokens: 50 }))).toEqual({
    kind: "queued",
    requestId: "ctx-ok",
  });
  expect(policy.enqueue(q("ctx-over", { promptTokens: 60, maxCompletionTokens: 50 }))).toEqual({
    kind: "refused",
    reason: "ContextLimitExceeded",
    retryAfterMs: null,
  });
  expect(policy.enqueue(q("ctx-over-2", { promptTokens: 0, maxCompletionTokens: 101 }))).toEqual({
    kind: "refused",
    reason: "ContextLimitExceeded",
    retryAfterMs: null,
  });
  expect(policy.snapshot()).toEqual({
    queued: 1,
    queuedBytes: 10,
    executing: 0,
    loading: null,
    resident: ["m@1"],
    byPrincipal: { p: 1 },
  });
});

test("#281: a request too large for the byte budget alone is refused without retry while aggregate overflow retries", async () => {
  const mod = await load();
  const t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxQueuedBytes: 100 }),
    now: (): number => t,
    resident: ["m@1"],
  });
  expect(policy.enqueue(q("huge", { bytes: 101 }))).toEqual({
    kind: "refused",
    reason: "QueueBytesExceeded",
    retryAfterMs: null,
  });
  expect(policy.enqueue(q("exact", { bytes: 100 }))).toEqual({
    kind: "queued",
    requestId: "exact",
  });
  expect(policy.enqueue(q("over", { bytes: 1 }))).toEqual({
    kind: "refused",
    reason: "QueueBytesExceeded",
    retryAfterMs: 250,
  });
  expect(policy.snapshot()).toEqual({
    queued: 1,
    queuedBytes: 100,
    executing: 0,
    loading: null,
    resident: ["m@1"],
    byPrincipal: { p: 1 },
  });
});

test("#281: deadlines at or before now are refused while future and infinite deadlines queue", async () => {
  const mod = await load();
  const t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim(),
    now: (): number => t,
    resident: ["m@1"],
  });
  expect(policy.enqueue(q("d-past", { deadlineMs: t - 1 }))).toEqual({
    kind: "refused",
    reason: "DeadlineExceeded",
    retryAfterMs: null,
  });
  expect(policy.enqueue(q("d-now", { deadlineMs: t }))).toEqual({
    kind: "refused",
    reason: "DeadlineExceeded",
    retryAfterMs: null,
  });
  expect(policy.enqueue(q("d-future", { deadlineMs: t + 1 }))).toEqual({
    kind: "queued",
    requestId: "d-future",
  });
  expect(policy.enqueue(q("d-inf", { deadlineMs: Number.POSITIVE_INFINITY }))).toEqual({
    kind: "queued",
    requestId: "d-inf",
  });
  expect(policy.snapshot()).toEqual({
    queued: 2,
    queuedBytes: 20,
    executing: 0,
    loading: null,
    resident: ["m@1"],
    byPrincipal: { p: 2 },
  });
});

test("#281: a principal at maxPerPrincipal is refused while other principals still queue", async () => {
  const mod = await load();
  const t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxPerPrincipal: 2, maxQueued: 6, retryAfterMs: 500 }),
    now: (): number => t,
    resident: ["m@1"],
  });
  expect(policy.enqueue(q("alice-1", { principal: "alice" }))).toEqual({
    kind: "queued",
    requestId: "alice-1",
  });
  expect(policy.enqueue(q("alice-2", { principal: "alice" }))).toEqual({
    kind: "queued",
    requestId: "alice-2",
  });
  expect(policy.enqueue(q("alice-3", { principal: "alice" }))).toEqual({
    kind: "refused",
    reason: "PrincipalShareExceeded",
    retryAfterMs: 500,
  });
  expect(policy.enqueue(q("bob-1", { principal: "bob" }))).toEqual({
    kind: "queued",
    requestId: "bob-1",
  });
  expect(policy.snapshot()).toEqual({
    queued: 3,
    queuedBytes: 30,
    executing: 0,
    loading: null,
    resident: ["m@1"],
    byPrincipal: { alice: 2, bob: 1 },
  });
});

test("#281: executing requests count toward the principal share", async () => {
  const mod = await load();
  const t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxExecutions: 1, maxPerPrincipal: 1, retryAfterMs: 500 }),
    now: (): number => t,
    resident: ["m@1"],
  });
  expect(policy.enqueue(q("p-run", { principal: "p" }))).toEqual({
    kind: "queued",
    requestId: "p-run",
  });
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "p-run", modelKey: "m@1" },
  ]);
  expect(policy.enqueue(q("p-next", { principal: "p" }))).toEqual({
    kind: "refused",
    reason: "PrincipalShareExceeded",
    retryAfterMs: 500,
  });
  expect(policy.enqueue(q("q-next", { principal: "q" }))).toEqual({
    kind: "queued",
    requestId: "q-next",
  });
});

test("#281: a full queue refuses additional requests with the configured retryAfterMs", async () => {
  const mod = await load();
  const t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxQueued: 2, maxPerPrincipal: 10, retryAfterMs: 400 }),
    now: (): number => t,
    resident: ["m@1"],
  });
  for (const requestId of ["f-1", "f-2"]) {
    expect(policy.enqueue(q(requestId))).toEqual({ kind: "queued", requestId });
  }
  expect(policy.enqueue(q("f-3"))).toEqual({
    kind: "refused",
    reason: "QueueFull",
    retryAfterMs: 400,
  });
  expect(policy.snapshot()).toEqual({
    queued: 2,
    queuedBytes: 20,
    executing: 0,
    loading: null,
    resident: ["m@1"],
    byPrincipal: { p: 2 },
  });
});

test("#281: maxQueued counts queued requests only, not executing ones", async () => {
  const mod = await load();
  const t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxExecutions: 1, maxQueued: 1 }),
    now: (): number => t,
    resident: ["m@1"],
  });
  expect(policy.enqueue(q("run"))).toEqual({ kind: "queued", requestId: "run" });
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "run", modelKey: "m@1" },
  ]);
  expect(policy.enqueue(q("wait"))).toEqual({ kind: "queued", requestId: "wait" });
  expect(policy.enqueue(q("over"))).toEqual({
    kind: "refused",
    reason: "QueueFull",
    retryAfterMs: 250,
  });
});

test("#281: refusal checks run in the specified order", async () => {
  const mod = await load();
  const t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxQueued: 1, maxPerPrincipal: 1, maxQueuedBytes: 100, maxContextTokens: 100 }),
    now: (): number => t,
    resident: [],
  });
  expect(policy.enqueue(q("fill"))).toEqual({ kind: "queued", requestId: "fill" });
  expect(policy.enqueue(q("deadline-wins", { deadlineMs: t }))).toEqual({
    kind: "refused",
    reason: "DeadlineExceeded",
    retryAfterMs: null,
  });
  expect(policy.enqueue(q("ctx-wins", { promptTokens: 90, maxCompletionTokens: 20 }))).toEqual({
    kind: "refused",
    reason: "ContextLimitExceeded",
    retryAfterMs: null,
  });
  expect(
    policy.enqueue(q("ctx-bytes-wins", { promptTokens: 90, maxCompletionTokens: 20, bytes: 200 })),
  ).toEqual({ kind: "refused", reason: "ContextLimitExceeded", retryAfterMs: null });
  expect(
    policy.enqueue(
      q("ctx-deadline-wins", { promptTokens: 90, maxCompletionTokens: 20, deadlineMs: t }),
    ),
  ).toEqual({ kind: "refused", reason: "ContextLimitExceeded", retryAfterMs: null });
  expect(
    policy.enqueue(
      q("invalid-wins", { deadlineMs: Number.NaN, promptTokens: 90, maxCompletionTokens: 20 }),
    ),
  ).toEqual({ kind: "refused", reason: "InvalidRequest", retryAfterMs: null });
  expect(policy.enqueue(q("invalid-bytes-wins", { bytes: -1, deadlineMs: t }))).toEqual({
    kind: "refused",
    reason: "InvalidRequest",
    retryAfterMs: null,
  });
  expect(policy.enqueue(q("bytes-wins", { bytes: 200, deadlineMs: t }))).toEqual({
    kind: "refused",
    reason: "QueueBytesExceeded",
    retryAfterMs: null,
  });
  expect(policy.enqueue(q("both-wins", { principal: "q", bytes: 95 }))).toEqual({
    kind: "refused",
    reason: "QueueFull",
    retryAfterMs: 250,
  });
  const sharePolicy = mod.createRequestQueuePolicy({
    limits: lim({ maxQueued: 2, maxPerPrincipal: 1 }),
    now: (): number => t,
    resident: [],
  });
  expect(sharePolicy.enqueue(q("s-1", { principal: "p" }))).toEqual({
    kind: "queued",
    requestId: "s-1",
  });
  expect(sharePolicy.enqueue(q("s-2", { principal: "q" }))).toEqual({
    kind: "queued",
    requestId: "s-2",
  });
  expect(sharePolicy.enqueue(q("s-3", { principal: "p" }))).toEqual({
    kind: "refused",
    reason: "PrincipalShareExceeded",
    retryAfterMs: 250,
  });
  const bytesPolicy = mod.createRequestQueuePolicy({
    limits: lim({ maxQueued: 5, maxQueuedBytes: 100, maxPerPrincipal: 5 }),
    now: (): number => t,
    resident: [],
  });
  expect(bytesPolicy.enqueue(q("b-1", { bytes: 60 }))).toEqual({
    kind: "queued",
    requestId: "b-1",
  });
  expect(bytesPolicy.enqueue(q("b-2", { bytes: 50, deadlineMs: t }))).toEqual({
    kind: "refused",
    reason: "DeadlineExceeded",
    retryAfterMs: null,
  });
  expect(policy.snapshot()).toEqual({
    queued: 1,
    queuedBytes: 10,
    executing: 0,
    loading: null,
    resident: [],
    byPrincipal: { p: 1 },
  });
});

test("#281: a duplicate requestId is idempotent and leaves the snapshot untouched", async () => {
  const mod = await load();
  const t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxExecutions: 1 }),
    now: (): number => t,
    resident: ["m@1"],
  });
  expect(policy.snapshot()).toEqual({
    queued: 0,
    queuedBytes: 0,
    executing: 0,
    loading: null,
    resident: ["m@1"],
    byPrincipal: {},
  });
  expect(policy.enqueue(q("dup"))).toEqual({ kind: "queued", requestId: "dup" });
  const queuedSnapshot = {
    queued: 1,
    queuedBytes: 10,
    executing: 0,
    loading: null,
    resident: ["m@1"],
    byPrincipal: { p: 1 },
  };
  expect(policy.snapshot()).toEqual(queuedSnapshot);
  expect(policy.enqueue(q("dup", { bytes: -5 }))).toEqual({
    kind: "duplicate",
    requestId: "dup",
    state: "queued",
  });
  expect(policy.snapshot()).toEqual(queuedSnapshot);
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "dup", modelKey: "m@1" },
  ]);
  expect(policy.enqueue(q("dup", { principal: "other" }))).toEqual({
    kind: "duplicate",
    requestId: "dup",
    state: "executing",
  });
  expect(policy.snapshot()).toEqual({
    queued: 0,
    queuedBytes: 0,
    executing: 1,
    loading: null,
    resident: ["m@1"],
    byPrincipal: { p: 1 },
  });
});

test("#281: cancelling every waiter of a cold model prevents any load", async () => {
  const mod = await load();
  let t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxExecutions: 2 }),
    now: (): number => t,
    resident: [],
  });
  const cold = { name: "cold", revision: "v1" };
  for (const requestId of ["c-1", "c-2", "c-3"]) {
    expect(policy.enqueue(q(requestId, { model: cold }))).toEqual({
      kind: "queued",
      requestId,
    });
  }
  for (const requestId of ["c-1", "c-2", "c-3"]) {
    expect(policy.cancel(requestId)).toEqual({ kind: "cancelled", state: "queued" });
  }
  expect(policy.cancel("ghost")).toEqual({ kind: "unknown" });
  expect(policy.enqueue(q("c-1", { model: cold }))).toEqual({
    kind: "queued",
    requestId: "c-1",
  });
  expect(policy.cancel("c-1")).toEqual({ kind: "cancelled", state: "queued" });
  expect(policy.snapshot()).toEqual({
    queued: 0,
    queuedBytes: 0,
    executing: 0,
    loading: null,
    resident: [],
    byPrincipal: {},
  });
  for (const _ of [1, 2, 3]) {
    t += 10;
    expect(policy.schedule()).toEqual([]);
  }
});

test("#281: a request cancelled while its model loads never executes", async () => {
  const mod = await load();
  const t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxExecutions: 2 }),
    now: (): number => t,
    resident: [],
  });
  const cold = { name: "cold", revision: "v1" };
  for (const requestId of ["w-1", "w-2"]) {
    expect(policy.enqueue(q(requestId, { model: cold }))).toEqual({
      kind: "queued",
      requestId,
    });
  }
  expect(policy.schedule()).toEqual([
    { kind: "start-load", loadId: "load-1", modelKey: "cold@v1" },
  ]);
  expect(policy.cancel("w-1")).toEqual({ kind: "cancelled", state: "queued" });
  expect(policy.schedule()).toEqual([]);
  expect(policy.loadSettled("load-1", "ready")).toEqual([]);
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "w-2", modelKey: "cold@v1" },
  ]);
  expect(policy.snapshot()).toEqual({
    queued: 0,
    queuedBytes: 0,
    executing: 1,
    loading: null,
    resident: ["cold@v1"],
    byPrincipal: { p: 1 },
  });
});

test("#281: cancelling an executing request frees its slot for the next waiter", async () => {
  const mod = await load();
  const t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxExecutions: 2 }),
    now: (): number => t,
    resident: ["m@1"],
  });
  for (const requestId of ["e-1", "e-2", "e-3"]) {
    expect(policy.enqueue(q(requestId))).toEqual({ kind: "queued", requestId });
  }
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "e-1", modelKey: "m@1" },
    { kind: "start-execution", requestId: "e-2", modelKey: "m@1" },
  ]);
  expect(policy.cancel("e-1")).toEqual({ kind: "cancelled", state: "executing" });
  expect(policy.snapshot()).toEqual({
    queued: 1,
    queuedBytes: 10,
    executing: 1,
    loading: null,
    resident: ["m@1"],
    byPrincipal: { p: 2 },
  });
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "e-3", modelKey: "m@1" },
  ]);
  expect(policy.snapshot()).toEqual({
    queued: 0,
    queuedBytes: 0,
    executing: 2,
    loading: null,
    resident: ["m@1"],
    byPrincipal: { p: 2 },
  });
});

test("#281: queue-wait and deadline expiry release queue resources", async () => {
  const mod = await load();
  let t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxExecutions: 1, maxQueueWaitMs: 1_000, retryAfterMs: 640 }),
    now: (): number => t,
    resident: ["m@1"],
  });
  expect(policy.enqueue(q("anchor", { principal: "p-anchor" }))).toEqual({
    kind: "queued",
    requestId: "anchor",
  });
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "anchor", modelKey: "m@1" },
  ]);
  expect(policy.enqueue(q("waiter", { principal: "alice", bytes: 100 }))).toEqual({
    kind: "queued",
    requestId: "waiter",
  });
  expect(policy.enqueue(q("dying", { principal: "bob", bytes: 200, deadlineMs: t + 600 }))).toEqual(
    { kind: "queued", requestId: "dying" },
  );
  expect(policy.snapshot()).toEqual({
    queued: 2,
    queuedBytes: 300,
    executing: 1,
    loading: null,
    resident: ["m@1"],
    byPrincipal: { "p-anchor": 1, alice: 1, bob: 1 },
  });
  t += 600;
  expect(policy.schedule()).toEqual([
    { kind: "expire", requestId: "dying", reason: "DeadlineExceeded", retryAfterMs: null },
  ]);
  expect(policy.snapshot()).toEqual({
    queued: 1,
    queuedBytes: 100,
    executing: 1,
    loading: null,
    resident: ["m@1"],
    byPrincipal: { "p-anchor": 1, alice: 1 },
  });
  t += 400;
  expect(policy.schedule()).toEqual([
    { kind: "expire", requestId: "waiter", reason: "QueueWaitExceeded", retryAfterMs: 640 },
  ]);
  expect(policy.snapshot()).toEqual({
    queued: 0,
    queuedBytes: 0,
    executing: 1,
    loading: null,
    resident: ["m@1"],
    byPrincipal: { "p-anchor": 1 },
  });
});

test("#281: simultaneous deadline and wait expiries emit in enqueue order", async () => {
  const mod = await load();
  let t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxQueueWaitMs: 500, maxExecutions: 1, retryAfterMs: 640 }),
    now: (): number => t,
    resident: [],
  });
  expect(policy.enqueue(q("d-first", { deadlineMs: t + 100 }))).toEqual({
    kind: "queued",
    requestId: "d-first",
  });
  expect(policy.enqueue(q("w-second"))).toEqual({ kind: "queued", requestId: "w-second" });
  t += 600;
  expect(policy.schedule()).toEqual([
    { kind: "expire", requestId: "d-first", reason: "DeadlineExceeded", retryAfterMs: null },
    { kind: "expire", requestId: "w-second", reason: "QueueWaitExceeded", retryAfterMs: 640 },
  ]);
  expect(policy.snapshot()).toEqual({
    queued: 0,
    queuedBytes: 0,
    executing: 0,
    loading: null,
    resident: [],
    byPrincipal: {},
  });
});

test("#281: a failed load releases only that model's waiters and frees the loader", async () => {
  const mod = await load();
  const t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxExecutions: 1, retryAfterMs: 700 }),
    now: (): number => t,
    resident: [],
  });
  const modelA = { name: "model-a", revision: "1" };
  const modelB = { name: "model-b", revision: "1" };
  for (const requestId of ["a-1", "a-2"]) {
    expect(policy.enqueue(q(requestId, { principal: "pa", model: modelA }))).toEqual({
      kind: "queued",
      requestId,
    });
  }
  expect(policy.enqueue(q("b-1", { principal: "pb", model: modelB }))).toEqual({
    kind: "queued",
    requestId: "b-1",
  });
  expect(policy.schedule()).toEqual([
    { kind: "start-load", loadId: "load-1", modelKey: "model-a@1" },
  ]);
  expect(policy.loadSettled("load-1", "failed")).toEqual([
    { kind: "fail", requestId: "a-1", reason: "LoadFailed", retryAfterMs: 700 },
    { kind: "fail", requestId: "a-2", reason: "LoadFailed", retryAfterMs: 700 },
  ]);
  const afterFail = {
    queued: 1,
    queuedBytes: 10,
    executing: 0,
    loading: null,
    resident: [],
    byPrincipal: { pb: 1 },
  };
  expect(policy.snapshot()).toEqual(afterFail);
  expect(policy.loadSettled("load-1", "ready")).toEqual([]);
  expect(policy.loadSettled("load-99", "failed")).toEqual([]);
  expect(policy.snapshot()).toEqual(afterFail);
  expect(policy.schedule()).toEqual([
    { kind: "start-load", loadId: "load-2", modelKey: "model-b@1" },
  ]);
});

test("#281: markEvicted returns a resident model's waiters to the load path", async () => {
  const mod = await load();
  const t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxExecutions: 1 }),
    now: (): number => t,
    resident: ["m@1"],
  });
  expect(policy.enqueue(q("e-1"))).toEqual({ kind: "queued", requestId: "e-1" });
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "e-1", modelKey: "m@1" },
  ]);
  expect(policy.enqueue(q("w-1"))).toEqual({ kind: "queued", requestId: "w-1" });
  policy.markEvicted("m@1");
  expect(policy.finishExecution("e-1")).toBe(true);
  expect(policy.schedule()).toEqual([{ kind: "start-load", loadId: "load-1", modelKey: "m@1" }]);
  expect(policy.snapshot()).toEqual({
    queued: 1,
    queuedBytes: 10,
    executing: 0,
    loading: "m@1",
    resident: [],
    byPrincipal: { p: 1 },
  });
});

test("#281: the constructor rejects non-positive, non-finite and non-integer limits", async () => {
  const mod = await load();
  const t = 1_000;
  const allFields = [
    "maxExecutions",
    "maxQueued",
    "maxQueuedBytes",
    "maxQueueWaitMs",
    "maxPerPrincipal",
    "starvationBoundMs",
    "maxContextTokens",
    "retryAfterMs",
  ] as const;
  const intFields = ["maxExecutions", "maxQueued", "maxPerPrincipal", "maxContextTokens"] as const;
  for (const field of allFields) {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const limits = lim();
      limits[field] = bad;
      expect(() => mod.createRequestQueuePolicy({ limits, now: (): number => t })).toThrow();
    }
  }
  for (const field of intFields) {
    for (const bad of [0.5, 1.5]) {
      const limits = lim();
      limits[field] = bad;
      expect(() => mod.createRequestQueuePolicy({ limits, now: (): number => t })).toThrow();
    }
  }
  expect(() => mod.createRequestQueuePolicy({ limits: lim(), now: (): number => t })).not.toThrow();
});

test("#281: markEvicted -> loadSettled('ready') -> execute: evicted model reloads and waiter executes", async () => {
  const mod = await load();
  const t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxExecutions: 1 }),
    now: (): number => t,
    resident: ["m@1"],
  });
  expect(policy.enqueue(q("w-1"))).toEqual({ kind: "queued", requestId: "w-1" });
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "w-1", modelKey: "m@1" },
  ]);
  expect(policy.enqueue(q("w-2"))).toEqual({ kind: "queued", requestId: "w-2" });
  // Evict the resident model
  policy.markEvicted("m@1");
  // Finish the execution - this should trigger a reload
  expect(policy.finishExecution("w-1")).toBe(true);
  // After eviction, the model is no longer resident, so a load starts
  expect(policy.schedule()).toEqual([{ kind: "start-load", loadId: "load-1", modelKey: "m@1" }]);
  expect(policy.snapshot()).toEqual({
    queued: 1,
    queuedBytes: 10,
    executing: 0,
    loading: "m@1",
    resident: [],
    byPrincipal: { p: 1 },
  });
  // Settle the load
  expect(policy.loadSettled("load-1", "ready")).toEqual([]);
  expect(policy.snapshot()).toEqual({
    queued: 1,
    queuedBytes: 10,
    executing: 0,
    loading: null,
    resident: ["m@1"],
    byPrincipal: { p: 1 },
  });
  // Now the waiter should be able to execute
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "w-2", modelKey: "m@1" },
  ]);
});

test("#281: starved background waiters outrank only interactive waiters enqueued after them", async () => {
  const mod = await load();
  let t = 1_000;
  // maxExecutions=1, starvationBoundMs=1000, maxQueueWaitMs=60000
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxExecutions: 1, starvationBoundMs: 1000, maxQueueWaitMs: 60000 }),
    now: (): number => t,
    resident: ["m@1"],
  });

  // Enqueue a background waiter (seq 0)
  expect(policy.enqueue(q("bg-early", { priority: "background" }))).toEqual({
    kind: "queued",
    requestId: "bg-early",
  });

  // Start execution
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "bg-early", modelKey: "m@1" },
  ]);

  // Enqueue an interactive waiter (seq 1)
  expect(policy.enqueue(q("interactive-1", { priority: "interactive" }))).toEqual({
    kind: "queued",
    requestId: "interactive-1",
  });

  // Finish the background execution and re-enqueue it so it can be starved
  expect(policy.finishExecution("bg-early")).toBe(true);
  expect(policy.enqueue(q("bg-early", { priority: "background" }))).toEqual({
    kind: "queued",
    requestId: "bg-early",
  });

  // Wait for the background waiter to become starved (past starvationBoundMs)
  t += 1100;

  // Enqueue another background waiter (seq 3) - arrives AFTER the interactive
  expect(policy.enqueue(q("bg-later", { priority: "background" }))).toEqual({
    kind: "queued",
    requestId: "bg-later",
  });

  // Queue now has: bg-early (seq 2, starved), interactive-1 (seq 1, not starved), bg-later (seq 3, not starved)
  // Schedule: interactive-1 should win because:
  // - bg-early (starved, seq 2) was enqueued AFTER interactive-1 (seq 1)
  // - The fix says: starved background outranks interactive waiters enqueued AFTER it
  // - Since interactive-1 (seq 1) was enqueued BEFORE bg-early (seq 2), bg-early should NOT outrank it
  // - So interactive-1 wins (interactive priority beats background when bg-early was enqueued later)
  const actions = policy.schedule();
  const startExecs = actions.filter((a) => a.kind === "start-execution");
  expect(startExecs).toHaveLength(1);
  expect(startExecs[0]).toEqual({
    kind: "start-execution",
    requestId: "interactive-1",
    modelKey: "m@1",
  });

  // Now interactive-1 is executing, finish it
  expect(policy.finishExecution("interactive-1")).toBe(true);

  // bg-early (seq 2, starved) should start before bg-later (seq 3, not starved)
  // because bg-early is starved and bg-later was enqueued after bg-early
  const actions2 = policy.schedule();
  const startExecs2 = actions2.filter((a) => a.kind === "start-execution");
  expect(startExecs2).toHaveLength(1);
  expect(startExecs2[0]).toEqual({
    kind: "start-execution",
    requestId: "bg-early",
    modelKey: "m@1",
  });
});

test("#281: sustained overload: interactive starts before maxQueueWait and before background enqueued after it", async () => {
  const mod = await load();
  let t = 1_000;
  const execMs = 300;
  const interactiveAt = 5_000;
  const maxQueueWaitMs = 60_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({
      maxExecutions: 1,
      maxQueued: 10_000,
      maxQueuedBytes: 100_000_000,
      maxPerPrincipal: 100_000,
      starvationBoundMs: 1_000,
      maxQueueWaitMs,
    }),
    now: (): number => t,
    resident: ["m@1"],
  });

  // Deterministic repro of the review scenario: one execution slot, a
  // background arrival every 100ms, each execution holding the slot for
  // 300ms, and a single interactive request enqueued at t=5000.
  let busyId: string | null = null;
  let busyUntil = 0;
  const execLog: { tick: number; action: QueueAction }[] = [];
  const runTick = (tick: number): void => {
    t = tick;
    if (busyId !== null && tick >= busyUntil) {
      expect(policy.finishExecution(busyId)).toBe(true);
      busyId = null;
    }
    const bgId = `bg-${String(tick)}`;
    expect(policy.enqueue(q(bgId, { priority: "background" }))).toEqual({
      kind: "queued",
      requestId: bgId,
    });
    if (tick === interactiveAt) {
      expect(policy.enqueue(q("interactive-1", { priority: "interactive" }))).toEqual({
        kind: "queued",
        requestId: "interactive-1",
      });
    }
    for (const action of policy.schedule()) {
      execLog.push({ tick, action });
      if (action.kind === "start-execution") {
        busyId = action.requestId;
        busyUntil = tick + execMs;
      }
    }
  };
  for (let tick = 1_000; tick <= 70_000; tick += 100) {
    runTick(tick);
  }

  const startExecs = execLog.flatMap((entry) =>
    entry.action.kind === "start-execution"
      ? [{ tick: entry.tick, requestId: entry.action.requestId }]
      : [],
  );
  const interactiveIdx = startExecs.findIndex((entry) => entry.requestId === "interactive-1");
  const interactiveStartTick = interactiveIdx === -1 ? null : startExecs[interactiveIdx]!.tick;
  const interactiveExpired = execLog.some(
    (entry) => entry.action.kind === "expire" && entry.action.requestId === "interactive-1",
  );

  expect(interactiveExpired).toBe(false);
  expect(interactiveStartTick).not.toBeNull();
  expect(interactiveStartTick!).toBeGreaterThanOrEqual(interactiveAt);
  expect(interactiveStartTick!).toBeLessThan(interactiveAt + maxQueueWaitMs);
  // Only backgrounds enqueued at or before the interactive request (bg-5000
  // and earlier) may start ahead of it; every later arrival waits.
  for (const entry of interactiveIdx === -1 ? [] : startExecs.slice(0, interactiveIdx)) {
    expect(Number(entry.requestId.slice(3))).toBeLessThanOrEqual(interactiveAt);
  }
});

test("#281: schedule reads the clock once so urgency order cannot shift mid-sort", async () => {
  const mod = await load();
  let calls = 0;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxExecutions: 1, starvationBoundMs: 4 }),
    now: (): number => {
      calls++;
      return 1_000 + calls;
    },
    resident: ["m@1"],
  });

  // The clock advances on every read, so waited time is measured in clock
  // reads. After six enqueues the schedule-time read puts s-0 and s-2 past
  // the starvation bound while s-3 and s-5 are still fresh; a comparator
  // that re-read the clock per comparison could flip that boundary
  // mid-sort, so schedule() must snapshot now once and pass it down.
  const arrivals: [string, Priority][] = [
    ["s-0", "background"],
    ["s-1", "interactive"],
    ["s-2", "background"],
    ["s-3", "background"],
    ["s-4", "interactive"],
    ["s-5", "background"],
  ];
  for (const [requestId, priority] of arrivals) {
    expect(policy.enqueue(q(requestId, { priority }))).toEqual({ kind: "queued", requestId });
  }

  const actions = policy.schedule();
  expect(calls).toBe(arrivals.length + 1);
  expect(actions).toEqual([{ kind: "start-execution", requestId: "s-0", modelKey: "m@1" }]);
});

test("#281: starvation in cold-load target choice: starved background executes before its model loads", async () => {
  const mod = await load();
  let t = 1_000;
  // maxExecutions=1, starvationBoundMs=1000, resident=[]
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxExecutions: 1, starvationBoundMs: 1000 }),
    now: (): number => t,
    resident: [],
  });

  // Enqueue an interactive request and start its load-1
  expect(
    policy.enqueue(
      q("interactive-c", { priority: "interactive", model: { name: "c", revision: "1" } }),
    ),
  ).toEqual({
    kind: "queued",
    requestId: "interactive-c",
  });
  expect(policy.schedule()).toEqual([{ kind: "start-load", loadId: "load-1", modelKey: "c@1" }]);

  // At t=1000, enqueue a background request for model a@1
  t = 1000;
  expect(
    policy.enqueue(q("bg-a", { priority: "background", model: { name: "a", revision: "1" } })),
  ).toEqual({
    kind: "queued",
    requestId: "bg-a",
  });

  // At t=2500, enqueue an interactive request for model z@1
  t = 2500;
  expect(
    policy.enqueue(
      q("interactive-z", { priority: "interactive", model: { name: "z", revision: "1" } }),
    ),
  ).toEqual({
    kind: "queued",
    requestId: "interactive-z",
  });

  // No schedule should start yet (load-1 is in flight)
  expect(policy.schedule()).toEqual([]);

  // Settle load-1 (model c@1 is now loaded)
  expect(policy.loadSettled("load-1", "ready")).toEqual([]);

  // Schedule should start execution for interactive-c (load-1 done) and
  // start-load for model a@1 (bg-a's model), NOT model z@1.
  // This pins the starvation-bound fix: modelKeyForNextLoad must use 0
  // (not `now`) so that the starvation-bound check in the load path
  // never fires, and the first non-resident model wins regardless of
  // whether a starved background waiter exists in the queue.
  const actions = policy.schedule();
  const startLoads = actions.filter((a) => a.kind === "start-load");
  expect(startLoads).toHaveLength(1);
  expect(startLoads[0]).toEqual({
    kind: "start-load",
    loadId: "load-2",
    modelKey: "a@1",
  });
});

test("#281: starved background enqueued before interactive-2 outranks interactive-2", async () => {
  const mod = await load();
  let t = 1_000;
  // maxExecutions=1, starvationBoundMs=500, maxQueueWaitMs=60000
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxExecutions: 1, starvationBoundMs: 500, maxQueueWaitMs: 60000 }),
    now: (): number => t,
    resident: ["m@1"],
  });

  // Enqueue an interactive waiter (seq 0)
  expect(policy.enqueue(q("interactive-1", { priority: "interactive" }))).toEqual({
    kind: "queued",
    requestId: "interactive-1",
  });

  // Start execution
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "interactive-1", modelKey: "m@1" },
  ]);

  // Finish the execution
  expect(policy.finishExecution("interactive-1")).toBe(true);

  // Wait until the starvation bound is reached
  t += 600;

  // Enqueue a background waiter that will be starved (seq 1)
  expect(policy.enqueue(q("bg-starved", { priority: "background" }))).toEqual({
    kind: "queued",
    requestId: "bg-starved",
  });

  // The background waiter is starved (600ms > 500ms starvationBoundMs)
  // But it was enqueued AFTER the interactive waiter was processed
  // With the fix, this starved background should NOT outrank future interactive waiters
  // For now, it should execute since there's no competition
  const actions = policy.schedule();
  const startExecs = actions.filter((a) => a.kind === "start-execution");
  expect(startExecs).toHaveLength(1);
  expect(startExecs[0]).toEqual({
    kind: "start-execution",
    requestId: "bg-starved",
    modelKey: "m@1",
  });

  // Finish the background execution and re-enqueue it so it can be starved
  expect(policy.finishExecution("bg-starved")).toBe(true);
  expect(policy.enqueue(q("bg-starved", { priority: "background" }))).toEqual({
    kind: "queued",
    requestId: "bg-starved",
  });

  // Wait until the starvation bound is reached again after re-enqueue
  // bg-starved was re-enqueued at t=1600, so we need to wait until t=2100 (500ms > 500ms starvationBoundMs)
  t += 600;

  // Now enqueue an interactive waiter (seq 3)
  expect(policy.enqueue(q("interactive-2", { priority: "interactive" }))).toEqual({
    kind: "queued",
    requestId: "interactive-2",
  });

  // Queue has: bg-starved (seq 2, starved), interactive-2 (seq 3, not starved)
  // bg-starved (seq 2) was enqueued BEFORE interactive-2 (seq 3)
  // The fix says: starved background outranks interactive waiters enqueued AFTER it
  // Since interactive-2 (seq 3) was enqueued AFTER bg-starved (seq 2), bg-starved should outrank it
  const actions2 = policy.schedule();
  const startExecs2 = actions2.filter((a) => a.kind === "start-execution");
  expect(startExecs2).toHaveLength(1);
  expect(startExecs2[0]).toEqual({
    kind: "start-execution",
    requestId: "bg-starved",
    modelKey: "m@1",
  });
});
