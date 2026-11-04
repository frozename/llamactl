// packages/app/test/lib/transport/sse-lifecycle.test.ts
// Issue #410, P4 RED — pins the SSE lifecycle wrapper that
// buildHttpLinks is expected to grow: exponential-backoff reconnects
// on top of the real httpSubscriptionLink, a 2s health confirm before
// backoff resets, terminal classification of guard errors (401 →
// invalid session), a __reconnect__ sentinel between attempts, and
// full teardown on unsubscribe/abort with no timer or EventSource
// leaks. At the base commit buildHttpLinks ignores the new options,
// so every case fails by assertion — a spy is never called, no timer
// is recorded, or an error reaches onError — never by import error.

import type { TRPCLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";

import { createTRPCClient } from "@trpc/client";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ErrorEvent } from "eventsource";

const HTTP_SPEC = "../../../src/lib/transport/http.ts";
const LIFECYCLE_SPEC = "../../../src/lib/transport/sse-lifecycle.ts";
const ERRORS_SPEC = "../../../src/lib/transport/errors.ts";
const STORE_SPEC = "../../../src/console/session-store.ts";

const BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000] as const;

type FetchInput = string | URL | Request;
type FakeFetch = (input: FetchInput, init?: RequestInit) => Promise<Response>;

interface TimerEntry {
  fn: () => void;
  ms: number;
  due: number;
  cleared: boolean;
  fired: boolean;
}

interface ManualTimers {
  entries: TimerEntry[];
  setTimeout: (fn: () => void, ms: number) => TimerEntry;
  clearTimeout: (handle: unknown) => void;
  advance: (ms: number) => void;
  pending: () => TimerEntry[];
}

interface BuildHttpLinksOptions {
  baseUrl: string;
  node: string;
  fetch?: FakeFetch;
  EventSource?: unknown;
  timers?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
  onInvalidSession?: () => void;
  onStateChange?: (...args: unknown[]) => void;
}

interface HttpTransportModule {
  buildHttpLinks?: (opts: BuildHttpLinksOptions) => TRPCLink<AnyRouter>[];
}

interface LifecycleModule {
  sseLifecycleLink?: unknown;
  RECONNECT_SIGNAL?: unknown;
  isReconnectSignal?: (value: unknown) => boolean;
  BACKOFF_MS?: readonly number[];
  HEALTH_CONFIRM_MS?: number;
}

interface ErrorsModule {
  classifyTransportError?: (err: unknown) => { kind: string } | undefined;
}

interface StoreModule {
  consoleSessionStore?: {
    isInvalid: () => boolean;
    reset: () => void;
  };
}

interface SubscribeOpts {
  onData?: (value: unknown) => void;
  onError?: (err: unknown) => void;
  onComplete?: () => void;
  onStarted?: () => void;
  onStopped?: () => void;
  onConnectionStateChange?: (state: unknown) => void;
  signal?: AbortSignal;
}

interface UntypedProcedures {
  chatStream: {
    subscribe: (input: undefined, opts: SubscribeOpts) => { unsubscribe: () => void };
  };
}

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = this.CONNECTING;
  closes = 0;
  readonly url: string;

  constructor(url: string, init?: { withCredentials?: boolean }) {
    super();
    this.url = url;
    void init;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.readyState = this.CLOSED;
    this.closes += 1;
  }

  connect(): void {
    this.readyState = this.OPEN;
    this.dispatchEvent(new MessageEvent("connected", { data: "{}" }));
  }

  emit(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }

  serverReturn(): void {
    this.dispatchEvent(new MessageEvent("return", { data: "" }));
  }

  dropNetwork(): void {
    this.readyState = this.CONNECTING;
    this.dispatchEvent(new ErrorEvent("error", { message: "fetch failed" }));
  }

  dropClosed(): void {
    this.readyState = this.CLOSED;
    this.dispatchEvent(new ErrorEvent("error", { message: "connection dropped" }));
  }

  failStatus(status: number): void {
    this.readyState = this.CLOSED;
    this.dispatchEvent(
      new ErrorEvent("error", {
        code: status,
        message: `Non-200 status code (${String(status)})`,
      }),
    );
  }
}

