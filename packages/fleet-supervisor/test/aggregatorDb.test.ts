import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetSnapshotEntry } from '../src/types.js';
import { getHistoricalForNode, getLatestPerNode, openAggregatorDb, writeSnapshot } from '../src/aggregator-db.js';

const snapshot = (node: string, ts: string, freeMb: number): FleetSnapshotEntry => ({
  kind: 'fleet-snapshot',
  ts,
  node,
  node_mem: {
    free_mb: freeMb,
    active_mb: 0,
    inactive_mb: 0,
    wired_mb: 0,
    compressor_mb: 100,
    swap_in: 0,
    swap_out: 0,
  },
  workloads: [],
});

describe('aggregator db', () => {
  test('writeSnapshot then getLatestPerNode returns the inserted row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aggr-db-test-'));
    const dbPath = join(dir, 'cluster.db');
    try {
      const db = openAggregatorDb(dbPath);
      writeSnapshot(db, 'mac-mini', snapshot('mac-mini', '2026-05-25T17:00:00Z', 2048));
      const rows = getLatestPerNode(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.node).toBe('mac-mini');
      expect(rows[0]?.snapshot.node_mem.free_mb).toBe(2048);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('multiple upserts for same node: getLatestPerNode returns row with latest ts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aggr-db-test-'));
    const dbPath = join(dir, 'cluster.db');
    try {
      const db = openAggregatorDb(dbPath);
      writeSnapshot(db, 'mac-mini', snapshot('mac-mini', '2026-05-25T17:00:00Z', 1024));
      writeSnapshot(db, 'mac-mini', snapshot('mac-mini', '2026-05-25T17:02:00Z', 4096));
      const rows = getLatestPerNode(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.ts).toBe('2026-05-25T17:02:00Z');
      expect(rows[0]?.snapshot.node_mem.free_mb).toBe(4096);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('getHistoricalForNode filters by sinceTs, honors limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aggr-db-test-'));
    const dbPath = join(dir, 'cluster.db');
    try {
      const db = openAggregatorDb(dbPath);
      writeSnapshot(db, 'mac-mini', snapshot('mac-mini', '2026-05-25T17:00:00Z', 1000));
      writeSnapshot(db, 'mac-mini', snapshot('mac-mini', '2026-05-25T17:01:00Z', 2000));
      writeSnapshot(db, 'mac-mini', snapshot('mac-mini', '2026-05-25T17:02:00Z', 3000));
      const rows = getHistoricalForNode(db, 'mac-mini', {
        sinceTs: '2026-05-25T17:00:30Z',
        limit: 1,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.ts).toBe('2026-05-25T17:02:00Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('db dir is created on first open (mkdirSync)', () => {
    const root = mkdtempSync(join(tmpdir(), 'aggr-db-test-'));
    const nested = join(root, 'a', 'b', 'c', 'cluster.db');
    try {
      expect(existsSync(join(root, 'a', 'b', 'c'))).toBe(false);
      const db = openAggregatorDb(nested);
      db.close();
      expect(existsSync(join(root, 'a', 'b', 'c'))).toBe(true);
      expect(existsSync(nested)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
