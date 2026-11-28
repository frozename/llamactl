/**
 * #281 (DF-08) — the remote async request-admission wrapper over the #576
 * pure queue policy: acquire() hands back a release function, AbortSignal
 * and per-request deadlines reject queued waiters, and overload surfaces as
 * typed RequestAdmissionError codes. The module lands with the fix, so it
 * is reached through a guarded dynamic import whose specifier stays a
 * `string` (not a literal) so `tsc` cannot resolve it at base — every RED
 * case fails by assertion, never by a missing module or a type error. Same
 * pattern as packages/remote/test/residency/stop-fence.test.ts.
 *
 * Explicitly NOT covered here (still open): queue fairness across ingress,
 * the mixed-ingress execution cap, stream-lifetime slot holding, and
 * no-orphan-load on cancellation.
 */
import type {
  QueueRequest,
  QueueSnapshot,
  RequestQueueLimits,
} from "@llamactl/core/residency/queue-policy";

import { describe, expect, test } from "bun:test";

const ADMISSION_MODULE = "../../src/residency/request-admission.js" as string;

type AdmissionRequest = Omit<QueueRequest, "deadlineMs">;

type AdmissionError = Error & {
  code: string;
  retryAfterMs: number | null;
  requestId: string;
};

type RequestAdmission = {
  acquire: (
    request: AdmissionRequest,
    options?: { signal?: AbortSignal; deadlineMs?: number },
  ) => Promise<() => void>;
  snapshot: () => QueueSnapshot;
};

type AdmissionOptions = {
  limits: RequestQueueLimits;
  resident: string[];
  load: (modelKey: string, signal: AbortSignal) => unknown;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
};

type AdmissionModule = {
  createRequestAdmission: (opts: AdmissionOptions) => RequestAdmission;
  RequestAdmissionError: new (...args: never[]) => Error;
};

async function loadAdmission(): Promise<AdmissionModule | null> {
  try {
    return (await import(ADMISSION_MODULE)) as AdmissionModule;
  } catch {
    return null;
  }
}

type FakeTimer = { id: number; due: number; fn: () => void };

class FakeClock {
  t = 1_000;
  readonly earlyMs: number;
  readonly timers: FakeTimer[] = [];
  readonly requested: number[] = [];
  private nextTimerId = 1;

  constructor(earlyMs = 0) {
    this.earlyMs = earlyMs;
  }

  now = (): number => this.t;

  setTimer = (fn: () => void, ms: number): number => {
    this.requested.push(ms);
    const id = this.nextTimerId;
    this.nextTimerId += 1;
    this.timers.push({ id, due: this.t + Math.max(1, ms - this.earlyMs), fn });
    return id;
  };

  clearTimer = (id: number): void => {
    const index = this.timers.findIndex((timer) => timer.id === id);
    if (index !== -1) {
      this.timers.splice(index, 1);
    }
  };

  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (const _ of Array.from({ length: 1_000 }, () => null)) {
      let next: FakeTimer | undefined;
      for (const timer of this.timers) {
        if (timer.due <= target && (next === undefined || timer.due < next.due)) {
          next = timer;
        }
      }
      if (next === undefined) {
        this.t = target;
        await flush();
        return;
      }
      this.timers.splice(this.timers.indexOf(next), 1);
      this.t = next.due;
      next.fn();
      await flush();
    }
    throw new Error("FakeClock.advance: iteration cap exceeded");
  }
}

async function flush(): Promise<void> {
  for (const _ of Array.from({ length: 20 }, () => null)) {
    await Promise.resolve();
  }
}

const limits = (over: Partial<RequestQueueLimits> = {}): RequestQueueLimits => ({
  maxExecutions: over.maxExecutions ?? 1,
  maxQueued: over.maxQueued ?? 8,
  maxQueuedBytes: over.maxQueuedBytes ?? 1_000_000,
  maxQueueWaitMs: over.maxQueueWaitMs ?? 10_000,
  maxPerPrincipal: over.maxPerPrincipal ?? 8,
  starvationBoundMs: over.starvationBoundMs ?? 5_000,
  maxContextTokens: over.maxContextTokens ?? 100_000,
  retryAfterMs: over.retryAfterMs ?? 250,
});

const req = (id: string): AdmissionRequest => ({
  requestId: id,
  principal: "p",
  priority: "interactive",
  model: { name: "m", revision: "r1" },
  bytes: 10,
  promptTokens: 10,
  maxCompletionTokens: 10,
});

