// DF04a1 slice 1 + DF-04 remainder (#277): typed host-memory observations, a
// pure, conservative headroom derivation, Linux GTT counter parsing,
// per-model KV envelopes keyed by (model, ctx, kvType, slots), swap-rate
// derivation, full calibration keys and measured per-model memory envelopes.
// Trusts only the host's physical + available readings; every other field
// stays a distinct source-attributed observation. GTT is a device-wide
// shared counter — never attributed to a model, never added to OS used
// memory. This is NOT a model-load grant. No IO, no Date.now, no platform
// probing: timestamps and readings are injected.
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

// DF-04 unified-memory calibration (#277): swap-rate derivation, canonical
// calibration keys and measured per-model memory envelopes.

export interface SwapCounterSample {
  status: MemoryReadStatus;
  source: string;
  observedAtMs: number | null;
  swapInBytes: number | null;
  swapOutBytes: number | null;
}

export interface SwapRateOptions {
  nowMs: number;
  maxAgeMs: number;
}

export type SwapRate =
  | {
      known: true;
      swapInBytesPerSec: number;
      swapOutBytesPerSec: number;
      intervalMs: number;
      source: string;
    }
  | {
      known: false;
      reason:
        | "invalid-input"
        | "unknown-source"
        | "stale-source"
        | "counter-reset"
        | "source-changed";
    };

export type SpeculativeDecoding =
  | { mode: "none" }
  | { mode: "mtp" }
  | { mode: "draft"; artifactRevision: string };

export interface MemoryCalibrationKey {
  artifactRevision: string;
  engine: string;
  engineBuild: string;
  ctx: number;
  kvType: string;
  speculative: SpeculativeDecoding;
  prefillBatch: number;
  concurrency: number;
}

export interface CalibrationSample {
  status: MemoryReadStatus;
  source: string;
  observedAtMs: number | null;
  processBytes: number | null;
  processDeviceBytes: number | null;
  sharedDeviceBytes: number | null;
}

export interface CalibrationOptions {
  minSamples: number;
  overheadFraction: number;
}

export type MeasuredEnvelope =
  | {
      known: true;
      key: string;
      provenance: "measured";
      sampleCount: number;
      peakBytes: number;
      calibrationOverheadBytes: number;
      envelopeBytes: number;
      attribution: "process" | "uncertain";
    }
  | {
      known: false;
      reason: "invalid-input" | "invalid-key" | "insufficient-samples" | "unknown-device";
    };

interface ValidSwapSample {
  observedAtMs: number;
  swapInBytes: number;
  swapOutBytes: number;
}

// Returns a refusal when the counter is unknown or malformed, or a non-negative
// finite reading otherwise. `null` is unknown, never zero.
function checkSwapCounter(value: number | null): Refusal | number {
  if (value === null) return "unknown-source";
  if (!Number.isFinite(value) || value < 0) return "invalid-input";
  return value;
}

function inspectSwapSample(
  sample: SwapCounterSample,
  nowMs: number,
  maxAgeMs: number,
): Refusal | ValidSwapSample {
  if (sample.status !== "ok") return "unknown-source";
  if (sample.source.trim() === "") return "unknown-source";
  const observedAtMs = checkSwapCounter(sample.observedAtMs);
  if (typeof observedAtMs === "string") return observedAtMs;
  const swapInBytes = checkSwapCounter(sample.swapInBytes);
  if (typeof swapInBytes === "string") return swapInBytes;
  const swapOutBytes = checkSwapCounter(sample.swapOutBytes);
  if (typeof swapOutBytes === "string") return swapOutBytes;
  const age = nowMs - observedAtMs;
  if (age < 0) return "invalid-input";
  if (age > maxAgeMs) return "stale-source";
  return { observedAtMs, swapInBytes, swapOutBytes };
}

export function deriveSwapRate(
  previous: SwapCounterSample,
  current: SwapCounterSample,
  options: SwapRateOptions,
): SwapRate {
  const { nowMs, maxAgeMs } = options;
  const numericOptionsValid =
    Number.isFinite(nowMs) && nowMs >= 0 && Number.isFinite(maxAgeMs) && maxAgeMs >= 0;
  if (!numericOptionsValid) return { known: false, reason: "invalid-input" };

  const prev = inspectSwapSample(previous, nowMs, maxAgeMs);
  const cur = inspectSwapSample(current, nowMs, maxAgeMs);

  if (typeof prev === "string" && typeof cur === "string")
    return { known: false, reason: worseRefusal(prev, cur) };
  if (typeof prev === "string") return { known: false, reason: prev };
  if (typeof cur === "string") return { known: false, reason: cur };

  if (previous.source !== current.source) return { known: false, reason: "source-changed" };

  if (cur.observedAtMs <= prev.observedAtMs) return { known: false, reason: "invalid-input" };

  if (cur.swapInBytes < prev.swapInBytes || cur.swapOutBytes < prev.swapOutBytes) {
    return { known: false, reason: "counter-reset" };
  }

  const intervalMs = cur.observedAtMs - prev.observedAtMs;
  const swapInDelta = cur.swapInBytes - prev.swapInBytes;
  const swapOutDelta = cur.swapOutBytes - prev.swapOutBytes;

  return {
    known: true,
    swapInBytesPerSec: (swapInDelta * 1000) / intervalMs,
    swapOutBytesPerSec: (swapOutDelta * 1000) / intervalMs,
    intervalMs,
    source: current.source,
  };
}

