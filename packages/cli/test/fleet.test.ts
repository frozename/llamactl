import { describe, expect, test } from 'bun:test';
import { runFleet } from '../src/commands/fleet.js';
import type { FleetSnapshotEntry } from '../../fleet-supervisor/src/types.js';
import type { ClusterConfig } from '../../remote/src/config/cluster.js';

const snap = (node: string, free: number, comp: number, ts = '2026-05-25T17:00:00Z'): FleetSnapshotEntry => ({
  kind: 'fleet-snapshot',
  ts,
  node,
  node_mem: {
    free_mb: free,
    active_mb: 0,
    inactive_mb: 0,
    wired_mb: 0,
    compressor_mb: comp,
    swap_in: 0,
    swap_out: 0,
  },
  workloads: [{
    name: 'w1',
    kind: 'ModelHost',
    endpoint: 'http://127.0.0.1:8000',
    priority: 50,
    rss_mb: null,
    request_rate_5m: null,
    error_rate_5m: 0,
    p50_ms: 10,
    p95_ms: 20,
    models: [],
    reachable: true,
    consecutiveErrors: 0,
  }],
});

function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  let out = '';
  const orig = console.log;
  console.log = ((...args: unknown[]) => {
    out += `${args.map((x) => String(x)).join(' ')}\n`;
  }) as typeof console.log;
  return fn().then((result) => ({ result, out })).finally(() => {
    console.log = orig;
  });
}

function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  let out = '';
  const orig = console.error;
  console.error = ((...args: unknown[]) => {
    out += `${args.map((x) => String(x)).join(' ')}\n`;
  }) as typeof console.error;
  return fn().then((result) => ({ result, out })).finally(() => {
    console.error = orig;
  });
}

describe('fleet command', () => {
  test('fleet snapshot prints local node latest snapshot JSON', async () => {
    const { result, out } = await captureStdout(() => runFleet(['snapshot'], {
      readLocalSnapshot: async () => snap('local', 2048, 100),
      readClusterConfig: () => ({ peers: [] }),
      fetchPeerSnapshot: async () => null,
    }));

    expect(result).toBe(0);
    const parsed = JSON.parse(out.trim()) as { kind: string; node: string };
    expect(parsed.kind).toBe('fleet-snapshot');
    expect(parsed.node).toBe('local');
  });

  test('fleet snapshot --all prints table with expected columns', async () => {
    const cfg: ClusterConfig = {
      peers: [{ id: 'mac-mini', endpoint: 'https://mac-mini' }],
    };
    const { result, out } = await captureStdout(() => runFleet(['snapshot', '--all'], {
      readLocalSnapshot: async () => snap('local', 2048, 100),
      readClusterConfig: () => cfg,
      fetchPeerSnapshot: async () => snap('mac-mini', 3000, 90),
    }));

    expect(result).toBe(0);
    expect(out).toContain('node | free_mb | compressor_mb | workloads | pressure');
    expect(out).toContain('local | 2048 | 100 | 1 | NORMAL');
    expect(out).toContain('mac-mini | 3000 | 90 | 1 | NORMAL');
  });

  test('fleet status prints one summary line per node', async () => {
    const cfg: ClusterConfig = {
      peers: [{ id: 'mac-mini', endpoint: 'https://mac-mini' }],
    };
    const { result, out } = await captureStdout(() => runFleet(['status'], {
      readLocalSnapshot: async () => snap('local', 200, 3000),
      readClusterConfig: () => cfg,
      fetchPeerSnapshot: async () => snap('mac-mini', 3000, 90),
    }));

    expect(result).toBe(0);
    expect(out).toContain('local:');
    expect(out).toContain('mac-mini:');
    const lines = out.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
  });

  test('fleet snapshot exits non-zero when local snapshot is missing', async () => {
    const { result, out } = await captureStderr(() => runFleet(['snapshot'], {
      readLocalSnapshot: async () => null,
      readClusterConfig: () => ({ peers: [] }),
      fetchPeerSnapshot: async () => null,
    }));
    expect(result).toBe(1);
    expect(out).toContain('no local fleet-snapshot entry found');
  });
});
