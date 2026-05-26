import { describe, expect, it } from 'bun:test';
import { createMigrationController, type FleetJournalEntry, type MoveProposal } from '../src/index.js';

describe('MigrationController integration', () => {
  it('creates and executes a move flow without env gating', async () => {
    delete process.env.LLAMACTL_FLEET_MOVE_ENABLED;

    let nowMs = 1_700_000_000_000;
    let tick = 10;
    const journal: FleetJournalEntry[] = [];

    const controller = createMigrationController({
      peers: ['m2mini'],
      fetchSnapshot: async () => ({
        node: 'm2mini',
        schedulerLeaseHolder: 'm4pro',
        pressureState: 'NORMAL',
        nodeMem: { freeMb: 8000 },
        workloads: [{ name: 'model-a', reachable: true }],
      }),
      deployWorkload: async () => undefined,
      removeWorkload: async () => undefined,
      leaseholder: 'm4pro',
      getNowMs: () => nowMs,
      getCurrentTick: () => tick,
      healthTimeoutMs: 5,
      pollIntervalMs: 1,
      sleep: async () => {
        nowMs += 1;
        tick += 1;
      },
    });

    expect(controller).not.toBeNull();

    const proposal = await controller?.onJournalEntry(
      {
        kind: 'fleet-transition',
        ts: new Date(nowMs).toISOString(),
        node: 'm4pro',
        subject: 'node',
        subjectKind: 'node',
        signal: 'pressure',
        from: 'NORMAL',
        to: 'HIGH',
      },
      {
        name: 'model-a',
        node: 'm4pro',
        spec: { placement: 'auto' },
        evictProposalId: 'evict-1',
      },
      {
        node: 'm4pro',
        schedulerLeaseHolder: 'm4pro',
        pressureState: 'HIGH',
        nodeMem: { freeMb: 100 },
        workloads: [],
      },
    );

    expect(proposal).not.toBeNull();

    const result = await controller?.executeMove(proposal as MoveProposal, (entry) => journal.push(entry));
    expect(result).toBe('executed');
    expect(
      journal.some((entry) => entry.kind === 'fleet-proposal' && entry.action.type === 'move'),
    ).toBe(true);
    expect(journal.some((entry) => entry.kind === 'fleet-execution' && entry.status === 'executed')).toBe(true);
  });
});
