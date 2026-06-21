import type {
  FleetExecutionEntry,
  FleetJournalEntry,
  FleetProposalEntry,
  MoveProposal,
} from "./types.js";

export interface NodeSnapshot {
  node?: string;
  pressureState: "NORMAL" | "HIGH";
  nodeMem?: { freeMb: number };
  workloads?: { name: string; reachable: boolean }[];
}

export interface MigrationWorkload {
  name: string;
  node?: string;
  spec?: {
    placement?: string;
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
  readRecentMoves?: () => Iterable<unknown>;
  /** This node's own id. */
  selfNode: string;
  /**
   * Returns the currently elected scheduler-lease holder, or null when no holder
   * is elected. A move is only initiated when the holder is this node (`selfNode`).
   * In PR-1 this is wired to `() => selfNode` (always self → behavior-preserving);
   * PR-2 derives it from `electLeaseHolder` over peer snapshots.
   */
  getLeaseHolder: () => string | null;
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

interface PendingHealthPoll {
  proposal: MoveProposal;
  writeJournalEntry: (entry: FleetJournalEntry) => void;
  deployedAtMs: number;
}

export class MigrationController {
  private readonly inFlightMoves = new Map<string, InFlightMoveState>();
  private readonly pendingHealthPolls = new Map<string, PendingHealthPoll>();

  constructor(private readonly deps: MigrationControllerDeps) {
    if (!deps.readRecentMoves) return;
    for (const recentMove of deps.readRecentMoves()) {
      if (typeof recentMove !== "object" || recentMove === null) continue;
      const candidate = recentMove as { workload?: unknown; movedAtMs?: unknown };
      if (typeof candidate.workload !== "string") continue;
      if (typeof candidate.movedAtMs !== "number" || !Number.isFinite(candidate.movedAtMs))
        continue;
      const prior = this.inFlightMoves.get(candidate.workload);
      if (!prior || candidate.movedAtMs > prior.movedAtMs) {
        this.inFlightMoves.set(candidate.workload, { movedAtMs: candidate.movedAtMs });
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

  /** Highest-free-memory viable peer for a move off `fromNode`, or
   *  null when no peer is NORMAL with enough free memory. */
  private async findBestDestination(
    fromNode: string,
    requiredFreeMb: number,
  ): Promise<string | null> {
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

    let bestNode: string | null = null;
    let bestFreeMb = -1;
    for (const peerSnapshotEntry of peerSnapshots) {
      if (!peerSnapshotEntry) continue;
      const { peer, snapshot: peerSnapshot } = peerSnapshotEntry;

      const freeMb = peerSnapshot.nodeMem?.freeMb;
      const isViable =
        peerSnapshot.pressureState === "NORMAL" &&
        typeof freeMb === "number" &&
        Number.isFinite(freeMb) &&
        freeMb >= requiredFreeMb;
      if (!isViable) continue;

      if (freeMb > bestFreeMb) {
        bestFreeMb = freeMb;
        bestNode = peer;
      }
    }
    return bestNode;
  }

  async evaluateMove(
    workload: MigrationWorkload,
    snapshot: NodeSnapshot,
  ): Promise<MoveProposal | null> {
    const holder = this.deps.getLeaseHolder();
    if (holder === null || holder !== this.deps.selfNode) return null;
    if (workload.spec?.placement === "pinned") return null;
    if (this.isInMoveCooldown(workload.name)) return null;

    const fromNode = snapshot.node ?? workload.node;
    if (!fromNode) return null;

    const workloadMemoryMb = workload.spec?.resources?.memoryMb;
    const requiredFreeMb = this.minRequiredFreeMb(workloadMemoryMb);

    const bestNode = await this.findBestDestination(fromNode, requiredFreeMb);
    if (!bestNode) return null;

    const proposalId = `move-${workload.name}-${String(this.nowMs)}`;
    return {
      workload: workload.name,
      fromNode,
      toNode: bestNode,
      proposalId,
      evictProposalId: workload.evictProposalId ?? `evict-${workload.name}-${String(this.nowMs)}`,
      expiresAt: new Date(this.nowMs + MIGRATION_POLICY_DEFAULTS.moveProposalTtlMs).toISOString(),
      expiresAtMs: this.nowMs + MIGRATION_POLICY_DEFAULTS.moveProposalTtlMs,
      ...(workloadMemoryMb !== undefined ? { workloadMemoryMb } : {}),
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
  ): Promise<
    "executed" | "timed_out" | "destination_unavailable" | "apply_failed" | "pending_health_check"
  > {
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
      typeof destFreeMb !== "number" ||
      !Number.isFinite(destFreeMb) ||
      destFreeMb < requiredFreeMb
    ) {
      return "destination_unavailable";
    }

    const ts = new Date(this.nowMs).toISOString();

    try {
      await this.deps.deployWorkload(proposal.workload, proposal.toNode);
    } catch (err) {
      writeJournalEntry(this.buildDeployFailedEntry(proposal, (err as Error).message));
      // Arm cooldown even on deploy failure to prevent a tight per-tick retry loop.
      this.markMoveInFlight(proposal.workload);
      return "apply_failed";
    }

    this.writeSkippedEvictAndMoveProposal(proposal, ts, writeJournalEntry);
    this.markMoveInFlight(proposal.workload);

    // Register a pending health poll so the tick returns immediately.
    // advancePendingHealthPolls() advances one probe per tick until
    // the workload is reachable or the deadline passes.
    this.pendingHealthPolls.set(proposal.workload, {
      proposal,
      writeJournalEntry,
      deployedAtMs: this.nowMs,
    });

    return "pending_health_check";
  }

  /** Advance all in-flight health polls by one probe each. Call once per
   *  supervisor tick before evaluating new moves. */
  async advancePendingHealthPolls(): Promise<void> {
    if (!this.deps.removeWorkload) return;
    const removeWorkload = this.deps.removeWorkload;

    for (const [workloadName, poll] of this.pendingHealthPolls) {
      const { proposal, writeJournalEntry, deployedAtMs } = poll;
      const ts = new Date(this.nowMs).toISOString();
      const action: FleetExecutionEntry["action"] = {
        type: "move",
        workload: proposal.workload,
        fromNode: proposal.fromNode,
        toNode: proposal.toNode,
        reason: "rebalance",
      };

      if (this.nowMs > deployedAtMs + this.healthTimeoutMs) {
        this.pendingHealthPolls.delete(workloadName);
        writeJournalEntry({
          kind: "fleet-execution",
          ts,
          node: this.deps.selfNode,
          proposalId: proposal.proposalId,
          action,
          status: "failed",
          reason: "timeout waiting for destination health",
        });
        continue;
      }

      const snapshot = await this.safeFetchSnapshot(proposal.toNode);
      const reachable = snapshot?.workloads?.some(
        (entry) => entry.name === proposal.workload && entry.reachable,
      );
      if (reachable) {
        this.pendingHealthPolls.delete(workloadName);
        await removeWorkload(proposal.workload, proposal.fromNode);
        writeJournalEntry({
          kind: "fleet-execution",
          ts,
          node: this.deps.selfNode,
          proposalId: proposal.proposalId,
          action,
          status: "executed",
        });
      }
      // else: still waiting — leave in pending for the next tick
    }
  }

  private buildDeployFailedEntry(proposal: MoveProposal, errorMsg: string): FleetExecutionEntry {
    return {
      kind: "fleet-execution",
      ts: new Date(this.nowMs).toISOString(),
      node: this.deps.selfNode,
      proposalId: proposal.proposalId,
      action: {
        type: "move",
        workload: proposal.workload,
        fromNode: proposal.fromNode,
        toNode: proposal.toNode,
        reason: "rebalance",
      },
      status: "failed",
      reason: `apply failed: ${errorMsg}`,
    };
  }

  private writeSkippedEvictAndMoveProposal(
    proposal: MoveProposal,
    ts: string,
    writeJournalEntry: (entry: FleetJournalEntry) => void,
  ): void {
    const skippedEvict: FleetExecutionEntry = {
      kind: "fleet-execution",
      ts,
      node: this.deps.selfNode,
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
      node: this.deps.selfNode,
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
