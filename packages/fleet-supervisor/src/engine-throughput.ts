// Read-only per-ModelHost throughput recorder for frozename/llamactl#249:
// decode/prefill token rates, slot occupancy and deferral, derived from
// llama-server /metrics counters and completion `timings` blocks. Pure and
// observational — loop wiring, journaling, the CLI surface, proxy capture and
// a fleet cache-hit gauge are later follow-ups.

import type { SlotProgressReading } from "./types.js";

/** llama-server `/metrics` counters, defensively parsed; null when absent or unparseable. */
export interface EngineMetrics {
  promptTokensTotal: number | null;
  predictedTokensTotal: number | null;
  requestsProcessing: number | null;
  requestsDeferred: number | null;
}

/** A llama.cpp completion `timings` block, camelCased; null when the field is unknown. */
export interface CompletionTimings {
  promptN: number | null;
  promptPerSecond: number | null;
  predictedN: number | null;
  predictedPerSecond: number | null;
  cachedN: number | null;
}

/** One counter + occupancy observation for a workload, taken at `now()`. */
export interface CounterSampleInput {
  counters: EngineMetrics;
  busySlots: number | null;
  revision?: string | null;
}

/** Nearest-rank summary over a bounded window of rate observations. */
export interface ThroughputDistribution {
  median: number;
  p10: number;
  p90: number;
  count: number;
}

export interface WorkloadThroughputStats {
  workload: string;
  revision: string | null;
  sampleCount: number;
  intervalCount: number;
  counterResets: number;
  firstSampleAt: string | null;
  lastSampleAt: string | null;
  decodeTokPerSec: ThroughputDistribution | null;
  prefillTokPerSec: ThroughputDistribution | null;
  decodeByBusySlots: Record<string, ThroughputDistribution>;
  meanBusySlots: number | null;
  maxBusySlots: number | null;
  meanRequestsProcessing: number | null;
  deferredShare: number | null;
  requestCount: number;
  requestDecodeTokPerSec: ThroughputDistribution | null;
  requestPrefillTokPerSec: ThroughputDistribution | null;
  requestCachedPromptShare: number | null;
}

export interface EngineThroughputRecorderOptions {
  now?: () => number;
  maxSamples?: number;
  maxRequests?: number;
}

export type EngineCounters = EngineMetrics;
export type RateDistribution = ThroughputDistribution;
export type EngineThroughputStats = WorkloadThroughputStats;

const METRIC_FIELDS: Record<string, keyof EngineMetrics> = {
  "llamacpp:prompt_tokens_total": "promptTokensTotal",
  "llamacpp:tokens_predicted_total": "predictedTokensTotal",
  "llamacpp:requests_processing": "requestsProcessing",
  "llamacpp:requests_deferred": "requestsDeferred",
};

// Only monotonic counters may signal a reset; requestsProcessing and
// requestsDeferred are gauges whose normal decreases are not restarts
// (frozename/llamactl#249).
const RESET_COUNTER_KEYS = ["promptTokensTotal", "predictedTokensTotal"] as const;

function emptyMetrics(): EngineMetrics {
  return {
    promptTokensTotal: null,
    predictedTokensTotal: null,
    requestsProcessing: null,
    requestsDeferred: null,
  };
}

function parseMetricLine(line: string): { field: keyof EngineMetrics; value: number } | null {
  const nameMatch = /^[A-Za-z_:][\w:]*/.exec(line);
  if (nameMatch === null) {
    return null;
  }
  const name = nameMatch[0];
  const field = METRIC_FIELDS[name];
  if (field === undefined) {
    return null;
  }
  let rest = line.slice(name.length);
  if (rest.startsWith("{")) {
    const close = rest.indexOf("}");
    if (close === -1) {
      return null;
    }
    rest = rest.slice(close + 1);
  }
  const valueToken = rest.trim().split(/\s+/)[0];
  if (valueToken === undefined || valueToken === "") {
    return null;
  }
  const value = Number(valueToken);
  return Number.isFinite(value) ? { field, value } : null;
}

