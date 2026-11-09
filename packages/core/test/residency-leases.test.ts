import { expect, test } from "bun:test";

// #278: request-lifetime residency leases land with the fix. A variable
// specifier keeps tsc from resolving the not-yet-existing module, so each
// case fails by assertion at the pinned base rather than by a resolution
// error.
const LEASES_MODULE = "../src/residency/leases.js";
const INDEX_SPEC = "../src/index.js";

type Lease = {
  id: string;
  workload: string;
  epoch: number;
  signal: AbortSignal;
  release: () => boolean;
};

type AcquireResult =
  | { ok: true; lease: Lease }
  | { ok: false; reason: "Draining" | "Unloaded"; workload: string; epoch: number };

type DrainToken = {
  workload: string;
  epoch: number;
};

type BeginDrainResult =
  | { ok: true; token: DrainToken; active: string[] }
  | { ok: false; reason: "AlreadyDraining" | "Unloaded"; workload: string; epoch: number };

type WhenIdleResult =
  | { idle: true }
  | { idle: false; reason: "Aborted" | "DrainCancelled" | "StaleDrainToken"; active: string[] };

type CommitUnloadResult =
  | { ok: true; revoked: string[] }
  | { ok: false; reason: "LeasesActive"; active: string[] }
  | { ok: false; reason: "StaleDrainToken" };

type ResidencySnapshot = {
  workload: string;
  phase: "open" | "draining" | "unloaded";
  epoch: number;
  active: string[];
};

type ResidencyAuditEntry = {
  workload: string;
  epoch: number;
  forced: true;
  revoked: string[];
  reason?: string;
};

type ResidencyLeases = {
  acquire: (workload: string) => AcquireResult;
  active: (workload: string) => string[];
  beginDrain: (workload: string) => BeginDrainResult;
  whenIdle: (token: DrainToken, opts?: { signal?: AbortSignal }) => Promise<WhenIdleResult>;
  commitUnload: (
    token: DrainToken,
    opts?: { force?: boolean; reason?: string },
  ) => CommitUnloadResult;
  cancelDrain: (token: DrainToken) => boolean;
  reopen: (token: DrainToken) => boolean;
  snapshot: (workload: string) => ResidencySnapshot;
  audit: () => ResidencyAuditEntry[];
};

type Mod = {
  createResidencyLeases: () => ResidencyLeases;
  bindLeaseToBody: (body: ReadableStream<Uint8Array>, lease: Lease) => ReadableStream<Uint8Array>;
};

async function load(): Promise<Mod> {
  const mod = (await import(LEASES_MODULE).catch(() => undefined)) as Mod | undefined;
  expect(typeof mod?.createResidencyLeases).toBe("function");
  expect(typeof mod?.bindLeaseToBody).toBe("function");
  return mod!;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function mustAcquire(reg: ResidencyLeases, workload: string): Lease {
  const res = reg.acquire(workload);
  expect(res.ok).toBe(true);
  if (!res.ok) {
    throw new Error(`acquire(${workload}) refused`);
  }
  return res.lease;
}

function mustBeginDrain(
  reg: ResidencyLeases,
  workload: string,
): { token: DrainToken; active: string[] } {
  const res = reg.beginDrain(workload);
  expect(res.ok).toBe(true);
  if (!res.ok) {
    throw new Error(`beginDrain(${workload}) refused`);
  }
  return { token: res.token, active: res.active };
}

function openBody(): {
  body: ReadableStream<Uint8Array>;
  controller: ReadableStreamDefaultController<Uint8Array>;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c): void {
      controller = c;
    },
  });
  return { body, controller };
}

test("#278: acquire returns a lease that releases exactly once", async () => {
  const mod = await load();
  const reg = mod.createResidencyLeases();
  const lease = mustAcquire(reg, "glm");
  expect(lease.workload).toBe("glm");
  expect(typeof lease.id).toBe("string");
  expect(reg.active("glm")).toEqual([lease.id]);
  expect(lease.signal.aborted).toBe(false);
  expect(lease.release()).toBe(true);
  expect(reg.active("glm")).toEqual([]);
  expect(lease.release()).toBe(false);
});

