// DF04a1 slice 1: typed host-memory observations + a pure, conservative
// headroom derivation. Trusts only the host's physical + available readings;
// every other field stays a distinct source-attributed observation. This is
// NOT a model-load grant and NOT a calibrated envelope — calibration keys,
// swap deltas, remote OS collectors and all consumers are deferred. No IO, no
// Date.now, no platform probing: timestamps and readings are injected.

export type MemoryReadStatus = "ok" | "unavailable" | "denied" | "unsupported";

export interface MemoryReading {
  bytes: number | null;
  observedAtMs: number | null;
  source: string;
  status: MemoryReadStatus;
}

export interface HostMemoryObservation {
  physical: MemoryReading;
  available: MemoryReading;
  reclaimable: MemoryReading;
  rss: MemoryReading;
  footprint: MemoryReading;
  device: MemoryReading & { scope: "shared" | "process" | "unknown" };
  swapUsed: MemoryReading;
  pressure: "normal" | "warning" | "critical" | null;
}

export type HostHeadroom =
  | {
      known: true;
      usableBytes: number;
      physicalBytes: number;
      availableBytes: number;
      reservedBytes: number;
    }
  | {
      known: false;
      reason: "invalid-input" | "unknown-source" | "stale-source" | "pressure";
    };

export interface HostHeadroomOptions {
  nowMs: number;
  maxAgeMs: number;
  reserveBytes: number;
}

type Refusal = "invalid-input" | "unknown-source" | "stale-source";

const REFUSAL_RANK: Record<Refusal, number> = {
  "invalid-input": 0,
  "unknown-source": 1,
  "stale-source": 2,
};

type ReadingVerdict = { refusal: Refusal } | { bytes: number };

function inspectReading(reading: MemoryReading, nowMs: number, maxAgeMs: number): ReadingVerdict {
  if (reading.status !== "ok") return { refusal: "unknown-source" };
  if (reading.source.trim() === "") return { refusal: "unknown-source" };
  const bytes = reading.bytes;
  if (bytes === null) return { refusal: "unknown-source" };
  if (!Number.isFinite(bytes) || bytes < 0) return { refusal: "invalid-input" };
  const observedAtMs = reading.observedAtMs;
  if (observedAtMs === null) return { refusal: "unknown-source" };
  if (!Number.isFinite(observedAtMs)) return { refusal: "invalid-input" };
  const age = nowMs - observedAtMs;
  if (age < 0) return { refusal: "invalid-input" };
  if (age > maxAgeMs) return { refusal: "stale-source" };
  return { bytes };
}

function pickWorstRefusal(a: ReadingVerdict, b: ReadingVerdict): Refusal | null {
  const ar = "refusal" in a ? a.refusal : null;
  const br = "refusal" in b ? b.refusal : null;
  if (ar !== null && br !== null) {
    return REFUSAL_RANK[ar] <= REFUSAL_RANK[br] ? ar : br;
  }
  return ar ?? br;
}

export function deriveHostHeadroom(
  observation: HostMemoryObservation,
  options: HostHeadroomOptions,
): HostHeadroom {
  const { nowMs, maxAgeMs, reserveBytes } = options;
  const numericOptionsValid =
    Number.isFinite(nowMs) &&
    Number.isFinite(maxAgeMs) &&
    maxAgeMs >= 0 &&
    Number.isFinite(reserveBytes) &&
    reserveBytes >= 0;
  if (!numericOptionsValid) return { known: false, reason: "invalid-input" };

  const physical = inspectReading(observation.physical, nowMs, maxAgeMs);
  const available = inspectReading(observation.available, nowMs, maxAgeMs);
  if (!("bytes" in physical) || !("bytes" in available)) {
    return {
      known: false,
      reason: pickWorstRefusal(physical, available) ?? "unknown-source",
    };
  }
  const { bytes: physicalBytes } = physical;
  const { bytes: availableBytes } = available;
  if (availableBytes > physicalBytes) return { known: false, reason: "invalid-input" };

  if (observation.pressure === "warning" || observation.pressure === "critical") {
    return { known: false, reason: "pressure" };
  }
  if (observation.pressure !== "normal") return { known: false, reason: "unknown-source" };

  const usableBytes = Math.max(0, availableBytes - reserveBytes);
  return {
    known: true,
    usableBytes,
    physicalBytes,
    availableBytes,
    reservedBytes: reserveBytes,
  };
}
