// packages/app/test/console/logs-reconnect.test.ts
// Issue #410 — pins the resumable subscription contract for the
// console logs tail. A server RETURN on serverLogs must schedule a
// bounded reconnect behind a __reconnecting__ data frame instead of
// completing the subscription; the backoff resets only after
// HEALTH_CONFIRM_MS of stable streaming; unsubscribe during backoff
// cancels the pending attempt; and the logs-scope reducer folds the
// reconnecting frame into the conn dot plus a single divider.
// Exports that do not exist at the base commit are read through
// Record casts, so every case fails by assertion — never by import
// or type error.

import { describe, expect, test } from "bun:test";

import * as scope from "../../src/console/logs-scope";
import * as lifecycle from "../../src/lib/transport/sse-lifecycle";

const lifecycleRecord = lifecycle as unknown as Record<string, unknown>;
const scopeRecord = scope as unknown as Record<string, unknown>;

const RECONNECTING_FRAME = lifecycleRecord["RECONNECTING_SIGNAL"] ?? {
  type: "__reconnecting__",
};

type LogsConnStateFn = (
  status: unknown,
  error: unknown,
  gate: unknown,
  reconnecting: boolean,
) => unknown;

const logsConnState4 = scopeRecord["logsConnState"] as LogsConnStateFn | undefined;

const EXPECTED_BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000] as const;
const HEALTH_CONFIRM_ADVANCE_MS = 2000;

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

interface InnerObserver {
  next: (envelope: unknown) => void;
  error: (err: unknown) => void;
  complete: () => void;
}

interface FakeSubscription {
  unsubscribe: () => void;
}

interface FakeObservable {
  subscribe: (observer: InnerObserver) => FakeSubscription;
}

interface HarnessStats {
  nextCalls: number;
  unsubs: number;
  completes: number;
}

interface Harness {
  timers: ManualTimers;
  states: lifecycle.SseLifecycleStateChange[];
  outer: unknown[];
  errors: unknown[];
  inners: InnerObserver[];
  sub: { unsubscribe: () => void };
  stats: () => HarnessStats;
  emitStarted: () => void;
  emitLine: (line: string) => void;
  serverReturn: () => void;
}

const STARTED_ENVELOPE = { result: { type: "started" } };

function lineEnvelope(line: string): unknown {
  return { result: { type: "data", data: { type: "line", line } } };
}

function lineEvent(line: string): { type: "line"; line: string } {
  return { type: "line", line };
}

function isReconnecting(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)["type"] === "__reconnecting__"
  );
}

function reconnectingFlag(state: unknown): unknown {
  return (state as Record<string, unknown>)["reconnecting"];
}

function payloadsOf(envelopes: readonly unknown[]): unknown[] {
  const payloads: unknown[] = [];
  for (const envelope of envelopes) {
    if (typeof envelope !== "object" || envelope === null) continue;
    const result = (envelope as Record<string, unknown>)["result"];
    if (typeof result !== "object" || result === null) continue;
    const fields = result as Record<string, unknown>;
    if (fields["type"] !== "data") continue;
    payloads.push(fields["data"]);
  }
  return payloads;
}

function reconnectingDelays(
  states: readonly lifecycle.SseLifecycleStateChange[],
): (number | undefined)[] {
  return states.filter((s) => s.state === "reconnecting").map((s) => s.delayMs);
}

function makeHarness(): Harness {
  const timers = makeTimers();
  const states: lifecycle.SseLifecycleStateChange[] = [];
  const outer: unknown[] = [];
  const errors: unknown[] = [];
  const inners: InnerObserver[] = [];
  let nextCalls = 0;
  let unsubs = 0;
  let completes = 0;

  const link = lifecycle.sseLifecycleLink({
    timers,
    onStateChange: (event: lifecycle.SseLifecycleStateChange): void => {
      states.push(event);
    },
    resumablePaths: ["serverLogs"],
  } as never)({});

  const obs = link({
    op: {
      id: 1,
      type: "subscription",
      path: "serverLogs",
      input: undefined,
      context: {},
      signal: null,
    },
    next: (): FakeObservable => {
      nextCalls += 1;
      return {
        subscribe(observer: InnerObserver): FakeSubscription {
          inners.push(observer);
          return {
            unsubscribe(): void {
              unsubs += 1;
            },
          };
        },
      };
    },
  } as never);

  const sub = obs.subscribe({
    next: (envelope): void => {
      outer.push(envelope);
    },
    error: (err): void => {
      errors.push(err);
    },
    complete: (): void => {
      completes += 1;
    },
  });

  const emitStarted = (): void => {
    inners.at(-1)!.next(STARTED_ENVELOPE);
  };
  const emitLine = (line: string): void => {
    inners.at(-1)!.next(lineEnvelope(line));
  };
  const serverReturn = (): void => {
    try {
      inners.at(-1)!.complete();
    } catch {
      // handleInnerComplete throws on the terminal path by design.
    }
  };

  return {
    timers,
    states,
    outer,
    errors,
    inners,
    sub,
    stats: (): HarnessStats => ({ nextCalls, unsubs, completes }),
    emitStarted,
    emitLine,
    serverReturn,
  };
}

