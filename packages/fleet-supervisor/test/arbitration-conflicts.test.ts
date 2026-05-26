import { beforeEach, describe, expect, it } from 'bun:test';
import { DEFAULT_PRESSURE_THRESHOLDS } from '../src/loop.js';
import { MigrationController, type NodeSnapshot } from '../src/migration-controller.js';
import type { FleetJournalEntry, MoveProposal } from '../src/types.js';

describe('Arbitration conflicts', () => {
  let nowMs = 1_700_000_000_000;
  let snapshots: Record<string, NodeSnapshot>;
  let journal: FleetJournalEntry[];
  let applyCalls = 0;
  let controller: MigrationController;

  beforeEach(() => {
    nowMs = 1_700_000_000_000;
    snapshots = {};
    journal = [];
    applyCalls = 0;

    controller = new MigrationController({
      peers: ['m2mini'],
      fetchSnapshot: async (node) => snapshots[node] ?? {
        node,
        pressureState: 'NORMAL',
        node_mem: { free_mb: 4096 },
        workloads: [{ name: 'model-a', reachable: true }],
      },
      applyWorkload: async () => {
        applyCalls += 1;
      },
      deleteWorkload: async () => undefined,
      leaseholder: 'm4pro',
      getNowMs: () => nowMs,
      healthTimeoutMs: 5,
      pollIntervalMs: 1,
      sleep: async () => {
        nowMs += 1;
      },
    });
  });

  function proposal(overrides: Partial<MoveProposal> = {}): MoveProposal {
    return {
      workload: 'model-a',
      fromNode: 'm4pro',
      toNode: 'm2mini',
      proposalId: 'move-1',
      evictProposalId: 'evict-1',
      expiresAt: new Date(nowMs + 30_000).toISOString(),
      ...overrides,
    };
  }

  it('C1: move supersedes evict only with fresh headroom proof (re-checked at execution)', async () => {
    snapshots.m2mini = { node: 'm2mini', pressureState: 'HIGH', node_mem: { free_mb: 100 }, workloads: [] };

    const result = await controller.executeMove(proposal(), (entry) => journal.push(entry));

    expect(result).toBe('destination_lost');
    expect(applyCalls).toBe(0);
    expect(journal.some((entry) => entry.kind === 'fleet-execution' && entry.proposalId === 'evict-1' && entry.status === 'skipped')).toBe(false);
  });

  it('C2: stale move proposal (ts + 30s < now) is not executed', async () => {
    const stale = proposal({ expiresAt: new Date(nowMs - 1_000).toISOString() });

    const result = await controller.executeMove(stale, (entry) => journal.push(entry));

    expect(result).toBe('timed_out');
    expect(applyCalls).toBe(0);
  });

  it('C3: fleet-placement journal entries do not affect supervisor consecutiveTicks', () => {
    controller.onJournalEntry({
      kind: 'fleet-placement',
      ts: new Date(nowMs).toISOString(),
      node: 'm4pro',
      decision: {
        workload: 'model-a',
        requestedNode: 'auto',
        chosenNode: 'm2mini',
        expectedMemoryMb: 1024,
        headroomMinMb: 512,
        modelFilePenaltyMb: 2048,
        scores: [],
      },
    });

    expect(DEFAULT_PRESSURE_THRESHOLDS.consecutiveTicks).toBe(3);
    expect(DEFAULT_PRESSURE_THRESHOLDS.clearTicks).toBe(5);
  });

  it('C4: HIGH-pressure destination refused even if it was NORMAL at proposal time', async () => {
    snapshots.m2mini = { node: 'm2mini', pressureState: 'HIGH', node_mem: { free_mb: 120 }, workloads: [] };

    const result = await controller.executeMove(proposal(), (entry) => journal.push(entry));

    expect(result).toBe('destination_lost');
    expect(applyCalls).toBe(0);
  });

  it('C5: supervisor restart action never cross-calls schedulePlacement', async () => {
    const restartEntry: FleetJournalEntry = {
      kind: 'fleet-proposal',
      ts: new Date(nowMs).toISOString(),
      node: 'm4pro',
      proposalId: 'restart-1',
      transition: {
        subject: 'model-a',
        subjectKind: 'workload',
        signal: 'degraded',
        from: 'healthy',
        to: 'degraded',
      },
      action: { type: 'restart', workload: 'model-a', reason: 'degraded' },
    };

    const triggered = await controller.onJournalEntry(restartEntry, {
      name: 'model-a',
      node: 'm4pro',
      spec: { placement: 'auto' },
      evictProposalId: 'evict-1',
    }, {
      node: 'm4pro',
      schedulerLeaseHolder: 'm4pro',
      pressureState: 'HIGH',
      node_mem: { free_mb: 100 },
      workloads: [],
    });

    expect(triggered).toBeNull();
    expect(applyCalls).toBe(0);
  });
});
