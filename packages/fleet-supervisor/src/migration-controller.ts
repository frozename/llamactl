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
  /**
   * Partition self-demotion (design §2). When this node is the elected holder,
   * it may only initiate a move if it can ALSO see at least one fresh
   * destination peer — i.e. a peer it could move a workload onto. A
   * partitioned-but-alive holder (its own lease intent stays fresh, so
   * `getLeaseHolder` still names it) that sees no fresh peer must NOT issue
   * moves onto nodes it can't observe; it self-demotes (treated as holder
   * `null`). This is destination VISIBILITY, not lease-eligibility: in the
   * single-eligible prod case the holder still sees its (ineligible) peers as
   * fresh destinations, so it does not demote and migrations proceed as today.
   *
   * Optional: when omitted (PR-1/PR-2 call-sites, most tests) the holder is
   * never demoted on this axis — behavior-preserving.
   */
  canSeeFreshDestinationPeer?: () => boolean;
  /**
   * Cross-node in-flight-move consumer (design §4). Returns true iff some FRESH
   * peer is currently mid-moving the named workload — i.e. that peer published it
   * in its snapshot `inFlightMoves` (deployed onto a destination, source not yet
   * removed). When a peer is mid-moving W, this node must NOT start a SECOND move
   * of W: a node's OWN local cooldown (`isInMoveCooldown`) only knows about moves
   * THIS node started, so without this consumer two holders (the takeover window,
   * or a transient double-holder) can each begin a move of the same workload — the
   * cross-node double-move. The guard runs before proposing a move and skips the
   * workload when this returns true.
   *
   * The implementation (wired in supervisor.ts) reuses the SAME per-node-fresh
   * peer view as `getLeaseHolder` / `canSeeFreshDestinationPeer`
   * (getLatestPerNode over the local cluster.db, direct peer-fetch fallback),
   * filters to fresh peers, and tests whether any reports `workload` in its
   * published `inFlightMoves`.
   *
   * Optional + workload-scoped: when omitted (PR-1..PR-3 call-sites, most tests)
   * NO workload is ever skipped on this axis — byte-preserving. In the
   * single-eligible prod case no peer publishes any in-flight move, so even when
   * supplied this is a no-op and migrations proceed exactly as today.
   */
  isPeerMovingWorkload?: (workload: string) => boolean;
  getNowMs?: () => number;
  getCurrentTick?: () => number;
  moveCooldownTicks?: number;
  healthTimeoutMs?: number;
  pollIntervalMs?: number;
  tickIntervalMs?: number;
  minDestinationFreeMb?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const MIGRATION_POLICY_DEFAULTS = {
  moveProposalTtlMs: 30_000,
  moveCooldownTicks: 10,
  tickIntervalMs: 30_000,
  healthTimeoutMs: 300_000,
  minDestinationFreeMb: 512,
} as const;

interface InFlightMoveState {
  movedAtMs: number;
  tick?: number;
}

interface DestinationCapacityReservation {
  tick: number;
  freeMb: number;
}

interface PendingHealthPoll {
  proposal: MoveProposal;
  writeJournalEntry: (entry: FleetJournalEntry) => void;
  deployedAtMs: number;
  /**
   * Defect A: tracks whether the destination has EVER been observed reachable
   * for this move. Once true, the timeout/failure path must retry SOURCE
   * removal only — it must NOT remove the destination, because that would
   * destroy the healthy copy just because the source could not be cleaned up.
   */
  destinationReachableObserved: boolean;
}

/**
 * Published in-flight-move intent (design §2/§4). A move that has deployed onto
 * the destination but not yet removed from the source — the half-done state that
 * a successor must honor (via the existing cooldown) so it does not start a
 * second move of the same workload. Carried additively in the node's snapshot.
 */
export interface InFlightMove {
  workload: string;
  fromNode: string;
  toNode: string;
  proposalId: string;
  /** Local-clock ms when the deploy onto the destination completed. */
  deployedAtMs: number;
}

export class MigrationController {
  private readonly inFlightMoves = new Map<string, InFlightMoveState>();
  private readonly pendingHealthPolls = new Map<string, PendingHealthPoll>();
  private readonly destinationCapacityReservations = new Map<
    string,
    DestinationCapacityReservation
  >();

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

  private get tickIntervalMs(): number {
    return this.deps.tickIntervalMs ?? MIGRATION_POLICY_DEFAULTS.tickIntervalMs;
  }

  private get minDestinationFreeMb(): number {
    return this.deps.minDestinationFreeMb ?? MIGRATION_POLICY_DEFAULTS.minDestinationFreeMb;
  }

  private get reservationTick(): number {
    if (this.deps.getCurrentTick) return this.currentTick;
    const interval = this.tickIntervalMs;
    return interval <= 0 ? Math.floor(this.nowMs / 1_000) : Math.floor(this.nowMs / interval);
  }

  private getOrInitDestinationProjection(peer: string, freeMb: number): number {
    const reservation = this.destinationCapacityReservations.get(peer);
    if (reservation?.tick !== this.reservationTick) {
      this.destinationCapacityReservations.set(peer, { tick: this.reservationTick, freeMb });
      return freeMb;
    }
    return reservation.freeMb;
  }