describe("console logs reconnect (#410)", () => {
  test("a server RETURN on serverLogs reconnects behind a __reconnecting__ frame", () => {
    const h = makeHarness();
    h.emitStarted();
    h.emitLine("a");
    h.serverReturn();

    expect(h.stats().completes).toBe(0);
    expect(h.errors).toHaveLength(0);
    expect(reconnectingDelays(h.states)).toEqual([1000]);
    expect(h.timers.pending()).toHaveLength(1);
    expect(h.timers.pending()[0]?.ms).toBe(1000);
    expect(payloadsOf(h.outer).filter(isReconnecting)).toHaveLength(1);

    h.timers.advance(1000);

    expect(h.stats().nextCalls).toBe(2);
    expect(h.stats().unsubs).toBe(0);

    h.emitStarted();

    expect(h.states.at(-1)?.state).toBe("streaming");
    expect(payloadsOf(h.outer).filter(lifecycle.isReconnectSignal)).toHaveLength(1);
  });

  test("reconnect backoff caps at 30s and resets only after a healthy stream", () => {
    const h = makeHarness();
    const delays: number[] = [];

    for (const expected of EXPECTED_BACKOFF_DELAYS) {
      h.emitStarted();
      h.serverReturn();
      const delay = reconnectingDelays(h.states).at(-1);
      expect(delay).toBe(expected);
      delays.push(delay ?? -1);
      h.timers.advance(delay ?? 0);
    }

    expect(delays).toEqual([...EXPECTED_BACKOFF_DELAYS]);

    h.emitStarted();
    h.timers.advance(HEALTH_CONFIRM_ADVANCE_MS);
    h.serverReturn();

    expect(reconnectingDelays(h.states).at(-1)).toBe(1000);
  });

  test("unsubscribe during backoff cancels the pending reconnect", () => {
    const h = makeHarness();
    h.emitStarted();
    h.serverReturn();

    const pending = h.timers.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.ms).toBe(1000);

    const before = h.stats();
    h.sub.unsubscribe();
    expect(pending[0]?.cleared).toBe(true);

    h.timers.advance(60000);

    expect(h.stats().nextCalls).toBe(before.nextCalls);
    expect(h.stats().completes).toBe(0);
    expect(h.errors).toHaveLength(0);
    expect(h.timers.pending()).toHaveLength(0);
  });

  test("logsReducer marks reconnecting, keeps lines, and lands one divider on RECONNECT_SIGNAL", () => {
    const reducer = scope.logsReducer;
    let state = scope.INITIAL_LOGS_STATE;

    state = reducer(state, { type: "event", event: lineEvent("a") });
    state = reducer(state, { type: "event", event: lineEvent("b") });
    state = reducer(state, { type: "event", event: RECONNECTING_FRAME });

    expect(reconnectingFlag(state)).toBe(true);
    expect(state.entries).toEqual([
      { kind: "line", text: "a" },
      { kind: "line", text: "b" },
    ]);
    expect(logsConnState4!("pending", null, "online", true)).toBe("reconnecting");

    state = reducer(state, { type: "event", event: RECONNECTING_FRAME });
    state = reducer(state, { type: "event", event: lifecycle.RECONNECT_SIGNAL });
    state = reducer(state, { type: "event", event: lineEvent("a") });
    state = reducer(state, { type: "event", event: lineEvent("b") });

    expect(state.entries).toEqual([
      { kind: "divider" },
      { kind: "line", text: "a" },
      { kind: "line", text: "b" },
    ]);
    expect(reconnectingFlag(state)).toBeFalsy();
    expect(Object.hasOwn(state, "reconnecting")).toBe(false);
    expect(logsConnState4!("pending", null, "online", false)).toBe("streaming");

    state = reducer(state, { type: "event", event: RECONNECTING_FRAME });
    state = reducer(state, { type: "clear" });

    expect(reconnectingFlag(state)).toBe(true);
    expect(state.entries).toEqual([]);
  });
});