export function parseEngineMetrics(text: unknown): EngineMetrics {
  const parsed = emptyMetrics();
  if (typeof text !== "string") {
    return parsed;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const sample = parseMetricLine(line);
    if (sample === null) {
      continue;
    }
    parsed[sample.field] ??= sample.value;
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return null;
}

function positiveRate(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  return null;
}

export function parseCompletionTimings(body: unknown): CompletionTimings | null {
  if (!isRecord(body)) {
    return null;
  }
  const timings = body["timings"];
  if (!isRecord(timings)) {
    return null;
  }
  return {
    promptN: nonNegativeCount(timings["prompt_n"]),
    promptPerSecond: positiveRate(timings["prompt_per_second"]),
    predictedN: nonNegativeCount(timings["predicted_n"]),
    predictedPerSecond: positiveRate(timings["predicted_per_second"]),
    cachedN: nonNegativeCount(timings["cache_n"]),
  };
}

export function countBusySlots(reading: SlotProgressReading): number | null {
  if (!reading.available) {
    return null;
  }
  if (reading.slots.length === 0) {
    return 0;
  }
  let known = false;
  let busy = 0;
  for (const slot of reading.slots) {
    if (slot.processing !== null) {
      known = true;
      if (slot.processing) {
        busy += 1;
      }
    }
  }
  return known ? busy : null;
}

function rankValue(sorted: number[], quantile: number): number {
  const rank = Math.ceil(quantile * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? 0;
}

function distribution(values: number[]): RateDistribution | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: rankValue(sorted, 0.5),
    p10: rankValue(sorted, 0.1),
    p90: rankValue(sorted, 0.9),
    count: sorted.length,
  };
}

function meanOf(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}

function maxOf(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  let max = values[0] ?? 0;
  for (const value of values) {
    if (value > max) {
      max = value;
    }
  }
  return max;
}

function definedValues<T>(items: T[], read: (item: T) => number | null): number[] {
  const out: number[] = [];
  for (const item of items) {
    const value = read(item);
    if (value !== null) {
      out.push(value);
    }
  }
  return out;
}

interface CounterSample {
  atMs: number;
  counters: EngineMetrics;
  busySlots: number | null;
  revision: string | null;
}

interface WorkloadBuffer {
  samples: CounterSample[];
  completions: CompletionTimings[];
}

interface IntervalRates {
  decode: number[];
  prefill: number[];
  bySlots: Map<string, number[]>;
  intervalCount: number;
  resets: number;
}

function decreased(prev: number | null, next: number | null): boolean {
  return prev !== null && next !== null && next < prev;
}

function isCounterReset(a: CounterSample, b: CounterSample): boolean {
  if (a.revision !== null && b.revision !== null && a.revision !== b.revision) {
    return true;
  }
  return RESET_COUNTER_KEYS.some((key) => decreased(a.counters[key], b.counters[key]));
}

function positiveDelta(prev: number | null, next: number | null, dtSec: number): number | null {
  if (prev === null || next === null) {
    return null;
  }
  const rate = (next - prev) / dtSec;
  return rate > 0 ? rate : null;
}

function pushGroup(groups: Map<string, number[]>, key: string, value: number): void {
  const existing = groups.get(key);
  if (existing === undefined) {
    groups.set(key, [value]);
    return;
  }
  existing.push(value);
}

function absorbPair(rates: IntervalRates, a: CounterSample, b: CounterSample): void {
  const dtSec = (b.atMs - a.atMs) / 1000;
  if (dtSec <= 0) {
    return;
  }
  if (isCounterReset(a, b)) {
    rates.resets += 1;
    return;
  }
  const decode = positiveDelta(
    a.counters.predictedTokensTotal,
    b.counters.predictedTokensTotal,
    dtSec,
  );
  const prefill = positiveDelta(a.counters.promptTokensTotal, b.counters.promptTokensTotal, dtSec);
  if (decode !== null) {
    rates.decode.push(decode);
  }
  if (prefill !== null) {
    rates.prefill.push(prefill);
  }
  if (decode !== null || prefill !== null) {
    rates.intervalCount += 1;
  }
  if (decode !== null && a.busySlots !== null && a.busySlots === b.busySlots) {
    pushGroup(rates.bySlots, String(a.busySlots), decode);
  }
}

function collectIntervals(samples: CounterSample[]): IntervalRates {
  const rates: IntervalRates = {
    decode: [],
    prefill: [],
    bySlots: new Map<string, number[]>(),
    intervalCount: 0,
    resets: 0,
  };
  for (const [index, current] of samples.entries()) {
    const previous = index === 0 ? undefined : samples[index - 1];
    if (previous === undefined) {
      continue;
    }
    absorbPair(rates, previous, current);
  }
  return rates;
}

function distributionsByGroup(groups: Map<string, number[]>): Record<string, RateDistribution> {
  const out: Record<string, RateDistribution> = {};
  for (const [key, values] of groups) {
    const dist = distribution(values);
    if (dist !== null) {
      out[key] = dist;
    }
  }
  return out;
}

