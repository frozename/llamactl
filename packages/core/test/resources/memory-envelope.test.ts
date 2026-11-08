import { describe, expect, test } from "bun:test";

import {
  deriveHostHeadroom,
  type HostHeadroom,
  type HostHeadroomOptions,
  type HostMemoryObservation,
  type MemoryReading,
} from "../../src/resources/memory.js";
import * as memoryNs from "../../src/resources/memory.js";

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

  test("resources/memory subpath exposes GTT counters and KV envelope APIs", async () => {
    const memoryModule = (await import(subpath)) as MemoryModule & Partial<EnvelopeApi>;
    expect(typeof memoryModule.parseGttCounters).toBe("function");
    expect(typeof memoryModule.kvEnvelopeKey).toBe("function");
    expect(typeof memoryModule.deriveModelKvBudget).toBe("function");
  });
});

// DF-04 remainder (#277): Linux GTT observation + per-model KV envelopes.
// The functions under test do not exist at the pinned base; every case reaches
// them through a namespace import plus a structural cast so a missing export
// fails by assertion, never by a module-link error.
type GttCountersObservation = {
  status: "ok" | "unavailable" | "denied" | "unsupported";
  totalBytes: number | null;
  usedBytes: number | null;
  observedAtMs: number;
  source: string;
  scope: "shared";
};

type GttDeviceReading = MemoryReading & { scope: "shared" | "process" | "unknown" };

type KvEnvelopeKey = {
  model: string;
  ctx: number;
  kvType: string;
  slots: number;
};

type ModelKvEnvelope = {
  key: KvEnvelopeKey;
  weightsBytes: number;
  kvBytes: number;
  workspaceBytes: number;
  provenance: "measured" | "declared";
};

