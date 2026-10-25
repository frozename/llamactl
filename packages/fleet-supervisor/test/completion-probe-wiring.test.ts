/* eslint-disable @typescript-eslint/require-await -- Test fetch/probe stubs implement async contracts without artificial scheduling. */
import { describe, expect, it } from "bun:test";

import type { CompletionProbeConfig, CompletionProbeResult } from "../src/completion-probe.js";
import type { CompletionProbeState } from "../src/loop-helpers.js";
import type { SlotProgressReading } from "../src/types.js";
import type { WorkloadTarget } from "../src/workload-probe.js";

import { makeDefaultProbeFn } from "../src/loop-helpers.js";
import { detectDegradation } from "../src/policy.js";

const PROBE_CONFIG: CompletionProbeConfig = {
  path: "/v1/chat/completions",
  prompt: "ping",
  maxTokens: 1,
  timeoutMs: 500,
  everyNTicks: 2,
};

function healthyFetch(): (url: string) => Promise<Response> {
  return async (url: string): Promise<Response> => {
    if (url.endsWith("/health")) return new Response("ok", { status: 200 });
    if (url.endsWith("/v1/models"))
      return new Response(JSON.stringify({ data: [{ id: "granite-3b" }] }), { status: 200 });
    return new Response("", { status: 404 });
  };
}

function freshState(): Required<
  Pick<
    CompletionProbeState,
    "consecutiveFailures" | "tickCounter" | "lastResult" | "lastSlotProgress" | "latencySamples"
  >
> {
  return {
    consecutiveFailures: new Map<string, number>(),
    tickCounter: new Map<string, number>(),
    lastResult: new Map(),
    lastSlotProgress: new Map(),
    latencySamples: new Map(),
  };
}

const TARGET: WorkloadTarget = {
  name: "granite-judge",
  endpoint: "http://127.0.0.1:8086",
  kind: "ModelRun",
  completionProbe: PROBE_CONFIG,
};

const DEGRADATION_THRESHOLDS = {
  consecutiveErrorsForDegraded: 3,
  p95DegradedMs: 5_000,
  consecutiveCompletionErrorsForDegraded: 2,
};

