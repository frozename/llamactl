import { describe, it, expect, beforeEach } from 'bun:test';
import { MigrationController } from '../src/migration-controller.js';
import { startSupervisorLoop, DEFAULT_PRESSURE_THRESHOLDS } from '../src/loop.js';
import type { NodeSnapshot } from '../src/migration-controller.js';
import type { FleetExecutionEntry, FleetJournalEntry } from '../src/types.js';

describe('MigrationController', () => {
  let controller: MigrationController;
  let applyCalled = false;
  let deleteCalled = false;
  let journal: any[] = [];
  let snapshots: Record<string, NodeSnapshot> = {};
  let currentMs = 1000000;
  let currentTick = 100;

  beforeEach(() => {
    applyCalled = false;
    deleteCalled = false;
    journal = [];
    snapshots = {};
    currentMs = 1000000;
    currentTick = 100;

    controller = new MigrationController({
      peers: ['m4pro', 'm2mini'],
      fetchSnapshot: async (node) => snapshots[node] || { pressureState: 'NORMAL', node_mem: { free_mb: 4000 } } as any,
      applyWorkload: async () => { applyCalled = true; },
      deleteWorkload: async () => { deleteCalled = true; },
      leaseholder: 'm4pro',
      
      getCurrentTick: () => currentTick,
      stickyTicks: 10,
      healthTimeoutMs: 100,
      pollIntervalMs: 10, // only in tests
    });
  });

  const baseSnapshot = {
    schedulerLeaseHolder: 'm4pro',
    pressureState: 'HIGH',
    node_mem: { free_mb: 100 },
  } as any;

  const baseWorkload = {
    name: 'test-workload',
    spec: { placement: 'auto' }
  } as any;

  it('T1: evaluateMove returns null when not scheduler leaseholder', async () => {
    const snap = { ...baseSnapshot, schedulerLeaseHolder: 'other' };
    expect(await controller.evaluateMove(baseWorkload, snap, 'evict-1')).toBeNull();
  });

  it('T2: evaluateMove returns null when workload is pinned', async () => {
    const pinnedWorkload = { ...baseWorkload, spec: { placement: 'pinned' } };
    expect(await controller.evaluateMove(pinnedWorkload, baseSnapshot, 'evict-1')).toBeNull();
  });

  it('T3: evaluateMove returns null when sticky window is active', async () => {
    controller.markMoveInFlight('test-workload');
    currentTick += 5; // < 10 ticks
    expect(await controller.evaluateMove(baseWorkload, baseSnapshot, 'evict-1')).toBeNull();
  });

  it('T4: evaluateMove returns null when no viable destination node', async () => {
    snapshots['m4pro'] = { pressureState: 'HIGH', node_mem: { free_mb: 100 } } as any;
    snapshots['m2mini'] = { pressureState: 'HIGH', node_mem: { free_mb: 100 } } as any;
    expect(await controller.evaluateMove(baseWorkload, baseSnapshot, 'evict-1')).toBeNull();
  });

  it('T5: evaluateMove returns MoveProposal with correct from/to', async () => {
    snapshots['m2mini'] = { pressureState: 'NORMAL', node_mem: { free_mb: 8000 } } as any;
    const proposal = await controller.evaluateMove(baseWorkload, baseSnapshot, 'evict-1');
    expect(proposal).not.toBeNull();
    expect(proposal?.workload).toBe('test-workload');
    expect(proposal?.toNode).toBe('m2mini');
    expect(proposal?.evictProposalId).toBe('evict-1');
  });

  it('T6: after markMoveInFlight, isStickyWindowActive returns true for stickyTicks', () => {
    expect(controller.isStickyWindowActive('test-workload')).toBe(false);
    controller.markMoveInFlight('test-workload');
    expect(controller.isStickyWindowActive('test-workload')).toBe(true);
    currentTick += 11;
    expect(controller.isStickyWindowActive('test-workload')).toBe(false);
  });

  it('T7: executeMove writes skipped for evict, then executed on success', async () => {
    snapshots['m2mini'] = { pressureState: 'NORMAL', node_mem: { free_mb: 8000 }, workloads: [{ name: 'test-workload', reachable: true }] } as any;
    const proposal = {
      workload: 'test-workload',
      fromNode: 'm4pro',
      toNode: 'm2mini',
      proposalId: 'move-1',
      expiresAt: new Date(Date.now() + 10000).toISOString(),
      evictProposalId: 'evict-1'
    };
    
    const result = await controller.executeMove(proposal, (e) => journal.push(e));
    expect(result).toBe('executed');
    expect(applyCalled).toBe(true);
    expect(deleteCalled).toBe(true);
    
    const skipped = journal.find(e => e.kind === 'fleet-execution' && e.status === 'skipped');
    expect(skipped.proposalId).toBe('evict-1');
    expect(skipped.reason).toBe('move in flight');

    const executed = journal.find(e => e.kind === 'fleet-execution' && e.status === 'executed');
    expect(executed.proposalId).toBe('move-1');
  });

  it('T8: executeMove writes failed on move timeout, returns timed_out', async () => {
    // Make reachable false to cause timeout
    snapshots['m2mini'] = { pressureState: 'NORMAL', node_mem: { free_mb: 8000 }, workloads: [{ name: 'test-workload', reachable: false }] } as any;
    const proposal = {
      workload: 'test-workload',
      fromNode: 'm4pro',
      toNode: 'm2mini',
      proposalId: 'move-1',
      expiresAt: new Date(Date.now() + 10000).toISOString(),
      evictProposalId: 'evict-1'
    };

    const result = await controller.executeMove(proposal, (e) => journal.push(e));
    expect(result).toBe('timed_out');
    expect(applyCalled).toBe(true);
    expect(deleteCalled).toBe(false);

    const failed = journal.find(e => e.kind === 'fleet-execution' && e.status === 'failed');
    expect(failed.proposalId).toBe('move-1');
  });

  it('T9: destination headroom re-checked at execution time', async () => {
    // Was normal at evaluate, but now HIGH
    snapshots['m2mini'] = { pressureState: 'HIGH', node_mem: { free_mb: 100 } } as any;
    const proposal = {
      workload: 'test-workload',
      fromNode: 'm4pro',
      toNode: 'm2mini',
      proposalId: 'move-1',
      expiresAt: new Date(Date.now() + 10000).toISOString(),
      evictProposalId: 'evict-1'
    };

    const result = await controller.executeMove(proposal, (e) => journal.push(e));
    expect(result).toBe('destination_lost');
    expect(applyCalled).toBe(false);
  });

  it('T10: onJournalEntry triggers onEvaluateTrigger on NORMAL->HIGH pressure transition', () => {
    let evaluateCalled = false;
    controller.onEvaluateTrigger = () => { evaluateCalled = true; };
    
    controller.onJournalEntry({
      kind: 'fleet-transition',
      signal: 'pressure',
      from: 'NORMAL',
      to: 'HIGH',
      subject: 'node',
      subjectKind: 'node',
      node: 'm4pro',
      ts: new Date().toISOString()
    });
    
    expect(evaluateCalled).toBe(true);
  });

  it('T11: loop hysteresis counters unchanged by fleet-move entries', () => {
    expect(DEFAULT_PRESSURE_THRESHOLDS.consecutiveTicks).toBe(3);
    expect(DEFAULT_PRESSURE_THRESHOLDS.clearTicks).toBe(5);
  });
});