const noopLoad = (): Promise<void> => Promise.resolve();

const admissionOptions = (
  clock: FakeClock,
  over: Partial<AdmissionOptions> = {},
): AdmissionOptions => ({
  limits: over.limits ?? limits(),
  resident: over.resident ?? ["m@r1"],
  load: over.load ?? noopLoad,
  now: over.now ?? clock.now,
  setTimer: over.setTimer ?? clock.setTimer,
  clearTimer: over.clearTimer ?? clock.clearTimer,
});

type Tracker = {
  releases: Record<string, (() => void) | undefined>;
  errors: Record<string, AdmissionError | undefined>;
  grants: string[];
  track: (label: string, p: Promise<() => void>) => void;
};

const tracker = (): Tracker => {
  const releases: Record<string, (() => void) | undefined> = {};
  const errors: Record<string, AdmissionError | undefined> = {};
  const grants: string[] = [];
  const track = (label: string, p: Promise<() => void>): void => {
    void p.then(
      (release) => {
        grants.push(label);
        releases[label] = release;
      },
      (e: unknown) => {
        errors[label] = e as AdmissionError;
      },
    );
  };
  return { releases, errors, grants, track };
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("createRequestAdmission (#281 DF-08)", () => {
  // Kills: release not re-pumping the policy schedule.
  test("grants a resident model up to maxExecutions and hands the slot to the next waiter on release", async () => {
    const mod = await loadAdmission();
    expect(typeof mod?.createRequestAdmission).toBe("function");
    const create = mod!.createRequestAdmission;
    const clock = new FakeClock();
    const adm = create(admissionOptions(clock));
    const { grants, releases, track } = tracker();

    track("a", adm.acquire(req("a")));
    track("b", adm.acquire(req("b")));
    await flush();

    expect(grants).toEqual(["a"]);
    const snap = adm.snapshot();
    expect(snap.executing).toBe(1);
    expect(snap.queued).toBe(1);

    releases["a"]?.();
    await flush();

    expect(grants).toEqual(["a", "b"]);
  });

  // Kills: the abort listener calling policy.cancel/finishExecution after the
  // grant, and a release that throws on its second call.
  test("abort after grant does not free the execution slot; double release is a no-op", async () => {
    const mod = await loadAdmission();
    expect(typeof mod?.createRequestAdmission).toBe("function");
    const create = mod!.createRequestAdmission;
    const clock = new FakeClock();
    const adm = create(admissionOptions(clock, { limits: limits({ maxExecutions: 1 }) }));
    const ca = new AbortController();
    const { errors, grants, releases, track } = tracker();

    track("a", adm.acquire(req("a"), { signal: ca.signal }));
    track("b", adm.acquire(req("b")));
    await flush();

    ca.abort();
    await flush();

    expect(adm.snapshot().executing).toBe(1);
    expect(grants).toEqual(["a"]);
    expect(errors["a"]).toBeUndefined();

    expect(() => {
      releases["a"]?.();
      releases["a"]?.();
    }).not.toThrow();
    await flush();

    expect(grants.filter((g) => g === "b")).toHaveLength(1);
    expect(adm.snapshot().executing).toBe(1);
  });

  // Kills: release lacking its once-guard, which calls finishExecution("a")
  // a second time and evicts the newer holder's slot.
  test("a stale release of a reused requestId does not free the newer holder's slot (release-once)", async () => {
    const mod = await loadAdmission();
    expect(typeof mod?.createRequestAdmission).toBe("function");
    const create = mod!.createRequestAdmission;
    const clock = new FakeClock();
    const adm = create(admissionOptions(clock));
    const { grants, releases, track } = tracker();

    track("a#1", adm.acquire(req("a")));
    await flush();
    expect(grants).toEqual(["a#1"]);

    releases["a#1"]?.();
    await flush();

    track("a#2", adm.acquire(req("a")));
    await flush();
    expect(grants).toEqual(["a#1", "a#2"]);

    track("c", adm.acquire(req("c")));
    await flush();

    releases["a#1"]?.();
    await flush();

    expect(adm.snapshot().executing).toBe(1);
    expect(grants).toEqual(["a#1", "a#2"]);
  });

  // Kills: a missing abort listener, or one not calling policy.cancel.
  test("abort while queued rejects Aborted and removes the waiter", async () => {
    const mod = await loadAdmission();
    expect(typeof mod?.createRequestAdmission).toBe("function");
    const create = mod!.createRequestAdmission;
    const clock = new FakeClock();
    const adm = create(admissionOptions(clock));
    const cb = new AbortController();
    const { errors, grants, releases, track } = tracker();

    track("a", adm.acquire(req("a")));
    track("b", adm.acquire(req("b"), { signal: cb.signal }));
    await flush();

    cb.abort();
    await flush();

    expect(errors["b"]?.code).toBe("Aborted");
    expect(errors["b"]?.retryAfterMs).toBeNull();
    expect(errors["b"] instanceof mod!.RequestAdmissionError).toBe(true);
    expect(adm.snapshot().queued).toBe(0);

    releases["a"]?.();
    track("c", adm.acquire(req("c")));
    await flush();

    expect(grants).toEqual(["a", "c"]);
  });

  // Kills: enqueue before checking signal.aborted.
  test("an already-aborted signal rejects without enqueueing", async () => {
    const mod = await loadAdmission();
    expect(typeof mod?.createRequestAdmission).toBe("function");
    const create = mod!.createRequestAdmission;
    const clock = new FakeClock();
    const adm = create(admissionOptions(clock));
    const cb = new AbortController();
    cb.abort();
    const { errors, track } = tracker();

    track("x", adm.acquire(req("x"), { signal: cb.signal }));
    await flush();

    expect(errors["x"]?.code).toBe("Aborted");
    expect(adm.snapshot().queued).toBe(0);
    expect(adm.snapshot().executing).toBe(0);
  });

  // Kills: mapping refusals to retryAfterMs null, or resolving a refused request.
  test("queue overload rejects QueueFull with retryAfterMs", async () => {
    const mod = await loadAdmission();
    expect(typeof mod?.createRequestAdmission).toBe("function");
    const create = mod!.createRequestAdmission;
    const clock = new FakeClock();
    const adm = create(admissionOptions(clock, { limits: limits({ maxQueued: 1 }) }));
    const { errors, grants, track } = tracker();

    track("a", adm.acquire(req("a")));
    track("b", adm.acquire(req("b")));
    track("c", adm.acquire(req("c")));
    await flush();

    expect(errors["c"]?.code).toBe("QueueFull");
    expect(errors["c"]?.retryAfterMs).toBe(250);
    expect(errors["c"]?.message).toContain("QueueFull");
    expect(errors["b"]).toBeUndefined();
    expect(grants).toEqual(["a"]);
  });

  // Kills: no per-waiter timer, since expiry then only happens on the next release.
  test("a queued waiter is rejected DeadlineExceeded at its deadline", async () => {
    const mod = await loadAdmission();
    expect(typeof mod?.createRequestAdmission).toBe("function");
    const create = mod!.createRequestAdmission;
    const clock = new FakeClock();
    const adm = create(admissionOptions(clock));
    const { errors, track } = tracker();

    track("a", adm.acquire(req("a")));
    track("b", adm.acquire(req("b"), { deadlineMs: clock.t + 50 }));
    await flush();
    expect(errors["b"]).toBeUndefined();

    await clock.advance(49);
    expect(errors["b"]).toBeUndefined();

    await clock.advance(1);
    expect(errors["b"]?.code).toBe("DeadlineExceeded");
    expect(errors["b"]?.retryAfterMs).toBeNull();

    const waitClock = new FakeClock();
    const waitAdm = create(
      admissionOptions(waitClock, { limits: limits({ maxQueueWaitMs: 100 }) }),
    );
    const waitTracker = tracker();
    waitTracker.track("a", waitAdm.acquire(req("a")));
    waitTracker.track("b", waitAdm.acquire(req("b")));
    await flush();

    await waitClock.advance(100);
    expect(waitTracker.errors["b"]?.code).toBe("QueueWaitExceeded");
    expect(waitTracker.errors["b"]?.retryAfterMs).toBe(250);
  });

  // Kills: the one-shot timer not re-arming when it fires early.
  test("an early-firing timer re-arms until the waiter is actually due", async () => {
    const mod = await loadAdmission();
    expect(typeof mod?.createRequestAdmission).toBe("function");
    const create = mod!.createRequestAdmission;
    const clock = new FakeClock(30);
    const adm = create(admissionOptions(clock, { limits: limits({ maxQueueWaitMs: 100 }) }));
    const { errors, track } = tracker();

    track("a", adm.acquire(req("a")));
    track("b", adm.acquire(req("b")));
    await flush();

    await clock.advance(70);
    expect(errors["b"]).toBeUndefined();
    expect(clock.timers.length).toBe(1);

    await clock.advance(40);
    expect(errors["b"]?.code).toBe("QueueWaitExceeded");
  });

  // Kills: the duplicate overwriting the waiter map entry, after which a#1
  // never resolves, or the duplicate joining as a second waiter.
  test("duplicate acquire of a live requestId rejects DuplicateRequest without a second waiter", async () => {
    const mod = await loadAdmission();
    expect(typeof mod?.createRequestAdmission).toBe("function");
    const create = mod!.createRequestAdmission;
    const clock = new FakeClock();
    const adm = create(admissionOptions(clock));
    const { errors, grants, releases, track } = tracker();

    track("x", adm.acquire(req("x")));
    track("a#1", adm.acquire(req("a")));
    track("a#2", adm.acquire(req("a")));
    await flush();

    expect(errors["a#2"]?.code).toBe("DuplicateRequest");
    expect(errors["a#2"]?.retryAfterMs).toBeNull();
    expect(errors["a#1"]).toBeUndefined();
    expect(adm.snapshot().queued).toBe(1);

    releases["x"]?.();
    await flush();

    expect(grants).toEqual(["x", "a#1"]);
  });

  test("cancelling the last waiter before dispatch prevents the cold load", async () => {
    const mod = await loadAdmission();
    const loads: string[] = [];
    const admission = mod!.createRequestAdmission(
      admissionOptions(new FakeClock(), {
        resident: [],
        load: (key) => {
          loads.push(key);
        },
      }),
    );
    const abort = new AbortController();
    const pending = admission.acquire(req("cancelled"), { signal: abort.signal });
    abort.abort();
    expect(await pending.catch((error: unknown) => error)).toMatchObject({ code: "Aborted" });
    await flush();
    expect(loads).toEqual([]);
    expect(admission.snapshot().loading).toBeNull();
    const next = await admission.acquire(req("fresh"));
    expect(loads).toEqual(["m@r1"]);
    next();
  });

  test("last-waiter cancellation signals the load owner without clearing its allocation gate", async () => {
    const mod = await loadAdmission();
    const loads: { key: string; signal: AbortSignal }[] = [];
    const settleFirst = deferred<null>();
    const admission = mod!.createRequestAdmission(
      admissionOptions(new FakeClock(), {
        resident: [],
        load: (key, signal) => {
          loads.push({ key, signal });
          return key === "m@r1" ? settleFirst.promise : Promise.resolve();
        },
      }),
    );
    const first = new AbortController();
    const second = new AbortController();
    const a = admission
      .acquire(req("first"), { signal: first.signal })
      .catch((error: unknown) => error);
    const b = admission
      .acquire(req("second"), { signal: second.signal })
      .catch((error: unknown) => error);
    await flush();
    const other = admission.acquire({
      ...req("other"),
      model: { name: "different", revision: "r2" },
    });
    try {
      expect(loads).toHaveLength(1);
      first.abort();
      expect(await a).toMatchObject({ code: "Aborted" });
      expect(loads[0]?.signal.aborted).toBe(false);
      second.abort();
      expect(await b).toMatchObject({ code: "Aborted" });
      expect(loads[0]?.signal.aborted).toBe(true);
      expect(admission.snapshot().loading).toBe("m@r1");
      expect(loads).toHaveLength(1);
    } finally {
      settleFirst.resolve(null);
    }
    await flush();
    expect(loads.map(({ key }) => key)).toEqual(["m@r1", "different@r2"]);
    (await other)();
  });

  // Kills: calling load per waiter, or not pumping after loadSettled("ready").
  test("concurrent acquires for one cold model call load exactly once", async () => {
    const mod = await loadAdmission();
    expect(typeof mod?.createRequestAdmission).toBe("function");
    const create = mod!.createRequestAdmission;
    const clock = new FakeClock();
    const loadCalls: string[] = [];
    const loadResult = deferred<null>();
    const adm = create(
      admissionOptions(clock, {
        limits: limits({ maxExecutions: 2 }),
        resident: [],
        load: (modelKey) => {
          loadCalls.push(modelKey);
          return loadResult.promise;
        },
      }),
    );
    const { grants, track } = tracker();

    track("a", adm.acquire(req("a")));
    track("b", adm.acquire(req("b")));
    track("c", adm.acquire(req("c")));
    await flush();

    expect(loadCalls).toEqual(["m@r1"]);
    expect(grants).toEqual([]);

    loadResult.resolve(null);
    await flush();

    expect(grants).toEqual(["a", "b"]);
  });

  // Kills: calling load() directly instead of through Promise.resolve().then(() => load()).
  test("a synchronously throwing load rejects every waiter LoadFailed", async () => {
    const mod = await loadAdmission();
    expect(typeof mod?.createRequestAdmission).toBe("function");
    const create = mod!.createRequestAdmission;
    const clock = new FakeClock();
    const adm = create(
      admissionOptions(clock, {
        limits: limits({ maxExecutions: 2 }),
        resident: [],
        load: () => {
          throw new Error("boom");
        },
      }),
    );
    const { errors, track } = tracker();

    expect(() => {
      track("a", adm.acquire(req("a")));
    }).not.toThrow();
    expect(() => {
      track("b", adm.acquire(req("b")));
    }).not.toThrow();
    await flush();

    expect(errors["a"]?.code).toBe("LoadFailed");
    expect(errors["b"]?.code).toBe("LoadFailed");
    expect(errors["a"]?.retryAfterMs).toBe(250);
    expect(adm.snapshot().loading).toBeNull();
  });

  // Kills: no clamp.
  test("timer delays are clamped to the 32-bit setTimeout max", async () => {
    const mod = await loadAdmission();
    expect(typeof mod?.createRequestAdmission).toBe("function");
    const create = mod!.createRequestAdmission;
    const clock = new FakeClock();
    const adm = create(
      admissionOptions(clock, { limits: limits({ maxQueueWaitMs: 3_000_000_000 }) }),
    );
    const { track } = tracker();

    track("a", adm.acquire(req("a")));
    track("b", adm.acquire(req("b")));
    await flush();

    expect(Math.max(...clock.requested)).toBeLessThanOrEqual(2_147_483_647);
    expect(clock.requested.length).toBeGreaterThan(0);
  });

  // Kills M13: settle() not calling clearTimer(waiter.timer). With real timers
  // every granted or aborted waiter would leave a timer pending for up to
  // maxQueueWaitMs.
  test("settling a waiter by grant, release hand-off or abort clears its wait timer", async () => {
    const mod = await loadAdmission();
    expect(typeof mod?.createRequestAdmission).toBe("function");
    const create = mod!.createRequestAdmission;
    const clock = new FakeClock();
    const adm = create(admissionOptions(clock));
    const cc = new AbortController();
    const { errors, grants, releases, track } = tracker();

    track("a", adm.acquire(req("a")));
    await flush();
    expect(grants).toEqual(["a"]);
    expect(clock.timers).toHaveLength(0);

    track("b", adm.acquire(req("b")));
    await flush();
    expect(clock.timers).toHaveLength(1);

    releases["a"]?.();
    await flush();
    expect(grants).toEqual(["a", "b"]);
    expect(clock.timers).toHaveLength(0);

    track("c", adm.acquire(req("c"), { signal: cc.signal }));
    await flush();
    expect(clock.timers).toHaveLength(1);

    cc.abort();
    await flush();
    expect(errors["c"]?.code).toBe("Aborted");
    expect(clock.timers).toHaveLength(0);
  });

  // Kills M12: settle() not calling waiter.detachAbort(). A long-lived shared
  // AbortSignal would then keep one abort listener per request it ever covered.
  test("a shared AbortSignal has every abort listener removed once each waiter settles", async () => {
    const mod = await loadAdmission();
    expect(typeof mod?.createRequestAdmission).toBe("function");
    const create = mod!.createRequestAdmission;
    const clock = new FakeClock();
    const adm = create(admissionOptions(clock));
    const shared = new AbortController();
    const sharedCounts = countAbortListeners(shared.signal);
    const { errors, grants, releases, track } = tracker();

    track("a", adm.acquire(req("a"), { signal: shared.signal }));
    track("b", adm.acquire(req("b"), { signal: shared.signal }));
    track("c", adm.acquire(req("c"), { signal: shared.signal }));
    await flush();
    expect(grants).toEqual(["a"]);
    expect(sharedCounts).toEqual({ added: 3, removed: 1 });

    releases["a"]?.();
    await flush();
    releases["b"]?.();
    await flush();
    expect(grants).toEqual(["a", "b", "c"]);
    expect(sharedCounts).toEqual({ added: 3, removed: 3 });

    const aborting = new AbortController();
    const abortingCounts = countAbortListeners(aborting.signal);
    track("d", adm.acquire(req("d"), { signal: aborting.signal }));
    track("e", adm.acquire(req("e"), { signal: aborting.signal }));
    await flush();
    expect(abortingCounts).toEqual({ added: 2, removed: 0 });

    aborting.abort();
    await flush();
    expect(errors["d"]?.code).toBe("Aborted");
    expect(errors["e"]?.code).toBe("Aborted");
    expect(abortingCounts).toEqual({ added: 2, removed: 2 });
  });
});

type ListenerCounts = { added: number; removed: number };

// Counts "abort" add/removeEventListener calls on one signal instance.
function countAbortListeners(signal: AbortSignal): ListenerCounts {
  const counts: ListenerCounts = { added: 0, removed: 0 };
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  Object.assign(signal, {
    addEventListener: (...args: Parameters<typeof add>): void => {
      if (args[0] === "abort") {
        counts.added += 1;
      }
      add(...args);
    },
    removeEventListener: (...args: Parameters<typeof remove>): void => {
      if (args[0] === "abort") {
        counts.removed += 1;
      }
      remove(...args);
    },
  });
  return counts;
}

test("queue wait records one outcome per reservation using its own priority and elapsed time", async () => {
  const module = await loadAdmission();
  expect(module).not.toBeNull();
  if (module === null) return;
  const clock = new FakeClock();
  const samples: unknown[] = [];
  const options = {
    ...admissionOptions(clock, { limits: limits({ maxQueued: 2, maxQueueWaitMs: 50 }) }),
    observeWait: (sample: unknown): void => {
      samples.push(sample);
    },
  };
  const admission = module.createRequestAdmission(options);
  const held = await admission.acquire(req("held"));
  const controller = new AbortController();
  const cancelled = admission
    .acquire(
      { ...req("cancelled"), priority: "background" },
      {
        signal: controller.signal,
      },
    )
    .catch((error: unknown) => error);
  const next = admission.acquire(req("next"));
  const refusal = await admission.acquire(req("refused")).catch((error: unknown) => error);
  expect(refusal).toMatchObject({ code: "QueueFull" });
  await clock.advance(25);
  controller.abort();
  expect(await cancelled).toMatchObject({ code: "Aborted" });
  held();
  held();
  const release = await next;
  const expired = admission
    .acquire({ ...req("expired"), priority: "background" })
    .catch((error: unknown) => error);
  await clock.advance(50);
  expect(await expired).toMatchObject({ code: "QueueWaitExceeded" });
  release();
  expect(samples).toEqual([
    { priority: "interactive", outcome: "admitted", waitMs: 0 },
    { priority: "interactive", outcome: "refused", waitMs: 0 },
    { priority: "background", outcome: "cancelled", waitMs: 25 },
    { priority: "interactive", outcome: "admitted", waitMs: 25 },
    { priority: "background", outcome: "expired", waitMs: 50 },
  ]);
});

test("a failing queue observer cannot strand grants, refusals or cancelled waiters", async () => {
  const module = await loadAdmission();
  expect(module).not.toBeNull();
  if (module === null) return;
  const options = {
    ...admissionOptions(new FakeClock(), { limits: limits({ maxQueued: 1 }) }),
    observeWait: (): void => {
      throw new Error("recorder unavailable");
    },
  };
  const admission = module.createRequestAdmission(options);
  const release = await admission.acquire(req("active"));
  const controller = new AbortController();
  const cancelled = admission
    .acquire(req("cancelled"), { signal: controller.signal })
    .catch((error: unknown) => error);
  const refusal = await admission.acquire(req("refused")).catch((error: unknown) => error);
  expect(refusal).toMatchObject({ code: "QueueFull" });
  controller.abort();
  expect(await cancelled).toMatchObject({ code: "Aborted" });
  const next = admission.acquire(req("next"));
  release();
  (await next)();
  expect(admission.snapshot()).toMatchObject({ queued: 0, executing: 0 });
});
