/* eslint-disable @typescript-eslint/require-await -- Test doubles implement async migration contracts without artificial scheduling. */
import { describe, expect, it } from "bun:test";

import type { FleetJournalEntry, MoveProposal } from "../src/types.js";

import {
  MigrationController,
  type MigrationControllerDeps,
  type NodeSnapshot,
} from "../src/migration-controller.js";

/**
 * PR-3 partition-safety (design §2 split-brain self-demotion + §4 lease-loss
 * mid-operation; failure modes F2 and F3 in §6). Each test isolates one PR-3
 * invariant; destinations always have ample free memory so the ONLY gate under
 * test is the lease/partition guard.
 */

const SOURCE: NodeSnapshot = {
  node: "m4pro",
  pressureState: "HIGH",
  nodeMem: { freeMb: 100 },
  workloads: [],
};

const WORKLOAD = {
  name: "model-a",
  node: "m4pro",
  spec: { placement: "auto" as const },
  evictProposalId: "evict-1",
};

function freshDestSnapshot(node: string): NodeSnapshot {
  return {
    node,
    pressureState: "NORMAL",
    nodeMem: { freeMb: 16_000 },
    workloads: [],
  };
}

function makeController(
  overrides: Partial<MigrationControllerDeps> = {},
  nowMs = 1_700_000_000_000,
): MigrationController {
  return new MigrationController({
    peers: ["m2mini", "m4pro"],
    fetchSnapshot: async (node): Promise<NodeSnapshot> => freshDestSnapshot(node),
    deployWorkload: async (): Promise<void> => undefined,
    removeWorkload: async (): Promise<void> => undefined,
    selfNode: "m4pro",
    getLeaseHolder: (): string | null => "m4pro",
    getNowMs: (): number => nowMs,
    getCurrentTick: (): number => 100,
    healthTimeoutMs: 5,
    pollIntervalMs: 1,
    ...overrides,
  });
}

describe("PR-3 partition self-demotion (design §2 / F2)", () => {
  it("F2: holder self-demotes (no move) when it can see NO fresh destination peer", async () => {
    // Partitioned-but-alive holder: getLeaseHolder still names self (its own
    // lease intent is fresh), but the holder cannot see any fresh destination
    // peer (partition). It must demote and emit no move.
    const partitioned = makeController({
      getLeaseHolder: (): string | null => "m4pro",
      canSeeFreshDestinationPeer: (): boolean => false,
    });

    const result = await partitioned.evaluateMove(WORKLOAD, SOURCE);
    expect(result).toBeNull();
  });

  it("HEALTHY: holder does NOT demote when it sees a fresh destination peer (behavior-preserving)", async () => {
    // Single-eligible prod: self is the only lease-eligible node, but a fresh
    // (ineligible) destination peer is visible. No demotion — migrations proceed
    // exactly as today.
    const healthy = makeController({
      getLeaseHolder: (): string | null => "m4pro",
      canSeeFreshDestinationPeer: (): boolean => true,
    });

    const result = await healthy.evaluateMove(WORKLOAD, SOURCE);
    expect(result).not.toBeNull();
    expect(result?.toNode).toBe("m2mini");
  });

  it("HEALTHY (default): absent the partition dep, behavior is unchanged (move emitted)", async () => {
    // PR-2 / existing call-sites do not inject canSeeFreshDestinationPeer; the
    // self-demotion must be opt-in and never suppress a move by default.
    const legacy = makeController();
    const result = await legacy.evaluateMove(WORKLOAD, SOURCE);
    expect(result).not.toBeNull();
    expect(result?.toNode).toBe("m2mini");
  });

  it("F2 (successor takeover): when self is NOT the holder, no move regardless of destination visibility", async () => {
    const notHolder = makeController({
      getLeaseHolder: (): string | null => "m2mini",
      canSeeFreshDestinationPeer: (): boolean => true,
    });
    const result = await notHolder.evaluateMove(WORKLOAD, SOURCE);
    expect(result).toBeNull();
  });
});

