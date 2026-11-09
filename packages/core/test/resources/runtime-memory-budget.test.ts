// RED pins for frozename/llamactl#367: evaluateRuntimeMemoryBudget charges a
// single basis — physical footprint when it is ok and fresh, process RSS as
// the fallback — against a per-role byte budget, never sums JS heap /
// external / device-wide counters into the charge, and refuses malformed or
// stale observations with the same precedence as deriveHostHeadroom. The
// function does not exist at the pinned base; every case reaches it through
// a namespace import so a missing export fails by assertion, never by a
// module-link error.
import { describe, expect, test } from "bun:test";

import * as memoryNs from "../../src/resources/memory.js";

const { evaluateRuntimeMemoryBudget } = memoryNs;

type MemoryReading = memoryNs.MemoryReading;
type RuntimeMemorySample = memoryNs.RuntimeMemorySample;
type RuntimeMemoryBudget = memoryNs.RuntimeMemoryBudget;
type RuntimeMemoryBudgetOptions = memoryNs.RuntimeMemoryBudgetOptions;
type RuntimeMemoryBudgetResult = memoryNs.RuntimeMemoryVerdict;

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const NOW = 1_000_000_000_000;
const MAX_AGE_MS = 60_000;

function reading(overrides: Partial<MemoryReading> = {}): MemoryReading {
  return {
    bytes: null,
    observedAtMs: null,
    source: "",
    status: "unavailable",
    ...overrides,
  };
}

function hostReading(bytes: number, ageMs = 0): MemoryReading {
  return reading({
    bytes,
    observedAtMs: NOW - ageMs,
    source: "host",
    status: "ok",
  });
}

function sample(overrides: Partial<RuntimeMemorySample> = {}): RuntimeMemorySample {
  return {
    role: "control",
    rss: hostReading(2765 * MiB),
    footprint: hostReading(1526 * MiB),
    jsHeapUsed: reading({ bytes: 64 * MiB, observedAtMs: NOW, source: "js-heap" }),
    external: reading({ bytes: 16 * MiB, observedAtMs: NOW, source: "external" }),
    device: { ...reading({ source: "device" }), scope: "unknown" },
    ...overrides,
  };
}

function budget(overrides: Partial<RuntimeMemoryBudget> = {}): RuntimeMemoryBudget {
  return { role: "control", maxBytes: 2048 * MiB, ...overrides };
}

function budgetOptions(
  overrides: Partial<RuntimeMemoryBudgetOptions> = {},
): RuntimeMemoryBudgetOptions {
  return { nowMs: NOW, maxAgeMs: MAX_AGE_MS, ...overrides };
}

function evaluate(
  runtimeSample: RuntimeMemorySample,
  runtimeBudget: RuntimeMemoryBudget,
  options: RuntimeMemoryBudgetOptions,
): RuntimeMemoryBudgetResult {
  return evaluateRuntimeMemoryBudget(runtimeSample, runtimeBudget, options);
}

describe("evaluateRuntimeMemoryBudget charged basis", () => {
  test("charges footprint when it is ok and fresh", () => {
    expect(evaluate(sample(), budget(), budgetOptions())).toEqual({
      known: true,
      role: "control",
      basis: "footprint",
      chargedBytes: 1526 * MiB,
      maxBytes: 2048 * MiB,
      withinBudget: true,
      overBytes: 0,
    });
  });

  test("falls back to rss when footprint is unsupported", () => {
    expect(
      evaluate(
        sample({
          footprint: reading({ status: "unsupported" }),
          rss: hostReading(300 * MiB),
        }),
        budget({ maxBytes: 256 * MiB }),
        budgetOptions(),
      ),
    ).toEqual({
      known: true,
      role: "control",
      basis: "rss",
      chargedBytes: 300 * MiB,
      maxBytes: 256 * MiB,
      withinBudget: false,
      overBytes: 44 * MiB,
    });
  });

  test("falls back to rss when footprint is stale", () => {
    expect(
      evaluate(
        sample({
          footprint: hostReading(1526 * MiB, MAX_AGE_MS + 1),
          rss: hostReading(400 * MiB),
        }),
        budget(),
        budgetOptions(),
      ),
    ).toEqual({
      known: true,
      role: "control",
      basis: "rss",
      chargedBytes: 400 * MiB,
      maxBytes: 2048 * MiB,
      withinBudget: true,
      overBytes: 0,
    });
  });

  test("never sums js heap, external or shared device counters into the charge", () => {
    expect(
      evaluate(
        sample({
          rss: hostReading(200 * MiB),
          footprint: reading({ status: "unsupported" }),
          jsHeapUsed: reading({ bytes: 10 * GiB, observedAtMs: NOW, source: "js-heap" }),
          external: reading({ bytes: 10 * GiB, observedAtMs: NOW, source: "external" }),
          device: { ...hostReading(30 * GiB), scope: "shared" },
        }),
        budget({ maxBytes: 256 * MiB }),
        budgetOptions(),
      ),
    ).toEqual({
      known: true,
      role: "control",
      basis: "rss",
      chargedBytes: 200 * MiB,
      maxBytes: 256 * MiB,
      withinBudget: true,
      overBytes: 0,
    });
  });
});

