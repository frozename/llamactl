// E-11 / frozename/llamactl#523: p50/p95 cold-start load-ms estimates per
// (model, node). Bench vision load_ms is the only load-time record at the
// base: #249 holds throughput only and DF-04 holds memory only. It is a
// vision-only proxy from the one-shot llama-mtmd-cli (model + mmproj load),
// not llama-server spawn-to-ready, so text-only models get no samples. Live
// spawn-to-ready capture is still to be built. `machine` is a hardware
// profile, so callers must map it to a node. Not wired into the scorer or
// cold catalog yet (E-13).
import type { BenchVision } from "@llamactl/core/schemas";

export type ColdStartSample = {
  model: string;
  node: string;
  loadMs: number;
  observedAtMs: number;
};

export type ColdStartKey = {
  model: string;
  node: string;
};

export type ColdStartEstimate =
  | {
      state: "unknown";
      model: string;
      node: string;
      sampleCount: 0;
    }
  | {
      state: "estimated";
      model: string;
      node: string;
      p50Ms: number;
      p95Ms: number;
      sampleCount: number;
    };

export type ColdStartOptions = {
  now: () => number;
  windowMs: number;
  maxSamples: number;
};

export type BenchVisionAdapterOptions = {
  resolveNode: (machineProfile: string) => string | undefined;
};

function nearestRank(sorted: number[], quantile: number): number {
  const rank = Math.ceil(quantile * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? 0;
}

const BENCH_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:?\d{2})$/;

function parseBenchTimestamp(value: string): number | undefined {
  const match = BENCH_TIMESTAMP.exec(value);
  if (!match) return undefined;
  const offset = match[7] ?? "Z";
  let offsetMs = 0;
  if (offset !== "Z") {
    const digits = offset.slice(1).replace(":", "");
    const offsetMinutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
    offsetMs = (offset.startsWith("-") ? -1 : 1) * offsetMinutes * 60_000;
  }
  const epochMs =
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    ) - offsetMs;
  return Number.isFinite(epochMs) ? epochMs : undefined;
}

export function estimateColdStart(
  samples: readonly ColdStartSample[],
  key: ColdStartKey,
  opts: ColdStartOptions,
): ColdStartEstimate {
  if (!Number.isFinite(opts.windowMs) || opts.windowMs <= 0) {
    throw new RangeError("windowMs must be finite and > 0");
  }
  if (!Number.isInteger(opts.maxSamples) || opts.maxSamples < 1) {
    throw new RangeError("maxSamples must be an integer >= 1");
  }

  const t = opts.now();
  const matching = samples.filter(
    (sample) =>
      sample.model === key.model &&
      sample.node === key.node &&
      Number.isFinite(sample.loadMs) &&
      sample.loadMs > 0 &&
      Number.isFinite(sample.observedAtMs) &&
      t - opts.windowMs <= sample.observedAtMs &&
      sample.observedAtMs <= t,
  );

  const capped = [...matching]
    .sort((a, b) => b.observedAtMs - a.observedAtMs)
    .slice(0, opts.maxSamples);

  if (capped.length === 0) {
    return { state: "unknown", model: key.model, node: key.node, sampleCount: 0 };
  }

  const sortedLoads = capped.map((sample) => sample.loadMs).sort((a, b) => a - b);
  return {
    state: "estimated",
    model: key.model,
    node: key.node,
    p50Ms: nearestRank(sortedLoads, 0.5),
    p95Ms: nearestRank(sortedLoads, 0.95),
    sampleCount: sortedLoads.length,
  };
}

export function coldStartSamplesFromBenchVision(
  rows: readonly BenchVision[],
  opts: BenchVisionAdapterOptions,
): ColdStartSample[] {
  const samples: ColdStartSample[] = [];
  for (const row of rows) {
    const node = opts.resolveNode(row.machine);
    if (node === undefined || node === "") continue;
    const loadMs = Number(row.load_ms);
    if (!Number.isFinite(loadMs) || loadMs <= 0) continue;
    const observedAtMs = parseBenchTimestamp(row.updated_at);
    if (observedAtMs === undefined) continue;
    samples.push({ model: row.rel, node, loadMs, observedAtMs });
  }
  return samples;
}