describe("PR-3 lease-loss mid-operation (design §4 / F3)", () => {
  it("F3: advancePendingHealthPolls COMPLETES a pending move even after the lease is lost", async () => {
    const journal: FleetJournalEntry[] = [];
    const deleteCalls: { workload: string; fromNode: string }[] = [];
    let leaseHolder = "m4pro"; // self holds at start
    let reachable = false;
    const nowMs = 1_700_000_000_000;

    const controller = makeController(
      {
        getLeaseHolder: (): string | null => leaseHolder,
        fetchSnapshot: async (node): Promise<NodeSnapshot> => ({
          node,
          pressureState: "NORMAL",
          nodeMem: { freeMb: 16_000 },
          workloads: reachable ? [{ name: "model-a", reachable: true }] : [],
        }),
        removeWorkload: async (workload, fromNode): Promise<void> => {
          deleteCalls.push({ workload, fromNode });
        },
        healthTimeoutMs: 5_000,
      },
      nowMs,
    );

    const proposal: MoveProposal = {
      workload: "model-a",
      fromNode: "m4pro",
      toNode: "m2mini",
      proposalId: "move-1",
      evictProposalId: "evict-1",
      expiresAt: new Date(nowMs + 30_000).toISOString(),
      expiresAtMs: nowMs + 30_000,
    };

    // Start the move while self holds the lease: deploy succeeds, pending poll armed.
    const started = await controller.executeMove(proposal, (entry) => journal.push(entry));
    expect(started).toBe("pending_health_check");
    expect(deleteCalls).toHaveLength(0);

    // LEASE LOST: a successor is now the holder. New proposals are gated (F2),
    // but the in-flight move MUST still complete (poll -> remove source).
    leaseHolder = "m2mini";
    reachable = true;

    await controller.advancePendingHealthPolls();

    // The source removal completed despite the lost lease — converged to one copy.
    expect(deleteCalls).toEqual([{ workload: "model-a", fromNode: "m4pro" }]);
    const executed = journal.find(
      (entry) => entry.kind === "fleet-execution" && entry.status === "executed",
    );
    expect(executed).toBeTruthy();
  });
});

describe("PR-3 in-flight-move publication (design §2 / §4)", () => {
  it("publishes the in-flight move intent so a successor can honor it", async () => {
    const journal: FleetJournalEntry[] = [];
    const nowMs = 1_700_000_000_000;
    const controller = makeController({}, nowMs);

    // No in-flight move yet.
    expect(controller.getInFlightMoves()).toEqual([]);

    const proposal: MoveProposal = {
      workload: "model-a",
      fromNode: "m4pro",
      toNode: "m2mini",
      proposalId: "move-1",
      evictProposalId: "evict-1",
      expiresAt: new Date(nowMs + 30_000).toISOString(),
      expiresAtMs: nowMs + 30_000,
    };

    await controller.executeMove(proposal, (entry) => journal.push(entry));

    // The half-done move (deployed on dest, not yet removed from source) is
    // published so a successor honors it via cooldown.
    const inFlight = controller.getInFlightMoves();
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0]).toMatchObject({
      workload: "model-a",
      fromNode: "m4pro",
      toNode: "m2mini",
      proposalId: "move-1",
    });
  });

  it("drops the published intent once the move completes (source removed)", async () => {
    const journal: FleetJournalEntry[] = [];
    const nowMs = 1_700_000_000_000;
    const controller = makeController(
      {
        fetchSnapshot: async (node): Promise<NodeSnapshot> => ({
          node,
          pressureState: "NORMAL",
          nodeMem: { freeMb: 16_000 },
          workloads: [{ name: "model-a", reachable: true }],
        }),
      },
      nowMs,
    );

    const proposal: MoveProposal = {
      workload: "model-a",
      fromNode: "m4pro",
      toNode: "m2mini",
      proposalId: "move-1",
      evictProposalId: "evict-1",
      expiresAt: new Date(nowMs + 30_000).toISOString(),
      expiresAtMs: nowMs + 30_000,
    };

    await controller.executeMove(proposal, (entry) => journal.push(entry));
    expect(controller.getInFlightMoves()).toHaveLength(1);

    await controller.advancePendingHealthPolls();
    expect(controller.getInFlightMoves()).toEqual([]);
  });
});
