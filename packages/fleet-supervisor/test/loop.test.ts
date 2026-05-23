import { describe, it, expect } from 'bun:test';
import { startSupervisorLoop } from '../src/loop.js';
import type { FleetJournalEntry, FleetTransitionEntry, NodeMemSnapshot, WorkloadSnapshot } from '../src/types.js';
import type { WorkloadTarget } from '../src/workload-probe.js';

const FAKE_NODE_MEM: NodeMemSnapshot = {
  free_mb: 1031, active_mb: 912, inactive_mb: 839,
  wired_mb: 320, compressor_mb: 100, swap_in: 0, swap_out: 0,
};

const TARGET: WorkloadTarget = {
  name: 'qwen-host',
  endpoint: 'http://127.0.0.1:8090',
  kind: 'ModelHost', priority: 50,
};

function makeReachableLocal(t: WorkloadTarget): WorkloadSnapshot { return { name: t.name, kind: t.kind, endpoint: t.endpoint, priority: t.priority ?? 50, rss_mb: null, request_rate_5m: null, error_rate_5m: 0, p50_ms: 10, p95_ms: 10, models: [], reachable: true, consecutiveErrors: 0 }; }

describe('startSupervisorLoop', () => {

  it('emits fleet-pressure-status while HIGH at the configured cadence', async () => {
    const entries: any[] = [];
    let tickCount = 0;
    const handle = startSupervisorLoop({
      node: 'local',
      intervalMs: 1,
      workloads: [TARGET],
      probeNodeMem: async () => {
        if (tickCount++ >= 7) handle.stop();
        return { ...FAKE_NODE_MEM, free_mb: 100, compressor_mb: 4000 };
      },
      probeWorkload: async (t) => makeReachableLocal(t),
      writeJournal: (entry) => entries.push(entry),
      pressureStatusEveryTicks: 2,
    });
    await handle.done;
    
    const statuses = entries.filter(e => e.kind === 'fleet-pressure-status');
    expect(statuses.length).toBeGreaterThanOrEqual(2);
    expect(statuses[0].state).toBe('HIGH');
    expect(statuses[0].free_mb).toBe(100);
    expect(statuses[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(statuses[0].consecutiveClearTicks).toBe(0);
  });
  
  it('resets ticksInHigh on HIGH->NORMAL clear', async () => {
    const entries: any[] = [];
    let tickCount = 0;
    const handle = startSupervisorLoop({
      node: 'local',
      intervalMs: 1,
      workloads: [TARGET],
      probeNodeMem: async () => {
        tickCount++;
        if (tickCount >= 11) handle.stop();
        if (tickCount <= 3 || tickCount >= 9) return { ...FAKE_NODE_MEM, free_mb: 100, compressor_mb: 4000 };
        return FAKE_NODE_MEM;
      },
      probeWorkload: async (t) => makeReachableLocal(t),
      writeJournal: (entry) => entries.push(entry),
      pressureStatusEveryTicks: 2,
    });
    await handle.done;
    
    const transitions = entries.filter(e => e.kind === 'fleet-transition' && e.subjectKind === 'node');
    expect(transitions).toHaveLength(3); // NORMAL->HIGH, HIGH->NORMAL, NORMAL->HIGH
  });

  const isTransition = (entry: FleetJournalEntry): entry is FleetTransitionEntry =>
    entry.kind === 'fleet-transition';
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

  it('emits fleet-transition + fleet-proposal on NORMAL→HIGH pressure flip', async () => {
    const entries: FleetJournalEntry[] = [];
    const HIGH_MEM: NodeMemSnapshot = {
      free_mb: 30, compressor_mb: 4000,
      active_mb: 0, inactive_mb: 0, wired_mb: 0, swap_in: 0, swap_out: 0,
    };
    let tickIdx = 0;
    const handle = startSupervisorLoop({
      node: 'local',
      once: false,
      intervalMs: 1,
      workloads: [TARGET],
      probeNodeMem: async () => {
        if (tickIdx++ >= 3) handle.stop();
        return HIGH_MEM;
      },
      probeWorkload: async (t) => ({ ...makeReachable(t), rss_mb: 12000 }),
      writeJournal: (entry) => entries.push(entry),
      pressureThresholds: {
        headroomMinMb: 512,
        compressorWarnMb: 2048,
        consecutiveTicks: 3,
        clearTicks: 5,
      },
    });
    await handle.done;
    const transitions = entries.filter(isTransition);
    const proposals = entries.filter((e) => e.kind === 'fleet-proposal');
    expect(transitions.length).toBe(1);
    expect(proposals.length).toBe(1);
    if (transitions[0]!.kind === 'fleet-transition') {
      expect(transitions[0]!.from).toBe('NORMAL');
      expect(transitions[0]!.to).toBe('HIGH');
    }
    if (proposals[0]!.kind === 'fleet-proposal' && proposals[0]!.action.type === 'evict') {
      expect(proposals[0]!.action.workload).toBe('qwen-host');
    }
  });

  it('applies pressure hysteresis before clearing HIGH and reopening', async () => {
    const entries: FleetJournalEntry[] = [];
    const HIGH_MEM: NodeMemSnapshot = {
      free_mb: 30, compressor_mb: 4000,
      active_mb: 0, inactive_mb: 0, wired_mb: 0, swap_in: 0, swap_out: 0,
    };
    const NORMAL_MEM: NodeMemSnapshot = {
      free_mb: 4096, compressor_mb: 100,
      active_mb: 0, inactive_mb: 0, wired_mb: 0, swap_in: 0, swap_out: 0,
    };
    const sequence: NodeMemSnapshot[] = [
      HIGH_MEM, HIGH_MEM, HIGH_MEM,
      NORMAL_MEM,
      HIGH_MEM, HIGH_MEM, HIGH_MEM,
      NORMAL_MEM, NORMAL_MEM, NORMAL_MEM,
      HIGH_MEM, HIGH_MEM, HIGH_MEM,
    ];
    let tickIdx = 0;
    const handle = startSupervisorLoop({
      node: 'local',
      once: false,
      intervalMs: 1,
      workloads: [TARGET],
      probeNodeMem: async () => {
        const next = sequence[tickIdx] ?? NORMAL_MEM;
        tickIdx++;
        if (tickIdx >= sequence.length) handle.stop();
        return next;
      },
      probeWorkload: async (t) => ({ ...makeReachable(t), rss_mb: 12000 }),
      writeJournal: (entry) => entries.push(entry),
      pressureThresholds: {
        headroomMinMb: 512,
        compressorWarnMb: 2048,
        consecutiveTicks: 3,
        clearTicks: 3,
      },
    });
    await handle.done;

    const pressureTransitions = entries.filter(isTransition).filter((entry) => entry.signal === 'pressure');
    const proposals = entries.filter((entry) => entry.kind === 'fleet-proposal');

    expect(proposals.length).toBe(2);
    expect(pressureTransitions.length).toBe(2);

    expect(pressureTransitions[0]!.from).toBe('NORMAL');
    expect(pressureTransitions[0]!.to).toBe('HIGH');
    expect(pressureTransitions[1]!.from).toBe('NORMAL');
    expect(pressureTransitions[1]!.to).toBe('HIGH');

    const clearTransitions = entries.filter(isTransition).filter((entry) => entry.signal === 'pressure-cleared');
    expect(clearTransitions.length).toBe(1);
    expect(clearTransitions[0]!.from).toBe('HIGH');
    expect(clearTransitions[0]!.to).toBe('NORMAL');

    expect(proposals[0]!.kind).toBe('fleet-proposal');
    expect(proposals[1]!.kind).toBe('fleet-proposal');
  });

  it('applies oscillation hysteresis requiring clearTicks consecutive non-hot ticks', async () => {
    const entries: FleetJournalEntry[] = [];
    const HIGH_MEM: NodeMemSnapshot = {
      free_mb: 30, compressor_mb: 4000,
      active_mb: 0, inactive_mb: 0, wired_mb: 0, swap_in: 0, swap_out: 0,
    };
    const NORMAL_MEM: NodeMemSnapshot = {
      free_mb: 4096, compressor_mb: 100,
      active_mb: 0, inactive_mb: 0, wired_mb: 0, swap_in: 0, swap_out: 0,
    };
    const sequence = [
      HIGH_MEM, HIGH_MEM, HIGH_MEM, HIGH_MEM,
      NORMAL_MEM, HIGH_MEM, NORMAL_MEM, HIGH_MEM,
      NORMAL_MEM, NORMAL_MEM, NORMAL_MEM, NORMAL_MEM, NORMAL_MEM,
    ];
    const transitionsByTick: Array<{ tick: number; transition: string }> = [];
    let tickIdx = 0;
    const handle = startSupervisorLoop({
      node: 'local',
      once: false,
      intervalMs: 1,
      workloads: [TARGET],
      pressureThresholds: {
        headroomMinMb: 512,
        compressorWarnMb: 2048,
        consecutiveTicks: 3,
        clearTicks: 5,
      },
      probeNodeMem: async () => {
        const next = sequence[tickIdx] ?? NORMAL_MEM;
        tickIdx++;
        if (tickIdx >= sequence.length) handle.stop();
        return next;
      },
      probeWorkload: async (t) => ({ ...makeReachable(t), rss_mb: 12000 }),
      writeJournal: (entry) => {
        entries.push(entry);
        if (isTransition(entry)) {
          transitionsByTick.push({ tick: tickIdx, transition: `${entry.signal}:${entry.from}->${entry.to}` });
        }
      },
    });
    await handle.done;

    const pressureTransitions = entries.filter(isTransition).filter((entry) => entry.signal === 'pressure');
    const pressureClearTransitions = entries
      .filter(isTransition)
      .filter((entry) => entry.signal === 'pressure-cleared');
    const pressurePressureTransitions = transitionsByTick.filter(
      ({ transition }) => transition.startsWith('pressure:'),
    );
    const pressureClearTicks = transitionsByTick
      .filter(({ transition }) => transition.startsWith('pressure-cleared:'))
      .map(({ tick }) => tick);

    expect(pressureTransitions.length).toBe(1);
    expect(pressurePressureTransitions.map(({ tick }) => tick)[0]).toBe(3);
    expect(pressureClearTransitions.length).toBe(1);
    expect(pressureClearTicks).toEqual([13]);
    expect(entries.filter((entry) => entry.kind === 'fleet-proposal').length).toBe(1);
  });

  it('emits fleet-transition + fleet-proposal on healthy→degraded workload flip', async () => {
    const entries: FleetJournalEntry[] = [];
    let calls = 0;
    const handle = startSupervisorLoop({
      node: 'mac-mini',
      once: true,
      workloads: [TARGET],
      probeNodeMem: async () => FAKE_NODE_MEM,
      probeWorkload: async (t) => ({
        ...makeReachable(t),
        reachable: false,
        consecutiveErrors: 4,
      }),
      writeJournal: (entry) => entries.push(entry),
      onTick: () => { calls++; },
    });
    await handle.done;
    expect(calls).toBe(1);
    const transitions = entries.filter((e) => e.kind === 'fleet-transition');
    const proposals = entries.filter((e) => e.kind === 'fleet-proposal');
    expect(transitions.length).toBe(1);
    expect(proposals.length).toBe(1);
    if (transitions[0]!.kind === 'fleet-transition') {
      expect(transitions[0]!.signal).toBe('degraded');
      expect(transitions[0]!.from).toBe('healthy');
      expect(transitions[0]!.to).toBe('degraded');
      expect(transitions[0]!.subject).toBe('qwen-host');
    }
    if (proposals[0]!.kind === 'fleet-proposal' && proposals[0]!.action.type === 'restart') {
      expect(proposals[0]!.action.workload).toBe('qwen-host');
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

  it('emits a fleet-pressure-status entry on the same tick as the NORMALéHIGH transition', async () => {
    const entries: any[] = [];
    let tickCount = 0;
    const handle = startSupervisorLoop({
      node: 'local',
      intervalMs: 1,
      workloads: [TARGET],
      probeNodeMem: async () => {
        if (tickCount++ >= 3) handle.stop();
        return { ...FAKE_NODE_MEM, free_mb: 100, compressor_mb: 4000 };
      },
      probeWorkload: async (t) => makeReachable(t),
      writeJournal: (entry) => entries.push(entry),
      pressureThresholds: {
        headroomMinMb: 512,
        compressorWarnMb: 2048,
        consecutiveTicks: 3,
        clearTicks: 5,
      },
      pressureStatusEveryTicks: 0, // disable periodic to ensure we only get the inline one
    });
    await handle.done;
    
    const transitions = entries.filter(e => e.kind === 'fleet-transition' && e.to === 'HIGH');
    const statuses = entries.filter(e => e.kind === 'fleet-pressure-status');
    expect(transitions.length).toBe(1);
    expect(statuses.length).toBe(1);
    expect(statuses[0].ts).toBe(transitions[0].ts);
    expect(statuses[0].enteredAt).toBe(transitions[0].ts);
    expect(statuses[0].durationMs).toBe(0);
  });
 });
  

function makeReachable(target: WorkloadTarget): WorkloadSnapshot {
  return {
    name: target.name,
    kind: target.kind,
    endpoint: target.endpoint,
    priority: target.priority ?? 50,
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