// Canonical encoding of the speculative-decoding mode, or null when the mode
// is unrecognised or a draft names no artifact revision. The default branch
// guards untyped callers; the type alone does not prevent a bogus mode.
function encodeSpeculative(spec: SpeculativeDecoding): string[] | null {
  switch (spec.mode) {
    case "none":
      return ["none"];
    case "mtp":
      return ["mtp"];
    case "draft": {
      const draftRev = spec.artifactRevision.trim();
      return draftRev === "" ? null : ["draft", draftRev];
    }
    default:
      return null;
  }
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function memoryCalibrationKey(key: MemoryCalibrationKey): string | null {
  const artifactRevision = key.artifactRevision.trim();
  const engine = key.engine.trim();
  const engineBuild = key.engineBuild.trim();
  const kvType = key.kvType.trim();
  if (artifactRevision === "" || engine === "" || engineBuild === "" || kvType === "") {
    return null;
  }
  if (
    !isPositiveSafeInteger(key.ctx) ||
    !isPositiveSafeInteger(key.prefillBatch) ||
    !isPositiveSafeInteger(key.concurrency)
  ) {
    return null;
  }

  const encodedSpec = encodeSpeculative(key.speculative);
  if (encodedSpec === null) return null;

  return JSON.stringify([
    artifactRevision,
    engine,
    engineBuild,
    key.ctx,
    kvType,
    encodedSpec,
    key.prefillBatch,
    key.concurrency,
  ]);
}

function isInvalidReading(value: number | null): boolean {
  return value !== null && (!Number.isFinite(value) || value < 0);
}

// Every non-null numeric field of an ok sample must be a non-negative finite
// reading; one malformed sample refuses the whole calibration.
function hasInvalidReading(sample: CalibrationSample): boolean {
  return (
    isInvalidReading(sample.processBytes) ||
    isInvalidReading(sample.processDeviceBytes) ||
    isInvalidReading(sample.sharedDeviceBytes) ||
    isInvalidReading(sample.observedAtMs)
  );
}

interface UsableCalibrationSample {
  processBytes: number;
  processDeviceBytes: number | null;
}

function isValidCalibrationOptions(options: CalibrationOptions): boolean {
  const { minSamples, overheadFraction } = options;
  return (
    Number.isSafeInteger(minSamples) &&
    minSamples >= 1 &&
    Number.isFinite(overheadFraction) &&
    overheadFraction >= 0
  );
}

// Non-ok and unattributed samples are skipped (unknown, never zero); samples
// without a process reading are unusable. Returns null when any ok sample
// carries a malformed reading.
function collectUsableSamples(
  samples: readonly CalibrationSample[],
): UsableCalibrationSample[] | null {
  const usable: UsableCalibrationSample[] = [];
  for (const sample of samples) {
    if (sample.status !== "ok" || sample.source.trim() === "") continue;
    if (hasInvalidReading(sample)) return null;
    if (sample.processBytes !== null) {
      usable.push({
        processBytes: sample.processBytes,
        processDeviceBytes: sample.processDeviceBytes,
      });
    }
  }
  return usable;
}

export function calibrateMeasuredEnvelope(input: {
  key: MemoryCalibrationKey;
  samples: readonly CalibrationSample[];
  options: CalibrationOptions;
}): MeasuredEnvelope {
  const calKey = memoryCalibrationKey(input.key);
  if (calKey === null) return { known: false, reason: "invalid-key" };
  if (!isValidCalibrationOptions(input.options)) {
    return { known: false, reason: "invalid-input" };
  }

  const usableSamples = collectUsableSamples(input.samples);
  if (usableSamples === null) return { known: false, reason: "invalid-input" };
  if (usableSamples.length < input.options.minSamples) {
    return { known: false, reason: "insufficient-samples" };
  }

  // Shared device counters are never attributed to the process. A null
  // per-process device reading is unknown, not zero: refuse the calibration
  // so the envelope stays unknown-device rather than a lower-bound process
  // attribution. On Metal/AMD RSS understates GPU memory, so a device-blind
  // calibration is not a conservative admission envelope.
  let peakBytes = 0;
  for (const { processBytes, processDeviceBytes } of usableSamples) {
    if (processDeviceBytes === null) return { known: false, reason: "unknown-device" };
    peakBytes = Math.max(peakBytes, processBytes + processDeviceBytes);
  }

  const calibrationOverheadBytes = Math.ceil(peakBytes * input.options.overheadFraction);
  const envelopeBytes = peakBytes + calibrationOverheadBytes;

  return {
    known: true,
    key: calKey,
    provenance: "measured",
    sampleCount: usableSamples.length,
    peakBytes,
    calibrationOverheadBytes,
    envelopeBytes,
    attribution: "process",
  };
}