describe("makeDefaultProbeFn completion wiring", () => {
  it("runs the completion probe on cadence ticks and stays sticky between them", async () => {
    const seen: { endpoint: string; models: string[]; prior: number }[] = [];
    const fakeProbe = async (
      endpoint: string,
      opts: { models?: string[]; priorConsecutiveFailures?: number },
    ): Promise<CompletionProbeResult> => {
      const prior = opts.priorConsecutiveFailures ?? 0;
      seen.push({ endpoint, models: opts.models ?? [], prior });
      return {
        ok: false,
        status: 503,
        latencyMs: 5,
        classification: "wedge",
        consecutiveFailures: prior + 1,
      };
    };

    const state = freshState();
    const probeFn = makeDefaultProbeFn({
      fetch: healthyFetch() as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
      completion: { ...state, probe: fakeProbe },
    });

    const a = await probeFn(TARGET);
    const b = await probeFn(TARGET);
    const c = await probeFn(TARGET);
    const d = await probeFn(TARGET);

    expect(a.completionProbe).toEqual({
      ran: true,
      ok: false,
      status: 503,
      consecutiveFailures: 1,
      latencyMs: 5,
    });
    expect(b.completionProbe?.ran).toBe(false);
    expect(b.completionProbe?.consecutiveFailures).toBe(1);
    expect(c.completionProbe?.ran).toBe(true);
    expect(c.completionProbe?.consecutiveFailures).toBe(2);
    expect(d.completionProbe?.ran).toBe(false);
    expect(d.completionProbe?.consecutiveFailures).toBe(2);

    // Probe only actually fired on the two cadence ticks, with the served models + resolved endpoint.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({
      endpoint: "http://127.0.0.1:8086",
      models: ["granite-3b"],
      prior: 0,
    });
    expect(seen[1]?.prior).toBe(1);
  });

  it("clears completion state and omits the field when /health is unreachable", async () => {
    const fakeProbe = async (
      _endpoint: string,
      opts: { priorConsecutiveFailures?: number },
    ): Promise<CompletionProbeResult> => ({
      ok: false,
      status: 503,
      latencyMs: 5,
      classification: "wedge",
      consecutiveFailures: (opts.priorConsecutiveFailures ?? 0) + 1,
    });
    const state = freshState();

    const wedged = makeDefaultProbeFn({
      fetch: healthyFetch() as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
      completion: { ...state, probe: fakeProbe },
    });
    await wedged(TARGET);
    expect(state.consecutiveFailures.get("granite-judge")).toBe(1);

    const downFetch = async (): Promise<Response> => new Response("down", { status: 503 });
    const down = makeDefaultProbeFn({
      fetch: downFetch as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
      completion: { ...state, probe: fakeProbe },
    });
    const snap = await down(TARGET);
    expect(snap.reachable).toBe(false);
    expect(snap.completionProbe).toBeUndefined();
    expect(state.consecutiveFailures.has("granite-judge")).toBe(false);
    expect(state.tickCounter.has("granite-judge")).toBe(false);
  });

  it("does not probe a workload without a completionProbe config", async () => {
    let probeCalls = 0;
    const fakeProbe = async (): Promise<CompletionProbeResult> => {
      probeCalls++;
      return { ok: true, status: 200, latencyMs: 1, classification: "ok", consecutiveFailures: 0 };
    };
    const probeFn = makeDefaultProbeFn({
      fetch: healthyFetch() as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
      completion: { ...freshState(), probe: fakeProbe },
    });
    const snap = await probeFn({
      name: "plain",
      endpoint: "http://127.0.0.1:8090",
      kind: "ModelHost",
    });
    expect(snap.completionProbe).toBeUndefined();
    expect(probeCalls).toBe(0);
  });

  it("holds the snapshot counter and adds a busy reason when /slots shows progress", async () => {
    const fakeProbe = async (
      _endpoint: string,
      opts: { priorConsecutiveFailures?: number },
    ): Promise<CompletionProbeResult> => ({
      ok: false,
      status: null,
      latencyMs: 500,
      classification: "wedge",
      consecutiveFailures: (opts.priorConsecutiveFailures ?? 0) + 1,
    });
    const fakeSlots = async (): Promise<SlotProgressReading> => ({
      available: true,
      slots: [{ id: 0, state: 1, processing: true, nPast: 4096, nDecoded: 200 }],
    });
    const state = freshState();
    state.consecutiveFailures.set("granite-judge", 1);
    state.lastSlotProgress.set("granite-judge", {
      nPast: 4096,
      nDecoded: 128,
      stallChecks: 0,
      lastAdvanceAt: 0,
    });

    const probeFn = makeDefaultProbeFn({
      fetch: healthyFetch() as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
      completion: { ...state, probe: fakeProbe, readSlotProgress: fakeSlots },
    });

    const snap = await probeFn(TARGET);

    expect(snap.completionProbe).toMatchObject({
      ran: true,
      ok: false,
      status: null,
      consecutiveFailures: 1,
      latencyMs: 500,
      reason: "busy",
      // F3: forensic slot counters surfaced on the snapshot when the guard ran.
      nPast: 4096,
      nDecoded: 200,
      stallChecks: 0,
    });
    expect(state.consecutiveFailures.get("granite-judge")).toBe(1);
    const stored = state.lastSlotProgress.get("granite-judge");
    expect(stored).toMatchObject({ nPast: 4096, nDecoded: 200, stallChecks: 0 });
    expect(typeof stored?.lastAdvanceAt).toBe("number");
  });

  it("feeds the guarded snapshot counter to degradation policy", async () => {
    const workload = {
      name: "granite-judge",
      kind: "ModelRun" as const,
      endpoint: "http://127.0.0.1:8086",
      priority: 50,
      rss_mb: null,
      request_rate_5m: null,
      error_rate_5m: 0,
      p50_ms: 10,
      p95_ms: 10,
      models: ["granite-3b"],
      reachable: true,
      consecutiveErrors: 0,
      revision: null,
      completionProbe: {
        ran: true,
        ok: false,
        status: null,
        consecutiveFailures: 1,
        latencyMs: 500,
        reason: "busy" as const,
      },
    };

    expect(detectDegradation(workload, "healthy", DEGRADATION_THRESHOLDS)).toBeNull();
  });

  it("holds the snapshot counter when /slots is unavailable", async () => {
    const fakeProbe = async (
      _endpoint: string,
      opts: { priorConsecutiveFailures?: number },
    ): Promise<CompletionProbeResult> => ({
      ok: false,
      status: null,
      latencyMs: 500,
      classification: "wedge",
      consecutiveFailures: (opts.priorConsecutiveFailures ?? 0) + 1,
    });
    const fakeSlots = async (): Promise<SlotProgressReading> => ({
      available: false,
      reason: "HTTP 404",
      slots: [],
    });
    const state = freshState();
    state.consecutiveFailures.set("granite-judge", 1);

    const probeFn = makeDefaultProbeFn({
      fetch: healthyFetch() as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
      completion: { ...state, probe: fakeProbe, readSlotProgress: fakeSlots },
    });

    const snap = await probeFn(TARGET);

    expect(snap.completionProbe).toEqual({
      ran: true,
      ok: false,
      status: null,
      consecutiveFailures: 1,
      latencyMs: 500,
    });
    expect(state.consecutiveFailures.get("granite-judge")).toBe(1);
  });

  it("clears stored slot progress when a completion probe succeeds", async () => {
    const fakeProbe = async (): Promise<CompletionProbeResult> => ({
      ok: true,
      status: 200,
      latencyMs: 80,
      classification: "ok",
      consecutiveFailures: 0,
    });
    const state = freshState();
    state.consecutiveFailures.set("granite-judge", 1);
    state.lastSlotProgress.set("granite-judge", {
      nPast: 4096,
      nDecoded: 128,
      stallChecks: 1,
      lastAdvanceAt: 0,
    });

    const probeFn = makeDefaultProbeFn({
      fetch: healthyFetch() as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
      completion: { ...state, probe: fakeProbe },
    });

    const snap = await probeFn(TARGET);

    expect(snap.completionProbe?.consecutiveFailures).toBe(0);
    expect(state.consecutiveFailures.get("granite-judge")).toBe(0);
    expect(state.lastSlotProgress.has("granite-judge")).toBe(false);
  });

  it("clears stored slot progress and latency samples when /health is unreachable", async () => {
    const fakeProbe = async (): Promise<CompletionProbeResult> => ({
      ok: false,
      status: 503,
      latencyMs: 5,
      classification: "wedge",
      consecutiveFailures: 1,
    });
    const state = freshState();
    state.consecutiveFailures.set("granite-judge", 1);
    state.tickCounter.set("granite-judge", 1);
    state.lastSlotProgress.set("granite-judge", {
      nPast: 4096,
      nDecoded: 128,
      stallChecks: 1,
      lastAdvanceAt: 0,
    });
    state.latencySamples.set("granite-judge", [80, 90, 100]);

    const downFetch = async (): Promise<Response> => new Response("down", { status: 503 });
    const probeFn = makeDefaultProbeFn({
      fetch: downFetch as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
      completion: { ...state, probe: fakeProbe },
    });

    const snap = await probeFn(TARGET);

    expect(snap.completionProbe).toBeUndefined();
    expect(state.lastSlotProgress.has("granite-judge")).toBe(false);
    expect(state.latencySamples.has("granite-judge")).toBe(false);
  });

  it("passes the effective timeout into the probe and records ok latency", async () => {
    const seenTimeouts: number[] = [];
    const fakeProbe = async (
      _endpoint: string,
      opts: { config: CompletionProbeConfig },
    ): Promise<CompletionProbeResult> => {
      seenTimeouts.push(opts.config.timeoutMs);
      return {
        ok: true,
        status: 200,
        latencyMs: 700,
        classification: "ok",
        consecutiveFailures: 0,
      };
    };
    const state = freshState();
    state.latencySamples.set("granite-judge", [1_000, 1_000, 1_000, 1_000, 2_000]);

    const probeFn = makeDefaultProbeFn({
      fetch: healthyFetch() as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
      completion: { ...state, probe: fakeProbe },
    });

    const snap = await probeFn({
      ...TARGET,
      completionProbe: { ...PROBE_CONFIG, k: 3, minSamples: 5, maxTimeoutMs: 600_000 },
    });

    expect(seenTimeouts).toEqual([6_000]);
    expect(snap.completionProbe?.effectiveTimeoutMs).toBe(6_000);
    expect(state.latencySamples.get("granite-judge")).toEqual([
      1_000, 1_000, 1_000, 1_000, 2_000, 700,
    ]);
  });

  it("does not record wedge latency in the adaptive timeout ring", async () => {
    const fakeProbe = async (): Promise<CompletionProbeResult> => ({
      ok: false,
      status: null,
      latencyMs: 5_000,
      classification: "wedge",
      consecutiveFailures: 1,
    });
    const state = freshState();
    state.latencySamples.set("granite-judge", [100, 200, 300, 400, 500]);

    const probeFn = makeDefaultProbeFn({
      fetch: healthyFetch() as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
      completion: { ...state, probe: fakeProbe },
    });

    await probeFn(TARGET);

    expect(state.latencySamples.get("granite-judge")).toEqual([100, 200, 300, 400, 500]);
  });

  it("reads /slots with the generous effective timeout, not the small base (M1)", async () => {
    let slotsTimeout = -1;
    const fakeProbe = async (
      _endpoint: string,
      opts: { priorConsecutiveFailures?: number },
    ): Promise<CompletionProbeResult> => ({
      ok: false,
      status: null,
      latencyMs: 500,
      classification: "wedge",
      consecutiveFailures: (opts.priorConsecutiveFailures ?? 0) + 1,
    });
    const fakeSlots = async (
      _endpoint: string,
      opts?: { timeoutMs?: number },
    ): Promise<SlotProgressReading> => {
      slotsTimeout = opts?.timeoutMs ?? -1;
      return {
        available: true,
        slots: [{ id: 0, state: 1, processing: true, nPast: 5000, nDecoded: 300 }],
      };
    };
    const state = freshState();
    // 5 samples >= minSamples -> p95 2000 * k 3 = 6000 effective timeout (> base 500)
    state.latencySamples.set("granite-judge", [2_000, 2_000, 2_000, 2_000, 2_000]);

    const probeFn = makeDefaultProbeFn({
      fetch: healthyFetch() as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
      completion: { ...state, probe: fakeProbe, readSlotProgress: fakeSlots },
    });

    await probeFn({
      ...TARGET,
      completionProbe: { ...PROBE_CONFIG, k: 3, minSamples: 5, maxTimeoutMs: 600_000 },
    });

    expect(slotsTimeout).toBe(6_000);
  });

  it("clears the stale latency ring when the revision changes with /health still 200 (M2)", async () => {
    const fakeProbe = async (
      _endpoint: string,
      opts: { priorConsecutiveFailures?: number },
    ): Promise<CompletionProbeResult> => ({
      ok: false,
      status: null,
      latencyMs: 500,
      classification: "wedge",
      consecutiveFailures: (opts.priorConsecutiveFailures ?? 0) + 1,
    });
    let created = 1_000;
    const mutableCreatedFetch = async (url: string): Promise<Response> => {
      if (url.endsWith("/health")) return new Response("ok", { status: 200 });
      if (url.endsWith("/v1/models"))
        return new Response(JSON.stringify({ data: [{ id: "granite-3b", created }] }), {
          status: 200,
        });
      return new Response("", { status: 404 });
    };
    const state = { ...freshState(), lastRevision: new Map<string, string | null>() };
    const target = { ...TARGET, completionProbe: { ...PROBE_CONFIG, everyNTicks: 1 } };
    const probeFn = makeDefaultProbeFn({
      fetch: mutableCreatedFetch as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
      completion: { ...state, probe: fakeProbe },
    });

    await probeFn(target);
    await probeFn(target);
    expect(state.lastRevision.get("granite-judge")).toBe("1000");

    // a stale ring from the old boot, then the server restarts (revision flips) without
    // /health ever dropping — the ring must be invalidated so it can't mask a wedge.
    state.latencySamples.set("granite-judge", [9_000, 9_000, 9_000, 9_000, 9_000]);

    created = 2_000;
    // First read of the new boot is unconfirmed (revision null): it must not
    // overwrite "1000" nor clear the ring yet.
    await probeFn(target);
    expect(state.lastRevision.get("granite-judge")).toBe("1000");

    // Second read agrees: the confirmed flip clears the stale ring.
    await probeFn(target);
    expect(state.lastRevision.get("granite-judge")).toBe("2000");
    expect(state.latencySamples.has("granite-judge")).toBe(false);
  });
});

