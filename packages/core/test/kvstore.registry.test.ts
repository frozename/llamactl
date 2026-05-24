import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KvRegistry, longestPrefixLookup, openKvStorage, type KvEntry } from '../src/kvstore/index.js';

function makeTempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'llamactl-kvstore-registry-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function baseEntry(overrides: Partial<KvEntry> = {}): KvEntry {
  return {
    sha: 'sha-base',
    workload: 'foo',
    upstreamSlotFile: '/tmp/slot.bin',
    quantBits: 4,
    tokens: 128,
    ctxSize: 32768,
    hits: 0,
    createdAt: 1716576000,
    lastUsed: 1716576000,
    payloadBytes: 1024,
    textBytes: 512,
    reason: 'cold',
    prefixByteLength: 16,
    workloadEpoch: 'epoch-1',
    quarantined: 0,
    ...overrides,
  };
}

test('longestPrefixLookup chooses longest matching prefix regardless of candidate order', () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, 'slot.bin');
    writeFileSync(slotFile, 'payload');
    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    registry.insert(baseEntry({ sha: 'A', prefixByteLength: 10, tokens: 10, upstreamSlotFile: slotFile }));
    registry.insert(baseEntry({ sha: 'B', prefixByteLength: 20, tokens: 20, upstreamSlotFile: slotFile }));
    registry.insert(baseEntry({ sha: 'C', prefixByteLength: 30, tokens: 30, upstreamSlotFile: slotFile }));

    const result = longestPrefixLookup(registry, {
      candidatePrefixes: [
        { sha: 'A', prefixByteLength: 10, tokenCount: 10 },
        { sha: 'C', prefixByteLength: 30, tokenCount: 30 },
        { sha: 'B', prefixByteLength: 20, tokenCount: 20 },
      ],
      workload: 'foo',
      quantBits: 4,
      ctxSize: 32768,
      workloadEpoch: 'epoch-1',
    });
    expect(result?.sha).toBe('C');
    storage.close();
  } finally {
    t.cleanup();
  }
});

test('longestPrefixLookup rejects workload mismatch', () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, 'slot.bin');
    writeFileSync(slotFile, 'payload');
    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    registry.insert(baseEntry({ sha: 'same-sha', workload: 'foo', quantBits: 4, upstreamSlotFile: slotFile }));
    const result = longestPrefixLookup(registry, {
      candidatePrefixes: [{ sha: 'same-sha', prefixByteLength: 16, tokenCount: 128 }],
      workload: 'bar',
      quantBits: 4,
      ctxSize: 32768,
      workloadEpoch: 'epoch-1',
    });
    expect(result).toBeNull();
    storage.close();
  } finally {
    t.cleanup();
  }
});

test('longestPrefixLookup rejects quant_bits mismatch', () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, 'slot.bin');
    writeFileSync(slotFile, 'payload');
    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    registry.insert(baseEntry({ sha: 'same-sha', quantBits: 4, upstreamSlotFile: slotFile }));
    const result = longestPrefixLookup(registry, {
      candidatePrefixes: [{ sha: 'same-sha', prefixByteLength: 16, tokenCount: 128 }],
      workload: 'foo',
      quantBits: 8,
      ctxSize: 32768,
      workloadEpoch: 'epoch-1',
    });
    expect(result).toBeNull();
    storage.close();
  } finally {
    t.cleanup();
  }
});

test('longestPrefixLookup rejects ctx_size mismatch', () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, 'slot.bin');
    writeFileSync(slotFile, 'payload');
    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    registry.insert(baseEntry({ sha: 'same-sha', ctxSize: 32768, upstreamSlotFile: slotFile }));
    const result = longestPrefixLookup(registry, {
      candidatePrefixes: [{ sha: 'same-sha', prefixByteLength: 16, tokenCount: 128 }],
      workload: 'foo',
      quantBits: 4,
      ctxSize: 65536,
      workloadEpoch: 'epoch-1',
    });
    expect(result).toBeNull();
    storage.close();
  } finally {
    t.cleanup();
  }
});