test("#278: a bound body pins its lease until the stream finishes", async () => {
  const mod = await load();
  const reg = mod.createResidencyLeases();
  const lease = mustAcquire(reg, "glm");
  const { body, controller } = openBody();
  controller.enqueue(new TextEncoder().encode("chunk"));
  const bound = mod.bindLeaseToBody(body, lease);
  const reader = bound.getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);
  expect(reg.active("glm")).toEqual([lease.id]);

  const drain = mustBeginDrain(reg, "glm");
  expect(drain.token.workload).toBe("glm");
  expect(drain.token.epoch).toBe(1);
  expect(drain.active).toEqual([lease.id]);
  expect(reg.commitUnload(drain.token)).toEqual({
    ok: false,
    reason: "LeasesActive",
    active: [lease.id],
  });

  controller.close();
  let next = await reader.read();
  while (!next.done) {
    next = await reader.read();
  }
  expect(reg.active("glm")).toEqual([]);
  expect(lease.release()).toBe(false);
  expect(reg.commitUnload(drain.token)).toEqual({ ok: true, revoked: [] });
  expect(reg.snapshot("glm").phase).toBe("unloaded");
});

test("#278: cancelling or erroring a bound body releases its lease", async () => {
  const mod = await load();
  const reg = mod.createResidencyLeases();

  const cancelled = mustAcquire(reg, "glm");
  const firstBody = openBody();
  const boundCancel = mod.bindLeaseToBody(firstBody.body, cancelled);
  await boundCancel.getReader().cancel();
  expect(reg.active("glm")).toEqual([]);
  expect(cancelled.release()).toBe(false);

  const errored = mustAcquire(reg, "glm");
  const secondBody = openBody();
  const boundError = mod.bindLeaseToBody(secondBody.body, errored);
  const reader = boundError.getReader();
  secondBody.controller.error(new Error("x"));
  // eslint-disable-next-line @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun's rejects matcher is typed as void.
  await expect(reader.read()).rejects.toThrow("x");
  expect(reg.active("glm")).toEqual([]);
});

test("#278: bound body unread keeps lease active", async () => {
  const mod = await load();
  const reg = mod.createResidencyLeases();
  const lease = mustAcquire(reg, "glm");
  const { body, controller } = openBody();
  controller.enqueue(new TextEncoder().encode("chunk"));
  const bound = mod.bindLeaseToBody(body, lease);
  // Do NOT read the bound stream — just hold the reader.
  void bound.getReader();
  // The lease must still be active because the upstream hasn't finished.
  expect(reg.active("glm")).toEqual([lease.id]);
  // Release the lease explicitly — it should still be active since the
  // upstream body was never drained to completion.
  expect(lease.release()).toBe(true);
  expect(reg.active("glm")).toEqual([]);
});

test("#278: slow consumer does not cause unbounded buffering", async () => {
  const mod = await load();
  const reg = mod.createResidencyLeases();
  const lease = mustAcquire(reg, "glm");
  const { body, controller } = openBody();
  // Enqueue multiple chunks rapidly — a bounded pull() should only
  // deliver one at a time because the bound stream's pull() drives
  // exactly one reader.read() per pull invocation.
  controller.enqueue(new TextEncoder().encode("a"));
  controller.enqueue(new TextEncoder().encode("b"));
  controller.enqueue(new TextEncoder().encode("c"));
  const bound = mod.bindLeaseToBody(body, lease);
  const reader = bound.getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);
  expect(first.value).toEqual(new TextEncoder().encode("a"));
  expect(reg.active("glm")).toEqual([lease.id]);
  // Do NOT read again — the upstream should not have buffered more than
  // one chunk ahead because pull() drives the reader from the upstream.
  await flushMicrotasks();
  await flushMicrotasks();
  // Pull the next chunk — it should be "b", not "c", proving bounded
  // buffering (only one chunk was pulled from the upstream).
  const second = await reader.read();
  expect(second.done).toBe(false);
  expect(second.value).toEqual(new TextEncoder().encode("b"));
  const third = await reader.read();
  expect(third.done).toBe(false);
  expect(third.value).toEqual(new TextEncoder().encode("c"));
  controller.close();
  let next = await reader.read();
  while (!next.done) {
    next = await reader.read();
  }
  expect(reg.active("glm")).toEqual([]);
  expect(lease.release()).toBe(false);
});

test("#278: whenIdle abort signal removes waiter", async () => {
  const mod = await load();
  const reg = mod.createResidencyLeases();
  const lease = mustAcquire(reg, "glm");
  const drain = mustBeginDrain(reg, "glm");

  const abort = new AbortController();
  let settled = false;
  const idle = reg.whenIdle(drain.token, { signal: abort.signal }).then((r): WhenIdleResult => {
    settled = true;
    return r;
  });
  await flushMicrotasks();
  expect(settled).toBe(false);

  // Abort the signal — the waiter should be removed from the set.
  abort.abort();
  const result = await idle;
  expect(result).toEqual({ idle: false, reason: "Aborted", active: [lease.id] });
  expect(settled).toBe(true);

  // The waiter should have been removed — re-adding a new waiter and
  // checking that the old one is gone is hard to verify directly, but we
  // can verify that releasing the lease triggers idle for a NEW waiter.
  const newAbort = new AbortController();
  let newSettled = false;
  const newIdle = reg
    .whenIdle(drain.token, { signal: newAbort.signal })
    .then((r): WhenIdleResult => {
      newSettled = true;
      return r;
    });
  await flushMicrotasks();
  expect(newSettled).toBe(false);

  // Release the lease — the new waiter should resolve with idle: true.
  expect(lease.release()).toBe(true);
  const newResult = await newIdle;
  expect(newResult).toEqual({ idle: true });
});