function deferredShareOf(samples: CounterSample[]): number | null {
  let known = 0;
  let deferred = 0;
  for (const sample of samples) {
    const value = sample.counters.requestsDeferred;
    if (value !== null) {
      known += 1;
      if (value > 0) {
        deferred += 1;
      }
    }
  }
  return known === 0 ? null : deferred / known;
}

function cachedShareOf(completions: CompletionTimings[]): number | null {
  let cached = 0;
  let uncached = 0;
  for (const completion of completions) {
    if (
      completion.cachedN !== null &&
      completion.promptN !== null &&
      completion.cachedN + completion.promptN > 0
    ) {
      cached += completion.cachedN;
      uncached += completion.promptN;
    }
  }
  const total = cached + uncached;
  return total > 0 ? cached / total : null;
}

function isoOf(sample: CounterSample | undefined): string | null {
  return sample === undefined ? null : new Date(sample.atMs).toISOString();
}

const defaultNow = (): number => Date.now();

export class EngineThroughputRecorder {
  private readonly nowFn: () => number;
  private readonly maxSamples: number;
  private readonly maxRequests: number;
  private readonly buffers = new Map<string, WorkloadBuffer>();

  constructor(opts?: EngineThroughputRecorderOptions) {
    const maxSamples = opts?.maxSamples ?? 240;
    const maxRequests = opts?.maxRequests ?? 256;
    if (!Number.isInteger(maxSamples) || maxSamples < 2) {
      throw new RangeError(`maxSamples must be an integer >= 2, got ${String(maxSamples)}`);
    }
    if (!Number.isInteger(maxRequests) || maxRequests < 1) {
      throw new RangeError(`maxRequests must be an integer >= 1, got ${String(maxRequests)}`);
    }
    this.nowFn = opts?.now ?? defaultNow;
    this.maxSamples = maxSamples;
    this.maxRequests = maxRequests;
  }

  recordCounters(workload: string, input: CounterSampleInput): void {
    const buffer = this.bufferFor(workload);
    buffer.samples.push({
      atMs: this.nowFn(),
      counters: { ...input.counters },
      busySlots: input.busySlots,
      revision: input.revision ?? null,
    });
    while (buffer.samples.length > this.maxSamples) {
      buffer.samples.shift();
    }
  }

  record(workload: string, input: CounterSampleInput): void {
    this.recordCounters(workload, input);
  }

  recordCompletion(workload: string, timings: CompletionTimings): void {
    const buffer = this.bufferFor(workload);
    buffer.completions.push({ ...timings });
    while (buffer.completions.length > this.maxRequests) {
      buffer.completions.shift();
    }
  }

  get(workload: string): EngineThroughputStats | null {
    const buffer = this.buffers.get(workload);
    if (buffer === undefined) {
      return null;
    }
    const intervals = collectIntervals(buffer.samples);
    const busy = definedValues(buffer.samples, (sample) => sample.busySlots);
    const processing = definedValues(
      buffer.samples,
      (sample) => sample.counters.requestsProcessing,
    );
    const requestDecode = definedValues(
      buffer.completions,
      (completion) => completion.predictedPerSecond,
    );
    const requestPrefill = definedValues(
      buffer.completions,
      (completion) => completion.promptPerSecond,
    );
    const last = buffer.samples.at(-1);
    return {
      workload,
      revision: last?.revision ?? null,
      sampleCount: buffer.samples.length,
      intervalCount: intervals.intervalCount,
      counterResets: intervals.resets,
      firstSampleAt: isoOf(buffer.samples[0]),
      lastSampleAt: isoOf(last),
      decodeTokPerSec: distribution(intervals.decode),
      prefillTokPerSec: distribution(intervals.prefill),
      decodeByBusySlots: distributionsByGroup(intervals.bySlots),
      meanBusySlots: meanOf(busy),
      maxBusySlots: maxOf(busy),
      meanRequestsProcessing: meanOf(processing),
      deferredShare: deferredShareOf(buffer.samples),
      requestCount: buffer.completions.length,
      requestDecodeTokPerSec: distribution(requestDecode),
      requestPrefillTokPerSec: distribution(requestPrefill),
      requestCachedPromptShare: cachedShareOf(buffer.completions),
    };
  }

  workloads(): string[] {
    return [...this.buffers.keys()].sort();
  }

  forget(workload: string): void {
    this.buffers.delete(workload);
  }

  private bufferFor(workload: string): WorkloadBuffer {
    const existing = this.buffers.get(workload);
    if (existing !== undefined) {
      return existing;
    }
    const created: WorkloadBuffer = { samples: [], completions: [] };
    this.buffers.set(workload, created);
    return created;
  }
}
