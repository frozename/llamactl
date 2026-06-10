import type {
  FleetExecutionEntry,
  FleetJournalEntry,
  FleetProposalEntry,
  MoveProposal,
} from "./types.js";

export interface NodeSnapshot {
  node?: string;
  schedulerLeaseHolder?: string;
  pressureState: "NORMAL" | "HIGH";
  nodeMem: { freeMb: number };
  workloads?: { name: string; reachable: boolean }[];
}

export interface MigrationWorkload {
  name: string;
  node?: string;
  spec?: {
    placement?: "auto" | "pinned" | string;
    resources?: {
      memoryMb?: number;
    };
  };
  evictProposalId?: string;
}

export interface MigrationControllerDeps {
  peers: string[];
  fetchSnapshot: (node: string) => Promise<NodeSnapshot>;
  deployWorkload?: (workloadName: string, toNode: string) => Promise<void>;
  removeWorkload?: (workloadName: string, fromNode: string) => Promise<void>;
  readRecentMoves?: () => Iterable<{ workload: string; movedAtMs: number }>;
  leaseholder: string;
  getNowMs?: () => number;
  getCurrentTick?: () => number;
  moveCooldownTicks?: number;
  healthTimeoutMs?: number;
  pollIntervalMs?: number;
  minDestinationFreeMb?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const MIGRATION_POLICY_DEFAULTS = {
  moveProposalTtlMs: 30_000,
  moveCooldownTicks: 10,
  healthTimeoutMs: 300_000,
  minDestinationFreeMb: 512,
} as const;

interface InFlightMoveState {
  movedAtMs: number;
  tick?: number;
}

export class MigrationController {
  private readonly inFlightMoves = new Map<string, InFlightMoveState>();

  constructor(private readonly deps: MigrationControllerDeps) {
    if (!deps.readRecentMoves) return;
    for (const recentMove of deps.readRecentMoves()) {
      if (!recentMove || typeof recentMove.workload !== "string") continue;
      if (!Number.isFinite(recentMove.movedAtMs)) continue;
      const prior = this.inFlightMoves.get(recentMove.workload);
      if (!prior || recentMove.movedAtMs > prior.movedAtMs) {
        this.inFlightMoves.set(recentMove.workload, { movedAtMs: recentMove.movedAtMs });
      }
    }
  }

  private get nowMs(): number {
    return this.deps.getNowMs?.() ?? Date.now();
  }

  private get currentTick(): number {
    return this.deps.getCurrentTick?.() ?? 0;
  }

  private get moveCooldownTicks(): number {
    return this.deps.moveCooldownTicks ?? MIGRATION_POLICY_DEFAULTS.moveCooldownTicks;
  }

  private get healthTimeoutMs(): number {
    return this.deps.healthTimeoutMs ?? MIGRATION_POLICY_DEFAULTS.healthTimeoutMs;
  }

  private get pollIntervalMs(): number {
    return this.deps.pollIntervalMs ?? 1_000;
  }

  private get minDestinationFreeMb(): number {
    return this.deps.minDestinationFreeMb ?? MIGRATION_POLICY_DEFAULTS.minDestinationFreeMb;
  }

  private minRequiredFreeMb(workloadMemoryMb?: number): number {
    if (typeof workloadMemoryMb !== "number" || !Number.isFinite(workloadMemoryMb)) {
      return this.minDestinationFreeMb;
    }
    return Math.max(this.minDestinationFreeMb, workloadMemoryMb);
  }