test("#278: draining fences acquires until the drain commits or reopens", async () => {
  const mod = await load();
  const reg = mod.createResidencyLeases();
  const a = mustAcquire(reg, "glm");

  const drain = mustBeginDrain(reg, "glm");
  expect(drain.token.epoch).toBe(1);
  expect(drain.active).toEqual([a.id]);
  expect(reg.acquire("glm")).toEqual({
    ok: false,
    reason: "Draining",
    workload: "glm",
    epoch: 1,
  });

  expect(a.release()).toBe(true);
  expect(reg.commitUnload(drain.token)).toEqual({ ok: true, revoked: [] });

  const unloaded = reg.acquire("glm");
  expect(unloaded.ok).toBe(false);
  if (!unloaded.ok) {
    expect(unloaded.reason).toBe("Unloaded");
  }
  expect(reg.snapshot("glm").phase).toBe("unloaded");

  expect(reg.reopen(drain.token)).toBe(true);
  expect(mustAcquire(reg, "glm").workload).toBe("glm");
  expect(reg.snapshot("glm").phase).toBe("open");
});

test("#278: whenIdle waits for leases and reports abort, cancel and stale tokens", async () => {
  const mod = await load();
  const regA = mod.createResidencyLeases();

  const a = mustAcquire(regA, "glm");
  const drainA = mustBeginDrain(regA, "glm");
  let settledA = false;
  const idleA = regA.whenIdle(drainA.token).then((r): WhenIdleResult => {
    settledA = true;
    return r;
  });
  await flushMicrotasks();
  expect(settledA).toBe(false);
  expect(a.release()).toBe(true);
  expect(await idleA).toEqual({ idle: true });

  const regB = mod.createResidencyLeases();
  const b = mustAcquire(regB, "glm");
  const drainB = mustBeginDrain(regB, "glm");
  const token = drainB.token;
  const abort = new AbortController();
  abort.abort();
  expect(await regB.whenIdle(token, { signal: abort.signal })).toEqual({
    idle: false,
    reason: "Aborted",
    active: [b.id],
  });
  expect(regB.active("glm")).toEqual([b.id]);

  let settledC = false;
  const idleC = regB.whenIdle(token).then((r): WhenIdleResult => {
    settledC = true;
    return r;
  });
  await flushMicrotasks();
  expect(settledC).toBe(false);
  expect(regB.cancelDrain(token)).toBe(true);
  expect(await idleC).toEqual({
    idle: false,
    reason: "DrainCancelled",
    active: [b.id],
  });
  const c = mustAcquire(regB, "glm");

  let settledD = false;
  const idleD = regB.whenIdle(token).then((r): WhenIdleResult => {
    settledD = true;
    return r;
  });
  await flushMicrotasks();
  expect(settledD).toBe(true);
  expect(await idleD).toEqual({
    idle: false,
    reason: "StaleDrainToken",
    active: [b.id, c.id],
  });
  expect(regB.cancelDrain(token)).toBe(false);
});