  private reserveDestinationCapacity(peer: string, memoryMb: number): void {
    const freeMb = this.getOrInitDestinationProjection(peer, this.minDestinationFreeMb);
    this.destinationCapacityReservations.set(peer, {
      tick: this.reservationTick,
      freeMb: freeMb - Math.max(memoryMb, 0),
    });
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
      const projectedFreeMb =
        typeof freeMb === "number" ? this.getOrInitDestinationProjection(peer, freeMb) : null;
      const isViable =
        peerSnapshot.pressureState === "NORMAL" &&
        typeof projectedFreeMb === "number" &&
        Number.isFinite(projectedFreeMb) &&
        projectedFreeMb >= requiredFreeMb;
      if (!isViable) continue;

      if (projectedFreeMb > bestFreeMb) {
        bestFreeMb = projectedFreeMb;
        bestNode = peer;
      }
    }
    return bestNode;
  }

  async evaluateMove(
    workload: MigrationWorkload,
    snapshot: NodeSnapshot,
  ): Promise<MoveProposal | null> {
    // Source-pressure gate (defect 2): only rebalance OFF a node that is itself
    // under HIGH pressure. Without this the supervisor proposes a 'rebalance'
    // move every tick regardless of source load. Gates ONLY new proposals —
    // in-flight health-poll completion (advancePendingHealthPolls) is a separate
    // method and is unaffected.
    if (snapshot.pressureState !== "HIGH") return null;
    const holder = this.deps.getLeaseHolder();
    if (holder === null || holder !== this.deps.selfNode) return null;
    // Partition self-demotion (design §2): a holder that cannot see any fresh
    // destination peer is partitioned-but-alive — it must NOT move workloads
    // onto nodes it can't observe. Treat the holder as null (emit no move).
    // Absent the dep, never demote (behavior-preserving). This gates only NEW
    // proposals; in-flight completion (advancePendingHealthPolls) is unaffected.
    if (this.deps.canSeeFreshDestinationPeer && !this.deps.canSeeFreshDestinationPeer()) {
      return null;
    }
    if (workload.spec?.placement === "pinned") return null;
    if (this.isInMoveCooldown(workload.name)) return null;
    if (this.pendingHealthPolls.has(workload.name)) return null;
    // Cross-node in-flight-move consumer (design §4): a node's OWN cooldown only
    // knows the moves THIS node started. If a FRESH peer is already mid-moving
    // this workload (it published it in its snapshot inFlightMoves — deployed on a
    // destination, source not yet removed), starting a SECOND move would be a
    // cross-node double-move. Honor the peer's in-flight move and skip W. Absent
    // the dep, never skip (behavior-preserving); single-eligible prod publishes no
    // peer in-flight moves, so this is a no-op there.
    if (this.deps.isPeerMovingWorkload?.(workload.name)) return null;

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
    const currentTick = this.deps.getCurrentTick?.();
    const inFlightMove: InFlightMoveState = { movedAtMs: this.nowMs };
    if (currentTick !== undefined) {
      inFlightMove.tick = currentTick;
    }
    this.inFlightMoves.set(workload, inFlightMove);
  }

  /**
   * Snapshot of the moves this node has deployed onto a destination but not yet
   * removed from the source (design §2/§4). Published additively in the node's
   * fleet-snapshot so a successor that takes over the lease can honor the move
   * (the existing cooldown bounds a double-move). Drains as each move completes
   * (source removed) in advancePendingHealthPolls.
   */
  getInFlightMoves(): InFlightMove[] {
    const moves: InFlightMove[] = [];
    for (const poll of this.pendingHealthPolls.values()) {
      moves.push({
        workload: poll.proposal.workload,
        fromNode: poll.proposal.fromNode,
        toNode: poll.proposal.toNode,
        proposalId: poll.proposal.proposalId,
        deployedAtMs: poll.deployedAtMs,
      });
    }
    return moves;
  }

  isInMoveCooldown(workload: string): boolean {
    const state = this.inFlightMoves.get(workload);
    if (!state) return false;
    const active =
      state.tick !== undefined && this.deps.getCurrentTick
        ? this.currentTick - state.tick < this.moveCooldownTicks
        : this.nowMs - state.movedAtMs < this.moveCooldownTicks * this.tickIntervalMs;
    if (!active) this.inFlightMoves.delete(workload);
    return active;
  }

  async executeMove(
    proposal: MoveProposal,
    writeJournalEntry: (entry: FleetJournalEntry) => void,
  ): Promise<
    | "executed"
    | "timed_out"
    | "destination_unavailable"
    | "apply_failed"
    | "pending_health_check"
    | "lease_lost"
  > {
    if (this.pendingHealthPolls.has(proposal.workload)) {
      writeJournalEntry({
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
        reason: "refused to overwrite active health poll",
      });
      return "apply_failed";
    }

    if (!this.deps.deployWorkload || !this.deps.removeWorkload) {
      return "destination_unavailable";
    }
    // Defect B: evaluateMove read getLeaseHolder before awaiting
    // findBestDestination, so ownership could have flipped to another node
    // during that async window. Re-check here so a node that lost the lease
    // never deploys on top of the new holder (split-brain double-deploy).
    if (this.deps.getLeaseHolder() !== this.deps.selfNode) {
      return "lease_lost";
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
    this.reserveDestinationCapacity(proposal.toNode, requiredFreeMb);
    this.markMoveInFlight(proposal.workload);

    // Register a pending health poll so the tick returns immediately.
    // advancePendingHealthPolls() advances one probe per tick until
    // the workload is reachable or the deadline passes.
    this.pendingHealthPolls.set(proposal.workload, {
      proposal,
      writeJournalEntry,
      deployedAtMs: this.nowMs,
      destinationReachableObserved: false,
    });

    return "pending_health_check";
  }

  /** Advance all in-flight health polls by one probe each. Call once per
   *  supervisor tick before evaluating new moves. */
  async advancePendingHealthPolls(): Promise<void> {
    if (!this.deps.removeWorkload) return;
    const removeWorkload = this.deps.removeWorkload;

    for (const [workloadName, poll] of this.pendingHealthPolls) {
      await this.advanceSinglePendingPoll(workloadName, poll, removeWorkload);
    }
  }

  private async advanceSinglePendingPoll(
    workloadName: string,
    poll: PendingHealthPoll,
    removeWorkload: (workloadName: string, fromNode: string) => Promise<void>,
  ): Promise<void> {
    const { proposal, writeJournalEntry, deployedAtMs } = poll;
    const ts = new Date(this.nowMs).toISOString();
    const action = this.buildMoveAction(proposal);

    const timedOut = this.nowMs > deployedAtMs + this.healthTimeoutMs;

    // Defect A: only the genuinely-failed-deploy timeout branch (destination
    // never came up) may remove the destination. A timeout reached AFTER
    // destination reachability was observed means the deploy succeeded and
    // only source cleanup is stuck — that path falls through to source-only
    // retry below, leaving the healthy destination in place.
    if (timedOut && !poll.destinationReachableObserved) {
      await this.cleanupTimedOutDeploy(
        workloadName,
        proposal,
        ts,
        action,
        writeJournalEntry,
        removeWorkload,
      );
      return;
    }

    const reachable = await this.observeDestinationReachable(poll);
    if (!reachable) return; // still waiting — leave in pending for the next tick

    await this.completeMoveBySourceRemoval(
      workloadName,
      proposal,
      ts,
      action,
      writeJournalEntry,
      removeWorkload,
    );
  }

  private buildMoveAction(proposal: MoveProposal): FleetExecutionEntry["action"] {
    return {
      type: "move",
      workload: proposal.workload,
      fromNode: proposal.fromNode,
      toNode: proposal.toNode,
      reason: "rebalance",
    };
  }

  private async observeDestinationReachable(poll: PendingHealthPoll): Promise<boolean> {
    // Once reachability has been observed, commit to source-removal until it
    // drains. Re-probing the destination here could flap on a transient miss
    // and would re-introduce the false-timeout-destroy hazard.
    if (poll.destinationReachableObserved) return true;
    const snapshot = await this.safeFetchSnapshot(poll.proposal.toNode);
    const reachable =
      snapshot?.workloads?.some(
        (entry) => entry.name === poll.proposal.workload && entry.reachable,
      ) ?? false;
    if (reachable) poll.destinationReachableObserved = true;
    return reachable;
  }

  private async cleanupTimedOutDeploy(
    workloadName: string,
    proposal: MoveProposal,
    ts: string,
    action: FleetExecutionEntry["action"],
    writeJournalEntry: (entry: FleetJournalEntry) => void,
    removeWorkload: (workloadName: string, fromNode: string) => Promise<void>,
  ): Promise<void> {
    try {
      await removeWorkload(proposal.workload, proposal.toNode);
    } catch (err) {
      writeJournalEntry({
        kind: "fleet-execution",
        ts,
        node: this.deps.selfNode,
        proposalId: proposal.proposalId,
        action,
        status: "failed",
        reason: `timeout waiting for destination health; destination cleanup failed: ${(err as Error).message}; will retry`,
      });
      return;
    }
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
  }

  private async completeMoveBySourceRemoval(
    workloadName: string,
    proposal: MoveProposal,
    ts: string,
    action: FleetExecutionEntry["action"],
    writeJournalEntry: (entry: FleetJournalEntry) => void,
    removeWorkload: (workloadName: string, fromNode: string) => Promise<void>,
  ): Promise<void> {
    try {
      await removeWorkload(proposal.workload, proposal.fromNode);
    } catch (err) {
      writeJournalEntry({
        kind: "fleet-execution",
        ts,
        node: this.deps.selfNode,
        proposalId: proposal.proposalId,
        action,
        status: "failed",
        reason: `remove failed: ${(err as Error).message}; will retry`,
      });
      return;
    }
    this.pendingHealthPolls.delete(workloadName);
    writeJournalEntry({
      kind: "fleet-execution",
      ts,
      node: this.deps.selfNode,
      proposalId: proposal.proposalId,
      action,
      status: "executed",
    });
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