function makeTimers(): ManualTimers {
  let now = 0;
  const entries: TimerEntry[] = [];
  return {
    entries,
    setTimeout(fn: () => void, ms: number): TimerEntry {
      const entry: TimerEntry = { fn, ms, due: now + ms, cleared: false, fired: false };
      entries.push(entry);
      return entry;
    },
    clearTimeout(handle: unknown): void {
      if (typeof handle === "object" && handle !== null && "cleared" in handle) {
        (handle as TimerEntry).cleared = true;
      }
    },
    advance(ms: number): void {
      now += ms;
      for (;;) {
        const next = entries
          .filter((e) => !e.cleared && !e.fired && e.due <= now)
          .sort((a, b) => a.due - b.due)[0];
        if (next === undefined) return;
        next.fired = true;
        next.fn();
      }
    },
    pending: () => entries.filter((e) => !e.cleared && !e.fired),
  };
}

async function importHttp(): Promise<HttpTransportModule | null> {
  return (await import(HTTP_SPEC).catch(() => null)) as HttpTransportModule | null;
}

async function importLifecycle(): Promise<LifecycleModule | null> {
  return (await import(LIFECYCLE_SPEC).catch(() => null)) as LifecycleModule | null;
}

async function importErrors(): Promise<ErrorsModule | null> {
  return (await import(ERRORS_SPEC).catch(() => null)) as ErrorsModule | null;
}

async function importStore(): Promise<StoreModule | null> {
  return (await import(STORE_SPEC).catch(() => null)) as StoreModule | null;
}

async function waitFor(cond: () => boolean, rounds = 250): Promise<boolean> {
  for (let i = 0; i < rounds; i++) {
    if (cond()) return true;
    await Promise.resolve();
  }
  return cond();
}

async function waitForSource(count: number): Promise<void> {
  await waitFor(() => FakeEventSource.instances.length >= count);
}

async function flush(): Promise<void> {
  await waitFor(() => false, 25);
}

function lastSource(): FakeEventSource {
  return FakeEventSource.instances.at(-1)!;
}

interface Observed {
  data: unknown[];
  errors: unknown[];
  completes: number;
  starts: number;
  stops: number;
  connStates: unknown[];
}

interface Harness {
  timers: ManualTimers;
  obs: Observed;
  states: unknown[][];
  invalid: number[];
  sub: { unsubscribe: () => void };
}

function makeHarness(
  buildHttpLinks: NonNullable<HttpTransportModule["buildHttpLinks"]>,
  adjust?: (opts: BuildHttpLinksOptions) => void,
  subscribeOpts?: SubscribeOpts,
): Harness {
  const timers = makeTimers();
  const obs: Observed = { data: [], errors: [], completes: 0, starts: 0, stops: 0, connStates: [] };
  const states: unknown[][] = [];
  const invalid: number[] = [];
  const opts: BuildHttpLinksOptions = {
    baseUrl: "/api",
    node: "local",
    fetch: () => Promise.reject(new TypeError("no batch expected")),
    EventSource: FakeEventSource,
    timers,
    onInvalidSession: () => invalid.push(1),
    onStateChange: (...args: unknown[]) => states.push(args),
  };
  adjust?.(opts);
  const client = createTRPCClient<AnyRouter>({
    links: buildHttpLinks(opts),
  }) as unknown as UntypedProcedures;
  const sub = client.chatStream.subscribe(undefined, {
    onData: (value) => obs.data.push(value),
    onError: (err) => obs.errors.push(err),
    onComplete: () => {
      obs.completes += 1;
    },
    onStarted: () => {
      obs.starts += 1;
    },
    onStopped: () => {
      obs.stops += 1;
    },
    onConnectionStateChange: (state) => obs.connStates.push(state),
    ...subscribeOpts,
  });
  return { timers, obs, states, invalid, sub };
}

