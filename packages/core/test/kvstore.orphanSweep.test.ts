import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KvRegistry, openKvStorage, sweepOrphanSlotFiles, type KvEntry } from '../src/kvstore/index.js';

function makeTempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'llamactl-kvstore-orphans-'));
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
    state: 'idle',
    firstResponseToken: null,
    ...overrides,
  };
}

test('old orphan slot file is deleted', () => {
  const t = makeTempRoot();
  try {
    const slotDir = join(t.root, 'slots');
    mkdirSync(slotDir, { recursive: true });
    const orphanPath = join(slotDir, 'orphan-sha.kvslot');
    writeFileSync(orphanPath, 'old-orphan');
    const now = Date.now();
    utimesSync(orphanPath, new Date(now - 20_000), new Date(now - 20_000));

    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    const result = sweepOrphanSlotFiles({ slotDir, registry, ttlMs: 10_000, now });
    expect(result).toEqual({ orphansFound: 1, orphansDeleted: 1 });
    expect(existsSync(orphanPath)).toBe(false);
    storage.close();
  } finally {
    t.cleanup();
  }
});

test('slot file with registry entry is preserved', () => {
  const t = makeTempRoot();
  try {
    const slotDir = join(t.root, 'slots');
    mkdirSync(slotDir, { recursive: true });
    const slotPath = join(slotDir, 'keep-sha.kvslot');
    writeFileSync(slotPath, 'in-registry');
    const now = Date.now();
    utimesSync(slotPath, new Date(now - 20_000), new Date(now - 20_000));

    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    registry.insert(baseEntry({ sha: 'keep-sha', upstreamSlotFile: slotPath }));

    const result = sweepOrphanSlotFiles({ slotDir, registry, ttlMs: 10_000, now });
    expect(result).toEqual({ orphansFound: 0, orphansDeleted: 0 });
    expect(existsSync(slotPath)).toBe(true);
    storage.close();
  } finally {
    t.cleanup();
  }
});

test('recent orphan slot file is not deleted', () => {
  const t = makeTempRoot();
  try {
    const slotDir = join(t.root, 'slots');
    mkdirSync(slotDir, { recursive: true });
    const orphanPath = join(slotDir, 'recent-orphan.kvslot');
    writeFileSync(orphanPath, 'recent');
    const now = Date.now();
    utimesSync(orphanPath, new Date(now - 1_000), new Date(now - 1_000));

    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    const result = sweepOrphanSlotFiles({ slotDir, registry, ttlMs: 10_000, now });
    expect(result).toEqual({ orphansFound: 1, orphansDeleted: 0 });
    expect(existsSync(orphanPath)).toBe(true);
    storage.close();
  } finally {
    t.cleanup();
  }
});
