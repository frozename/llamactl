import { expect, test } from "bun:test";

import type { KvEntry } from "../src/kvstore/index.js";

import { evictionScore } from "../src/kvstore/index.js";

function baseEntry(overrides: Partial<KvEntry> = {}): KvEntry {
  return {
    sha: "abc123",
    workload: "wl-a",
    model: null,
    upstreamSlotFile: "/tmp/slot.bin",
    quantBits: 8,
    tokens: 2048,
    ctxSize: 32768,
    hits: 0,
    createdAt: 1716576000,
    lastUsed: 1716576000,
    payloadBytes: 1024,
    textBytes: 512,
    reason: "cold",
    prefixByteLength: 256,
    workloadEpoch: "epoch-1",
    quarantined: 0,
    state: "idle",
    firstResponseToken: null,
    extFlags: 0,
    ...overrides,
  };
}

test("score equals ageComponent + sizeComponent - hitProtection", () => {
  const now = 1716576000 + 60_000;
  const entry = baseEntry({ hits: 3, payloadBytes: 4 * 1024 * 1024, lastUsed: now - 60_000 });

  const ageMs = now - entry.lastUsed;
  const decayedHits = entry.hits * Math.pow(0.5, ageMs / (6 * 3600 * 1000));
  const ageComponent = ageMs / (60 * 60 * 1000);
  const hitProtection = decayedHits * 25;
  const sizeComponent = entry.payloadBytes / (1024 * 1024);

  expect(evictionScore(entry, now)).toBe(ageComponent + sizeComponent - hitProtection);
});

test("hits decay with a 6h half-life", () => {
  const now = 1716576000 + 60_000;
  const recent = evictionScore(baseEntry({ sha: "recent", hits: 10, lastUsed: now - 60_000 }), now);
  const stale = evictionScore(
    baseEntry({ sha: "stale", hits: 10, lastUsed: now - 6 * 3600 * 1000 }),
    now,
  );

  expect(stale).toBeGreaterThan(recent);
});

test("larger payloads score higher than smaller ones at the same recency and hits", () => {
  const now = 1716576000 + 60_000;
  const small = evictionScore(baseEntry({ sha: "small", hits: 2, payloadBytes: 1024 * 1024 }), now);
  const large = evictionScore(
    baseEntry({ sha: "large", hits: 2, payloadBytes: 8 * 1024 * 1024 }),
    now,
  );

  expect(large).toBeGreaterThan(small);
});

test("never-used entries are more evictable than used entries of the same recency", () => {
  const now = 1716576000 + 60_000;
  const unused = evictionScore(baseEntry({ sha: "unused", hits: 0, lastUsed: now - 60_000 }), now);
  const used = evictionScore(baseEntry({ sha: "used", hits: 4, lastUsed: now - 60_000 }), now);

  expect(unused).toBeGreaterThan(used);
});

test("relative ordering matches recency and size rules", () => {
  const now = 1716576000 + 60_000;
  const entries = [
    baseEntry({
      sha: "recent-popular",
      hits: 10,
      payloadBytes: 1 * 1024 * 1024,
      lastUsed: now - 1_000,
    }),
    baseEntry({ sha: "smaller", hits: 2, payloadBytes: 1 * 1024 * 1024, lastUsed: now - 1_000 }),
    baseEntry({ sha: "bigger", hits: 2, payloadBytes: 8 * 1024 * 1024, lastUsed: now - 1_000 }),
  ];

  const ranked = entries
    .map((entry) => ({ sha: entry.sha, score: evictionScore(entry, now) }))
    .sort((a, b) => a.score - b.score)
    .map((item) => item.sha);

  expect(ranked).toEqual(["recent-popular", "smaller", "bigger"]);
});
