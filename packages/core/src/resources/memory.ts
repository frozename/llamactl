// DF04a1 slice 1: typed host-memory observations + a pure, conservative
// headroom derivation. Trusts only the host's physical + available readings;
// every other field stays a distinct source-attributed observation. This is
// NOT a model-load grant and NOT a calibrated envelope — calibration keys,
// swap deltas, remote OS collectors and all consumers are deferred. No IO, no
// Date.now, no platform probing: timestamps and readings are injected.
//
// Core accepts already-validated typed observations here. Untyped transport
// decoding, auth and provenance validation belong to the remote observer /
// consumer slice; the `source` string is attribution metadata, not a
// credential, so no source-prefix allowlist or trusted flag exists in core.

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
  // Configured host reserve policy, not an observed or committed workload
  // reservation: derivation acquires nothing. 12GiB reserve against 8GiB
  // available is a valid input that floors usableBytes to zero, not an error.
  reserveBytes: number;
}

type Refusal = "invalid-input" | "unknown-source" | "stale-source";

// Precedence policy when several host readings fail at once:
// invalid-input > unknown-source > stale-source. A malformed reading outranks
// a missing one, which outranks a lapsed one, so the operator sees the
// fixable cause first. This ranking is the contract, not field order; the
// dual-refusal tests in memory-envelope.test.ts pin both directions.
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
  if (observedAtMs < 0) return { refusal: "invalid-input" };
  const age = nowMs - observedAtMs;
  if (age < 0) return { refusal: "invalid-input" };
  if (age > maxAgeMs) return { refusal: "stale-source" };
  return { bytes };
}

function worseRefusal(a: Refusal, b: Refusal): Refusal {
  return REFUSAL_RANK[a] <= REFUSAL_RANK[b] ? a : b;
}

export function deriveHostHeadroom(
  observation: HostMemoryObservation,
  options: HostHeadroomOptions,
): HostHeadroom {
  const { nowMs, maxAgeMs, reserveBytes } = options;
  const numericOptionsValid =
    Number.isFinite(nowMs) &&
    nowMs >= 0 &&
    Number.isFinite(maxAgeMs) &&
    maxAgeMs >= 0 &&
    Number.isFinite(reserveBytes) &&
    reserveBytes >= 0;
  if (!numericOptionsValid) return { known: false, reason: "invalid-input" };

  const physical = inspectReading(observation.physical, nowMs, maxAgeMs);
  const available = inspectReading(observation.available, nowMs, maxAgeMs);
  if (!("bytes" in physical)) {
    const reason =
      "bytes" in available ? physical.refusal : worseRefusal(physical.refusal, available.refusal);
    return { known: false, reason };
  }
  if (!("bytes" in available)) {
    return { known: false, reason: available.refusal };
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
