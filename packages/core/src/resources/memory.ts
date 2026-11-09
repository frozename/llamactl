// DF04a1 slice 1 + DF-04 remainder (#277): typed host-memory observations, a
// pure, conservative headroom derivation, Linux GTT counter parsing and
// per-model KV envelopes keyed by (model, ctx, kvType, slots). Calibration
// keys are now provided via kvEnvelopeKey; swap deltas, remote OS collectors
// and all consumers are still deferred. Trusts only the host's physical +
// available readings; every other field stays a distinct source-attributed
// observation. GTT is a device-wide shared counter — never attributed to a
// model, never added to OS used memory. This is NOT a model-load grant. No
// IO, no Date.now, no platform probing: timestamps and readings are injected.
//
// Core accepts already-validated typed observations here. Untyped transport
// decoding, auth and provenance validation belong to the remote observer /
// consumer slice; the `source` string is attribution metadata, not a
// credential, so no source-prefix allowlist or trusted flag exists in core.
//
// DF-04 runtime budget: evaluateRuntimeMemoryBudget charges a single basis
// (footprint when ok and fresh, RSS as fallback) against a per-role byte
// budget. JS heap, external memory and device-wide counters are never
// attributed to a control process — JS/external memory is a subset of the
// process charge and device counters are shared, so they are never summed
// into the charge.

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

export interface GttObservation {
  status: MemoryReadStatus;
  totalBytes: number | null;
  usedBytes: number | null;
  observedAtMs: number | null;
  source: string;
  scope: "shared";
}

export function parseGttCounters(
  totalRaw: string,
  usedRaw: string,
  meta: { source: string; observedAtMs: number },
): GttObservation {
  const fail = (): GttObservation => ({
    status: "unavailable",
    totalBytes: null,
    usedBytes: null,
    observedAtMs: meta.observedAtMs,
    source: meta.source,
    scope: "shared",
  });
  const totalText = totalRaw.trim();
  const usedText = usedRaw.trim();
  if (!/^\d+$/.test(totalText) || !/^\d+$/.test(usedText)) return fail();
  const totalBytes = Number(totalText);
  const usedBytes = Number(usedText);
  if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(usedBytes)) return fail();
  if (usedBytes > totalBytes) return fail();
  return {
    status: "ok",
    totalBytes,
    usedBytes,
    observedAtMs: meta.observedAtMs,
    source: meta.source,
    scope: "shared",
  };
}

export function gttDeviceReading(obs: GttObservation): HostMemoryObservation["device"] {
  return {
    bytes: obs.status === "ok" ? obs.usedBytes : null,
    observedAtMs: obs.observedAtMs,
    source: obs.source,
    status: obs.status,
    scope: "shared",
  };
}

export interface KvEnvelopeKey {
  model: string;
  ctx: number;
  kvType: string;
  slots: number;
}

export function kvEnvelopeKey(key: KvEnvelopeKey): string | null {
  const model = key.model.trim();
  if (model === "") return null;
  if (!Number.isSafeInteger(key.ctx) || key.ctx <= 0) return null;
  if (!Number.isSafeInteger(key.slots) || key.slots <= 0) return null;
  if (key.kvType === "") return null;
  return JSON.stringify([model, key.ctx, key.kvType, key.slots]);
}

export interface KvEnvelope {
  key: KvEnvelopeKey;
  weightsBytes: number;
  kvBytes: number;
  workspaceBytes: number;
  provenance: "declared" | "measured";
}

export type ModelKvBudget =
  | {
      known: true;
      key: string;
      usableBytes: number;
      requiredBytes: number;
      kvBudgetBytes: number;
      fits: boolean;
      provenance: "declared" | "measured";
    }
  | {
      known: false;
      reason:
        | "invalid-input"
        | "unknown-source"
        | "stale-source"
        | "pressure"
        | "no-envelope"
        | "invalid-envelope";
    };

function canonicalEnvelopeKey(envelope: KvEnvelope): string | null {
  const canonical = kvEnvelopeKey(envelope.key);
  if (canonical === null) return null;
  const bytes = [envelope.weightsBytes, envelope.kvBytes, envelope.workspaceBytes];
  if (bytes.some((b) => !Number.isFinite(b) || b < 0)) return null;
  return canonical;
}

