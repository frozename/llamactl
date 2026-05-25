import { describe, expect, test } from 'bun:test';
import type { FleetSnapshotEntry } from '../src/types.js';
import { FleetAggregator } from '../src/aggregator.js';

const snapshot = (node: string, ts: string): FleetSnapshotEntry => ({
  kind: 'fleet-snapshot',
  ts,
  node,
  node_mem: {
    free_mb: 2048,
    active_mb: 0,
    inactive_mb: 0,
    wired_mb: 0,
    compressor_mb: 128,
    swap_in: 0,
    swap_out: 0,
  },
  workloads: [],
});

describe('FleetAggregator', () => {
  test('pollNow() populates cache for all peers via injected fetchFn', async () => {
    const peers = [{ id: 'a', endpoint: 'https://a' }, { id: 'b', endpoint: 'https://b' }];
    const aggr = new FleetAggregator({
      peers,
      fetchSnapshot: async (peer) => snapshot(peer.id, `2026-05-25T17:00:0${peer.id === 'a' ? '1' : '2'}Z`),
      now: () => 1_000,
    });

    await aggr.pollNow();

    const all = aggr.getAll();
    expect(all).toHaveLength(2);
    expect(all.find((x) => x.nodeId === 'a')?.snapshot?.node).toBe('a');
    expect(all.find((x) => x.nodeId === 'b')?.snapshot?.node).toBe('b');
  });

  test('on fetch error, prior snapshot is retained and marked stale', async () => {
    const peers = [{ id: 'a', endpoint: 'https://a' }];
    let fail = false;
    const aggr = new FleetAggregator({
      peers,
      fetchSnapshot: async (peer) => {
        if (fail) throw new Error('boom');
        return snapshot(peer.id, '2026-05-25T17:00:01Z');
      },
      now: (() => {
        let t = 0;
        return () => {
          t += 31_000;
          return t;
        };
      })(),
    });

    await aggr.pollNow();
    fail = true;
    await aggr.pollNow();

    const row = aggr.getAll()[0]!;
    expect(row.snapshot?.node).toBe('a');
    expect(row.stale).toBe(true);
  });

  test('getSnapshot(nodeId) returns null when fetchedAt > 90s ago (3 missed ticks)', async () => {
    const peers = [{ id: 'a', endpoint: 'https://a' }];
    let nowMs = 0;
    const aggr = new FleetAggregator({
      peers,
      fetchSnapshot: async (peer) => snapshot(peer.id, '2026-05-25T17:00:01Z'),
      now: () => nowMs,
    });

    nowMs = 1_000;
    await aggr.pollNow();
    const first = aggr.getSnapshot('a');
    expect(first).not.toBeNull();
    if (!first?.snapshot) throw new Error('expected snapshot');
    expect(first.snapshot.node).toBe('a');

    nowMs = 92_001;
    expect(aggr.getSnapshot('a')).toBeNull();
  });

  test('getAll() returns all known nodes including stale ones', async () => {
    const peers = [{ id: 'a', endpoint: 'https://a' }, { id: 'b', endpoint: 'https://b' }];
    const aggr = new FleetAggregator({
      peers,
      fetchSnapshot: async (peer) => {
        if (peer.id === 'b') throw new Error('down');
        return snapshot(peer.id, '2026-05-25T17:00:01Z');
      },
      now: () => 50_000,
    });

    await aggr.pollNow();

    const all = aggr.getAll();
    expect(all).toHaveLength(2);
    expect(all.some((x) => x.nodeId === 'b' && x.stale)).toBe(true);
  });

  test('pollNow() resolves after fetching ALL peers, not just the first', async () => {
    const peers = [{ id: 'a', endpoint: 'https://a' }, { id: 'b', endpoint: 'https://b' }];
    const order: string[] = [];
    const aggr = new FleetAggregator({
      peers,
      fetchSnapshot: async (peer) => {
        await new Promise((r) => setTimeout(r, peer.id === 'a' ? 20 : 40));
        order.push(peer.id);
        return snapshot(peer.id, '2026-05-25T17:00:01Z');
      },
      now: () => 100_000,
    });

    await aggr.pollNow();

    expect(order.sort()).toEqual(['a', 'b']);
    expect(aggr.getAll().filter((x) => x.snapshot !== null)).toHaveLength(2);
  });

  test('poll count does not exceed 1 per peer per 30s', async () => {
    const peers = [{ id: 'a', endpoint: 'https://a' }, { id: 'b', endpoint: 'https://b' }];
    const calls = new Map<string, number>();
    let nowMs = 0;
    const aggr = new FleetAggregator({
      peers,
      fetchSnapshot: async (peer) => {
        calls.set(peer.id, (calls.get(peer.id) ?? 0) + 1);
        return snapshot(peer.id, '2026-05-25T17:00:01Z');
      },
      now: () => nowMs,
    });

    nowMs = 1_000;
    await aggr.pollNow();
    nowMs = 10_000;
    await aggr.pollNow();

    expect(calls.get('a')).toBe(1);
    expect(calls.get('b')).toBe(1);

    nowMs = 31_100;
    await aggr.pollNow();
    expect(calls.get('a')).toBe(2);
    expect(calls.get('b')).toBe(2);
  });
});
