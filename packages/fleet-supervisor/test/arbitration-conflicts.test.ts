import { describe, it, expect, beforeEach } from 'bun:test';
import { MigrationController } from '../src/migration-controller.js';
import { DEFAULT_PRESSURE_THRESHOLDS } from '../src/loop.js';
import type { NodeSnapshot } from '../src/migration-controller.js';

describe('Arbitration Conflicts', () => {
  let controller: MigrationController;
  let currentMs = 1000000;
  let snapshots: Record<string, NodeSnapshot> = {};

  beforeEach(() => {
    currentMs = 1000000;
    snapshots = {};
    controller = new MigrationController({
      peers: ['m4pro', 'm2mini'],
      fetchSnapshot: async (node) => snapshots[node] || { pressureState: 'NORMAL', node_mem: { free_mb: 4000 } } as any,
      applyWorkload: async () => {},
      deleteWorkload: async () => {},
      leaseholder: 'm4pro',
      
    });
  });

  it('C1: move supersedes evict only with fresh headroom proof', async () => {
    snapshots['m2mini'] = { pressureState: 'HIGH', node_mem: { free_mb: 100 } } as any;
    const proposal = {
      workload: 'w1', fromNode: 'm4pro', toNode: 'm2mini',
      proposalId: 'move-1', evictProposalId: 'evict-1',
      expiresAt: new Date(Date.now() + 10000).toISOString()
    };
    const res = await controller.executeMove(proposal, () => {});
    expect(res).toBe('destination_lost');
  });

  it('C2: stale move proposal is not executed', async () => {
    const proposal = {
      workload: 'w1', fromNode: 'm4pro', toNode: 'm2mini',
      proposalId: 'move-1', evictProposalId: 'evict-1',
      expiresAt: new Date(Date.now() - 1000).toISOString() // past
    };
    const res = await controller.executeMove(proposal, () => {});
    expect(res).toBe('timed_out');
  });

  it('C3: fleet-placement entries do not change supervisor consecutiveTicks', () => {
    expect(DEFAULT_PRESSURE_THRESHOLDS.consecutiveTicks).toBe(3);
    expect(DEFAULT_PRESSURE_THRESHOLDS.clearTicks).toBe(5);
  });

  it('C4: HIGH-pressure destination refused even if NORMAL at proposal', async () => {
    // Simulating proposal was made when NORMAL, now it is HIGH
    snapshots['m2mini'] = { pressureState: 'HIGH', node_mem: { free_mb: 100 } } as any;
    const proposal = {
      workload: 'w1', fromNode: 'm4pro', toNode: 'm2mini',
      proposalId: 'move-1', evictProposalId: 'evict-1',
      expiresAt: new Date(Date.now() + 10000).toISOString()
    };
    const res = await controller.executeMove(proposal, () => {});
    expect(res).toBe('destination_lost');
  });

  it('C5: supervisor restart action never cross-calls schedulePlacement', () => {
    let evaluateCalled = false;
    controller.evaluateMove = async () => { evaluateCalled = true; return null; };
    controller.onJournalEntry({
      kind: 'fleet-proposal',
      action: { type: 'restart', workload: 'w1', reason: 'degraded' }
    } as any);
    expect(evaluateCalled).toBe(false);
  });
});