type ModelKvBudget =
  | {
      known: true;
      key: string;
      usableBytes: number;
      requiredBytes: number;
      kvBudgetBytes: number;
      fits: boolean;
      provenance: "measured" | "declared";
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

type ModelKvBudgetInput = {
  envelopes: ModelKvEnvelope[];
  key: KvEnvelopeKey;
  observation: HostMemoryObservation;
  options: HostHeadroomOptions;
};

type EnvelopeApi = {
  parseGttCounters: (
    totalRaw: string,
    usedRaw: string,
    meta: { source: string; observedAtMs: number },
  ) => GttCountersObservation;
  gttDeviceReading: (obs: GttCountersObservation) => GttDeviceReading;
  kvEnvelopeKey: (key: KvEnvelopeKey) => string | null;
  deriveModelKvBudget: (input: ModelKvBudgetInput) => ModelKvBudget;
};

const api = memoryNs as unknown as Partial<EnvelopeApi>;

function kvKey(overrides: Partial<KvEnvelopeKey> = {}): KvEnvelopeKey {
  return { model: "qwen3-30b", ctx: 32768, kvType: "q8_0", slots: 4, ...overrides };
}

function kvEnvelope(overrides: Partial<ModelKvEnvelope> = {}): ModelKvEnvelope {
  return {
    key: kvKey(),
    weightsBytes: 3 * GiB,
    kvBytes: 2 * GiB,
    workspaceBytes: GiB / 2,
    provenance: "measured",
    ...overrides,
  };
}

function encodedKey(key: KvEnvelopeKey): string {
  const keyOf = api.kvEnvelopeKey;
  expect(typeof keyOf).toBe("function");
  const encoded = keyOf!(key);
  if (encoded === null) {
    throw new Error("kvEnvelopeKey returned null for a valid key");
  }
  return encoded;
}

describe("parseGttCounters", () => {
  const GTT_SOURCE = "/sys/class/drm/card1/device";

  test("parses ok counters into a shared-scope observation", () => {
    const parse = api.parseGttCounters;
    expect(typeof parse).toBe("function");
    expect(
      parse!("68719476736\n", "4294967296\n", { source: GTT_SOURCE, observedAtMs: NOW }),
    ).toEqual({
      status: "ok",
      totalBytes: 64 * GiB,
      usedBytes: 4 * GiB,
      observedAtMs: NOW,
      source: GTT_SOURCE,
      scope: "shared",
    });
  });

  test.each([
    { label: "empty total", total: "", used: "4294967296\n" },
    { label: "non-numeric total", total: "abc", used: "4294967296\n" },
    { label: "negative total", total: "-5", used: "4294967296\n" },
    { label: "fractional total", total: "12.5", used: "4294967296\n" },
    { label: "used above total", total: "100", used: "200" },
    {
      label: "total above MAX_SAFE_INTEGER",
      total: String(Number.MAX_SAFE_INTEGER + 1),
      used: "1",
    },
  ])("malformed counters are unavailable, never zero: $label", ({ total, used }) => {
    const parse = api.parseGttCounters;
    expect(typeof parse).toBe("function");
    expect(parse!(total, used, { source: GTT_SOURCE, observedAtMs: NOW })).toEqual({
      status: "unavailable",
      totalBytes: null,
      usedBytes: null,
      observedAtMs: NOW,
      source: GTT_SOURCE,
      scope: "shared",
    });
  });
});

describe("gttDeviceReading", () => {
  const GTT_SOURCE = "/sys/class/drm/card1/device";

  test("maps an ok observation to shared device bytes", () => {
    const parse = api.parseGttCounters;
    const toReading = api.gttDeviceReading;
    expect(typeof parse).toBe("function");
    expect(typeof toReading).toBe("function");
    const obs = parse!("68719476736\n", "4294967296\n", {
      source: GTT_SOURCE,
      observedAtMs: NOW,
    });
    expect(toReading!(obs)).toEqual({
      bytes: 4 * GiB,
      observedAtMs: NOW,
      source: GTT_SOURCE,
      status: "ok",
      scope: "shared",
    });
  });

  test("maps an unavailable observation to null bytes with the same status", () => {
    const parse = api.parseGttCounters;
    const toReading = api.gttDeviceReading;
    expect(typeof parse).toBe("function");
    expect(typeof toReading).toBe("function");
    const obs = parse!("oops", "4294967296\n", { source: GTT_SOURCE, observedAtMs: NOW });
    expect(toReading!(obs)).toEqual({
      bytes: null,
      observedAtMs: NOW,
      source: GTT_SOURCE,
      status: "unavailable",
      scope: "shared",
    });
  });

  test("preserves denied and unsupported statuses", () => {
    const toReading = api.gttDeviceReading;
    expect(typeof toReading).toBe("function");
    for (const status of ["denied", "unsupported"] as const) {
      const obs: GttCountersObservation = {
        status,
        totalBytes: null,
        usedBytes: null,
        observedAtMs: NOW,
        source: GTT_SOURCE,
        scope: "shared",
      };
      expect(toReading!(obs)).toEqual({
        bytes: null,
        observedAtMs: NOW,
        source: GTT_SOURCE,
        status,
        scope: "shared",
      });
    }
  });

  test("shared GTT device bytes never enter host headroom", () => {
    const parse = api.parseGttCounters;
    const toReading = api.gttDeviceReading;
    expect(typeof parse).toBe("function");
    expect(typeof toReading).toBe("function");
    const gttObs = parse!("68719476736\n", String(10 * GiB), {
      source: GTT_SOURCE,
      observedAtMs: NOW,
    });
    const obs = observation({ device: toReading!(gttObs) });
    expect(deriveHostHeadroom(obs, options())).toEqual({
      known: true,
      usableBytes: 6 * GiB,
      physicalBytes: 16 * GiB,
      availableBytes: 8 * GiB,
      reservedBytes: 2 * GiB,
    });
  });
});

describe("kvEnvelopeKey", () => {
  const key: KvEnvelopeKey = { model: "qwen3-30b", ctx: 32768, kvType: "q8_0", slots: 4 };

  test("returns a non-empty string for a valid key", () => {
    const keyOf = api.kvEnvelopeKey;
    expect(typeof keyOf).toBe("function");
    const encoded = keyOf!(key);
    expect(typeof encoded).toBe("string");
    expect(encoded).not.toBe("");
  });

  test("is identical for a key built with different property order", () => {
    const keyOf = api.kvEnvelopeKey;
    expect(typeof keyOf).toBe("function");
    const reordered = { slots: 4, kvType: "q8_0", ctx: 32768, model: "qwen3-30b" };
    expect(keyOf!(reordered)).toBe(keyOf!(key));
  });

  test("gives each calibration variant a distinct key", () => {
    const keyOf = api.kvEnvelopeKey;
    expect(typeof keyOf).toBe("function");
    const base = keyOf!(key);
    const variants = [
      keyOf!({ ...key, model: "qwen3-32b" }),
      keyOf!({ ...key, ctx: 65536 }),
      keyOf!({ ...key, kvType: "f16" }),
      keyOf!({ ...key, slots: 8 }),
    ];
    for (const variant of [base, ...variants]) {
      expect(variant).not.toBeNull();
    }
    expect(new Set([base, ...variants]).size).toBe(5);
  });

  test("a model containing the separator cannot collide with another key", () => {
    const keyOf = api.kvEnvelopeKey;
    expect(typeof keyOf).toBe("function");
    const withSeparator = keyOf!({ model: "a|1", ctx: 5, kvType: "q8_0", slots: 2 });
    const plain = keyOf!({ model: "a", ctx: 1, kvType: "5|q8_0", slots: 2 });
    expect(withSeparator).not.toBeNull();
    expect(plain).not.toBeNull();
    expect(withSeparator).not.toBe(plain);
  });

  test.each([
    { label: "empty model", key: { model: "", ctx: 32768, kvType: "q8_0", slots: 4 } },
    {
      label: "whitespace-only model",
      key: { model: "  ", ctx: 32768, kvType: "q8_0", slots: 4 },
    },
    { label: "zero ctx", key: { model: "qwen3-30b", ctx: 0, kvType: "q8_0", slots: 4 } },
    { label: "fractional ctx", key: { model: "qwen3-30b", ctx: 1.5, kvType: "q8_0", slots: 4 } },
    {
      label: "NaN ctx",
      key: { model: "qwen3-30b", ctx: Number.NaN, kvType: "q8_0", slots: 4 },
    },
    { label: "zero slots", key: { model: "qwen3-30b", ctx: 32768, kvType: "q8_0", slots: 0 } },
    {
      label: "fractional slots",
      key: { model: "qwen3-30b", ctx: 32768, kvType: "q8_0", slots: 2.5 },
    },
    {
      label: "empty kvType",
      key: { model: "qwen3-30b", ctx: 32768, kvType: "", slots: 4 },
    },
  ])("invalid key returns null: $label", ({ key: invalid }) => {
    const keyOf = api.kvEnvelopeKey;
    expect(typeof keyOf).toBe("function");
    expect(keyOf!(invalid)).toBeNull();
  });
});

describe("deriveModelKvBudget", () => {
  function budgetArgs(overrides: Partial<ModelKvBudgetInput> = {}): ModelKvBudgetInput {
    return {
      envelopes: [kvEnvelope()],
      key: kvKey(),
      observation: observation(),
      options: options(),
      ...overrides,
    };
  }

  test("reports a known budget when weights, workspace and kv fit", () => {
    const derive = api.deriveModelKvBudget;
    expect(typeof derive).toBe("function");
    const key = kvKey();
    const result = derive!(budgetArgs({ envelopes: [kvEnvelope({ key })], key }));
    expect(result).toEqual({
      known: true,
      key: encodedKey(key),
      usableBytes: 6 * GiB,
      requiredBytes: 5.5 * GiB,
      kvBudgetBytes: 2.5 * GiB,
      fits: true,
      provenance: "measured",
    });
  });

  test("reports fits false when kv demand exceeds the kv budget", () => {
    const derive = api.deriveModelKvBudget;
    expect(typeof derive).toBe("function");
    const key = kvKey();
    const result = derive!(budgetArgs({ envelopes: [kvEnvelope({ key, kvBytes: 3 * GiB })], key }));
    expect(result).toEqual({
      known: true,
      key: encodedKey(key),
      usableBytes: 6 * GiB,
      requiredBytes: 6.5 * GiB,
      kvBudgetBytes: 2.5 * GiB,
      fits: false,
      provenance: "measured",
    });
  });

  test("fits at the equality boundary where requiredBytes equals usableBytes", () => {
    const derive = api.deriveModelKvBudget;
    expect(typeof derive).toBe("function");
    const key = kvKey();
    const result = derive!(
      budgetArgs({
        envelopes: [
          kvEnvelope({ key, weightsBytes: 3 * GiB, kvBytes: 2.5 * GiB, workspaceBytes: 0.5 * GiB }),
        ],
        key,
      }),
    );
    expect(result).toEqual({
      known: true,
      key: encodedKey(key),
      usableBytes: 6 * GiB,
      requiredBytes: 6 * GiB,
      kvBudgetBytes: 2.5 * GiB,
      fits: true,
      provenance: "measured",
    });
  });

  test("floors kvBudgetBytes at zero and never goes negative", () => {
    const derive = api.deriveModelKvBudget;
    expect(typeof derive).toBe("function");
    const key = kvKey();
    const result = derive!(
      budgetArgs({ envelopes: [kvEnvelope({ key, weightsBytes: 7 * GiB })], key }),
    );
    expect(result).toMatchObject({ known: true, kvBudgetBytes: 0, fits: false });
  });

  test("passes a pressure refusal through unchanged", () => {
    const derive = api.deriveModelKvBudget;
    expect(typeof derive).toBe("function");
    const result = derive!(budgetArgs({ observation: observation({ pressure: "warning" }) }));
    expect(result).toEqual({ known: false, reason: "pressure" });
  });

  test("passes a stale-source refusal through unchanged", () => {
    const derive = api.deriveModelKvBudget;
    expect(typeof derive).toBe("function");
    const result = derive!(
      budgetArgs({ observation: observation({ available: hostReading(8 * GiB, 61_000) }) }),
    );
    expect(result).toEqual({ known: false, reason: "stale-source" });
  });

  test("passes an invalid-input refusal through unchanged", () => {
    const derive = api.deriveModelKvBudget;
    expect(typeof derive).toBe("function");
    const result = derive!(budgetArgs({ options: options({ reserveBytes: -1 }) }));
    expect(result).toEqual({ known: false, reason: "invalid-input" });
  });

  test("does not match an envelope calibrated for different ctx, kvType or slots", () => {
    const derive = api.deriveModelKvBudget;
    expect(typeof derive).toBe("function");
    const envelope = kvEnvelope();
    for (const query of [
      kvKey({ ctx: 65536 }),
      kvKey({ kvType: "f16" }),
      kvKey({ slots: 8 }),
      kvKey({ model: "qwen3-32b" }),
    ]) {
      const result = derive!(budgetArgs({ envelopes: [envelope], key: query }));
      expect(result).toEqual({ known: false, reason: "no-envelope" });
    }
  });

  test("reports no-envelope for an empty envelope list", () => {
    const derive = api.deriveModelKvBudget;
    expect(typeof derive).toBe("function");
    const result = derive!(budgetArgs({ envelopes: [] }));
    expect(result).toEqual({ known: false, reason: "no-envelope" });
  });

  test("rejects two envelopes that share a key", () => {
    const derive = api.deriveModelKvBudget;
    expect(typeof derive).toBe("function");
    const key = kvKey();
    const result = derive!(
      budgetArgs({ envelopes: [kvEnvelope({ key }), kvEnvelope({ key })], key }),
    );
    expect(result).toEqual({ known: false, reason: "invalid-envelope" });
  });

  test.each([
    { label: "NaN weightsBytes", patch: { weightsBytes: Number.NaN } },
    { label: "negative weightsBytes", patch: { weightsBytes: -1 } },
    { label: "NaN kvBytes", patch: { kvBytes: Number.NaN } },
    { label: "negative kvBytes", patch: { kvBytes: -1 } },
    { label: "NaN workspaceBytes", patch: { workspaceBytes: Number.NaN } },
    { label: "negative workspaceBytes", patch: { workspaceBytes: -1 } },
  ])("rejects invalid envelope bytes: $label", ({ patch }) => {
    const derive = api.deriveModelKvBudget;
    expect(typeof derive).toBe("function");
    const key = kvKey();
    const result = derive!(budgetArgs({ envelopes: [kvEnvelope({ key, ...patch })], key }));
    expect(result).toEqual({ known: false, reason: "invalid-envelope" });
  });

  test("rejects an invalid query key", () => {
    const derive = api.deriveModelKvBudget;
    expect(typeof derive).toBe("function");
    const result = derive!(budgetArgs({ key: kvKey({ ctx: 0 }) }));
    expect(result).toEqual({ known: false, reason: "invalid-envelope" });
  });

  test("reports declared provenance back unchanged", () => {
    const derive = api.deriveModelKvBudget;
    expect(typeof derive).toBe("function");
    const key = kvKey();
    const result = derive!(
      budgetArgs({ envelopes: [kvEnvelope({ key, provenance: "declared" })], key }),
    );
    expect(result).toMatchObject({ known: true, provenance: "declared" });
  });

  test("never merges declared and measured envelopes for one key", () => {
    const derive = api.deriveModelKvBudget;
    expect(typeof derive).toBe("function");
    const key = kvKey();
    const result = derive!(
      budgetArgs({
        envelopes: [
          kvEnvelope({ key, provenance: "declared" }),
          kvEnvelope({ key, provenance: "measured" }),
        ],
        key,
      }),
    );
    expect(result).toEqual({ known: false, reason: "invalid-envelope" });
  });
});
