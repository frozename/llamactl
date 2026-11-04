// Pins for frozename/llamactl#249: per-ModelHost decode/prefill throughput,
// slot occupancy and deferral. Only the monotonic token counters may trigger a
// counter reset — requestsProcessing/requestsDeferred are gauges, so a decrease
// between samples is an ordinary interval, not a reset.
import { describe, expect, it } from "bun:test";

import type * as EngineThroughput from "../src/engine-throughput.js";
import type { SlotProgress, SlotProgressReading } from "../src/types.js";

import * as fleet from "../src/index.js";

type Api = typeof EngineThroughput;

function load(): Api {
  const api = fleet as unknown as Api;
  expect(typeof api.parseEngineMetrics).toBe("function");
  expect(typeof api.parseCompletionTimings).toBe("function");
  expect(typeof api.countBusySlots).toBe("function");
  expect(typeof api.EngineThroughputRecorder).toBe("function");
  return api;
}

function counters(
  prompt: number | null,
  predicted: number | null,
  processing: number | null = null,
  deferred: number | null = null,
): EngineThroughput.EngineMetrics {
  return {
    promptTokensTotal: prompt,
    predictedTokensTotal: predicted,
    requestsProcessing: processing,
    requestsDeferred: deferred,
  };
}

function completion(
  over: Partial<EngineThroughput.CompletionTimings>,
): EngineThroughput.CompletionTimings {
  return {
    promptN: null,
    promptPerSecond: null,
    predictedN: null,
    predictedPerSecond: null,
    cachedN: null,
    ...over,
  };
}

function slot(processing: boolean | null): SlotProgress {
  return { id: null, state: null, processing, nPast: null, nDecoded: null };
}

const NULL_METRICS = {
  promptTokensTotal: null,
  predictedTokensTotal: null,
  requestsProcessing: null,
  requestsDeferred: null,
};

describe("parseEngineMetrics", () => {
  it("reads the four llama-server counters from a prometheus fixture", () => {
    const m = load();
    const fixture = [
      "# HELP llamacpp:prompt_tokens_total Total prompt tokens processed",
      "# TYPE llamacpp:prompt_tokens_total counter",
      "llamacpp:prompt_tokens_total 5000",
      "# HELP llamacpp:tokens_predicted_total Total tokens predicted",
      "# TYPE llamacpp:tokens_predicted_total counter",
      "llamacpp:tokens_predicted_total 1000",
      "# TYPE llamacpp:requests_processing gauge",
      "llamacpp:requests_processing 2",
      "# TYPE llamacpp:requests_deferred gauge",
      "llamacpp:requests_deferred 1",
    ].join("\n");
    expect(m.parseEngineMetrics(fixture)).toEqual({
      promptTokensTotal: 5000,
      predictedTokensTotal: 1000,
      requestsProcessing: 2,
      requestsDeferred: 1,
    });
  });

  it("reads a labeled sample whose label set contains a space", () => {
    const m = load();
    expect(m.parseEngineMetrics('llamacpp:tokens_predicted_total{slot="0", model="x"} 7')).toEqual({
      ...NULL_METRICS,
      predictedTokensTotal: 7,
    });
  });

  it("ignores a trailing prometheus timestamp column", () => {
    const m = load();
    expect(m.parseEngineMetrics("llamacpp:prompt_tokens_total 5000 1730000000000")).toEqual({
      ...NULL_METRICS,
      promptTokensTotal: 5000,
    });
  });

  it("returns null requestsDeferred when the gauge is absent", () => {
    const m = load();
    expect(m.parseEngineMetrics("llamacpp:requests_processing 3")).toEqual({
      ...NULL_METRICS,
      requestsProcessing: 3,
    });
  });

  it("returns all-null metrics for empty, garbage and non-string input", () => {
    const m = load();
    expect(m.parseEngineMetrics("")).toEqual(NULL_METRICS);
    expect(m.parseEngineMetrics("garbage")).toEqual(NULL_METRICS);
    expect(m.parseEngineMetrics(42)).toEqual(NULL_METRICS);
  });

  it("returns null for a NaN metric value", () => {
    const m = load();
    const fixture = "llamacpp:prompt_tokens_total NaN\nllamacpp:tokens_predicted_total 7";
    expect(m.parseEngineMetrics(fixture)).toEqual({
      ...NULL_METRICS,
      predictedTokensTotal: 7,
    });
  });
});

