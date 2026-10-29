import { describe, expect, test } from "bun:test";

import {
  deriveHostHeadroom,
  type HostHeadroom,
  type HostHeadroomOptions,
  type HostMemoryObservation,
  type MemoryReading,
} from "../../src/resources/memory.js";

type MemoryModule = {
  deriveHostHeadroom: (obs: HostMemoryObservation, opts: HostHeadroomOptions) => HostHeadroom;
};

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

describe("deriveHostHeadroom absolute clock domain", () => {
  test("negative nowMs with negative observedAtMs is invalid-input, not a small positive age", () => {
    const obs = observation({
      physical: { ...hostReading(16 * GiB), observedAtMs: -500 },
      available: { ...hostReading(8 * GiB), observedAtMs: -500 },
    });
    expect(deriveHostHeadroom(obs, options({ nowMs: -100 }))).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("negative observedAtMs with a close nonnegative nowMs is invalid-input", () => {
    const obs = observation({
      physical: { ...hostReading(16 * GiB), observedAtMs: -500 },
      available: { ...hostReading(8 * GiB), observedAtMs: -500 },
    });
    expect(deriveHostHeadroom(obs, options({ nowMs: 100 }))).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("zero timestamps are valid absolute times", () => {
    const obs = observation({
      physical: { ...hostReading(16 * GiB), observedAtMs: 0 },
      available: { ...hostReading(8 * GiB), observedAtMs: 0 },
    });
    const result = deriveHostHeadroom(obs, options({ nowMs: 0 }));
    expect(result.known).toBe(true);
  });
});

describe("deriveHostHeadroom refusal precedence", () => {
  test("physical stale plus available NaN is invalid-input, not stale-source", () => {
    const obs = observation({
      physical: hostReading(16 * GiB, 120_000),
      available: hostReading(Number.NaN),
    });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("physical NaN plus available stale is invalid-input, not stale-source", () => {
    const obs = observation({
      physical: hostReading(Number.NaN),
      available: hostReading(8 * GiB, 120_000),
    });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("physical unknown plus available stale is unknown-source, not stale-source", () => {
    const obs = observation({
      physical: reading({ source: "host" }),
      available: hostReading(8 * GiB, 120_000),
    });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "unknown-source",
    });
  });

  test("physical stale plus available unknown is unknown-source, not stale-source", () => {
    const obs = observation({
      physical: hostReading(16 * GiB, 120_000),
      available: reading({ source: "host" }),
    });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "unknown-source",
    });
  });

  test("physical invalid plus available unknown is invalid-input, not unknown-source", () => {
    const obs = observation({
      physical: hostReading(-1),
      available: reading({ source: "host" }),
    });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("physical unknown plus available invalid is invalid-input, not unknown-source", () => {
    const obs = observation({
      physical: reading({ source: "host" }),
      available: hostReading(-1),
    });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("whitespace-only source is unknown-source", () => {
    const obs = observation({
      available: { ...hostReading(8 * GiB), source: "   " },
    });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: false,
      reason: "unknown-source",
    });
  });
});

describe("deriveHostHeadroom option boundaries", () => {
  test("NaN maxAgeMs is invalid-input", () => {
    expect(deriveHostHeadroom(observation(), options({ maxAgeMs: Number.NaN }))).toEqual({
      known: false,
      reason: "invalid-input",
    });
  });

  test("Infinity maxAgeMs is invalid-input, not a never-stale window", () => {
    expect(
      deriveHostHeadroom(observation(), options({ maxAgeMs: Number.POSITIVE_INFINITY })),
    ).toEqual({ known: false, reason: "invalid-input" });
  });

  test("Infinity reserveBytes is invalid-input", () => {
    expect(
      deriveHostHeadroom(observation(), options({ reserveBytes: Number.POSITIVE_INFINITY })),
    ).toEqual({ known: false, reason: "invalid-input" });
  });

  test("available equal to physical is known; must-not-exceed allows equality", () => {
    const obs = observation({ available: hostReading(16 * GiB) });
    const result = deriveHostHeadroom(obs, options({ reserveBytes: 2 * GiB }));
    expect(result).toEqual({
      known: true,
      usableBytes: 14 * GiB,
      physicalBytes: 16 * GiB,
      availableBytes: 16 * GiB,
      reservedBytes: 2 * GiB,
    });
  });
});

describe("deriveHostHeadroom non-contributing auxiliaries", () => {
  test("populated swapUsed 6GiB plus footprint 3GiB do not change the 6GiB baseline", () => {
    const obs = observation({
      swapUsed: hostReading(6 * GiB),
      footprint: hostReading(3 * GiB),
    });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: true,
      usableBytes: 6 * GiB,
      physicalBytes: 16 * GiB,
      availableBytes: 8 * GiB,
      reservedBytes: 2 * GiB,
    });
  });

  test("malformed auxiliary readings stay distinct and never flip headroom to refusal", () => {
    const obs = observation({
      swapUsed: { ...hostReading(6 * GiB), bytes: Number.NaN },
      footprint: { ...hostReading(3 * GiB), bytes: -1 },
      device: { ...hostReading(4 * GiB), source: "", scope: "unknown" },
    });
    expect(deriveHostHeadroom(obs, options()).known).toBe(true);
  });
});

describe("memory module public surface", () => {
  // Variable specifiers + structural casts: any static self-name import trips
  // TS2209 (export map root ambiguity) under this package tsconfig. Bun
  // resolves the published specifiers at runtime, which is the contract
  // pinned here.
  const subpath = "@llamactl/core/resources/memory";
  const rootSpecifier = "@llamactl/core";

  test("resources/memory subpath export derives the known fixture", async () => {
    const memoryModule = (await import(subpath)) as MemoryModule;
    expect(typeof memoryModule.deriveHostHeadroom).toBe("function");
    expect(memoryModule.deriveHostHeadroom(observation(), options())).toEqual({
      known: true,
      usableBytes: 6 * GiB,
      physicalBytes: 16 * GiB,
      availableBytes: 8 * GiB,
      reservedBytes: 2 * GiB,
    });
  });

  test("root export exposes resourcesMemory with deriveHostHeadroom available", async () => {
    const coreRoot = (await import(rootSpecifier)) as {
      resourcesMemory?: { deriveHostHeadroom?: unknown };
    };
    expect(typeof coreRoot.resourcesMemory?.deriveHostHeadroom).toBe("function");
  });
});