export function deriveModelKvBudget(input: {
  envelopes: readonly KvEnvelope[];
  key: KvEnvelopeKey;
  observation: HostMemoryObservation;
  options: HostHeadroomOptions;
}): ModelKvBudget {
  const queryKey = kvEnvelopeKey(input.key);
  if (queryKey === null) return { known: false, reason: "invalid-envelope" };

  const seen = new Set<string>();
  let match: KvEnvelope | null = null;
  for (const envelope of input.envelopes) {
    const canonical = canonicalEnvelopeKey(envelope);
    if (canonical === null || seen.has(canonical)) {
      return { known: false, reason: "invalid-envelope" };
    }
    seen.add(canonical);
    if (canonical === queryKey) match = envelope;
  }
  if (match === null) return { known: false, reason: "no-envelope" };

  const headroom = deriveHostHeadroom(input.observation, input.options);
  if (!headroom.known) return { known: false, reason: headroom.reason };

  const requiredBytes = match.weightsBytes + match.kvBytes + match.workspaceBytes;
  const kvBudgetBytes = Math.max(
    0,
    headroom.usableBytes - match.weightsBytes - match.workspaceBytes,
  );
  return {
    known: true,
    key: queryKey,
    usableBytes: headroom.usableBytes,
    requiredBytes,
    kvBudgetBytes,
    fits: requiredBytes <= headroom.usableBytes,
    provenance: match.provenance,
  };
}

export interface RuntimeMemorySample {
  role: string;
  rss: MemoryReading;
  footprint: MemoryReading;
  jsHeapUsed: MemoryReading;
  external: MemoryReading;
  device: HostMemoryObservation["device"];
}

export interface RuntimeMemoryBudget {
  role: string;
  maxBytes: number;
}

export interface RuntimeMemoryBudgetOptions {
  nowMs: number;
  maxAgeMs: number;
}

export type RuntimeMemoryVerdict =
  | {
      known: true;
      role: string;
      basis: "footprint" | "rss";
      chargedBytes: number;
      maxBytes: number;
      withinBudget: boolean;
      overBytes: number;
    }
  | {
      known: false;
      reason: "invalid-input" | "unknown-source" | "stale-source" | "role-mismatch";
    };

/**
 * JS heap, external memory and device-wide counters are never attributed to
 * a control process — JS/external memory is a subset of the process charge
 * and device counters are shared, so they are never summed into the charge.
 */
export function evaluateRuntimeMemoryBudget(
  sample: RuntimeMemorySample,
  budget: RuntimeMemoryBudget,
  options: RuntimeMemoryBudgetOptions,
): RuntimeMemoryVerdict {
  const { nowMs, maxAgeMs } = options;
  const numericOptionsValid =
    Number.isFinite(nowMs) &&
    nowMs >= 0 &&
    Number.isFinite(maxAgeMs) &&
    maxAgeMs >= 0 &&
    Number.isFinite(budget.maxBytes) &&
    budget.maxBytes > 0;
  if (!numericOptionsValid) return { known: false, reason: "invalid-input" };

  const sampleRole = sample.role.trim();
  const budgetRole = budget.role.trim();
  if (sampleRole === "" || budgetRole === "") return { known: false, reason: "invalid-input" };
  if (sampleRole !== budgetRole) return { known: false, reason: "role-mismatch" };

  const footprintVerdict = inspectReading(sample.footprint, nowMs, maxAgeMs);
  if ("bytes" in footprintVerdict) {
    const chargedBytes = footprintVerdict.bytes;
    return {
      known: true,
      role: sampleRole,
      basis: "footprint",
      chargedBytes,
      maxBytes: budget.maxBytes,
      withinBudget: chargedBytes <= budget.maxBytes,
      overBytes: Math.max(0, chargedBytes - budget.maxBytes),
    };
  }

  // A malformed footprint refuses immediately — never falls back to RSS.
  if (footprintVerdict.refusal === "invalid-input") {
    return { known: false, reason: "invalid-input" };
  }

  const rssVerdict = inspectReading(sample.rss, nowMs, maxAgeMs);
  if ("bytes" in rssVerdict) {
    const chargedBytes = rssVerdict.bytes;
    return {
      known: true,
      role: sampleRole,
      basis: "rss",
      chargedBytes,
      maxBytes: budget.maxBytes,
      withinBudget: chargedBytes <= budget.maxBytes,
      overBytes: Math.max(0, chargedBytes - budget.maxBytes),
    };
  }

  return { known: false, reason: worseRefusal(footprintVerdict.refusal, rssVerdict.refusal) };
}
