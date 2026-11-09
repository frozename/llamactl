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
  maxExecutions: over.maxExecutions ?? 1,
  maxQueued: over.maxQueued ?? 16,
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

test("#281: an interactive request starts ahead of an earlier background request", async () => {
  const mod = await load();
  const t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ starvationBoundMs: 1_000 }),
    now: (): number => t,
    resident: ["m@1"],
  });
  expect(policy.enqueue(q("bg-first", { priority: "background" }))).toEqual({
    kind: "queued",
    requestId: "bg-first",
  });
  expect(policy.enqueue(q("int-late", { priority: "interactive" }))).toEqual({
    kind: "queued",
    requestId: "int-late",
  });
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "int-late", modelKey: "m@1" },
  ]);
  expect(policy.snapshot()).toEqual({
    queued: 1,
    queuedBytes: 10,
    executing: 1,
    loading: null,
    resident: ["m@1"],
    byPrincipal: { p: 2 },
  });
  expect(policy.finishExecution("int-late")).toBe(true);
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "bg-first", modelKey: "m@1" },
  ]);
});

test("#281: a background request at starvationBoundMs outranks a later interactive request", async () => {
  const mod = await load();
  let t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ starvationBoundMs: 1_000 }),
    now: (): number => t,
    resident: ["m@1"],
  });
  expect(policy.enqueue(q("bg-vet", { priority: "background" }))).toEqual({
    kind: "queued",
    requestId: "bg-vet",
  });
  t = 1_999;
  expect(policy.enqueue(q("int-early", { priority: "interactive" }))).toEqual({
    kind: "queued",
    requestId: "int-early",
  });
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "int-early", modelKey: "m@1" },
  ]);
  expect(policy.finishExecution("int-early")).toBe(true);
  t = 2_000;
  expect(policy.enqueue(q("int-late", { priority: "interactive" }))).toEqual({
    kind: "queued",
    requestId: "int-late",
  });
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "bg-vet", modelKey: "m@1" },
  ]);
  expect(policy.finishExecution("bg-vet")).toBe(true);
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "int-late", modelKey: "m@1" },
  ]);
});

test("#281: a steady interactive stream cannot starve a background request past its bound", async () => {
  const mod = await load();
  let t = 1_000;
  const bgEnqueueT = t;
  const TICK_MS = 100;
  const BOUND_MS = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxQueued: 50, starvationBoundMs: BOUND_MS }),
    now: (): number => t,
    resident: ["m@1"],
  });
  expect(policy.enqueue(q("bg-lurker", { priority: "background" }))).toEqual({
    kind: "queued",
    requestId: "bg-lurker",
  });
  let running: string | null = null;
  let bgStartT: number | null = null;
  const started: string[] = [];
  for (const i of Array.from({ length: 16 }, (_, n) => n + 1)) {
    t += TICK_MS;
    const requestId = `int-${String(i)}`;
    expect(policy.enqueue(q(requestId, { priority: "interactive" }))).toEqual({
      kind: "queued",
      requestId,
    });
    if (running !== null) {
      expect(policy.finishExecution(running)).toBe(true);
    }
    const actions = policy.schedule();
    expect(actions).toHaveLength(1);
    const action = actions[0]!;
    expect(action.kind).toBe("start-execution");
    if (action.kind === "start-execution") {
      started.push(action.requestId);
      if (action.requestId === "bg-lurker" && bgStartT === null) {
        bgStartT = t;
      }
      running = action.requestId;
    }
  }
  const waited = (bgStartT ?? Number.NEGATIVE_INFINITY) - bgEnqueueT;
  expect(waited).toBeGreaterThanOrEqual(BOUND_MS);
  expect(waited).toBeLessThanOrEqual(BOUND_MS + TICK_MS);
  expect(started).toContain("bg-lurker");
  expect(started.filter((id) => id.startsWith("int-"))).toHaveLength(15);
});

