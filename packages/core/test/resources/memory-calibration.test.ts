import { describe, expect, test } from "bun:test";

import * as memoryNs from "../../src/resources/memory.js";

// DF-04 unified-memory calibration (#277): swap-rate derivation, canonical
// calibration keys and measured per-model memory envelopes. None of these
// functions exist at the pinned base; every case reaches them through a
// namespace import plus a structural cast so a missing export fails by
// assertion, never by a module-link or TypeError.
type SwapCounterSample = {
  status: memoryNs.MemoryReadStatus;
  source: string;
  observedAtMs: number | null;
  swapInBytes: number | null;
  swapOutBytes: number | null;
};

type SwapRate =
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

type SwapRateOptions = { nowMs: number; maxAgeMs: number };

type SpeculativeDecoding =
  | { mode: "none" }
  | { mode: "mtp" }
  | { mode: "draft"; artifactRevision: string };

type MemoryCalibrationKey = {
  artifactRevision: string;
  engine: string;
  engineBuild: string;
  ctx: number;
  kvType: string;
  speculative: SpeculativeDecoding;
  prefillBatch: number;
  concurrency: number;
};

type CalibrationSample = {
  status: memoryNs.MemoryReadStatus;
  source: string;
  observedAtMs: number | null;
  processBytes: number | null;
  processDeviceBytes: number | null;
  sharedDeviceBytes: number | null;
};

type CalibrationOptions = { minSamples: number; overheadFraction: number };

type MeasuredEnvelope =
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

type CalibrationApi = {
  deriveSwapRate: (
    previous: SwapCounterSample,
    current: SwapCounterSample,
    options: SwapRateOptions,
  ) => SwapRate;
  memoryCalibrationKey: (key: MemoryCalibrationKey) => string | null;
  calibrateMeasuredEnvelope: (input: {
    key: MemoryCalibrationKey;
    samples: readonly CalibrationSample[];
    options: CalibrationOptions;
  }) => MeasuredEnvelope;
};

const api = memoryNs as Partial<CalibrationApi>;

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const NOW = 1_000_000_000_000;
const SWAP_PAGE = 16_384;

function swapSample(overrides: Partial<SwapCounterSample> = {}): SwapCounterSample {
  return {
    status: "ok",
    source: "vm_stat",
    observedAtMs: NOW,
    swapInBytes: 0,
    swapOutBytes: 0,
    ...overrides,
  };
}

function swapRateOptions(overrides: Partial<SwapRateOptions> = {}): SwapRateOptions {
  return { nowMs: NOW, maxAgeMs: 60_000, ...overrides };
}

function baseCalibrationKey(): MemoryCalibrationKey {
  return {
    artifactRevision: "sha256:aaa",
    engine: "llama.cpp",
    engineBuild: "b6100",
    ctx: 32768,
    kvType: "q8_0",
    speculative: { mode: "none" },
    prefillBatch: 512,
    concurrency: 4,
  };
}

function calibrationSample(overrides: Partial<CalibrationSample> = {}): CalibrationSample {
  return {
    status: "ok",
    source: "footprint+metal",
    observedAtMs: NOW,
    processBytes: null,
    processDeviceBytes: null,
    sharedDeviceBytes: null,
    ...overrides,
  };
}

function calibrationOptions(overrides: Partial<CalibrationOptions> = {}): CalibrationOptions {
  return { minSamples: 2, overheadFraction: 0, ...overrides };
}

function encodedCalibrationKey(key: MemoryCalibrationKey): string {
  const keyOf = api.memoryCalibrationKey;
  expect(typeof keyOf).toBe("function");
  const encoded = keyOf!(key);
  if (encoded === null) {
    throw new Error("memoryCalibrationKey returned null for a valid key");
  }
  return encoded;
}

function samplesWithSkippedReads(): CalibrationSample[] {
  return [
    calibrationSample({ processBytes: 4 * GiB }),
    calibrationSample({ processBytes: 2 * GiB }),
    calibrationSample({ status: "unavailable", observedAtMs: null, processBytes: null }),
    calibrationSample({ status: "denied", observedAtMs: null, processBytes: 0 }),
  ];
}

