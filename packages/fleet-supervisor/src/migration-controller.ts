import type {
  FleetExecutionEntry,
  FleetJournalEntry,
  FleetProposalEntry,
  MoveProposal,
} from './types.js';

export interface NodeSnapshot {
  node?: string;
  schedulerLeaseHolder?: string;
  pressureState: 'NORMAL' | 'HIGH';
  node_mem: { free_mb: number };
  workloads?: Array<{ name: string; reachable: boolean }>;
}

export interface MigrationWorkload {
  name: string;
  node?: string;
  spec?: {
    placement?: 'auto' | 'pinned' | string;
  };
  evictProposalId?: string;
}

export interface MigrationControllerDeps {
  peers: string[];
  fetchSnapshot: (node: string) => Promise<NodeSnapshot>;
  applyWorkload?: (workloadName: string, toNode: string) => Promise<void>;
  deleteWorkload?: (workloadName: string, fromNode: string) => Promise<void>;
  leaseholder: string;
  getNowMs?: () => number;
  getCurrentTick?: () => number;
  stickyTicks?: number;
  healthTimeoutMs?: number;
  pollIntervalMs?: number;
  minDestinationFreeMb?: number;
  sleep?: (ms: number) => Promise<void>;
}

const MOVE_PROPOSAL_TTL_MS = 30_000;

interface InFlightMoveState {
  movedAtMs: number;
  tick?: number;
}

export class MigrationController {
  private readonly inFlightMoves = new Map<string, InFlightMoveState>();

  constructor(private readonly deps: MigrationControllerDeps) {}

  private get nowMs(): number {
    return this.deps.getNowMs?.() ?? Date.now();
  }

  private get currentTick(): number {
    return this.deps.getCurrentTick?.() ?? 0;
  }

  private get stickyTicks(): number {
    return this.deps.stickyTicks ?? 10;
  }

  private get healthTimeoutMs(): number {
    return this.deps.healthTimeoutMs ?? 300_000;
  }

  private get pollIntervalMs(): number {
    return this.deps.pollIntervalMs ?? 1_000;
  }

  private get minDestinationFreeMb(): number {
    return this.deps.minDestinationFreeMb ?? 512;
  }

