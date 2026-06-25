/* eslint-disable @typescript-eslint/require-await -- Test doubles implement async controller contracts without artificial scheduling. */
import { describe, expect, it } from "bun:test";

import type {
  FleetSnapshotEntry,
  MoveProposal,
  NodeMemSnapshot,
  WorkloadSnapshot,
} from "../src/types.js";
import type { WorkloadTarget } from "../src/workload-probe.js";

import { startSupervisorLoop } from "../src/loop.js";
import { MigrationController, type NodeSnapshot } from "../src/migration-controller.js";

const HIGH_MEM: NodeMemSnapshot = {
  free_mb: 30,
  active_mb: 0,
  inactive_mb: 0,
  wired_mb: 0,
  compressor_mb: 4000,
  swap_in: 0,
  swap_out: 0,
};

const NORMAL_MEM: NodeMemSnapshot = {
  free_mb: 4096,
  active_mb: 0,
  inactive_mb: 0,
  wired_mb: 0,
  compressor_mb: 100,
  swap_in: 0,
  swap_out: 0,
};

const TARGET: WorkloadTarget = {
  name: "model-a",
  endpoint: "http://127.0.0.1:8090",
  kind: "ModelHost",
  priority: 50,
  expectedMemoryMb: 1024,
};

function makeReachable(t: WorkloadTarget): WorkloadSnapshot {
  return {
    name: t.name,
    kind: t.kind,
    endpoint: t.endpoint,
    priority: t.priority ?? 50,
    ...(t.expectedMemoryMb !== undefined ? { expectedMemoryMb: t.expectedMemoryMb } : {}),
    rss_mb: null,
    request_rate_5m: null,
    error_rate_5m: 0,
    p50_ms: 10,
    p95_ms: 10,
    models: [],
    reachable: true,
    consecutiveErrors: 0,
  };
}

describe("supervisor runTick — inFlightMoves reflect this tick's migration changes", () => {
  // Defect: the published fleet-snapshot's inFlightMoves was read BEFORE
  // evaluateMigrationWorkloads ran (loop.ts:~204 before fix). evaluateMigrationWorkloads
  // is what (a) drains completed health-polls (so a completed move leaves
  // inFlightMoves) and (b) starts new moves via executeMove (so a started move
  // enters inFlightMoves). The stale read caused a ~30s blind spot in the
  // cross-node double-move guard: a move STARTED in tick N was not published
  // until tick N+1, so a peer could not see it and could begin a second
  // concurrent move of the same workload.
  //
  // Invariant under test: a move started in tick N is present in tick N's
  // published snapshot, and a move completed in tick N is absent from tick N's
  // published snapshot.

  it("publishes a move STARTED during this tick in this tick's snapshot (not next)", async () => {
    let deployCalls = 0;
    const controller = new MigrationController({
      peers: ["m2mini"],
      fetchSnapshot: async (node): Promise<NodeSnapshot> => ({
        node,
        pressureState: "NORMAL",
        nodeMem: { freeMb: 16_000 },
        // Destination workloads list is empty so the post-deploy health poll
        // never observes the destination reachable — the move stays pending in
        // pendingHealthPolls, keeping it in getInFlightMoves() for subsequent
        // ticks. The point being tested is which TICK first publishes it.
        workloads: [],
      }),
      deployWorkload: async (): Promise<void> => {
        deployCalls += 1;
      },
      removeWorkload: async (): Promise<void> => undefined,
      selfNode: "local",
      getLeaseHolder: (): string | null => "local",
      healthTimeoutMs: 10_000_000,
    });

    type Sample = { tick: number; deploys: number; inFlightCount: number };
    const samples: Sample[] = [];
    let tickIdx = 0;

    const handle = startSupervisorLoop({
      node: "local",
      intervalMs: 1,
      workloads: [TARGET],
      probeNodeMem: async () => {
        tickIdx += 1;
        if (tickIdx >= 6) handle.stop();
        return HIGH_MEM;
      },
      probeWorkload: async (t) => makeReachable(t),
      migrationController: controller,
      writeJournal: () => undefined,
      onTick: (snapshot) => {
        samples.push({
          tick: tickIdx,
          deploys: deployCalls,
          inFlightCount: snapshot.inFlightMoves?.length ?? 0,
        });
      },
      pressureThresholds: {
        headroomMinMb: 512,
        compressorWarnMb: 2048,
        consecutiveTicks: 3,
        clearTicks: 5,
      },
      pressureStatusEveryTicks: 0,
    });
    await handle.done;

    // Sanity: the loop did actually deploy.
    expect(deployCalls).toBeGreaterThan(0);

    // The first tick at which any deploy has occurred MUST have already
    // published that in-flight move in its own snapshot. With the buggy read
    // order this would be 0 (the move is invisible until the next tick).
    const firstDeployedSample = samples.find((s) => s.deploys > 0);
    expect(firstDeployedSample).toBeDefined();
    expect(firstDeployedSample?.inFlightCount).toBeGreaterThan(0);
  });

  it("omits a move COMPLETED during this tick from this tick's snapshot", async () => {
    const nowMs = 1_700_000_000_000;
    let removeCalls = 0;
    // Destination reports the workload as reachable, so advancePendingHealthPolls
    // during the upcoming tick observes the deploy as healthy and removes the
    // source — completing the move (drops it from pendingHealthPolls).
    const controller = new MigrationController({
      peers: ["m2mini"],
      fetchSnapshot: async (node): Promise<NodeSnapshot> => ({
        node,
        pressureState: "NORMAL",
        nodeMem: { freeMb: 16_000 },
        workloads: [{ name: "model-a", reachable: true }],
      }),
      deployWorkload: async (): Promise<void> => undefined,
      removeWorkload: async (): Promise<void> => {
        removeCalls += 1;
      },
      selfNode: "local",
      getLeaseHolder: (): string | null => "local",
      getNowMs: (): number => nowMs,
      healthTimeoutMs: 10_000_000,
    });

    // Pre-deploy a move so pendingHealthPolls is non-empty going into the tick;
    // this is the "carried in from the prior tick" state.
    const proposal: MoveProposal = {
      workload: "model-a",
      fromNode: "local",
      toNode: "m2mini",
      proposalId: "move-1",
      evictProposalId: "evict-1",
      expiresAt: new Date(nowMs + 30_000).toISOString(),
      expiresAtMs: nowMs + 30_000,
    };
    await controller.executeMove(proposal, () => undefined);
    expect(controller.getInFlightMoves()).toHaveLength(1);

    const snapshots: FleetSnapshotEntry[] = [];
    const handle = startSupervisorLoop({
      node: "local",
      once: true,
      workloads: [TARGET],
      probeNodeMem: async () => NORMAL_MEM,
      probeWorkload: async (t) => makeReachable(t),
      migrationController: controller,
      writeJournal: (entry) => {
        if (entry.kind === "fleet-snapshot") snapshots.push(entry);
      },
    });
    await handle.done;

    // Sanity: the move actually completed during the test tick.
    expect(removeCalls).toBe(1);
    expect(controller.getInFlightMoves()).toHaveLength(0);

    // The single snapshot from this tick must reflect the post-completion
    // state — no stale lingering move. With the buggy read order the snapshot
    // would carry the now-completed move for one extra tick.
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.inFlightMoves).toBeUndefined();
  });
});