test('longestPrefixLookup rejects prefix_byte_length mismatch', () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, 'slot.bin');
    writeFileSync(slotFile, 'payload');
    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    registry.insert(baseEntry({ sha: 'same-sha', prefixByteLength: 16, upstreamSlotFile: slotFile }));
    const result = longestPrefixLookup(registry, {
      candidatePrefixes: [{ sha: 'same-sha', prefixByteLength: 32, tokenCount: 128 }],
      workload: 'foo',
      quantBits: 4,
      ctxSize: 32768,
      workloadEpoch: 'epoch-1',
    });
    expect(result).toBeNull();
    storage.close();
  } finally {
    t.cleanup();
  }
});

test('longestPrefixLookup rejects tokens mismatch', () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, 'slot.bin');
    writeFileSync(slotFile, 'payload');
    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    registry.insert(baseEntry({ sha: 'same-sha', tokens: 128, upstreamSlotFile: slotFile }));
    const result = longestPrefixLookup(registry, {
      candidatePrefixes: [{ sha: 'same-sha', prefixByteLength: 16, tokenCount: 64 }],
      workload: 'foo',
      quantBits: 4,
      ctxSize: 32768,
      workloadEpoch: 'epoch-1',
    });
    expect(result).toBeNull();
    storage.close();
  } finally {
    t.cleanup();
  }
});

test('longestPrefixLookup rejects workload_epoch mismatch', () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, 'slot.bin');
    writeFileSync(slotFile, 'payload');
    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    registry.insert(baseEntry({ sha: 'same-sha', workloadEpoch: 'epoch-1', upstreamSlotFile: slotFile }));
    const result = longestPrefixLookup(registry, {
      candidatePrefixes: [{ sha: 'same-sha', prefixByteLength: 16, tokenCount: 128 }],
      workload: 'foo',
      quantBits: 4,
      ctxSize: 32768,
      workloadEpoch: 'epoch-2',
    });
    expect(result).toBeNull();
    storage.close();
  } finally {
    t.cleanup();
  }
});

test('longestPrefixLookup rejects quarantined entries', () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, 'slot.bin');
    writeFileSync(slotFile, 'payload');
    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    registry.insert(baseEntry({ sha: 'same-sha', quarantined: 1, upstreamSlotFile: slotFile }));
    const result = longestPrefixLookup(registry, {
      candidatePrefixes: [{ sha: 'same-sha', prefixByteLength: 16, tokenCount: 128 }],
      workload: 'foo',
      quantBits: 4,
      ctxSize: 32768,
      workloadEpoch: 'epoch-1',
    });
    expect(result).toBeNull();
    storage.close();
  } finally {
    t.cleanup();
  }
});

test('longestPrefixLookup returns null when no candidates match', () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, 'slot.bin');
    writeFileSync(slotFile, 'payload');
    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    registry.insert(baseEntry({ sha: 'exists', upstreamSlotFile: slotFile }));
    const result = longestPrefixLookup(registry, {
      candidatePrefixes: [{ sha: 'missing', prefixByteLength: 16, tokenCount: 128 }],
      workload: 'foo',
      quantBits: 4,
      ctxSize: 32768,
      workloadEpoch: 'epoch-1',
    });
    expect(result).toBeNull();
    storage.close();
  } finally {
    t.cleanup();
  }
});

test('safeWrite reports ENOSPC, increments counter, and keeps reads available', () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, 'slot.bin');
    writeFileSync(slotFile, 'payload');
    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    registry.insert(baseEntry({ sha: 'keep', upstreamSlotFile: slotFile }));

    const realDb = storage.db;
    const realQuery = realDb.query.bind(realDb);
    (storage as unknown as { db: { query: (sql: string) => any } }).db = {
      query(sql: string): any {
        if (sql.includes('INSERT INTO kv_entries')) {
          const stmt = realQuery(sql);
          return {
            ...stmt,
            run(): never {
              const error = new Error('disk full') as Error & { code?: string };
              error.code = 'ENOSPC';
              throw error;
            },
          };
        }
        return realQuery(sql);
      },
    };

    const writeResult = storage.safeWrite(() => {
      registry.insert(baseEntry({ sha: 'explode', upstreamSlotFile: slotFile }));
    });
    expect(writeResult.ok).toBe(false);
    if (!writeResult.ok) expect(writeResult.reason).toBe('enospc');
    expect(storage.registry_write_fail_total).toBe(1);
    expect(registry.findBySha('keep')?.sha).toBe('keep');
    storage.close();
  } finally {
    t.cleanup();
  }
});