describe("evaluateRuntimeMemoryBudget refusals", () => {
  test("a malformed footprint refuses invalid-input and never falls back to rss", () => {
    expect(
      evaluate(
        sample({ footprint: { ...hostReading(1526 * MiB), bytes: -1 } }),
        budget(),
        budgetOptions(),
      ),
    ).toEqual({ known: false, reason: "invalid-input" });
  });

  test("unavailable footprint plus stale rss reports unknown-source, not stale-source", () => {
    expect(
      evaluate(
        sample({
          footprint: reading({ source: "footprint" }),
          rss: hostReading(300 * MiB, MAX_AGE_MS + 1),
        }),
        budget(),
        budgetOptions(),
      ),
    ).toEqual({ known: false, reason: "unknown-source" });
  });

  test("stale footprint plus stale rss reports stale-source", () => {
    expect(
      evaluate(
        sample({
          footprint: hostReading(1526 * MiB, MAX_AGE_MS + 1),
          rss: hostReading(300 * MiB, MAX_AGE_MS + 1),
        }),
        budget(),
        budgetOptions(),
      ),
    ).toEqual({ known: false, reason: "stale-source" });
  });

  test("a role mismatch between sample and budget refuses role-mismatch", () => {
    expect(evaluate(sample(), budget({ role: "model-host" }), budgetOptions())).toEqual({
      known: false,
      reason: "role-mismatch",
    });
  });

  test("a whitespace sample role refuses invalid-input", () => {
    expect(evaluate(sample({ role: "  " }), budget(), budgetOptions())).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("negative nowMs refuses invalid-input", () => {
    expect(evaluate(sample(), budget(), budgetOptions({ nowMs: -1 }))).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("NaN maxAgeMs refuses invalid-input", () => {
    expect(evaluate(sample(), budget(), budgetOptions({ maxAgeMs: Number.NaN }))).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("zero maxBytes refuses invalid-input", () => {
    expect(evaluate(sample(), budget({ maxBytes: 0 }), budgetOptions())).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("infinite maxBytes refuses invalid-input", () => {
    expect(
      evaluate(sample(), budget({ maxBytes: Number.POSITIVE_INFINITY }), budgetOptions()),
    ).toEqual({ known: false, reason: "invalid-input" });
  });

  test("a future rss timestamp refuses invalid-input even when footprint is unavailable", () => {
    expect(
      evaluate(
        sample({
          footprint: reading({ status: "unsupported" }),
          rss: { ...hostReading(300 * MiB), observedAtMs: NOW + 1 },
        }),
        budget(),
        budgetOptions(),
      ),
    ).toEqual({ known: false, reason: "invalid-input" });
  });
});

describe("evaluateRuntimeMemoryBudget budget boundary", () => {
  const rssOnlySample = (): RuntimeMemorySample =>
    sample({
      rss: hostReading(200 * MiB),
      footprint: reading({ status: "unsupported" }),
    });

  test("charged equal to maxBytes is within budget with zero overBytes", () => {
    expect(evaluate(rssOnlySample(), budget({ maxBytes: 200 * MiB }), budgetOptions())).toEqual({
      known: true,
      role: "control",
      basis: "rss",
      chargedBytes: 200 * MiB,
      maxBytes: 200 * MiB,
      withinBudget: true,
      overBytes: 0,
    });
  });

  test("maxBytes one byte under the charge reports overBytes 1", () => {
    expect(evaluate(rssOnlySample(), budget({ maxBytes: 200 * MiB - 1 }), budgetOptions())).toEqual(
      {
        known: true,
        role: "control",
        basis: "rss",
        chargedBytes: 200 * MiB,
        maxBytes: 200 * MiB - 1,
        withinBudget: false,
        overBytes: 1,
      },
    );
  });
});