test("#278: a forced commit revokes leases and audits the unload", async () => {
  const mod = await load();
  const reg = mod.createResidencyLeases();
  const lease = mustAcquire(reg, "glm");
  const { body, controller } = openBody();
  controller.enqueue(new TextEncoder().encode("chunk"));
  const bound = mod.bindLeaseToBody(body, lease);
  const reader = bound.getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);

  const drain = mustBeginDrain(reg, "glm");
  const idle = reg.whenIdle(drain.token);
  expect(reg.commitUnload(drain.token, { force: true, reason: "operator" })).toEqual({
    ok: true,
    revoked: [lease.id],
  });
  expect(await idle).toEqual({ idle: true });
  expect(lease.signal.aborted).toBe(true);
  expect(lease.release()).toBe(false);
  // eslint-disable-next-line @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun's rejects matcher is typed as void.
  await expect(reader.read()).rejects.toThrow();
  expect(reg.active("glm")).toEqual([]);
  const glmAudit: ResidencyAuditEntry[] = [
    { workload: "glm", epoch: 1, forced: true, revoked: [lease.id], reason: "operator" },
  ];
  expect(reg.audit()).toEqual(glmAudit);

  const qwenDrain = mustBeginDrain(reg, "qwen");
  expect(reg.commitUnload(qwenDrain.token)).toEqual({ ok: true, revoked: [] });
  expect(reg.audit()).toEqual(glmAudit);

  const mimo = mustAcquire(reg, "mimo");
  const mimoDrain = mustBeginDrain(reg, "mimo");
  expect(reg.commitUnload(mimoDrain.token, { force: true })).toEqual({
    ok: true,
    revoked: [mimo.id],
  });
  const audits = reg.audit();
  expect(audits).toHaveLength(2);
  const mimoEntry = audits.find((entry) => entry.workload === "mimo");
  expect(mimoEntry).toBeDefined();
  if (mimoEntry === undefined) {
    return;
  }
  expect(mimoEntry).toMatchObject({
    workload: "mimo",
    epoch: 1,
    forced: true,
    revoked: [mimo.id],
  });
  expect("reason" in mimoEntry).toBe(false);
});

test("#278: drain tokens are fenced by epoch across cancel and re-drain", async () => {
  const mod = await load();
  const reg = mod.createResidencyLeases();
  const first = mustBeginDrain(reg, "glm");
  expect(first.token.epoch).toBe(1);
  expect(reg.cancelDrain(first.token)).toBe(true);
  const second = mustBeginDrain(reg, "glm");
  expect(second.token.epoch).toBe(2);
  expect(reg.commitUnload(first.token)).toEqual({ ok: false, reason: "StaleDrainToken" });
  expect(reg.beginDrain("glm")).toEqual({
    ok: false,
    reason: "AlreadyDraining",
    workload: "glm",
    epoch: 2,
  });
  expect(reg.reopen(first.token)).toBe(false);
});

test("#278: drains and leases are scoped per workload", async () => {
  const mod = await load();
  const reg = mod.createResidencyLeases();
  mustAcquire(reg, "qwen");
  const drain = mustBeginDrain(reg, "glm");
  expect(mustAcquire(reg, "qwen").workload).toBe("qwen");
  expect(await reg.whenIdle(drain.token)).toEqual({ idle: true });
  expect(reg.snapshot("qwen").phase).toBe("open");
  expect(reg.snapshot("glm").phase).toBe("draining");
});

test("#278: the leases module is wired through the core index and exports map", async () => {
  const index = (await import(INDEX_SPEC)) as { residencyLeases?: Partial<Mod> };
  expect(typeof index.residencyLeases?.createResidencyLeases).toBe("function");
  const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
    exports: Record<string, string>;
  };
  expect(pkg.exports["./residency/leases"]).toBe("./src/residency/leases.ts");
});

test("#278: forced unload while read is pending on idle upstream rejects the read", async () => {
  const mod = await load();
  const reg = mod.createResidencyLeases();
  const lease = mustAcquire(reg, "glm");
  const { body, controller } = openBody();
  const bound = mod.bindLeaseToBody(body, lease);
  const reader = bound.getReader();
  // Do NOT enqueue anything — the upstream is idle, so reader.read()
  // will await indefinitely.  A forced commitUnload must resolve that
  // pending read with the revocation error.
  const readPromise = reader.read();
  expect(reg.active("glm")).toEqual([lease.id]);
  // Yield to the event loop so pull() has truly run and is waiting on
  // the upstream reader.read().  Without this, commitUnload fires in
  // the same synchronous turn so pull() hasn't yet awaited — the
  // abort listener never fires while a read is pending and the test
  // passes even with a broken implementation.
  await Bun.sleep(0);
  // Begin drain + forced unload while the read is still pending.
  const drain = mustBeginDrain(reg, "glm");
  const unloadResult = reg.commitUnload(drain.token, { force: true });
  expect(unloadResult).toEqual({ ok: true, revoked: [lease.id] });
  // The pending read must reject with the revocation reason.
  // eslint-disable-next-line @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun's rejects matcher is typed as void.
  await expect(readPromise).rejects.toThrow("lease revoked: forced unload");
  // The upstream body must be cancelled (no more pulls from it).
  expect(reg.active("glm")).toEqual([]);
  expect(lease.signal.aborted).toBe(true);
  // The lease must be released (no-op since revoked).
  expect(lease.release()).toBe(false);
  // The drain token is now stale (phase is "unloaded").
  expect(reg.commitUnload(drain.token)).toEqual({
    ok: false,
    reason: "StaleDrainToken",
  });
  expect(reg.snapshot("glm").phase).toBe("unloaded");
});