describe("deriveSwapRate", () => {
  test("derives per-second swap rates across a two-second vm_stat window", () => {
    const derive = api.deriveSwapRate;
    expect(typeof derive).toBe("function");
    const previous = swapSample({
      observedAtMs: NOW - 2000,
      swapInBytes: 100 * SWAP_PAGE,
      swapOutBytes: 1000 * SWAP_PAGE,
    });
    const current = swapSample({
      swapInBytes: 150 * SWAP_PAGE,
      swapOutBytes: 1600 * SWAP_PAGE,
    });
    expect(derive!(previous, current, swapRateOptions())).toEqual({
      known: true,
      swapInBytesPerSec: 409600,
      swapOutBytesPerSec: 4915200,
      intervalMs: 2000,
      source: "vm_stat",
    });
  });

  test("identical counters are a known zero rate, not unknown", () => {
    const derive = api.deriveSwapRate;
    expect(typeof derive).toBe("function");
    const previous = swapSample({
      observedAtMs: NOW - 2000,
      swapInBytes: 100 * SWAP_PAGE,
      swapOutBytes: 1000 * SWAP_PAGE,
    });
    const current = swapSample({
      swapInBytes: 100 * SWAP_PAGE,
      swapOutBytes: 1000 * SWAP_PAGE,
    });
    expect(derive!(previous, current, swapRateOptions())).toEqual({
      known: true,
      swapInBytesPerSec: 0,
      swapOutBytesPerSec: 0,
      intervalMs: 2000,
      source: "vm_stat",
    });
  });

  test("a lower swapOut counter is counter-reset, never negative", () => {
    const derive = api.deriveSwapRate;
    expect(typeof derive).toBe("function");
    const previous = swapSample({
      observedAtMs: NOW - 2000,
      swapInBytes: 100 * SWAP_PAGE,
      swapOutBytes: 1000 * SWAP_PAGE,
    });
    const current = swapSample({
      swapInBytes: 150 * SWAP_PAGE,
      swapOutBytes: 999 * SWAP_PAGE,
    });
    expect(derive!(previous, current, swapRateOptions())).toEqual({
      known: false,
      reason: "counter-reset",
    });
  });

  test("a lower swapIn counter alone is counter-reset", () => {
    const derive = api.deriveSwapRate;
    expect(typeof derive).toBe("function");
    const previous = swapSample({
      observedAtMs: NOW - 2000,
      swapInBytes: 100 * SWAP_PAGE,
      swapOutBytes: 1000 * SWAP_PAGE,
    });
    const current = swapSample({
      swapInBytes: 50 * SWAP_PAGE,
      swapOutBytes: 1000 * SWAP_PAGE,
    });
    expect(derive!(previous, current, swapRateOptions())).toEqual({
      known: false,
      reason: "counter-reset",
    });
  });

  test("an unavailable current sample is unknown-source", () => {
    const derive = api.deriveSwapRate;
    expect(typeof derive).toBe("function");
    const previous = swapSample({
      observedAtMs: NOW - 2000,
      swapInBytes: 100 * SWAP_PAGE,
      swapOutBytes: 1000 * SWAP_PAGE,
    });
    const current = swapSample({
      status: "unavailable",
      observedAtMs: null,
      swapInBytes: null,
      swapOutBytes: null,
    });
    expect(derive!(previous, current, swapRateOptions())).toEqual({
      known: false,
      reason: "unknown-source",
    });
  });

  test("a denied previous sample is unknown-source", () => {
    const derive = api.deriveSwapRate;
    expect(typeof derive).toBe("function");
    const previous = swapSample({
      status: "denied",
      observedAtMs: NOW - 2000,
      swapInBytes: 100 * SWAP_PAGE,
      swapOutBytes: 1000 * SWAP_PAGE,
    });
    const current = swapSample({
      swapInBytes: 150 * SWAP_PAGE,
      swapOutBytes: 1600 * SWAP_PAGE,
    });
    expect(derive!(previous, current, swapRateOptions())).toEqual({
      known: false,
      reason: "unknown-source",
    });
  });

  test("ok status with null swapOutBytes is unknown-source, not zero", () => {
    const derive = api.deriveSwapRate;
    expect(typeof derive).toBe("function");
    const previous = swapSample({
      observedAtMs: NOW - 2000,
      swapInBytes: 100 * SWAP_PAGE,
      swapOutBytes: 1000 * SWAP_PAGE,
    });
    const current = swapSample({ swapInBytes: 150 * SWAP_PAGE, swapOutBytes: null });
    expect(derive!(previous, current, swapRateOptions())).toEqual({
      known: false,
      reason: "unknown-source",
    });
  });

  test("a whitespace-only source is unknown-source", () => {
    const derive = api.deriveSwapRate;
    expect(typeof derive).toBe("function");
    const previous = swapSample({
      source: "   ",
      observedAtMs: NOW - 2000,
      swapInBytes: 100 * SWAP_PAGE,
      swapOutBytes: 1000 * SWAP_PAGE,
    });
    const current = swapSample({
      source: "   ",
      swapInBytes: 150 * SWAP_PAGE,
      swapOutBytes: 1600 * SWAP_PAGE,
    });
    expect(derive!(previous, current, swapRateOptions())).toEqual({
      known: false,
      reason: "unknown-source",
    });
  });

  test("a previous sample older than maxAgeMs is stale-source", () => {
    const derive = api.deriveSwapRate;
    expect(typeof derive).toBe("function");
    const previous = swapSample({
      observedAtMs: NOW - 60_001,
      swapInBytes: 100 * SWAP_PAGE,
      swapOutBytes: 1000 * SWAP_PAGE,
    });
    const current = swapSample({
      swapInBytes: 150 * SWAP_PAGE,
      swapOutBytes: 1600 * SWAP_PAGE,
    });
    expect(derive!(previous, current, swapRateOptions())).toEqual({
      known: false,
      reason: "stale-source",
    });
  });

  test("a stale current sample stays stale-source when the previous is older", () => {
    const derive = api.deriveSwapRate;
    expect(typeof derive).toBe("function");
    const previous = swapSample({
      observedAtMs: NOW - 120_000,
      swapInBytes: 100 * SWAP_PAGE,
      swapOutBytes: 1000 * SWAP_PAGE,
    });
    const current = swapSample({
      observedAtMs: NOW - 60_001,
      swapInBytes: 200 * SWAP_PAGE,
      swapOutBytes: 2000 * SWAP_PAGE,
    });
    expect(derive!(previous, current, swapRateOptions())).toEqual({
      known: false,
      reason: "stale-source",
    });
  });

  test("a previous sample exactly at maxAgeMs is still known", () => {
    const derive = api.deriveSwapRate;
    expect(typeof derive).toBe("function");
    const previous = swapSample({
      observedAtMs: NOW - 60_000,
      swapInBytes: 100 * SWAP_PAGE,
      swapOutBytes: 1000 * SWAP_PAGE,
    });
    const current = swapSample({
      swapInBytes: 700 * SWAP_PAGE,
      swapOutBytes: 2200 * SWAP_PAGE,
    });
    expect(derive!(previous, current, swapRateOptions())).toEqual({
      known: true,
      swapInBytesPerSec: 163840,
      swapOutBytesPerSec: 327680,
      intervalMs: 60_000,
      source: "vm_stat",
    });
  });

  test("a future current timestamp is invalid-input", () => {
    const derive = api.deriveSwapRate;
    expect(typeof derive).toBe("function");
    const previous = swapSample({
      observedAtMs: NOW - 2000,
      swapInBytes: 100 * SWAP_PAGE,
      swapOutBytes: 1000 * SWAP_PAGE,
    });
    const current = swapSample({
      observedAtMs: NOW + 1,
      swapInBytes: 150 * SWAP_PAGE,
      swapOutBytes: 1600 * SWAP_PAGE,
    });
    expect(derive!(previous, current, swapRateOptions())).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("equal observedAtMs on both samples is invalid-input", () => {
    const derive = api.deriveSwapRate;
    expect(typeof derive).toBe("function");
    const previous = swapSample({
      observedAtMs: NOW - 1000,
      swapInBytes: 100 * SWAP_PAGE,
      swapOutBytes: 1000 * SWAP_PAGE,
    });
    const current = swapSample({
      observedAtMs: NOW - 1000,
      swapInBytes: 150 * SWAP_PAGE,
      swapOutBytes: 1600 * SWAP_PAGE,
    });
    expect(derive!(previous, current, swapRateOptions())).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("reversed sample order is invalid-input", () => {
    const derive = api.deriveSwapRate;
    expect(typeof derive).toBe("function");
    const previous = swapSample({
      observedAtMs: NOW,
      swapInBytes: 100 * SWAP_PAGE,
      swapOutBytes: 1000 * SWAP_PAGE,
    });
    const current = swapSample({
      observedAtMs: NOW - 2000,
      swapInBytes: 150 * SWAP_PAGE,
      swapOutBytes: 1600 * SWAP_PAGE,
    });
    expect(derive!(previous, current, swapRateOptions())).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("a NaN swap counter is invalid-input", () => {
    const derive = api.deriveSwapRate;
    expect(typeof derive).toBe("function");
    const previous = swapSample({
      observedAtMs: NOW - 2000,
      swapInBytes: 100 * SWAP_PAGE,
      swapOutBytes: 1000 * SWAP_PAGE,
    });
    const current = swapSample({
      swapInBytes: Number.NaN,
      swapOutBytes: 1600 * SWAP_PAGE,
    });
    expect(derive!(previous, current, swapRateOptions())).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("a negative swap counter is invalid-input", () => {
    const derive = api.deriveSwapRate;
    expect(typeof derive).toBe("function");
    const previous = swapSample({
      observedAtMs: NOW - 2000,
      swapInBytes: 100 * SWAP_PAGE,
      swapOutBytes: 1000 * SWAP_PAGE,
    });
    const current = swapSample({
      swapInBytes: 150 * SWAP_PAGE,
      swapOutBytes: -1,
    });
    expect(derive!(previous, current, swapRateOptions())).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("mismatched counter sources are source-changed", () => {
    const derive = api.deriveSwapRate;
    expect(typeof derive).toBe("function");
    const previous = swapSample({
      observedAtMs: NOW - 2000,
      swapInBytes: 100 * SWAP_PAGE,
      swapOutBytes: 1000 * SWAP_PAGE,
    });
    const current = swapSample({
      source: "/proc/vmstat",
      swapInBytes: 150 * SWAP_PAGE,
      swapOutBytes: 1600 * SWAP_PAGE,
    });
    expect(derive!(previous, current, swapRateOptions())).toEqual({
      known: false,
      reason: "source-changed",
    });
  });

  test("invalid-input outranks stale-source across the two samples", () => {
    const derive = api.deriveSwapRate;
    expect(typeof derive).toBe("function");
    const previous = swapSample({
      observedAtMs: NOW - 2000,
      swapInBytes: Number.NaN,
      swapOutBytes: 1000 * SWAP_PAGE,
    });
    const current = swapSample({
      observedAtMs: NOW - 60_001,
      swapInBytes: 200 * SWAP_PAGE,
      swapOutBytes: 2000 * SWAP_PAGE,
    });
    expect(derive!(previous, current, swapRateOptions())).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("unknown-source outranks stale-source across the two samples", () => {
    const derive = api.deriveSwapRate;
    expect(typeof derive).toBe("function");
    const previous = swapSample({
      status: "unavailable",
      observedAtMs: null,
      swapInBytes: null,
      swapOutBytes: null,
    });
    const current = swapSample({
      observedAtMs: NOW - 60_001,
      swapInBytes: 200 * SWAP_PAGE,
      swapOutBytes: 2000 * SWAP_PAGE,
    });
    expect(derive!(previous, current, swapRateOptions())).toEqual({
      known: false,
      reason: "unknown-source",
    });
  });

  test("NaN nowMs is invalid-input", () => {
    const derive = api.deriveSwapRate;
    expect(typeof derive).toBe("function");
    const previous = swapSample({
      observedAtMs: NOW - 2000,
      swapInBytes: 100 * SWAP_PAGE,
      swapOutBytes: 1000 * SWAP_PAGE,
    });
    const current = swapSample({
      swapInBytes: 150 * SWAP_PAGE,
      swapOutBytes: 1600 * SWAP_PAGE,
    });
    expect(derive!(previous, current, swapRateOptions({ nowMs: Number.NaN }))).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("negative maxAgeMs is invalid-input", () => {
    const derive = api.deriveSwapRate;
    expect(typeof derive).toBe("function");
    const previous = swapSample({
      observedAtMs: NOW - 2000,
      swapInBytes: 100 * SWAP_PAGE,
      swapOutBytes: 1000 * SWAP_PAGE,
    });
    const current = swapSample({
      swapInBytes: 150 * SWAP_PAGE,
      swapOutBytes: 1600 * SWAP_PAGE,
    });
    expect(derive!(previous, current, swapRateOptions({ maxAgeMs: -1 }))).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("invalid-input on previous outranks stale-source on current", () => {
    const derive = api.deriveSwapRate;
    expect(typeof derive).toBe("function");
    const previous = swapSample({
      observedAtMs: NOW - 2000,
      swapInBytes: Number.NaN,
      swapOutBytes: 1000 * SWAP_PAGE,
    });
    const current = swapSample({
      observedAtMs: NOW - 60_001,
      swapInBytes: 200 * SWAP_PAGE,
      swapOutBytes: 2000 * SWAP_PAGE,
    });
    expect(derive!(previous, current, swapRateOptions())).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("unknown-source on previous outranks stale-source on current", () => {
    const derive = api.deriveSwapRate;
    expect(typeof derive).toBe("function");
    const previous = swapSample({
      status: "unavailable",
      observedAtMs: null,
      swapInBytes: null,
      swapOutBytes: null,
    });
    const current = swapSample({
      observedAtMs: NOW - 60_001,
      swapInBytes: 200 * SWAP_PAGE,
      swapOutBytes: 2000 * SWAP_PAGE,
    });
    expect(derive!(previous, current, swapRateOptions())).toEqual({
      known: false,
      reason: "unknown-source",
    });
  });
});

describe("memoryCalibrationKey", () => {
  test("returns a non-empty string for a valid key", () => {
    const keyOf = api.memoryCalibrationKey;
    expect(typeof keyOf).toBe("function");
    const encoded = keyOf!(baseCalibrationKey());
    expect(typeof encoded).toBe("string");
    expect(encoded).not.toBe("");
  });

  test("is identical for a key built with different property order", () => {
    const keyOf = api.memoryCalibrationKey;
    expect(typeof keyOf).toBe("function");
    const reordered: MemoryCalibrationKey = {
      concurrency: 4,
      prefillBatch: 512,
      speculative: { mode: "none" },
      kvType: "q8_0",
      ctx: 32768,
      engineBuild: "b6100",
      engine: "llama.cpp",
      artifactRevision: "sha256:aaa",
    };
    expect(keyOf!(reordered)).toBe(keyOf!(baseCalibrationKey()));
  });

  test("an extra unknown property does not change the key", () => {
    const keyOf = api.memoryCalibrationKey;
    expect(typeof keyOf).toBe("function");
    const withExtra = { ...baseCalibrationKey(), surprise: "ignored" } as MemoryCalibrationKey;
    expect(keyOf!(withExtra)).toBe(keyOf!(baseCalibrationKey()));
  });

  test("changing context, MTP or build invalidates the calibration key", () => {
    const keyOf = api.memoryCalibrationKey;
    expect(typeof keyOf).toBe("function");
    const base = baseCalibrationKey();
    const variants: MemoryCalibrationKey[] = [
      { ...base, artifactRevision: "sha256:bbb" },
      { ...base, engine: "oMLX" },
      { ...base, engineBuild: "b6200" },
      { ...base, ctx: 65536 },
      { ...base, kvType: "f16" },
      { ...base, speculative: { mode: "mtp" } },
      { ...base, speculative: { mode: "draft", artifactRevision: "sha256:ddd" } },
      { ...base, speculative: { mode: "draft", artifactRevision: "sha256:eee" } },
      { ...base, prefillBatch: 2048 },
      { ...base, concurrency: 8 },
    ];
    const encoded = [base, ...variants].map((variant) => keyOf!(variant));
    for (const value of encoded) {
      expect(value).not.toBeNull();
    }
    expect(new Set(encoded).size).toBe(11);
  });

  test("a separator-bearing engine cannot collide with a field split", () => {
    const keyOf = api.memoryCalibrationKey;
    expect(typeof keyOf).toBe("function");
    const withSeparator = keyOf!({
      ...baseCalibrationKey(),
      engine: 'a","b',
      engineBuild: "c",
    });
    const split = keyOf!({
      ...baseCalibrationKey(),
      engine: "a",
      engineBuild: 'b","c',
    });
    expect(withSeparator).not.toBeNull();
    expect(split).not.toBeNull();
    expect(withSeparator).not.toBe(split);
  });

  test.each([
    { label: "empty artifactRevision", patch: { artifactRevision: "" } },
    { label: "whitespace artifactRevision", patch: { artifactRevision: "   " } },
    { label: "empty engine", patch: { engine: "" } },
    { label: "whitespace engine", patch: { engine: "   " } },
    { label: "empty engineBuild", patch: { engineBuild: "" } },
    { label: "whitespace engineBuild", patch: { engineBuild: "   " } },
    { label: "empty kvType", patch: { kvType: "" } },
    { label: "whitespace kvType", patch: { kvType: "   " } },
    { label: "zero ctx", patch: { ctx: 0 } },
    { label: "fractional ctx", patch: { ctx: 1.5 } },
    { label: "NaN ctx", patch: { ctx: Number.NaN } },
    { label: "zero prefillBatch", patch: { prefillBatch: 0 } },
    { label: "zero concurrency", patch: { concurrency: 0 } },
    { label: "fractional concurrency", patch: { concurrency: 2.5 } },
    {
      label: "draft speculative with blank revision",
      patch: { speculative: { mode: "draft", artifactRevision: " " } },
    },
    {
      label: "unknown speculative mode",
      patch: { speculative: { mode: "bogus" } },
    },
  ])("invalid key returns null: $label", ({ patch }) => {
    const keyOf = api.memoryCalibrationKey;
    expect(typeof keyOf).toBe("function");
    const invalid = { ...baseCalibrationKey(), ...patch } as MemoryCalibrationKey;
    expect(keyOf!(invalid)).toBeNull();
  });
});

describe("calibrateMeasuredEnvelope", () => {
  test("low RSS with high GPU device memory yields a process-attributed envelope", () => {
    const calibrate = api.calibrateMeasuredEnvelope;
    expect(typeof calibrate).toBe("function");
    const samples = [
      calibrationSample({ processBytes: 1 * GiB, processDeviceBytes: 17 * GiB }),
      calibrationSample({ processBytes: 1.5 * GiB, processDeviceBytes: 18 * GiB }),
      calibrationSample({ processBytes: 1.25 * GiB, processDeviceBytes: 17.5 * GiB }),
    ];
    expect(
      calibrate!({
        key: baseCalibrationKey(),
        samples,
        options: calibrationOptions({ minSamples: 3, overheadFraction: 0.25 }),
      }),
    ).toEqual({
      known: true,
      key: encodedCalibrationKey(baseCalibrationKey()),
      provenance: "measured",
      sampleCount: 3,
      peakBytes: 19.5 * GiB,
      calibrationOverheadBytes: 4.875 * GiB,
      envelopeBytes: 24.375 * GiB,
      attribution: "process",
    });
  });

  test("null processDeviceBytes is unknown-device, not uncertain", () => {
    const calibrate = api.calibrateMeasuredEnvelope;
    expect(typeof calibrate).toBe("function");
    const samples = [
      calibrationSample({ processBytes: 2 * GiB, sharedDeviceBytes: 30 * GiB }),
      calibrationSample({ processBytes: 1.5 * GiB, sharedDeviceBytes: 30 * GiB }),
    ];
    expect(
      calibrate!({
        key: baseCalibrationKey(),
        samples,
        options: calibrationOptions({ minSamples: 2, overheadFraction: 0 }),
      }),
    ).toEqual({ known: false, reason: "unknown-device" });
  });

  test("non-ok samples are skipped rather than counted as zero", () => {
    const calibrate = api.calibrateMeasuredEnvelope;
    expect(typeof calibrate).toBe("function");
    const samples = [
      calibrationSample({ processBytes: 4 * GiB, processDeviceBytes: 16 * GiB }),
      calibrationSample({ processBytes: 2 * GiB, processDeviceBytes: 15 * GiB }),
      calibrationSample({ status: "unavailable", observedAtMs: null, processBytes: null }),
      calibrationSample({ status: "denied", observedAtMs: null, processBytes: 0 }),
    ];
    expect(
      calibrate!({
        key: baseCalibrationKey(),
        samples,
        options: calibrationOptions({ minSamples: 2 }),
      }),
    ).toMatchObject({ known: true, sampleCount: 2, peakBytes: 20 * GiB });
  });

  test("fewer ok samples than minSamples is insufficient-samples", () => {
    const calibrate = api.calibrateMeasuredEnvelope;
    expect(typeof calibrate).toBe("function");
    const samples = [
      calibrationSample({ processBytes: 4 * GiB, processDeviceBytes: 16 * GiB }),
      calibrationSample({ processBytes: 2 * GiB, processDeviceBytes: 15 * GiB }),
      calibrationSample({ status: "unavailable", observedAtMs: null, processBytes: null }),
      calibrationSample({ status: "denied", observedAtMs: null, processBytes: 0 }),
    ];
    expect(
      calibrate!({
        key: baseCalibrationKey(),
        samples,
        options: calibrationOptions({ minSamples: 3 }),
      }),
    ).toEqual({ known: false, reason: "insufficient-samples" });
  });

  test("an empty samples array is insufficient-samples", () => {
    const calibrate = api.calibrateMeasuredEnvelope;
    expect(typeof calibrate).toBe("function");
    expect(
      calibrate!({
        key: baseCalibrationKey(),
        samples: [],
        options: calibrationOptions({ minSamples: 2 }),
      }),
    ).toEqual({ known: false, reason: "insufficient-samples" });
  });

  test.each([
    { label: "NaN processBytes", patch: { processBytes: Number.NaN } },
    { label: "negative processDeviceBytes", patch: { processDeviceBytes: -1 } },
    {
      label: "Infinity sharedDeviceBytes",
      patch: { sharedDeviceBytes: Number.POSITIVE_INFINITY },
    },
  ])("rejects malformed ok-sample bytes: $label", ({ patch }) => {
    const calibrate = api.calibrateMeasuredEnvelope;
    expect(typeof calibrate).toBe("function");
    const samples = [calibrationSample({ processBytes: GiB }), calibrationSample(patch)];
    expect(
      calibrate!({
        key: baseCalibrationKey(),
        samples,
        options: calibrationOptions({ minSamples: 2 }),
      }),
    ).toEqual({ known: false, reason: "invalid-input" });
  });

  test("an invalid key is invalid-key even when samples are also invalid", () => {
    const calibrate = api.calibrateMeasuredEnvelope;
    expect(typeof calibrate).toBe("function");
    const samples = [calibrationSample({ processBytes: Number.NaN })];
    expect(
      calibrate!({
        key: { ...baseCalibrationKey(), ctx: 0 },
        samples,
        options: calibrationOptions({ minSamples: 1 }),
      }),
    ).toEqual({ known: false, reason: "invalid-key" });
  });

  test("minSamples 0 is invalid-input", () => {
    const calibrate = api.calibrateMeasuredEnvelope;
    expect(typeof calibrate).toBe("function");
    const samples = [calibrationSample({ processBytes: GiB })];
    expect(
      calibrate!({
        key: baseCalibrationKey(),
        samples,
        options: calibrationOptions({ minSamples: 0 }),
      }),
    ).toEqual({ known: false, reason: "invalid-input" });
  });

  test("negative overheadFraction is invalid-input", () => {
    const calibrate = api.calibrateMeasuredEnvelope;
    expect(typeof calibrate).toBe("function");
    const samples = [calibrationSample({ processBytes: GiB })];
    expect(
      calibrate!({
        key: baseCalibrationKey(),
        samples,
        options: calibrationOptions({ minSamples: 1, overheadFraction: -0.25 }),
      }),
    ).toEqual({ known: false, reason: "invalid-input" });
  });

  test("overheadFraction 0 yields zero overhead and an envelope equal to peak", () => {
    const calibrate = api.calibrateMeasuredEnvelope;
    expect(typeof calibrate).toBe("function");
    const samples = [
      calibrationSample({ processBytes: 3 * GiB, processDeviceBytes: 16 * GiB }),
      calibrationSample({ processBytes: GiB, processDeviceBytes: 15 * GiB }),
    ];
    expect(
      calibrate!({
        key: baseCalibrationKey(),
        samples,
        options: calibrationOptions(),
      }),
    ).toEqual({
      known: true,
      key: encodedCalibrationKey(baseCalibrationKey()),
      provenance: "measured",
      sampleCount: 2,
      peakBytes: 19 * GiB,
      calibrationOverheadBytes: 0,
      envelopeBytes: 19 * GiB,
      attribution: "process",
    });
  });

  test("null processDeviceBytes with non-null sharedDeviceBytes is unknown-device", () => {
    const calibrate = api.calibrateMeasuredEnvelope;
    expect(typeof calibrate).toBe("function");
    const samples = [
      calibrationSample({
        processBytes: 2 * GiB,
        processDeviceBytes: null,
        sharedDeviceBytes: 512 * MiB,
      }),
    ];
    expect(
      calibrate!({
        key: baseCalibrationKey(),
        samples,
        options: calibrationOptions({ minSamples: 1 }),
      }),
    ).toEqual({ known: false, reason: "unknown-device" });
  });

  test("null processDeviceBytes with null sharedDeviceBytes is unknown-device", () => {
    const calibrate = api.calibrateMeasuredEnvelope;
    expect(typeof calibrate).toBe("function");
    const samples = [
      calibrationSample({
        processBytes: 4 * GiB,
        processDeviceBytes: null,
        sharedDeviceBytes: null,
      }),
    ];
    expect(
      calibrate!({
        key: baseCalibrationKey(),
        samples,
        options: calibrationOptions({ minSamples: 1 }),
      }),
    ).toEqual({ known: false, reason: "unknown-device" });
  });

  test("a different speculative mode yields a different result key", () => {
    const calibrate = api.calibrateMeasuredEnvelope;
    expect(typeof calibrate).toBe("function");
    const samples = [calibrationSample({ processBytes: 2 * GiB, processDeviceBytes: 16 * GiB })];
    const options = calibrationOptions({ minSamples: 1 });
    const none = calibrate!({ key: baseCalibrationKey(), samples, options });
    const mtp = calibrate!({
      key: { ...baseCalibrationKey(), speculative: { mode: "mtp" } },
      samples,
      options,
    });
    expect(none.known).toBe(true);
    expect(mtp.known).toBe(true);
    if (none.known && mtp.known) {
      expect(none.key).not.toBe(mtp.key);
    }
  });

  test("null processDeviceBytes in any sample is unknown-device", () => {
    const calibrate = api.calibrateMeasuredEnvelope;
    expect(typeof calibrate).toBe("function");
    const samples = [
      calibrationSample({ processBytes: 2 * GiB, processDeviceBytes: 16 * GiB }),
      calibrationSample({ processBytes: 3 * GiB, processDeviceBytes: null }),
    ];
    expect(
      calibrate!({
        key: baseCalibrationKey(),
        samples,
        options: calibrationOptions({ minSamples: 2 }),
      }),
    ).toEqual({ known: false, reason: "unknown-device" });
  });

  test("overhead rounds up when peakBytes * overheadFraction is non-integral", () => {
    const calibrate = api.calibrateMeasuredEnvelope;
    expect(typeof calibrate).toBe("function");
    // peakBytes = 3 (from a single sample), overheadFraction = 0.5
    // product = 1.5, ceil(1.5) = 2: a conservative envelope never rounds down
    expect(
      calibrate!({
        key: baseCalibrationKey(),
        samples: [calibrationSample({ processBytes: 3, processDeviceBytes: 0 })],
        options: calibrationOptions({ minSamples: 1, overheadFraction: 0.5 }),
      }),
    ).toEqual({
      known: true,
      key: encodedCalibrationKey(baseCalibrationKey()),
      provenance: "measured",
      sampleCount: 1,
      peakBytes: 3,
      calibrationOverheadBytes: 2,
      envelopeBytes: 5,
      attribution: "process",
    });
  });
});

describe("public surface", () => {
  // Variable specifier + structural cast: a static self-name import trips
  // TS2209 under this package tsconfig; Bun resolves it at runtime.
  const subpath = "@llamactl/core/resources/memory";

  test("resources/memory subpath exposes the calibration APIs", async () => {
    const memoryModule = (await import(subpath)) as Partial<CalibrationApi>;
    expect(typeof memoryModule.deriveSwapRate).toBe("function");
    expect(typeof memoryModule.memoryCalibrationKey).toBe("function");
    expect(typeof memoryModule.calibrateMeasuredEnvelope).toBe("function");
  });
});
