// Collector wiring for frozename/llamactl#249: reads `${endpoint}/metrics` and
// `${endpoint}/slots` on DIRECT llama-server endpoints only. Endpoints routed
// through the node agent's internal proxy (resolveInternalProxyEndpoint, shared
// by all useProxy workloads, whose bare /metrics is the agent's own registry)
// are not supported yet — the later supervisor-CLI-flag PR owns proxied
// endpoints (frozename/llamactl#249). GET-only: never triggers inference or
// wakes a model.

import type { EngineMetrics, EngineThroughputRecorder } from "./engine-throughput.js";
import type { EngineThroughputSnapshot, WorkloadSnapshot } from "./types.js";
import type { WorkloadTarget } from "./workload-probe.js";

import { countBusySlots, parseEngineMetrics } from "./engine-throughput.js";
import { readSlotProgress } from "./slot-progress.js";
import { InvalidEndpointError, validateProbeEndpoint } from "./workload-probe.js";

const DEFAULT_TIMEOUT_MS = 5_000;

export interface ReadEngineMetricsOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  allowPublicEndpoints?: boolean;
}

export type EngineMetricsReading =
  | { available: true; metrics: EngineMetrics }
  | { available: false; reason: string; metrics: EngineMetrics };

function nullMetrics(): EngineMetrics {
  return {
    promptTokensTotal: null,
    predictedTokensTotal: null,
    requestsProcessing: null,
    requestsDeferred: null,
  };
}

function allNull(metrics: EngineMetrics): boolean {
  return (
    metrics.promptTokensTotal === null &&
    metrics.predictedTokensTotal === null &&
    metrics.requestsProcessing === null &&
    metrics.requestsDeferred === null
  );
}

/**
 * Read a workload's `/metrics` once, read-only. Mirrors readSlotProgress:
 * every failure returns `available:false` with a reason instead of throwing,
 * and an unavailable reading carries all-null counters, never zeros.
 */
export async function readEngineMetrics(
  endpoint: string,
  opts: ReadEngineMetricsOptions = {},
): Promise<EngineMetricsReading> {
  const {
    fetch: fetchFn = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    allowPublicEndpoints = false,
  } = opts;

  try {
    validateProbeEndpoint(endpoint, allowPublicEndpoints);
  } catch (err) {
    if (err instanceof InvalidEndpointError) {
      return {
        available: false,
        reason: `invalid endpoint: ${err.message}`,
        metrics: nullMetrics(),
      };
    }
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetchFn(`${endpoint}/metrics`, { method: "GET", signal: controller.signal });
    if (!res.ok) {
      return { available: false, reason: `HTTP ${String(res.status)}`, metrics: nullMetrics() };
    }
    const body = await res.text();
    const metrics = parseEngineMetrics(body);
    if (allNull(metrics)) {
      return { available: false, reason: "no llama.cpp counters", metrics: nullMetrics() };
    }
    return { available: true, metrics };
  } catch {
    return { available: false, reason: "network/timeout", metrics: nullMetrics() };
  } finally {
    clearTimeout(timer);
  }
}

export interface CollectEngineThroughputOptions {
  workloads: WorkloadSnapshot[];
  targets: WorkloadTarget[];
  recorder: EngineThroughputRecorder;
  tickMs: number;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  allowPublicEndpoints?: boolean;
}

type CollectorReadOptions = Pick<
  CollectEngineThroughputOptions,
  "fetch" | "timeoutMs" | "allowPublicEndpoints"
>;

function readOptionsFrom(opts: CollectEngineThroughputOptions): CollectorReadOptions {
  return {
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.allowPublicEndpoints !== undefined
      ? { allowPublicEndpoints: opts.allowPublicEndpoints }
      : {}),
  };
}

function unreachableSnapshot(
  target: WorkloadTarget,
  snapshot: WorkloadSnapshot | undefined,
  recorder: EngineThroughputRecorder,
  sampledAt: string,
): EngineThroughputSnapshot {
  return {
    workload: target.name,
    revision: snapshot?.revision ?? null,
    sampledAt,
    metrics: { available: false, reason: "workload unreachable" },
    slots: { available: false, reason: "workload unreachable" },
    stats: recorder.get(target.name),
  };
}

function availabilityField(reading: { available: boolean; reason?: string }): {
  available: boolean;
  reason?: string;
} {
  if (reading.available || reading.reason === undefined) return { available: reading.available };
  return { available: reading.available, reason: reading.reason };
}

async function sampleTarget(
  target: WorkloadTarget,
  snapshot: WorkloadSnapshot,
  recorder: EngineThroughputRecorder,
  readOptions: CollectorReadOptions,
  sampledAt: string,
): Promise<EngineThroughputSnapshot> {
  const [metrics, slots] = await Promise.all([
    readEngineMetrics(target.endpoint, readOptions),
    readSlotProgress(target.endpoint, readOptions),
  ]);

  if (metrics.available || slots.available) {
    recorder.recordCounters(target.name, {
      counters: metrics.metrics,
      busySlots: slots.available ? countBusySlots(slots) : null,
      revision: snapshot.revision ?? null,
    });
  }

  return {
    workload: target.name,
    revision: snapshot.revision ?? null,
    sampledAt,
    metrics: availabilityField(metrics),
    slots: availabilityField(slots),
    stats: recorder.get(target.name),
  };
}

/**
 * One read-only /metrics + /slots sample per reachable ModelHost target, fed
 * into the caller-owned recorder (the loop keeps one recorder so rate windows
 * persist across ticks). Never reads a clock itself — every timestamp derives
 * from `tickMs`.
 */
export async function collectEngineThroughput(
  opts: CollectEngineThroughputOptions,
): Promise<EngineThroughputSnapshot[]> {
  const { workloads, targets, recorder, tickMs } = opts;
  const sampledAt = new Date(tickMs).toISOString();
  const readOptions = readOptionsFrom(opts);
  const out: EngineThroughputSnapshot[] = [];

  for (const target of targets) {
    if (target.kind !== "ModelHost") continue;
    const snapshot = workloads.find((workload) => workload.name === target.name);
    if (!snapshot?.reachable) {
      out.push(unreachableSnapshot(target, snapshot, recorder, sampledAt));
      continue;
    }
    out.push(await sampleTarget(target, snapshot, recorder, readOptions, sampledAt));
  }
  return out;
}