describe("makeDefaultProbeFn revision stability", () => {
  const PLAIN_TARGET: WorkloadTarget = {
    name: "plain",
    endpoint: "http://127.0.0.1:8090",
    kind: "ModelHost",
  };

  it("keeps revision null while every read returns a new created (request-time clock)", async () => {
    let nextCreated = 1_792_877_007;
    const driftingFetch = async (url: string): Promise<Response> => {
      if (url.endsWith("/health")) return new Response("ok", { status: 200 });
      if (url.endsWith("/v1/models")) {
        const body = { data: [{ id: "granite-3b", created: nextCreated }] };
        nextCreated += 4;
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response("", { status: 404 });
    };
    const probeFn = makeDefaultProbeFn({
      fetch: driftingFetch as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
    });

    const a = await probeFn(PLAIN_TARGET);
    const b = await probeFn(PLAIN_TARGET);
    const c = await probeFn(PLAIN_TARGET);

    expect(a.revision).toBeNull();
    expect(b.revision).toBeNull();
    expect(c.revision).toBeNull();
  });

  it("publishes revision only once two consecutive reads agree", async () => {
    let created = 1_000;
    const mutableCreatedFetch = async (url: string): Promise<Response> => {
      if (url.endsWith("/health")) return new Response("ok", { status: 200 });
      if (url.endsWith("/v1/models"))
        return new Response(JSON.stringify({ data: [{ id: "granite-3b", created }] }), {
          status: 200,
        });
      return new Response("", { status: 404 });
    };
    const probeFn = makeDefaultProbeFn({
      fetch: mutableCreatedFetch as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
    });

    const revisions: (string | null)[] = [];
    created = 1_000;
    revisions.push((await probeFn(PLAIN_TARGET)).revision ?? null);
    created = 1_000;
    revisions.push((await probeFn(PLAIN_TARGET)).revision ?? null);
    created = 2_000;
    revisions.push((await probeFn(PLAIN_TARGET)).revision ?? null);
    created = 2_000;
    revisions.push((await probeFn(PLAIN_TARGET)).revision ?? null);

    expect(revisions).toEqual([null, "1000", null, "2000"]);
  });
});

describe("makeDefaultProbeFn local runtime-record revision", () => {
  const LOCAL_TARGET: WorkloadTarget = {
    name: "plain",
    endpoint: "http://127.0.0.1:8090",
    kind: "ModelHost",
  };

  function fixedCreatedFetch(created: number) {
    return async (url: string): Promise<Response> => {
      if (url.endsWith("/health")) return new Response("ok", { status: 200 });
      if (url.endsWith("/v1/models"))
        return new Response(JSON.stringify({ data: [{ id: "granite-3b", created }] }), {
          status: 200,
        });
      return new Response("", { status: 404 });
    };
  }

  it("uses the local runtime-record revision while /v1/models created drifts", async () => {
    let nextCreated = 1_792_877_007;
    const driftingFetch = async (url: string): Promise<Response> => {
      if (url.endsWith("/health")) return new Response("ok", { status: 200 });
      if (url.endsWith("/v1/models")) {
        const body = { data: [{ id: "granite-3b", created: nextCreated }] };
        nextCreated += 4;
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response("", { status: 404 });
    };
    const probeFn = makeDefaultProbeFn({
      fetch: driftingFetch as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
      readLocalRevision: () => "epoch-1",
    });

    const a = await probeFn(LOCAL_TARGET);
    const b = await probeFn(LOCAL_TARGET);
    const c = await probeFn(LOCAL_TARGET);

    expect(a.revision).toBe("epoch-1");
    expect(b.revision).toBe("epoch-1");
    expect(c.revision).toBe("epoch-1");
  });

  it("changes the revision when the local record changes (restart)", async () => {
    const revisions = ["epoch-1", "epoch-1", "epoch-2"];
    let calls = 0;
    const probeFn = makeDefaultProbeFn({
      fetch: fixedCreatedFetch(1_000) as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
      readLocalRevision: () => revisions[calls++] ?? "epoch-2",
    });

    const seen: (string | null)[] = [];
    seen.push((await probeFn(LOCAL_TARGET)).revision ?? null);
    seen.push((await probeFn(LOCAL_TARGET)).revision ?? null);
    seen.push((await probeFn(LOCAL_TARGET)).revision ?? null);

    expect(seen).toEqual(["epoch-1", "epoch-1", "epoch-2"]);
  });

  it("falls back to the two-read rule when there is no local record", async () => {
    const probeFn = makeDefaultProbeFn({
      fetch: fixedCreatedFetch(1_000) as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
      readLocalRevision: () => null,
    });

    const first = await probeFn(LOCAL_TARGET);
    const second = await probeFn(LOCAL_TARGET);

    expect([first.revision, second.revision]).toEqual([null, "1000"]);
  });

  it("publishes null when /health is unreachable even with a local record", async () => {
    const downFetch = async (): Promise<Response> => new Response("down", { status: 503 });
    const probeFn = makeDefaultProbeFn({
      fetch: downFetch as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
      readLocalRevision: () => "epoch-1",
    });

    const snap = await probeFn(LOCAL_TARGET);

    expect(snap.revision).toBeNull();
    expect(snap.reachable).toBe(false);
  });

  it("a throwing reader falls back without failing the probe", async () => {
    const probeFn = makeDefaultProbeFn({
      fetch: fixedCreatedFetch(1_000) as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
      readLocalRevision: (): string | null => {
        throw new Error("record unreadable");
      },
    });

    const first = await probeFn(LOCAL_TARGET);
    const second = await probeFn(LOCAL_TARGET);

    expect([first.revision, second.revision]).toEqual([null, "1000"]);
  });

  it("a local revision flip clears the stale latency ring", async () => {
    const fakeProbe = async (
      _endpoint: string,
      opts: { priorConsecutiveFailures?: number },
    ): Promise<CompletionProbeResult> => ({
      ok: false,
      status: null,
      latencyMs: 500,
      classification: "wedge",
      consecutiveFailures: (opts.priorConsecutiveFailures ?? 0) + 1,
    });
    let localRevision = "epoch-1";
    const state = { ...freshState(), lastRevision: new Map<string, string | null>() };
    const target = { ...TARGET, completionProbe: { ...PROBE_CONFIG, everyNTicks: 1 } };
    const probeFn = makeDefaultProbeFn({
      fetch: healthyFetch() as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
      completion: { ...state, probe: fakeProbe },
      readLocalRevision: () => localRevision,
    });

    await probeFn(target);
    expect(state.lastRevision.get("granite-judge")).toBe("epoch-1");

    // Stale ring from the old boot; the workload restarts (record rewritten)
    // without /health ever dropping — the ring must be invalidated.
    state.latencySamples.set("granite-judge", [9_000, 9_000, 9_000, 9_000, 9_000]);

    localRevision = "epoch-2";
    await probeFn(target);
    expect(state.lastRevision.get("granite-judge")).toBe("epoch-2");
    expect(state.latencySamples.has("granite-judge")).toBe(false);
  });
});