describe("parseCompletionTimings", () => {
  it("reads the timings block of a llama.cpp completion body", () => {
    const m = load();
    const body = {
      choices: [{}],
      timings: {
        prompt_n: 2945,
        prompt_per_second: 589.0,
        predicted_n: 270,
        predicted_per_second: 54.0,
        cache_n: 57000,
      },
    };
    expect(m.parseCompletionTimings(body)).toEqual({
      promptN: 2945,
      promptPerSecond: 589,
      predictedN: 270,
      predictedPerSecond: 54,
      cachedN: 57000,
    });
  });

  it("returns null cachedN when cache_n is absent", () => {
    const m = load();
    const body = {
      timings: {
        prompt_n: 10,
        prompt_per_second: 5,
        predicted_n: 2,
        predicted_per_second: 1,
      },
    };
    expect(m.parseCompletionTimings(body)).toEqual({
      promptN: 10,
      promptPerSecond: 5,
      predictedN: 2,
      predictedPerSecond: 1,
      cachedN: null,
    });
  });

  it("returns null for a usage-only OpenAI body without timings", () => {
    const m = load();
    const body = { usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } };
    expect(m.parseCompletionTimings(body)).toBeNull();
  });

  it("returns null for null, string and array bodies", () => {
    const m = load();
    expect(m.parseCompletionTimings(null)).toBeNull();
    expect(m.parseCompletionTimings("timings")).toBeNull();
    expect(m.parseCompletionTimings([])).toBeNull();
  });

  it("nulls negative counts and non-positive rates but keeps a zero count", () => {
    const m = load();
    const body = {
      timings: {
        predicted_n: 0,
        predicted_per_second: null,
        prompt_n: -1,
        prompt_per_second: 0,
        cache_n: -5,
      },
    };
    expect(m.parseCompletionTimings(body)).toEqual({
      promptN: null,
      promptPerSecond: null,
      predictedN: 0,
      predictedPerSecond: null,
      cachedN: null,
    });
  });
});

describe("countBusySlots", () => {
  it("returns null when the reading is unavailable", () => {
    const m = load();
    expect(m.countBusySlots({ available: false, reason: "HTTP 404", slots: [] })).toBeNull();
  });

  it("counts slots whose processing flag is true", () => {
    const m = load();
    const reading: SlotProgressReading = {
      available: true,
      slots: [slot(true), slot(false), slot(true)],
    };
    expect(m.countBusySlots(reading)).toBe(2);
  });

  it("returns null when every slot's processing flag is unknown", () => {
    const m = load();
    expect(m.countBusySlots({ available: true, slots: [slot(null), slot(null)] })).toBeNull();
  });

  it("returns zero for an available reading with no slots", () => {
    const m = load();
    expect(m.countBusySlots({ available: true, slots: [] })).toBe(0);
  });
});

