/* eslint-disable @typescript-eslint/require-await -- Test doubles implement async migration contracts without artificial scheduling. */
import { beforeEach, describe, expect, it } from "bun:test";

import type { FleetExecutionEntry, FleetJournalEntry, MoveProposal } from "../src/types.js";

import { MigrationController, type NodeSnapshot } from "../src/migration-controller.js";

describe("migration-controller cross-node safety: destination preservation + lease re-check", () => {
  let nowMs = 1_700_000_000_000;
  let snapshots: Record<string, NodeSnapshot>;
  let journal: FleetJournalEntry[];
  let applyCalls: { workload: string; toNode: string }[];
  let removeCalls: { workload: string; fromNode: string }[];

  beforeEach(() => {
    nowMs = 1_700_000_000_000;
    snapshots = {};
    journal = [];
    applyCalls = [];
    removeCalls = [];
  });

  function makeProposal(overrides: Partial<MoveProposal> = {}): MoveProposal {
    return {
      workload: "model-a",
      fromNode: "m4pro",
      toNode: "m2mini",
      proposalId: "move-1",
      evictProposalId: "evict-1",
      expiresAt: new Date(nowMs + 30_000).toISOString(),
      expiresAtMs: nowMs + 30_000,
      ...overrides,
    };
  }

  // ── DEFECT A: a healthy destination must not be destroyed just because the
  //    source could not be cleaned up. Once destination reachability is observed,
  //    a subsequent timeout in advancePendingHealthPolls must retry SOURCE
  //    removal only — it must NOT call removeWorkload(toNode).
  // ──────────────────────────────────────────────────────────────────────────

  it("DEFECT-A: once destination is reachable, source-removal failures past timeout never delete the destination", async () => {
    let removeAttemptsFromSource = 0;

    const ctrl = new MigrationController({
      peers: ["m2mini"],
      fetchSnapshot: async (node): Promise<NodeSnapshot> =>
        snapshots[node] ?? {
          node,
          pressureState: "NORMAL",
          nodeMem: { freeMb: 4096 },
          workloads: [],
        },
      deployWorkload: async (w, toNode): Promise<void> => {
        applyCalls.push({ workload: w, toNode });
      },
      removeWorkload: async (w, fromNode): Promise<void> => {
        if (fromNode === "m4pro") {
          removeAttemptsFromSource += 1;
          throw new Error("source stop refused");
        }
        // Track destination removal attempts so we can assert they never happen.
        removeCalls.push({ workload: w, fromNode });
      },
      selfNode: "m4pro",
      getLeaseHolder: (): string | null => "m4pro",
      getNowMs: (): number => nowMs,
      healthTimeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });

    // Destination has the workload deployed and reachable.
    snapshots["m2mini"] = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [{ name: "model-a", reachable: true }],
    };

    // Step 1: kick off the move. Returns pending_health_check.
    const result = await ctrl.executeMove(makeProposal(), (entry) => journal.push(entry));
    expect(result).toBe("pending_health_check");
    expect(applyCalls).toHaveLength(1);

    // Step 2: first poll — destination is reachable, source removal throws.
    await ctrl.advancePendingHealthPolls();
    expect(removeAttemptsFromSource).toBe(1);
    expect(removeCalls).toHaveLength(0); // no destination removal so far
    expect(ctrl.getInFlightMoves()).toHaveLength(1);
    expect(
      journal.find(
        (e): e is FleetExecutionEntry =>
          e.kind === "fleet-execution" &&
          e.status === "failed" &&
          (e.reason ?? "").includes("remove failed"),
      ),
    ).toBeTruthy();

    // Step 3: advance time well past healthTimeoutMs so the naive timeout
    // branch would trigger. Source removal is still failing.
    nowMs += 10_000;
    await ctrl.advancePendingHealthPolls();
    // Step 4: even more time passes; still no destination removal allowed.
    nowMs += 10_000;
    await ctrl.advancePendingHealthPolls();

    // Destination must never have been removed — it is the healthy copy.
    expect(removeCalls.some((c) => c.fromNode === "m2mini")).toBe(false);
    expect(removeCalls).toHaveLength(0);

    // Source-removal must have been retried at least once more after the
    // initial attempt (i.e. the timeout/failure path retries source-only).
    expect(removeAttemptsFromSource).toBeGreaterThanOrEqual(2);

    // Poll must still be pending (it's a half-done move — destination healthy,
    // source dirty — and the operator/source cleanup still has to drain it).
    expect(ctrl.getInFlightMoves()).toHaveLength(1);

    // No "timeout waiting for destination health" failure was journaled either —
    // that branch is for genuinely-failed deploys, not for stuck source cleanups.
    expect(
      journal.find(
        (e): e is FleetExecutionEntry =>
          e.kind === "fleet-execution" &&
          e.status === "failed" &&
          (e.reason ?? "").includes("timeout waiting for destination health"),
      ),
    ).toBeUndefined();
  });

  it("DEFECT-A: source eventually succeeding after timeout drains the pending move with executed status", async () => {
    let removeAttemptsFromSource = 0;

    const ctrl = new MigrationController({
      peers: ["m2mini"],
      fetchSnapshot: async (node): Promise<NodeSnapshot> =>
        snapshots[node] ?? {
          node,
          pressureState: "NORMAL",
          nodeMem: { freeMb: 4096 },
          workloads: [],
        },
      deployWorkload: async (w, toNode): Promise<void> => {
        applyCalls.push({ workload: w, toNode });
      },
      removeWorkload: async (w, fromNode): Promise<void> => {
        if (fromNode === "m4pro") {
          removeAttemptsFromSource += 1;
          if (removeAttemptsFromSource < 3) throw new Error("source still busy");
          return;
        }
        removeCalls.push({ workload: w, fromNode });
      },
      selfNode: "m4pro",
      getLeaseHolder: (): string | null => "m4pro",
      getNowMs: (): number => nowMs,
      healthTimeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });

    snapshots["m2mini"] = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [{ name: "model-a", reachable: true }],
    };

    await ctrl.executeMove(makeProposal(), (entry) => journal.push(entry));

    // First poll: dest reachable, source removal #1 fails.
    await ctrl.advancePendingHealthPolls();
    // Push past timeout.
    nowMs += 10_000;
    // Second poll past timeout: source removal #2 fails — must NOT delete dest.
    await ctrl.advancePendingHealthPolls();
    // Third poll past timeout: source removal #3 succeeds; move drains.
    await ctrl.advancePendingHealthPolls();

    expect(removeCalls.some((c) => c.fromNode === "m2mini")).toBe(false);
    expect(removeAttemptsFromSource).toBe(3);
    expect(ctrl.getInFlightMoves()).toHaveLength(0);
    expect(
      journal.find(
        (e): e is FleetExecutionEntry => e.kind === "fleet-execution" && e.status === "executed",
      ),
    ).toBeTruthy();
  });

  // ── DEFECT B: split-brain double-deploy. evaluateMove reads the lease holder
  //    before the async findBestDestination resolves; executeMove never
  //    re-checks. A node that lost the lease during destination selection
  //    must NOT deploy on top of the new holder.
  // ──────────────────────────────────────────────────────────────────────────

  it("DEFECT-B: executeMove refuses (no deploy, no source removal) when getLeaseHolder no longer names self", async () => {
    let holder: string | null = "m4pro";

    const ctrl = new MigrationController({
      peers: ["m2mini"],
      fetchSnapshot: async (node): Promise<NodeSnapshot> =>
        snapshots[node] ?? {
          node,
          pressureState: "NORMAL",
          nodeMem: { freeMb: 4096 },
          workloads: [],
        },
      deployWorkload: async (w, toNode): Promise<void> => {
        applyCalls.push({ workload: w, toNode });
      },
      removeWorkload: async (w, fromNode): Promise<void> => {
        removeCalls.push({ workload: w, fromNode });
      },
      selfNode: "m4pro",
      getLeaseHolder: (): string | null => holder,
      getNowMs: (): number => nowMs,
      healthTimeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });

    snapshots["m2mini"] = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [],
    };

    // Lease ownership changes between proposal-emission and executeMove —
    // simulating the async window after findBestDestination resolved.
    holder = "m2mini";

    const result = await ctrl.executeMove(makeProposal(), (entry) => journal.push(entry));

    expect(result).toBe("lease_lost");
    expect(applyCalls).toHaveLength(0);
    expect(removeCalls).toHaveLength(0);
    // No move proposal, no skipped-evict, no pending poll: we backed out cleanly.
    expect(ctrl.getInFlightMoves()).toHaveLength(0);
    expect(
      journal.some(
        (e) => e.kind === "fleet-execution" && e.proposalId === "evict-1" && e.status === "skipped",
      ),
    ).toBe(false);
    expect(journal.some((e) => e.kind === "fleet-proposal")).toBe(false);
  });

  it("DEFECT-B: executeMove proceeds normally when lease holder still names self at execution time", async () => {
    const ctrl = new MigrationController({
      peers: ["m2mini"],
      fetchSnapshot: async (node): Promise<NodeSnapshot> =>
        snapshots[node] ?? {
          node,
          pressureState: "NORMAL",
          nodeMem: { freeMb: 4096 },
          workloads: [],
        },
      deployWorkload: async (w, toNode): Promise<void> => {
        applyCalls.push({ workload: w, toNode });
      },
      removeWorkload: async (w, fromNode): Promise<void> => {
        removeCalls.push({ workload: w, fromNode });
      },
      selfNode: "m4pro",
      getLeaseHolder: (): string | null => "m4pro",
      getNowMs: (): number => nowMs,
      healthTimeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });

    snapshots["m2mini"] = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [{ name: "model-a", reachable: true }],
    };

    const result = await ctrl.executeMove(makeProposal(), (entry) => journal.push(entry));
    expect(result).toBe("pending_health_check");
    expect(applyCalls).toHaveLength(1);
  });
});