function stateName(call: unknown[]): string | undefined {
  const first = call[0];
  if (typeof first === "string") return first;
  if (typeof first === "object" && first !== null) {
    const obj = first as Record<string, unknown>;
    if (typeof obj["type"] === "string") return obj["type"];
    if (typeof obj["state"] === "string") return obj["state"];
  }
  return undefined;
}

function stateDetails(call: unknown[]): Record<string, unknown> | undefined {
  for (const arg of call) {
    if (typeof arg === "object" && arg !== null) return arg as Record<string, unknown>;
  }
  return undefined;
}

function expectAllSourcesClosed(): void {
  expect(FakeEventSource.instances.length).toBeGreaterThan(0);
  const total = FakeEventSource.instances.reduce((n, es) => n + es.closes, 0);
  expect(FakeEventSource.instances.every((es) => es.closes > 0)).toBe(true);
  expect(total).toBe(FakeEventSource.instances.length);
}

interface RecordedGlobalTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
  fired: boolean;
}

function replaceGlobalTimers(): {
  recorded: RecordedGlobalTimer[];
  restore: () => void;
} {
  const recorded: RecordedGlobalTimer[] = [];
  const origSet = globalThis.setTimeout;
  const origClear = globalThis.clearTimeout;
  globalThis.setTimeout = function (this: unknown, fn: () => void, ms?: number) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Illegal invocation");
    }
    const entry: RecordedGlobalTimer = { fn, ms: ms ?? 0, cleared: false, fired: false };
    recorded.push(entry);
    return entry;
  } as unknown as typeof setTimeout;
  globalThis.clearTimeout = function (this: unknown, handle: unknown): void {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Illegal invocation");
    }
    if (typeof handle === "object" && handle !== null && "cleared" in handle) {
      (handle as RecordedGlobalTimer).cleared = true;
    }
  };
  return {
    recorded,
    restore: (): void => {
      globalThis.setTimeout = origSet;
      globalThis.clearTimeout = origClear;
    },
  };
}

function fire(entry: RecordedGlobalTimer): void {
  entry.fired = true;
  entry.fn();
}

beforeEach(() => {
  FakeEventSource.instances = [];
});

afterEach(async () => {
  const smod = await importStore();
  smod?.consoleSessionStore?.reset();
});

