import { expect, test } from 'bun:test';
import type { KvEntry } from '../src/kvstore/index.js';
import { evictionScore } from '../src/kvstore/index.js';

function baseEntry(overrides: Partial<KvEntry> = {}): KvEntry {
  return {
    sha: 'abc123',
    workload: 'wl-a',
    upstreamSlotFile: '/tmp/slot.bin',
    quantBits: 8,
    tokens: 2048,
    ctxSize: 32768,
    hits: 0,
    createdAt: 1716576000,
    lastUsed: 1716576000,
    payloadBytes: 1024,
    textBytes: 512,
    reason: 'cold',
    prefixByteLength: 256,
    workloadEpoch: 'epoch-1',
    quarantined: 0,
    state: 'idle',
    firstResponseToken: null,
    ...overrides,
  };
}

test('protected entry is never evicted', () => {
  const now = 1716576000 + 60_000;
  const score = evictionScore(baseEntry({ sha: 'protected' }), 0, null, 'protected', now);
  expect(score).toBe(Number.NEGATIVE_INFINITY);
});

test('live-prefix-matching entry scores far below idle entry of the same age', () => {
  const now = 1716576000 + 60_000;
  const idle = evictionScore(baseEntry({ sha: 'idle', hits: 1, lastUsed: now - 60_000 }), 0, null, null, now);
  const live = evictionScore(baseEntry({ sha: 'live', hits: 1, lastUsed: now - 60_000 }), 0, 'live', null, now);

  expect(live).toBeLessThan(idle - 500);
});

test('hits decay with a 6h half-life', () => {
  const now = 1716576000 + 60_000;
  const recent = evictionScore(baseEntry({ sha: 'recent', hits: 10, lastUsed: now - 60_000 }), 0, null, null, now);
  const stale = evictionScore(baseEntry({ sha: 'stale', hits: 10, lastUsed: now - 6 * 3600 * 1000 }), 0, null, null, now);

  expect(stale).toBeGreaterThan(recent);
});

test('larger payloads score higher than smaller ones at the same recency and hits', () => {
  const now = 1716576000 + 60_000;
  const small = evictionScore(baseEntry({ sha: 'small', hits: 2, payloadBytes: 1024 * 1024 }), 0, null, null, now);
  const large = evictionScore(baseEntry({ sha: 'large', hits: 2, payloadBytes: 8 * 1024 * 1024 }), 0, null, null, now);

  expect(large).toBeGreaterThan(small);
});

test('never-used entries are more evictable than used entries of the same recency', () => {
  const now = 1716576000 + 60_000;
  const unused = evictionScore(baseEntry({ sha: 'unused', hits: 0, lastUsed: now - 60_000 }), 0, null, null, now);
  const used = evictionScore(baseEntry({ sha: 'used', hits: 4, lastUsed: now - 60_000 }), 0, null, null, now);

  expect(unused).toBeGreaterThan(used);
});

test('relative ordering matches protection, recency, size, and live-prefix rules', () => {
  const now = 1716576000 + 60_000;
  const entries = [
    baseEntry({ sha: 'protected', hits: 20, payloadBytes: 32 * 1024 * 1024 }),
    baseEntry({ sha: 'live', hits: 1, payloadBytes: 16 * 1024 * 1024, lastUsed: now - 6 * 3600 * 1000 }),
    baseEntry({ sha: 'recent-popular', hits: 10, payloadBytes: 1 * 1024 * 1024, lastUsed: now - 1_000 }),
    baseEntry({ sha: 'smaller', hits: 2, payloadBytes: 1 * 1024 * 1024, lastUsed: now - 1_000 }),
    baseEntry({ sha: 'bigger', hits: 2, payloadBytes: 8 * 1024 * 1024, lastUsed: now - 1_000 }),
  ];

  const ranked = entries
    .map((entry) => ({ sha: entry.sha, score: evictionScore(entry, 0, 'live', 'protected', now) }))
    .sort((a, b) => a.score - b.score)
    .map((item) => item.sha);

  expect(ranked).toEqual(['protected', 'live', 'recent-popular', 'smaller', 'bigger']);
});
