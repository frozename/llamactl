import { describe, it, expect } from 'bun:test';
import { startSupervisorLoop } from '../src/loop.js';
import type { FleetJournalEntry, NodeMemSnapshot, WorkloadSnapshot } from '../src/types.js';
import type { WorkloadTarget } from '../src/workload-probe.js';

const FAKE_NODE_MEM: NodeMemSnapshot = {
  free_mb: 1031, active_mb: 912, inactive_mb: 839,
  wired_mb: 320, compressor_mb: 100, swap_in: 0, swap_out: 0,
};

const TARGET: WorkloadTarget = {
  name: 'qwen-host',
  endpoint: 'http://127.0.0.1:8090',
  kind: 'ModelHost',
};

describe('startSupervisorLoop', () => {
  it('one tick emits fleet-snapshot + fleet-heartbeat to writeJournal', async () => {
    const entries: FleetJournalEntry[] = [];
    const handle = startSupervisorLoop({
      node: 'local',
      once: true,
      workloads: [TARGET],
      probeNodeMem: async () => FAKE_NODE_MEM,
      probeWorkload: async (t) => makeReachable(t),
      writeJournal: (entry) => entries.push(entry),
    });
    await handle.done;
    const kinds = entries.map((e) => e.kind);
    expect(kinds).toContain('fleet-snapshot');
    expect(kinds).toContain('fleet-heartbeat');
  });

  it('snapshot carries node_mem + workload payload', async () => {
    const entries: FleetJournalEntry[] = [];
    const handle = startSupervisorLoop({
      node: 'mac-mini',
      once: true,
      workloads: [TARGET],
      probeNodeMem: async () => FAKE_NODE_MEM,
      probeWorkload: async (t) => makeReachable(t),
      writeJournal: (entry) => entries.push(entry),
    });
    await handle.done;
    const snapshot = entries.find((e) => e.kind === 'fleet-snapshot');
    expect(snapshot).toBeDefined();
    if (snapshot && snapshot.kind === 'fleet-snapshot') {
      expect(snapshot.node).toBe('mac-mini');
      expect(snapshot.node_mem.free_mb).toBe(1031);
      expect(snapshot.workloads).toHaveLength(1);
      expect(snapshot.workloads[0]!.name).toBe('qwen-host');
      expect(snapshot.workloads[0]!.reachable).toBe(true);
    }
  });

  it('probes all workloads in parallel', async () => {
    const calls: string[] = [];
    const handle = startSupervisorLoop({
      node: 'local',
      once: true,
      workloads: [
        { name: 'a', endpoint: 'http://a', kind: 'ModelHost' },
        { name: 'b', endpoint: 'http://b', kind: 'ModelHost' },
        { name: 'c', endpoint: 'http://c', kind: 'ModelHost' },
      ],
      probeNodeMem: async () => FAKE_NODE_MEM,
      probeWorkload: async (t) => { calls.push(t.name); return makeReachable(t); },
      writeJournal: () => {},
    });
    await handle.done;
    expect(calls.sort()).toEqual(['a', 'b', 'c']);
  });

  it('tick survives a probe rejection — affected workload marked unreachable', async () => {
    const entries: FleetJournalEntry[] = [];
    const handle = startSupervisorLoop({
      node: 'local',
      once: true,
      workloads: [
        { name: 'good', endpoint: 'http://good', kind: 'ModelHost' },
        { name: 'bad', endpoint: 'http://bad', kind: 'ModelHost' },
      ],
      probeNodeMem: async () => FAKE_NODE_MEM,
      probeWorkload: async (t) => {
        if (t.name === 'bad') throw new Error('probe network failure');
        return makeReachable(t);
      },
      writeJournal: (entry) => entries.push(entry),
    });
    await handle.done;
    const snapshot = entries.find((e) => e.kind === 'fleet-snapshot');
    if (snapshot && snapshot.kind === 'fleet-snapshot') {
      const good = snapshot.workloads.find((w) => w.name === 'good');
      const bad = snapshot.workloads.find((w) => w.name === 'bad');
      expect(good?.reachable).toBe(true);
      expect(bad?.reachable).toBe(false);
      expect(bad?.consecutiveErrors).toBe(1);
    }
  });

  it('onTick callback receives the snapshot', async () => {
    const observed: Array<{ kind: string; node: string }> = [];
    const handle = startSupervisorLoop({
      node: 'local',
      once: true,
      workloads: [TARGET],
      probeNodeMem: async () => FAKE_NODE_MEM,
      probeWorkload: async (t) => makeReachable(t),
      writeJournal: () => {},
      onTick: (snapshot) => { observed.push({ kind: snapshot.kind, node: snapshot.node }); },
    });
    await handle.done;
    expect(observed).toEqual([{ kind: 'fleet-snapshot', node: 'local' }]);
  });
});

function makeReachable(target: WorkloadTarget): WorkloadSnapshot {
  return {
    name: target.name,
    kind: target.kind,
    endpoint: target.endpoint,
    rss_mb: null,
    request_rate_5m: null,
    error_rate_5m: 0,
    p50_ms: 12,
    p95_ms: 12,
    models: ['Qwen3.6-35B-A3B-4bit'],
    reachable: true,
    consecutiveErrors: 0,
  };
}