  private async sleep(ms: number): Promise<void> {
    if (this.deps.sleep) {
      await this.deps.sleep(ms);
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  async evaluateMove(
    workload: MigrationWorkload,
    snapshot: NodeSnapshot,
  ): Promise<MoveProposal | null> {
    if (this.deps.leaseholder !== snapshot.schedulerLeaseHolder) return null;
    if (workload.spec?.placement === "pinned") return null;
    if (this.isInMoveCooldown(workload.name)) return null;

    const fromNode = snapshot.node ?? workload.node;
    if (!fromNode) return null;

    let bestNode: string | null = null;
    let bestFreeMb = -1;
    const workloadMemoryMb = workload.spec?.resources?.memoryMb;
    const requiredFreeMb = this.minRequiredFreeMb(workloadMemoryMb);

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

      const freeMb = peerSnapshot.nodeMem?.freeMb;
      const isViable =
        peerSnapshot.pressureState === "NORMAL" &&
        Number.isFinite(freeMb) &&
        freeMb >= requiredFreeMb;
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
      expiresAt: new Date(this.nowMs + MIGRATION_POLICY_DEFAULTS.moveProposalTtlMs).toISOString(),
      expiresAtMs: this.nowMs + MIGRATION_POLICY_DEFAULTS.moveProposalTtlMs,
      workloadMemoryMb,
    };
  }

  markMoveInFlight(workload: string): void {
    this.inFlightMoves.set(workload, {
      movedAtMs: this.nowMs,
      ...(this.deps.getCurrentTick ? { tick: this.currentTick } : {}),
    });
  }

  isInMoveCooldown(workload: string): boolean {
    const state = this.inFlightMoves.get(workload);
    if (!state) return false;
    const active =
      state.tick !== undefined && this.deps.getCurrentTick
        ? this.currentTick - state.tick < this.moveCooldownTicks
        : this.nowMs - state.movedAtMs < this.moveCooldownTicks * this.pollIntervalMs;
    if (!active) this.inFlightMoves.delete(workload);
    return active;
  }

  async executeMove(
    proposal: MoveProposal,
    writeJournalEntry: (entry: FleetJournalEntry) => void,
  ): Promise<"executed" | "timed_out" | "destination_unavailable" | "apply_failed"> {
    if (!this.deps.deployWorkload || !this.deps.removeWorkload) {
      return "destination_unavailable";
    }
    const expiresAtMs = proposal.expiresAtMs ?? Date.parse(proposal.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs < this.nowMs) {
      return "timed_out";
    }

    const destinationSnapshot = await this.safeFetchSnapshot(proposal.toNode);
    if (!destinationSnapshot) {
      return "destination_unavailable";
    }

    const destFreeMb = destinationSnapshot.nodeMem?.freeMb;
    const requiredFreeMb = this.minRequiredFreeMb(proposal.workloadMemoryMb);
    if (
      destinationSnapshot.pressureState !== "NORMAL" ||
      !Number.isFinite(destFreeMb) ||
      destFreeMb < requiredFreeMb
    ) {
      return "destination_unavailable";
    }

    const ts = new Date(this.nowMs).toISOString();

    try {
      await this.deps.deployWorkload(proposal.workload, proposal.toNode);
    } catch (err) {
      writeJournalEntry({
        kind: "fleet-execution",
        ts: new Date(this.nowMs).toISOString(),
        node: this.deps.leaseholder,
        proposalId: proposal.proposalId,
        action: {
          type: "move",
          workload: proposal.workload,
          fromNode: proposal.fromNode,
          toNode: proposal.toNode,
          reason: "rebalance",
        },
        status: "failed",
        reason: `apply failed: ${(err as Error).message}`,
      });
      return "apply_failed";
    }

    const skippedEvict: FleetExecutionEntry = {
      kind: "fleet-execution",
      ts,
      node: this.deps.leaseholder,
      proposalId: proposal.evictProposalId,
      action: {
        type: "evict",
        workload: proposal.workload,
        reason: `evict suppressed by move ${proposal.proposalId}`,
      },
      status: "skipped",
      reason: `evict suppressed by move ${proposal.proposalId}`,
    };
    writeJournalEntry(skippedEvict);

    const moveProposalEntry: FleetProposalEntry = {
      kind: "fleet-proposal",
      ts,
      node: this.deps.leaseholder,
      proposalId: proposal.proposalId,
      transition: {
        subject: proposal.workload,
        subjectKind: "workload",
        signal: "placement",
        from: proposal.fromNode,
        to: proposal.toNode,
      },
      action: {
        type: "move",
        workload: proposal.workload,
        fromNode: proposal.fromNode,
        toNode: proposal.toNode,
        reason: "rebalance",
      },
      expiresAt: proposal.expiresAt,
    };
    writeJournalEntry(moveProposalEntry);

    this.markMoveInFlight(proposal.workload);

    const deadline = this.nowMs + this.healthTimeoutMs;
    while (this.nowMs <= deadline) {
      const snapshot = await this.safeFetchSnapshot(proposal.toNode);
      const reachable = snapshot?.workloads?.some(
        (entry) => entry.name === proposal.workload && entry.reachable,
      );
      if (reachable) {
        await this.deps.removeWorkload(proposal.workload, proposal.fromNode);
        writeJournalEntry({
          kind: "fleet-execution",
          ts: new Date(this.nowMs).toISOString(),
          node: this.deps.leaseholder,
          proposalId: proposal.proposalId,
          action: {
            type: "move",
            workload: proposal.workload,
            fromNode: proposal.fromNode,
            toNode: proposal.toNode,
            reason: "rebalance",
          },
          status: "executed",
        });
        return "executed";
      }

      await this.sleep(this.pollIntervalMs);
    }

    writeJournalEntry({
      kind: "fleet-execution",
      ts: new Date(this.nowMs).toISOString(),
      node: this.deps.leaseholder,
      proposalId: proposal.proposalId,
      action: {
        type: "move",
        workload: proposal.workload,
        fromNode: proposal.fromNode,
        toNode: proposal.toNode,
        reason: "rebalance",
      },
      status: "failed",
      reason: "timeout waiting for destination health",
    });

    return "timed_out";
  }

  async onJournalEntry(
    entry: FleetJournalEntry,
    workload?: MigrationWorkload,
    snapshot?: NodeSnapshot,
  ): Promise<MoveProposal | null> {
    const isPressureRise =
      entry.kind === "fleet-transition" &&
      entry.subjectKind === "node" &&
      entry.signal === "pressure" &&
      entry.from === "NORMAL" &&
      entry.to === "HIGH";

    if (!isPressureRise) return null;
    if (!workload || !snapshot) return null;

    return await this.evaluateMove(workload, snapshot);
  }

  private async safeFetchSnapshot(node: string): Promise<NodeSnapshot | null> {
    try {
      return await this.deps.fetchSnapshot(node);
    } catch {
      return null;
    }
  }
}