describe("sse lifecycle (#410 P4)", () => {
  test("L1: reconnect delays follow 1s→30s backoff, one new EventSource per attempt", async () => {
    const lmod = await importLifecycle();
    const http = await importHttp();
    expect(lmod?.BACKOFF_MS).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    expect(lmod?.HEALTH_CONFIRM_MS).toBe(2000);
    expect(http?.buildHttpLinks).toBeFunction();

    const h = makeHarness(http!.buildHttpLinks!);
    await waitForSource(1);
    expect(FakeEventSource.instances).toHaveLength(1);

    for (const delay of BACKOFF) {
      const sourcesBefore = FakeEventSource.instances.length;
      const timersBefore = h.timers.entries.length;
      lastSource().dropNetwork();
      await waitFor(() => h.timers.entries.length === timersBefore + 1);
      expect(h.timers.entries.at(-1)?.ms).toBe(delay);
      h.timers.advance(delay);
      await waitForSource(sourcesBefore + 1);
      expect(FakeEventSource.instances.length).toBe(sourcesBefore + 1);
    }

    expect(h.timers.entries.map((e) => e.ms)).toEqual([...BACKOFF]);

    h.sub.unsubscribe();
    expect(h.timers.pending()).toHaveLength(0);
    expectAllSourcesClosed();
  });

  test("L2: backoff only resets after a 2s health-confirm window", async () => {
    const http = await importHttp();
    expect(http?.buildHttpLinks).toBeFunction();

    const halfA = makeHarness(http!.buildHttpLinks!);
    await waitForSource(1);
    lastSource().dropNetwork();
    await waitFor(() => halfA.timers.entries.length === 1);
    halfA.timers.advance(1000);
    await waitForSource(2);
    lastSource().connect();
    await waitFor(() => halfA.timers.entries.length === 2);
    expect(halfA.timers.entries.at(-1)?.ms).toBe(2000);
    halfA.timers.advance(1999);
    lastSource().dropNetwork();
    await waitFor(() => halfA.timers.entries.length === 3);
    expect(halfA.timers.entries.at(-1)?.ms).toBe(2000);
    halfA.sub.unsubscribe();
    expect(halfA.timers.pending()).toHaveLength(0);

    FakeEventSource.instances = [];

    const halfB = makeHarness(http!.buildHttpLinks!);
    await waitForSource(1);
    lastSource().dropNetwork();
    await waitFor(() => halfB.timers.entries.length === 1);
    halfB.timers.advance(1000);
    await waitForSource(2);
    lastSource().connect();
    await waitFor(() => halfB.timers.entries.length === 2);
    halfB.timers.advance(2000);
    lastSource().dropNetwork();
    await waitFor(() => halfB.timers.entries.length === 3);
    expect(halfB.timers.entries.at(-1)?.ms).toBe(1000);
    halfB.sub.unsubscribe();
    expect(halfB.timers.pending()).toHaveLength(0);
    expectAllSourcesClosed();
  });

  test("L3: drops through observer.error (closed source) take the same backoff and never reach onError", async () => {
    const http = await importHttp();
    expect(http?.buildHttpLinks).toBeFunction();

    const h = makeHarness(http!.buildHttpLinks!);
    await waitForSource(1);

    for (const delay of BACKOFF) {
      const sourcesBefore = FakeEventSource.instances.length;
      const timersBefore = h.timers.entries.length;
      lastSource().dropClosed();
      await waitFor(() => h.timers.entries.length === timersBefore + 1);
      expect(h.timers.entries.at(-1)?.ms).toBe(delay);
      h.timers.advance(delay);
      await waitForSource(sourcesBefore + 1);
      expect(FakeEventSource.instances.length).toBe(sourcesBefore + 1);
    }

    expect(h.timers.entries.map((e) => e.ms)).toEqual([...BACKOFF]);
    expect(h.obs.errors).toHaveLength(0);

    h.sub.unsubscribe();
    expect(h.timers.pending()).toHaveLength(0);
    expectAllSourcesClosed();
  });

  test("L4: unsubscribe during a backoff wait clears the timer and builds no new source", async () => {
    const http = await importHttp();
    expect(http?.buildHttpLinks).toBeFunction();

    const h = makeHarness(http!.buildHttpLinks!);
    await waitForSource(1);
    lastSource().dropNetwork();
    await waitFor(() => h.timers.entries.length === 1);
    const wait = h.timers.entries.at(-1);

    h.sub.unsubscribe();
    expect(wait?.cleared).toBe(true);
    h.timers.advance(60000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(h.timers.pending()).toHaveLength(0);
    expectAllSourcesClosed();
  });

  test("L4b: unsubscribe while the health-confirm timer is pending clears it", async () => {
    const http = await importHttp();
    expect(http?.buildHttpLinks).toBeFunction();

    const h = makeHarness(http!.buildHttpLinks!);
    await waitForSource(1);
    lastSource().connect();
    await waitFor(() => h.timers.entries.length === 1);
    const health = h.timers.entries.at(-1);
    expect(health?.ms).toBe(2000);

    h.sub.unsubscribe();
    expect(health?.cleared).toBe(true);
    h.timers.advance(60000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(h.timers.pending()).toHaveLength(0);
    expectAllSourcesClosed();
  });

  test("L5: caller abort during a backoff wait tears down once — the caller signal gets one listener pair", async () => {
    const http = await importHttp();
    expect(http?.buildHttpLinks).toBeFunction();

    const ac = new AbortController();
    let adds = 0;
    let removes = 0;
    const origAdd = ac.signal.addEventListener.bind(ac.signal);
    const origRemove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void => {
      if (type === "abort") adds += 1;
      origAdd(type, listener, options);
    }) as typeof ac.signal.addEventListener;
    ac.signal.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ): void => {
      if (type === "abort") removes += 1;
      origRemove(type, listener, options);
    }) as typeof ac.signal.removeEventListener;

    const h = makeHarness(http!.buildHttpLinks!, undefined, { signal: ac.signal });
    await waitForSource(1);

    lastSource().dropNetwork();
    await waitFor(() => h.timers.entries.length === 1);
    h.timers.advance(1000);
    await waitForSource(2);
    lastSource().connect();
    await waitFor(() => h.obs.starts === 1);

    lastSource().dropNetwork();
    await waitFor(() => h.timers.entries.length === 3);
    h.timers.advance(2000);
    await waitForSource(3);
    lastSource().connect();
    await waitFor(() => h.obs.starts === 2);

    lastSource().dropNetwork();
    await waitFor(() => h.timers.entries.length === 5);
    const wait = h.timers.entries.at(-1);
    expect(wait?.ms).toBe(4000);

    ac.abort();
    await waitFor(() => wait?.cleared === true);
    expect(wait?.cleared).toBe(true);
    h.timers.advance(60000);
    expect(FakeEventSource.instances).toHaveLength(3);
    expect(h.timers.pending()).toHaveLength(0);
    expectAllSourcesClosed();
    await waitFor(() => h.obs.completes === 1);
    expect(h.obs.completes).toBe(1);
    expect(adds).toBe(1);
    expect(removes).toBe(1);
  });

  test("L5b: caller abort while streaming tears down once", async () => {
    const http = await importHttp();
    expect(http?.buildHttpLinks).toBeFunction();

    const ac = new AbortController();
    let adds = 0;
    let removes = 0;
    const origAdd = ac.signal.addEventListener.bind(ac.signal);
    const origRemove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void => {
      if (type === "abort") adds += 1;
      origAdd(type, listener, options);
    }) as typeof ac.signal.addEventListener;
    ac.signal.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ): void => {
      if (type === "abort") removes += 1;
      origRemove(type, listener, options);
    }) as typeof ac.signal.removeEventListener;

    const h = makeHarness(http!.buildHttpLinks!, undefined, { signal: ac.signal });
    await waitForSource(1);
    lastSource().connect();
    await waitFor(() => h.obs.starts === 1);

    ac.abort();
    await waitFor(() => h.obs.completes === 1);
    expect(h.obs.completes).toBe(1);
    expect(h.timers.pending()).toHaveLength(0);
    expectAllSourcesClosed();
    expect(adds).toBe(1);
    expect(removes).toBe(1);
  });

  test("L6: a 401 on connect is terminal — onInvalidSession once, onError once, no reconnect", async () => {
    const emod = await importErrors();
    const http = await importHttp();
    expect(http?.buildHttpLinks).toBeFunction();

    const h = makeHarness(http!.buildHttpLinks!);
    await waitForSource(1);
    lastSource().failStatus(401);
    await waitFor(() => h.obs.errors.length === 1);

    expect(h.invalid).toHaveLength(1);
    expect(h.obs.errors).toHaveLength(1);
    expect(emod?.classifyTransportError?.(h.obs.errors[0])?.kind).toBe("invalid_session");
    h.timers.advance(60000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(h.timers.pending()).toHaveLength(0);
    expect(h.states.map(stateName).at(-1)).toBe("error");

    h.sub.unsubscribe();
    expectAllSourcesClosed();
  });

  test("L6b: without an onInvalidSession option the console session store is marked invalid", async () => {
    const smod = await importStore();
    const http = await importHttp();
    expect(http?.buildHttpLinks).toBeFunction();

    const h = makeHarness(http!.buildHttpLinks!, (opts) => {
      delete opts.onInvalidSession;
    });
    await waitForSource(1);
    lastSource().failStatus(401);
    await waitFor(() => h.obs.errors.length === 1);

    expect(h.obs.errors).toHaveLength(1);
    expect(h.invalid).toHaveLength(0);
    expect(smod?.consoleSessionStore?.isInvalid()).toBe(true);
    h.timers.advance(60000);
    expect(FakeEventSource.instances).toHaveLength(1);

    h.sub.unsubscribe();
  });

  test("L7: SSE 404 and 400 are terminal procedure-side errors, never retried", async () => {
    const emod = await importErrors();
    const http = await importHttp();
    expect(http?.buildHttpLinks).toBeFunction();

    for (const [status, kind] of [
      [404, "not_exposed"],
      [400, "node_not_dispatchable"],
    ] as const) {
      FakeEventSource.instances = [];
      const h = makeHarness(http!.buildHttpLinks!);
      await waitForSource(1);
      lastSource().failStatus(status);
      await waitFor(() => h.obs.errors.length === 1);

      expect(h.obs.errors).toHaveLength(1);
      expect(h.invalid).toHaveLength(0);
      expect(emod?.classifyTransportError?.(h.obs.errors[0])?.kind).toBe(kind);
      h.timers.advance(60000);
      expect(FakeEventSource.instances).toHaveLength(1);
      expect(h.timers.pending()).toHaveLength(0);

      h.sub.unsubscribe();
      expectAllSourcesClosed();
    }
  });

  test("L8: each successful reopen emits exactly one RECONNECT_SIGNAL before new data", async () => {
    const lmod = await importLifecycle();
    const http = await importHttp();
    expect(http?.buildHttpLinks).toBeFunction();

    const h = makeHarness(http!.buildHttpLinks!);
    await waitForSource(1);
    lastSource().connect();
    await waitFor(() => h.obs.starts === 1);
    lastSource().emit({ type: "line", line: "a" });
    await waitFor(() => h.obs.data.length === 1);
    expect(h.obs.data[0]).toEqual({ type: "line", line: "a" });

    lastSource().dropNetwork();
    await waitFor(() => h.timers.entries.length === 2);
    h.timers.advance(1000);
    await waitForSource(2);
    lastSource().connect();
    await waitFor(() => h.obs.starts === 2);
    lastSource().emit({ type: "line", line: "b" });
    await waitFor(() => h.obs.data.length === 3);

    expect(h.obs.data[1]).toBe(lmod?.RECONNECT_SIGNAL);
    expect(lmod?.isReconnectSignal?.(h.obs.data[0])).toBe(false);
    expect(lmod?.isReconnectSignal?.(h.obs.data[1])).toBe(true);
    expect(lmod?.isReconnectSignal?.(h.obs.data[2])).toBe(false);
    expect(h.obs.data[2]).toEqual({ type: "line", line: "b" });

    lastSource().dropNetwork();
    await waitFor(() => h.timers.entries.at(-1)?.ms === 2000);
    h.timers.advance(2000);
    await waitForSource(3);
    lastSource().connect();
    await waitFor(() => h.obs.starts === 3);
    lastSource().emit({ type: "line", line: "c" });
    await waitFor(() => h.obs.data.length === 5);

    expect(h.obs.data.filter((v) => lmod?.isReconnectSignal?.(v))).toHaveLength(2);
    expect(h.obs.data[4]).toEqual({ type: "line", line: "c" });

    h.sub.unsubscribe();
    expect(h.timers.pending()).toHaveLength(0);
    expectAllSourcesClosed();
  });

  test("L9: lifecycle states flow through onStateChange; inner tRPC states never reach onConnectionStateChange", async () => {
    const http = await importHttp();
    expect(http?.buildHttpLinks).toBeFunction();

    const h = makeHarness(http!.buildHttpLinks!);
    await waitForSource(1);
    lastSource().connect();
    await waitFor(() => h.obs.starts === 1);
    lastSource().dropNetwork();
    await waitFor(() => h.timers.entries.length === 2);
    h.timers.advance(1000);
    await waitForSource(2);
    lastSource().connect();
    await waitFor(() => h.obs.starts === 2);

    expect(h.states.map(stateName)).toEqual([
      "connecting",
      "streaming",
      "reconnecting",
      "connecting",
      "streaming",
    ]);
    const reconnecting = h.states.find((call) => stateName(call) === "reconnecting");
    const details = reconnecting === undefined ? undefined : stateDetails(reconnecting);
    expect(details?.["delayMs"]).toBe(1000);
    expect(details?.["attempt"]).toBe(1);

    expect(h.obs.stops).toBe(0);
    expect(h.obs.starts).toBe(2);
    expect(h.obs.connStates).toHaveLength(0);

    h.sub.unsubscribe();
    await waitFor(() => h.states.length === 6);
    expect(stateName(h.states.at(-1)!)).toBe("idle");
    expect(h.timers.pending()).toHaveLength(0);
    expectAllSourcesClosed();
  });

  test("L10: without a timers option the lifecycle calls globalThis timers with a safe receiver", async () => {
    const http = await importHttp();
    expect(http?.buildHttpLinks).toBeFunction();

    const { recorded, restore } = replaceGlobalTimers();
    try {
      const h = makeHarness(http!.buildHttpLinks!, (opts) => {
        delete opts.timers;
      });
      await waitForSource(1);
      lastSource().dropNetwork();
      await waitFor(() => recorded.length === 1);

      const entry = recorded.at(-1);
      expect(entry?.ms).toBe(1000);
      expect(h.obs.errors).toHaveLength(0);
      expect(h.obs.errors.every((e) => !(e instanceof TypeError))).toBe(true);

      h.sub.unsubscribe();
      expect(entry?.cleared).toBe(true);
      expect(recorded.filter((e) => !e.cleared && !e.fired)).toHaveLength(0);
      expectAllSourcesClosed();
    } finally {
      restore();
    }
  });

  test("L11: the default fetch-based EventSource has no native retry and no leak", async () => {
    const http = await importHttp();
    expect(http?.buildHttpLinks).toBeFunction();

    const { recorded, restore } = replaceGlobalTimers();
    const fetchCalls: string[] = [];
    const rejectingFetch: FakeFetch = (input) => {
      fetchCalls.push(input instanceof Request ? input.url : String(input));
      return Promise.reject(new TypeError("fetch failed"));
    };
    try {
      const h = makeHarness(http!.buildHttpLinks!, (opts) => {
        delete opts.timers;
        delete opts.EventSource;
        opts.baseUrl = "http://127.0.0.1:9/api";
        opts.fetch = rejectingFetch;
      });
      await waitFor(() => fetchCalls.length === 1);
      await waitFor(() => recorded.some((e) => e.ms === 3000 && e.cleared));

      const nativeRetry = recorded.find((e) => e.ms === 3000);
      expect(nativeRetry?.cleared).toBe(true);
      const lifecycleRetry = recorded.find((e) => e.ms === 1000);
      expect(lifecycleRetry).toBeDefined();
      expect(lifecycleRetry?.cleared).toBe(false);
      expect(lifecycleRetry?.fired).toBe(false);
      expect(fetchCalls).toHaveLength(1);
      expect(h.obs.errors).toHaveLength(0);

      fire(lifecycleRetry!);
      await waitFor(() => fetchCalls.length === 2);
      expect(fetchCalls).toHaveLength(2);

      h.sub.unsubscribe();
      await flush();
      expect(recorded.filter((e) => !e.cleared && !e.fired)).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test("L12: a server return ends the stream cleanly — stopped once, complete once, no reconnect", async () => {
    const lmod = await importLifecycle();
    const http = await importHttp();
    expect(lmod?.sseLifecycleLink).toBeFunction();
    expect(http?.buildHttpLinks).toBeFunction();

    const h = makeHarness(http!.buildHttpLinks!);
    await waitForSource(1);
    lastSource().connect();
    await waitFor(() => h.obs.starts === 1);
    lastSource().emit({ type: "line", line: "a" });
    await waitFor(() => h.obs.data.length === 1);
    lastSource().serverReturn();
    await waitFor(() => h.obs.completes === 1);

    expect(h.obs.stops).toBe(1);
    expect(h.obs.completes).toBe(1);
    expect(h.obs.errors).toHaveLength(0);
    expect(h.timers.pending()).toHaveLength(0);
    h.timers.advance(60000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expectAllSourcesClosed();
  });
});