  private async sleep(ms: number): Promise<void> {
    if (this.deps.sleep) {
      await this.deps.sleep(ms);
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  async evaluateMove(workload: MigrationWorkload, snapshot: NodeSnapshot): Promise<MoveProposal | null> {
    if (this.deps.leaseholder !== snapshot.schedulerLeaseHolder) return null;
    if (workload.spec?.placement === 'pinned') return null;
    if (this.isStickyWindowActive(workload.name)) return null;

    const fromNode = snapshot.node ?? workload.node;
    if (!fromNode) return null;

    let bestNode: string | null = null;
    let bestFreeMb = -1;

    const peerSnapshots = await Promise.all(
      this.deps.peers
        .filter((peer) => peer !== fromNode)
        .map(async (peer) => {
          try {
            return { peer, snapshot: await this.deps.fetchSnapshot(peer) };
          } catch {
            return null;
          }
        }),
    );

    for (const peerSnapshotEntry of peerSnapshots) {
      if (!peerSnapshotEntry) continue;
      const { peer, snapshot: peerSnapshot } = peerSnapshotEntry;

      const freeMb = peerSnapshot.node_mem?.free_mb;
      const isViable =
        peerSnapshot.pressureState === 'NORMAL' &&
        Number.isFinite(freeMb) &&
        freeMb >= this.minDestinationFreeMb;
      if (!isViable) continue;

      if (freeMb > bestFreeMb) {
        bestFreeMb = freeMb;
        bestNode = peer;
      }
    }

    if (!bestNode) return null;

    const proposalId = `move-${workload.name}-${this.nowMs}`;
    return {
      workload: workload.name,
      fromNode,
      toNode: bestNode,
      proposalId,
      evictProposalId: workload.evictProposalId ?? `evict-${workload.name}-${this.nowMs}`,
      expiresAt: new Date(this.nowMs + MOVE_PROPOSAL_TTL_MS).toISOString(),
    };
  }

  markMoveInFlight(workload: string, _moveProposalId: string): void {
    this.inFlightMoves.set(workload, {
      movedAtMs: this.nowMs,
      ...(this.deps.getCurrentTick ? { tick: this.currentTick } : {}),
    });
  }

  isStickyWindowActive(workload: string): boolean {
    const state = this.inFlightMoves.get(workload);
    if (!state) return false;
    const active = state.tick !== undefined && this.deps.getCurrentTick
      ? this.currentTick - state.tick < this.stickyTicks
      : this.nowMs - state.movedAtMs < this.stickyTicks * this.pollIntervalMs;
    if (!active) this.inFlightMoves.delete(workload);
    return active;
  }

  async executeMove(
    proposal: MoveProposal,
    writeJournalEntry: (entry: FleetJournalEntry) => void,
  ): Promise<'executed' | 'timed_out' | 'destination_lost' | 'apply_failed'> {
    if (!this.deps.applyWorkload || !this.deps.deleteWorkload) {
      return 'destination_lost';
    }
    const expiresAtMs = Date.parse(proposal.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs < this.nowMs) {
      return 'timed_out';
    }

    const destinationSnapshot = await this.safeFetchSnapshot(proposal.toNode);
    if (!destinationSnapshot) {
      return 'destination_lost';
    }

    const destFreeMb = destinationSnapshot.node_mem?.free_mb;
    if (
      destinationSnapshot.pressureState !== 'NORMAL' ||
      !Number.isFinite(destFreeMb) ||
      destFreeMb < this.minDestinationFreeMb
    ) {
      return 'destination_lost';
    }

    const ts = new Date(this.nowMs).toISOString();

    try {
      await this.deps.applyWorkload(proposal.workload, proposal.toNode);
    } catch (err) {
      writeJournalEntry({
        kind: 'fleet-execution',
        ts: new Date(this.nowMs).toISOString(),
        node: this.deps.leaseholder,
        proposalId: proposal.proposalId,
        action: {
          type: 'move',
          workload: proposal.workload,
          fromNode: proposal.fromNode,
          toNode: proposal.toNode,
          reason: 'rebalance',
        },
        status: 'failed',
        reason: `apply failed: ${(err as Error).message}`,
      });
      return 'apply_failed';
    }

    const skippedEvict: FleetExecutionEntry = {
      kind: 'fleet-execution',
      ts,
      node: this.deps.leaseholder,
      proposalId: proposal.evictProposalId,
      action: { type: 'evict', workload: proposal.workload, reason: 'move in flight' },
      status: 'skipped',
      reason: 'move in flight',
    };
    writeJournalEntry(skippedEvict);

    const moveProposalEntry: FleetProposalEntry = {
      kind: 'fleet-proposal',
      ts,
      node: this.deps.leaseholder,
      proposalId: proposal.proposalId,
      transition: {
        subject: proposal.workload,
        subjectKind: 'workload',
        signal: 'placement',
        from: proposal.fromNode,
        to: proposal.toNode,
      },
      action: {
        type: 'move',
        workload: proposal.workload,
        fromNode: proposal.fromNode,
        toNode: proposal.toNode,
        reason: 'rebalance',
      },
      expiresAt: proposal.expiresAt,
    };
    writeJournalEntry(moveProposalEntry);

    writeJournalEntry({
      kind: 'fleet-move',
      ts,
      node: this.deps.leaseholder,
      workload: proposal.workload,
      fromNode: proposal.fromNode,
      toNode: proposal.toNode,
      proposalId: proposal.proposalId,
      expiresAt: proposal.expiresAt,
    });

    this.markMoveInFlight(proposal.workload, proposal.proposalId);

    const deadline = this.nowMs + this.healthTimeoutMs;
    while (this.nowMs <= deadline) {
      const snapshot = await this.safeFetchSnapshot(proposal.toNode);
      const reachable = snapshot?.workloads?.some(
        (entry) => entry.name === proposal.workload && entry.reachable,
      );
      if (reachable) {
        await this.deps.deleteWorkload(proposal.workload, proposal.fromNode);
        writeJournalEntry({
          kind: 'fleet-execution',
          ts: new Date(this.nowMs).toISOString(),
          node: this.deps.leaseholder,
          proposalId: proposal.proposalId,
          action: {
            type: 'move',
            workload: proposal.workload,
            fromNode: proposal.fromNode,
            toNode: proposal.toNode,
            reason: 'rebalance',
          },
          status: 'executed',
        });
        return 'executed';
      }

      await this.sleep(this.pollIntervalMs);
    }

    writeJournalEntry({
      kind: 'fleet-execution',
      ts: new Date(this.nowMs).toISOString(),
      node: this.deps.leaseholder,
      proposalId: proposal.proposalId,
      action: {
        type: 'move',
        workload: proposal.workload,
        fromNode: proposal.fromNode,
        toNode: proposal.toNode,
        reason: 'rebalance',
      },
      status: 'failed',
      reason: 'timeout waiting for destination health',
    });

    return 'timed_out';
  }

  async onJournalEntry(
    entry: FleetJournalEntry,
    workload?: MigrationWorkload,
    snapshot?: NodeSnapshot,
  ): Promise<MoveProposal | null> {
    const isPressureRise =
      entry.kind === 'fleet-transition' &&
      entry.subjectKind === 'node' &&
      entry.signal === 'pressure' &&
      entry.from === 'NORMAL' &&
      entry.to === 'HIGH';

    if (!isPressureRise) return null;
    if (!workload || !snapshot) return null;

    return this.evaluateMove(workload, snapshot);
  }

  private async safeFetchSnapshot(node: string): Promise<NodeSnapshot | null> {
    try {
      return await this.deps.fetchSnapshot(node);
    } catch {
      return null;
    }
  }
}