test("#281: requests of the same urgency class start in enqueue order", async () => {
  const mod = await load();
  const t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ starvationBoundMs: 1_000_000 }),
    now: (): number => t,
    resident: ["m@1"],
  });
  const order: { id: string; priority: Priority }[] = [
    { id: "i-1", priority: "interactive" },
    { id: "b-1", priority: "background" },
    { id: "i-2", priority: "interactive" },
    { id: "b-2", priority: "background" },
    { id: "i-3", priority: "interactive" },
  ];
  for (const spec of order) {
    expect(policy.enqueue(q(spec.id, { priority: spec.priority }))).toEqual({
      kind: "queued",
      requestId: spec.id,
    });
  }
  const start = (requestId: string): QueueAction[] => [
    { kind: "start-execution", requestId, modelKey: "m@1" },
  ];
  expect(policy.schedule()).toEqual(start("i-1"));
  expect(policy.finishExecution("i-1")).toBe(true);
  expect(policy.schedule()).toEqual(start("i-2"));
  expect(policy.finishExecution("i-2")).toBe(true);
  expect(policy.schedule()).toEqual(start("i-3"));
  expect(policy.finishExecution("i-3")).toBe(true);
  expect(policy.schedule()).toEqual(start("b-1"));
  expect(policy.finishExecution("b-1")).toBe(true);
  expect(policy.schedule()).toEqual(start("b-2"));
  expect(policy.finishExecution("b-2")).toBe(true);
  expect(policy.schedule()).toEqual([]);
});

test("#281: work-conserving execution — a warm-model request behind a cold-model waits slot", async () => {
  const mod = await load();
  const t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxExecutions: 1 }),
    now: (): number => t,
    resident: ["warm@1"],
  });
  // A is cold (model@2), B is warm (warm@1, which is resident)
  expect(policy.enqueue(q("a", { model: { name: "model", revision: "2" } }))).toEqual({
    kind: "queued",
    requestId: "a",
  });
  expect(policy.enqueue(q("b", { model: { name: "warm", revision: "1" } }))).toEqual({
    kind: "queued",
    requestId: "b",
  });
  // Work-conserving: both start-execution for warm and start-load for cold
  // happen in the same schedule() call (warm model is available immediately)
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "b", modelKey: "warm@1" },
    { kind: "start-load", loadId: "load-1", modelKey: "model@2" },
  ]);
  expect(policy.snapshot()).toEqual({
    queued: 1,
    queuedBytes: 10,
    executing: 1,
    loading: "model@2",
    resident: ["warm@1"],
    byPrincipal: { p: 2 },
  });
});

test("#281: load choice picks the most urgent waiter, not alphabetically", async () => {
  const mod = await load();
  const t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxExecutions: 1 }),
    now: (): number => t,
    resident: [],
  });
  // Background model 'a' enqueued first
  expect(
    policy.enqueue(q("a", { priority: "background", model: { name: "a", revision: "1" } })),
  ).toEqual({ kind: "queued", requestId: "a" });
  // Interactive model 'z' enqueued second — should win load choice
  expect(
    policy.enqueue(q("z", { priority: "interactive", model: { name: "z", revision: "1" } })),
  ).toEqual({ kind: "queued", requestId: "z" });
  // Load should target z (interactive) not a (background, alphabetically first)
  expect(policy.schedule()).toEqual([{ kind: "start-load", loadId: "load-1", modelKey: "z@1" }]);
});

test("#281: a starved background waiter's model eventually gets loaded", async () => {
  const mod = await load();
  let t = 1_000;
  const policy = mod.createRequestQueuePolicy({
    limits: lim({ maxExecutions: 1, starvationBoundMs: 1_000 }),
    now: (): number => t,
    resident: [],
  });
  // Background model 'a' enqueued first
  expect(
    policy.enqueue(q("a", { priority: "background", model: { name: "a", revision: "1" } })),
  ).toEqual({ kind: "queued", requestId: "a" });
  // Interactive model 'z' enqueued second
  t = 1_500;
  expect(
    policy.enqueue(q("z", { priority: "interactive", model: { name: "z", revision: "1" } })),
  ).toEqual({ kind: "queued", requestId: "z" });
  // First load picks z (interactive)
  expect(policy.schedule()).toEqual([{ kind: "start-load", loadId: "load-1", modelKey: "z@1" }]);
  // z loads ready; schedule starts z executing AND starts loading a (starved bg)
  expect(policy.loadSettled("load-1", "ready")).toEqual([]);
  expect(policy.schedule()).toEqual([
    { kind: "start-execution", requestId: "z", modelKey: "z@1" },
    { kind: "start-load", loadId: "load-2", modelKey: "a@1" },
  ]);
  // z finishes; a's model is still loading, so no execution yet
  expect(policy.finishExecution("z")).toBe(true);
  expect(policy.schedule()).toEqual([]);
  // a's model finishes loading
  expect(policy.loadSettled("load-2", "ready")).toEqual([]);
  t = 2_500;
  // Now a can execute (its model is loaded and a is starved)
  expect(policy.schedule()).toEqual([{ kind: "start-execution", requestId: "a", modelKey: "a@1" }]);
});
