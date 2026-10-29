import { describe, expect, test } from "bun:test";

import {
  deriveHostHeadroom,
  type HostHeadroomOptions,
  type HostMemoryObservation,
  type MemoryReading,
} from "../../src/resources/memory.js";

const GiB = 1024 * 1024 * 1024;
const NOW = 1_000_000_000_000;

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

function observation(overrides: Partial<HostMemoryObservation> = {}): HostMemoryObservation {
  return {
    physical: hostReading(16 * GiB),
    available: hostReading(8 * GiB),
    reclaimable: reading({ source: "reclaim" }),
    rss: reading({ source: "rss" }),
    footprint: reading({ source: "footprint" }),
    device: { ...reading({ source: "device" }), scope: "unknown" },
    swapUsed: reading({ source: "swap" }),
    pressure: "normal",
    ...overrides,
  };
}

function options(overrides: Partial<HostHeadroomOptions> = {}): HostHeadroomOptions {
  return { nowMs: NOW, maxAgeMs: 60_000, reserveBytes: 2 * GiB, ...overrides };
}

describe("deriveHostHeadroom", () => {
  test("known 6GiB from physical 16GiB / available 8GiB / reserve 2GiB", () => {
    const result = deriveHostHeadroom(observation(), options());
    expect(result).toEqual({
      known: true,
      usableBytes: 6 * GiB,
      physicalBytes: 16 * GiB,
      availableBytes: 8 * GiB,
      reservedBytes: 2 * GiB,
    });
  });

  test("a 10GiB shared device plus low RSS does not change headroom", () => {
    const obs = observation({
      device: {
        ...hostReading(10 * GiB),
        source: "metal",
        scope: "shared",
      },
      rss: hostReading(512 * 1024 * 1024),
    });
    const result = deriveHostHeadroom(obs, options());
    expect(result).toEqual({
      known: true,
      usableBytes: 6 * GiB,
      physicalBytes: 16 * GiB,
      availableBytes: 8 * GiB,
      reservedBytes: 2 * GiB,
    });
  });

  test("4GiB reclaimable is not added to available", () => {
    const obs = observation({ reclaimable: hostReading(4 * GiB) });
    const result = deriveHostHeadroom(obs, options());
    expect(result).toEqual({
      known: true,
      usableBytes: 6 * GiB,
      physicalBytes: 16 * GiB,
      availableBytes: 8 * GiB,
      reservedBytes: 2 * GiB,
    });
  });

  test("missing physical reading is unknown-source, not zero", () => {
    const obs = observation({ physical: reading({ source: "host" }) });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "unknown-source",
    });
  });

  test("missing available reading is unknown-source, not zero", () => {
    const obs = observation({ available: reading({ source: "host" }) });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "unknown-source",
    });
  });

  test("ok status but null available bytes is unknown-source, not zero", () => {
    const obs = observation({
      available: { ...hostReading(8 * GiB), bytes: null },
    });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "unknown-source",
    });
  });

  test("ok status but null physical bytes is unknown-source, not zero", () => {
    const obs = observation({
      physical: { ...hostReading(16 * GiB), bytes: null },
    });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "unknown-source",
    });
  });

  test("denied available reading is unknown-source", () => {
    const obs = observation({
      available: reading({
        bytes: 8 * GiB,
        observedAtMs: NOW,
        source: "host",
        status: "denied",
      }),
    });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "unknown-source",
    });
  });

  test("unsupported physical reading is unknown-source", () => {
    const obs = observation({
      physical: reading({
        bytes: 16 * GiB,
        observedAtMs: NOW,
        source: "host",
        status: "unsupported",
      }),
    });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "unknown-source",
    });
  });

  test("empty source on a trusted host reading is unknown-source", () => {
    const obs = observation({
      available: { ...hostReading(8 * GiB), source: "" },
    });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "unknown-source",
    });
  });

  test("auxiliary sources may be unknown while headroom stays known", () => {
    const result = deriveHostHeadroom(observation(), options());
    expect(result.known).toBe(true);
  });

  test("stale available reading is stale-source", () => {
    const obs = observation({ available: hostReading(8 * GiB, 61_000) });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "stale-source",
    });
  });

  test("future available timestamp is invalid-input", () => {
    const obs = observation({
      available: { ...hostReading(8 * GiB), observedAtMs: NOW + 1 },
    });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("stale physical reading is stale-source", () => {
    const obs = observation({ physical: hostReading(16 * GiB, 120_000) });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "stale-source",
    });
  });

  test("NaN bytes is invalid-input", () => {
    const obs = observation({
      available: hostReading(Number.NaN),
    });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("Infinity bytes is invalid-input", () => {
    const obs = observation({
      physical: hostReading(Number.POSITIVE_INFINITY),
    });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("negative bytes is invalid-input", () => {
    const obs = observation({ available: hostReading(-1) });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("available exceeding physical is invalid-input", () => {
    const obs = observation({ available: hostReading(20 * GiB) });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("NaN reserve is invalid-input", () => {
    expect(deriveHostHeadroom(observation(), options({ reserveBytes: Number.NaN }))).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("negative reserve is invalid-input", () => {
    expect(deriveHostHeadroom(observation(), options({ reserveBytes: -1 }))).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("Infinity nowMs is invalid-input", () => {
    expect(deriveHostHeadroom(observation(), options({ nowMs: Number.POSITIVE_INFINITY }))).toEqual(
      { known: false, reason: "invalid-input" },
    );
  });

  test("negative maxAgeMs is invalid-input", () => {
    expect(deriveHostHeadroom(observation(), options({ maxAgeMs: -1 }))).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("warning pressure is a pressure refusal", () => {
    const obs = observation({ pressure: "warning" });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "pressure",
    });
  });

  test("critical pressure is a pressure refusal", () => {
    const obs = observation({ pressure: "critical" });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "pressure",
    });
  });

  test("null pressure is unknown-source", () => {
    const obs = observation({ pressure: null });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "unknown-source",
    });
  });

  test("reserve equal to available yields known zero", () => {
    const result = deriveHostHeadroom(observation(), options({ reserveBytes: 8 * GiB }));
    expect(result).toEqual({
      known: true,
      usableBytes: 0,
      physicalBytes: 16 * GiB,
      availableBytes: 8 * GiB,
      reservedBytes: 8 * GiB,
    });
  });

  test("reserve above available clamps usable to zero", () => {
    const result = deriveHostHeadroom(observation(), options({ reserveBytes: 12 * GiB }));
    expect(result).toEqual({
      known: true,
      usableBytes: 0,
      physicalBytes: 16 * GiB,
      availableBytes: 8 * GiB,
      reservedBytes: 12 * GiB,
    });
  });

  test("boundary age exactly at maxAgeMs is known", () => {
    const obs = observation({ available: hostReading(8 * GiB, 60_000) });
    expect(deriveHostHeadroom(obs, options()).known).toBe(true);
  });
});
