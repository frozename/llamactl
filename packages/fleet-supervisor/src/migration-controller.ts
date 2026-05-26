export interface NodeSnapshot {
  node?: string;
  schedulerLeaseHolder?: string;
  pressureState: 'NORMAL' | 'HIGH';
  node_mem: { free_mb: number; };
  workloads?: any[];
}
import type { FleetExecutionEntry, FleetJournalEntry, FleetMoveEntry, MoveProposal } from './types.js';

export interface MigrationControllerDeps {
  peers: string[];
  fetchSnapshot: (node: string) => Promise<NodeSnapshot>;
  applyWorkload: (workloadName: string, toNode: string) => Promise<void>;
  deleteWorkload: (workloadName: string, fromNode: string) => Promise<void>;
  leaseholder: string;
  getNowMs?: () => number;
  getCurrentTick?: () => number;
  stickyTicks?: number;
  healthTimeoutMs?: number;
  pollIntervalMs?: number;
}

export class MigrationController {
  private inFlightMoves = new Map<string, number>();
  onEvaluateTrigger?: (entry: any) => void;

  constructor(private deps: MigrationControllerDeps) {}

  private get nowMs() { return this.deps.getNowMs ? this.deps.getNowMs() : Date.now(); }
  private get currentTick() { return this.deps.getCurrentTick ? this.deps.getCurrentTick() : 0; }
  private get stickyTicks() { return this.deps.stickyTicks ?? 10; }
  private get healthTimeoutMs() { return this.deps.healthTimeoutMs ?? 300_000; }
  private get pollIntervalMs() { return this.deps.pollIntervalMs ?? 1000; }

  async evaluateMove(workload: any, snapshot: NodeSnapshot, evictProposalId: string): Promise<MoveProposal | null> {
    if (this.deps.leaseholder !== snapshot.schedulerLeaseHolder) return null;
    if (workload.spec?.placement === 'pinned') return null;
    if (this.isStickyWindowActive(workload.name)) return null;

    let bestDest: string | null = null;
    let maxFree = 0;

    for (const peer of this.deps.peers) {
      try {
        const peerSnap = await this.deps.fetchSnapshot(peer);
        if (peerSnap.pressureState === 'NORMAL' && peerSnap.node_mem.free_mb > 512) {
          if (peerSnap.node_mem.free_mb > maxFree) {
            maxFree = peerSnap.node_mem.free_mb;
            bestDest = peer;
          }
        }
      } catch { }
    }

    if (!bestDest) return null;

    return {
      workload: workload.name,
      fromNode: snapshot.node || workload.node, // fallback if needed
      toNode: bestDest,
      proposalId: `move-${Date.now()}`,
      evictProposalId,
      expiresAt: new Date(this.nowMs + 30000).toISOString()
    };
  }

  markMoveInFlight(workloadName: string): void {
    this.inFlightMoves.set(workloadName, this.currentTick);
  }

  isStickyWindowActive(workloadName: string): boolean {
    const lastMoveTick = this.inFlightMoves.get(workloadName);
    if (lastMoveTick === undefined) return false;
    return (this.currentTick - lastMoveTick) < this.stickyTicks;
  }

  async executeMove(proposal: MoveProposal, writeJournalEntry: (entry: FleetJournalEntry) => void): Promise<'executed' | 'timed_out' | 'destination_lost'> {
    if (new Date(proposal.expiresAt).getTime() < this.nowMs) {
      return 'timed_out';
    }

    try {
      const destSnap = await this.deps.fetchSnapshot(proposal.toNode); 
      if (destSnap.pressureState === 'HIGH' || destSnap.node_mem.free_mb < 512) {
        return 'destination_lost';
      }
    } catch {
      return 'destination_lost';
    }

    writeJournalEntry({
      kind: 'fleet-execution',
      status: 'skipped',
      proposalId: proposal.evictProposalId,
      reason: 'move in flight',
      ts: new Date(this.nowMs).toISOString(),
      node: this.deps.leaseholder,
      action: { type: 'evict', workload: proposal.workload, reason: 'superseded by move' }
    });

    writeJournalEntry({
    kind: 'fleet-move',
      node: this.deps.leaseholder,
      workload: proposal.workload,
      fromNode: proposal.fromNode,
      toNode: proposal.toNode,
      proposalId: proposal.proposalId,
      expiresAt: proposal.expiresAt,
      ts: new Date(this.nowMs).toISOString()
    });

    this.markMoveInFlight(proposal.workload);

    await this.deps.applyWorkload(proposal.workload, proposal.toNode);

    const startMs = this.nowMs;
    let reachable = false;
    while (this.nowMs - startMs < this.healthTimeoutMs) {
      try {
        const snap = await this.deps.fetchSnapshot(proposal.toNode);
        const wl = snap.workloads?.find((w: any) => w.name === proposal.workload);
        if (wl && wl.reachable) {
          reachable = true;
          break;
        }
      } catch (_) {}
      await new Promise(r => setTimeout(r, this.pollIntervalMs));
    }

    if (!reachable) {
      writeJournalEntry({
        kind: 'fleet-execution',
        status: 'failed',
        proposalId: proposal.proposalId,
        ts: new Date(this.nowMs).toISOString(),
        node: this.deps.leaseholder,
        action: { type: 'move', workload: proposal.workload, fromNode: proposal.fromNode, toNode: proposal.toNode, reason: 'move' }
      });
      return 'timed_out';
    }

    await this.deps.deleteWorkload(proposal.workload, proposal.fromNode);
    
    writeJournalEntry({
      kind: 'fleet-execution',
      status: 'executed',
      proposalId: proposal.proposalId,
      ts: new Date(this.nowMs).toISOString(),
      node: this.deps.leaseholder,
      action: { type: 'move', workload: proposal.workload, fromNode: proposal.fromNode, toNode: proposal.toNode, reason: 'move' }
    });
    return 'executed';
  }

  onJournalEntry(entry: FleetJournalEntry): void {
    if (entry.kind === 'fleet-transition' && entry.signal === 'pressure' && entry.from === 'NORMAL' && entry.to === 'HIGH') {
      if (this.onEvaluateTrigger) {
        this.onEvaluateTrigger(entry);
      }
    }
  }
}