describe("EngineThroughputRecorder", () => {
  it("computes decode and prefill rates from two counter samples", () => {
    const m = load();
    let t = 0;
    const rec = new m.EngineThroughputRecorder({ now: (): number => t });
    rec.record("gufo", { counters: counters(5000, 1000, 1, 0), busySlots: 1 });
    t = 5000;
    rec.record("gufo", { counters: counters(7945, 1270, 1, 0), busySlots: 1 });
    const stats = rec.get("gufo");
    expect(stats?.sampleCount).toBe(2);
    expect(stats?.intervalCount).toBe(1);
    expect(stats?.counterResets).toBe(0);
    expect(stats?.decodeTokPerSec).toEqual({ median: 54, p10: 54, p90: 54, count: 1 });
    expect(stats?.prefillTokPerSec?.median).toBeCloseTo(589);
    expect(stats?.decodeByBusySlots["1"]).toEqual({ median: 54, p10: 54, p90: 54, count: 1 });
    expect(stats?.firstSampleAt).toBe(new Date(0).toISOString());
    expect(stats?.lastSampleAt).toBe(new Date(5000).toISOString());
  });

  it("counts a dropped counter pair as one reset and drops the interval", () => {
    const m = load();
    let t = 0;
    const rec = new m.EngineThroughputRecorder({ now: (): number => t });
    rec.record("gufo", { counters: counters(5000, 1000, 1, 0), busySlots: 1 });
    t = 5000;
    rec.record("gufo", { counters: counters(7945, 1270, 1, 0), busySlots: 1 });
    t = 10000;
    rec.record("gufo", { counters: counters(100, 40, 1, 0), busySlots: 1 });
    const stats = rec.get("gufo");
    expect(stats?.sampleCount).toBe(3);
    expect(stats?.intervalCount).toBe(1);
    expect(stats?.counterResets).toBe(1);
    expect(stats?.decodeTokPerSec).toEqual({ median: 54, p10: 54, p90: 54, count: 1 });
    expect(stats?.prefillTokPerSec).toEqual({ median: 589, p10: 589, p90: 589, count: 1 });
  });

  it("does not treat gauge decreases between samples as a counter reset", () => {
    const m = load();
    let t = 0;
    const rec = new m.EngineThroughputRecorder({ now: (): number => t });
    rec.record("gufo", { counters: counters(5000, 1000, 2, 1), busySlots: 2 });
    t = 5000;
    rec.record("gufo", { counters: counters(7945, 1200, 1, 0), busySlots: 2 });
    const stats = rec.get("gufo");
    expect(stats?.sampleCount).toBe(2);
    expect(stats?.counterResets).toBe(0);
    expect(stats?.intervalCount).toBe(1);
    expect(stats?.decodeTokPerSec).toEqual({ median: 40, p10: 40, p90: 40, count: 1 });
    expect(stats?.prefillTokPerSec).toEqual({ median: 589, p10: 589, p90: 589, count: 1 });
    expect(stats?.decodeByBusySlots["2"]).toEqual({ median: 40, p10: 40, p90: 40, count: 1 });
    expect(stats?.meanRequestsProcessing).toBeCloseTo(1.5);
    expect(stats?.deferredShare).toBeCloseTo(0.5);
  });

  it("does not treat a gauge falling to zero as a counter reset", () => {
    const m = load();
    let t = 0;
    const rec = new m.EngineThroughputRecorder({ now: (): number => t });
    rec.record("drain", { counters: counters(5000, 1000, 1, 0), busySlots: 1 });
    t = 5000;
    rec.record("drain", { counters: counters(5000, 1050, 0, 0), busySlots: 0 });
    const stats = rec.get("drain");
    expect(stats?.counterResets).toBe(0);
    expect(stats?.intervalCount).toBe(1);
    expect(stats?.decodeTokPerSec).toEqual({ median: 10, p10: 10, p90: 10, count: 1 });
    expect(stats?.prefillTokPerSec).toBeNull();
    expect(stats?.decodeByBusySlots).toEqual({});
  });

  it("treats a revision change as a counter reset, not an interval", () => {
    const m = load();
    let t = 0;
    const rec = new m.EngineThroughputRecorder({ now: (): number => t });
    rec.record("rev", { counters: counters(5000, 1000), busySlots: 1, revision: "a" });
    t = 5000;
    rec.record("rev", { counters: counters(8000, 1300), busySlots: 1, revision: "b" });
    const stats = rec.get("rev");
    expect(stats?.counterResets).toBe(1);
    expect(stats?.intervalCount).toBe(0);
    expect(stats?.decodeTokPerSec).toBeNull();
  });

  it("buckets decode rates by busy-slot count only when occupancy is unchanged", () => {
    const m = load();
    let t = 0;
    const rec = new m.EngineThroughputRecorder({ now: (): number => t });
    const sample = (predicted: number, busy: number): void => {
      rec.record("slots", { counters: counters(null, predicted), busySlots: busy });
      t += 5000;
    };
    sample(0, 1);
    sample(270, 1);
    sample(470, 2);
    sample(740, 2);
    const stats = rec.get("slots");
    expect(stats?.decodeTokPerSec?.count).toBe(3);
    expect(Object.keys(stats?.decodeByBusySlots ?? {}).sort()).toEqual(["1", "2"]);
    expect(stats?.decodeByBusySlots["1"]).toEqual({ median: 54, p10: 54, p90: 54, count: 1 });
    expect(stats?.decodeByBusySlots["2"]).toEqual({ median: 54, p10: 54, p90: 54, count: 1 });
    expect(stats?.maxBusySlots).toBe(2);
    expect(stats?.meanBusySlots).toBeCloseTo(1.5);
    sample(740, 2);
    const after = rec.get("slots");
    expect(after?.decodeTokPerSec?.count).toBe(3);
    expect(after?.decodeByBusySlots["2"]?.count).toBe(1);
    expect(after?.intervalCount).toBe(3);
    expect(after?.sampleCount).toBe(5);
  });

  it("reports null stats when every counter is unavailable", () => {
    const m = load();
    let t = 0;
    const rec = new m.EngineThroughputRecorder({ now: (): number => t });
    for (const at of [0, 1000, 2000]) {
      t = at;
      rec.record("down", { counters: counters(null, null), busySlots: null });
    }
    const stats = rec.get("down");
    expect(stats?.sampleCount).toBe(3);
    expect(stats?.intervalCount).toBe(0);
    expect(stats?.decodeTokPerSec).toBeNull();
    expect(stats?.prefillTokPerSec).toBeNull();
    expect(stats?.meanBusySlots).toBeNull();
    expect(stats?.maxBusySlots).toBeNull();
    expect(stats?.meanRequestsProcessing).toBeNull();
    expect(stats?.deferredShare).toBeNull();
    expect(stats?.requestDecodeTokPerSec).toBeNull();
    expect(stats?.requestPrefillTokPerSec).toBeNull();
    expect(stats?.requestCachedPromptShare).toBeNull();
    expect(stats?.decodeByBusySlots).toEqual({});
    expect(stats?.requestCount).toBe(0);
  });

  it("returns null for a workload that was never recorded", () => {
    const m = load();
    const rec = new m.EngineThroughputRecorder({ now: (): number => 0 });
    expect(rec.get("never-seen")).toBeNull();
  });

  it("summarizes interval rates with nearest-rank percentiles", () => {
    const m = load();
    let t = 0;
    let predicted = 0;
    const rec = new m.EngineThroughputRecorder({ now: (): number => t });
    rec.record("pct", { counters: counters(null, predicted), busySlots: null });
    for (const delta of [70, 10, 100, 40, 20, 90, 60, 30, 80, 50]) {
      t += 1000;
      predicted += delta;
      rec.record("pct", { counters: counters(null, predicted), busySlots: null });
    }
    expect(rec.get("pct")?.decodeTokPerSec).toEqual({ median: 50, p10: 10, p90: 90, count: 10 });
  });

  it("bounds the sample ring and re-bases firstSampleAt", () => {
    const m = load();
    let t = 0;
    const rec = new m.EngineThroughputRecorder({ now: (): number => t, maxSamples: 3 });
    for (const at of [0, 1000, 2000, 3000, 4000]) {
      t = at;
      rec.record("ring", { counters: counters(null, at), busySlots: null });
    }
    const stats = rec.get("ring");
    expect(stats?.sampleCount).toBe(3);
    expect(stats?.firstSampleAt).toBe(new Date(2000).toISOString());
  });

  it("bounds the per-request window with maxRequests", () => {
    const m = load();
    const rec = new m.EngineThroughputRecorder({ now: (): number => 0, maxRequests: 2 });
    for (const rate of [50, 40, 30]) {
      rec.recordCompletion("req", completion({ predictedPerSecond: rate }));
    }
    expect(rec.get("req")?.requestCount).toBe(2);
  });

  it("rejects degenerate bounds", () => {
    const m = load();
    expect(() => new m.EngineThroughputRecorder({ maxSamples: 1 })).toThrow(RangeError);
    expect(() => new m.EngineThroughputRecorder({ maxRequests: 0 })).toThrow(RangeError);
  });

  it("summarizes per-request decode rates in isolation per workload", () => {
    const m = load();
    const rec = new m.EngineThroughputRecorder({ now: (): number => 0 });
    rec.recordCompletion("z13", completion({ predictedPerSecond: 54 }));
    rec.recordCompletion("z13", completion({ predictedPerSecond: 27 }));
    rec.recordCompletion("z13", completion({ predictedPerSecond: 27 }));
    expect(rec.get("z13")?.requestDecodeTokPerSec).toEqual({
      median: 27,
      p10: 27,
      p90: 54,
      count: 3,
    });
    rec.recordCompletion("kapitsa", completion({ predictedPerSecond: 105 }));
    expect(rec.get("kapitsa")?.requestDecodeTokPerSec?.median).toBeCloseTo(105);
    expect(rec.get("z13")?.requestDecodeTokPerSec?.count).toBe(3);
    rec.recordCompletion("z13", completion({}));
    expect(rec.get("z13")?.requestCount).toBe(4);
    expect(rec.get("z13")?.requestDecodeTokPerSec?.count).toBe(3);
  });

  it("computes cached prompt share over completions reporting both counters", () => {
    const m = load();
    const rec = new m.EngineThroughputRecorder({ now: (): number => 0 });
    rec.recordCompletion("cache", completion({ promptN: 50, cachedN: 950 }));
    rec.recordCompletion("cache", completion({ promptN: 150, cachedN: 850 }));
    expect(rec.get("cache")?.requestCachedPromptShare).toBeCloseTo(0.9);
    rec.recordCompletion("cache", completion({ promptN: 1000 }));
    expect(rec.get("cache")?.requestCachedPromptShare).toBeCloseTo(0.9);
  });

  it("reports deferredShare as the share of samples with deferred requests", () => {
    const m = load();
    let t = 0;
    const rec = new m.EngineThroughputRecorder({ now: (): number => t });
    for (const deferred of [0, 1, 0, 2]) {
      rec.record("defer", { counters: counters(null, null, null, deferred), busySlots: null });
      t += 1000;
    }
    const stats = rec.get("defer");
    expect(stats?.deferredShare).toBeCloseTo(0.5);
    expect(stats?.meanRequestsProcessing).toBeNull();
  });

  it("reports meanRequestsProcessing over samples that report it", () => {
    const m = load();
    let t = 0;
    const rec = new m.EngineThroughputRecorder({ now: (): number => t });
    rec.record("proc", { counters: counters(null, null, 1), busySlots: null });
    t = 5000;
    rec.record("proc", { counters: counters(null, null, 3), busySlots: null });
    const stats = rec.get("proc");
    expect(stats?.meanRequestsProcessing).toBeCloseTo(2);
    expect(stats?.deferredShare).toBeNull();
  });

  it("returns defensive copies that do not share state with later get() calls", () => {
    const m = load();
    let t = 0;
    const rec = new m.EngineThroughputRecorder({ now: (): number => t });
    rec.record("z13", { counters: counters(5000, 1000, 1, 0), busySlots: 1 });
    t = 5000;
    rec.record("z13", { counters: counters(7945, 1270, 1, 0), busySlots: 1 });
    const s = rec.get("z13");
    expect(s).not.toBeNull();
    if (s === null) {
      return;
    }
    delete s.decodeByBusySlots["1"];
    s.sampleCount = 99;
    if (s.decodeTokPerSec !== null) {
      s.decodeTokPerSec.median = -1;
    }
    const fresh = rec.get("z13");
    expect(fresh?.sampleCount).toBe(2);
    expect(fresh?.decodeByBusySlots["1"]).toEqual({ median: 54, p10: 54, p90: 54, count: 1 });
    expect(fresh?.decodeTokPerSec?.median).toBeCloseTo(54);
  });

  it("lists recorded workloads sorted and forgets them on demand", () => {
    const m = load();
    const rec = new m.EngineThroughputRecorder({ now: (): number => 0 });
    rec.record("z13", { counters: counters(1, 1), busySlots: null });
    rec.record("gufo", { counters: counters(1, 1), busySlots: null });
    expect(rec.workloads()).toEqual(["gufo", "z13"]);
    rec.forget("z13");
    expect(rec.get("z13")).toBeNull();
    expect(rec.workloads()).toEqual(["gufo"]);
  });
});
