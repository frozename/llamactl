/* eslint-disable @typescript-eslint/require-await -- Test doubles implement async migration contracts without artificial scheduling. */
import { beforeEach, describe, expect, it } from "bun:test";

import type {
  FleetExecutionEntry,
  FleetJournalEntry,
  MoveProposal,
  NodeMemSnapshot,
  WorkloadSnapshot,
} from "../src/types.js";

import { evaluateMigrationWorkloads } from "../src/loop-helpers.js";
import { MigrationController, type NodeSnapshot } from "../src/migration-controller.js";

describe("migration safe-path: non-blocking health poll, apply_failed cooldown, pinned guard", () => {
  let nowMs = 1_700_000_000_000;
  let tick = 100;
  let snapshots: Record<string, NodeSnapshot>;
  let journal: FleetJournalEntry[];
  let applyCalls: { workload: string; toNode: string }[];
  let deleteCalls: { workload: string; fromNode: string }[];
  let sleepCalls: number;

  function makeController(
    overrides: Partial<ConstructorParameters<typeof MigrationController>[0]> = {},
  ): MigrationController {
    return new MigrationController({
      peers: ["m2mini"],
      fetchSnapshot: async (node): Promise<NodeSnapshot> =>
        snapshots[node] ?? {
          node,
          pressureState: "NORMAL",
          nodeMem: { freeMb: 4096 },
          workloads: [],
        },
      deployWorkload: async (workload, toNode): Promise<void> => {
        applyCalls.push({ workload, toNode });
      },
      removeWorkload: async (workload, fromNode): Promise<void> => {
        deleteCalls.push({ workload, fromNode });
      },
      leaseholder: "m4pro",
      getNowMs: (): number => nowMs,
      getCurrentTick: (): number => tick,
      healthTimeoutMs: 5_000,
      pollIntervalMs: 1_000,
      sleep: async (): Promise<void> => {
        sleepCalls++;
        nowMs += 100;
      },
      ...overrides,
    });
  }

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

  beforeEach(() => {
    nowMs = 1_700_000_000_000;
    tick = 100;
    snapshots = {};
    journal = [];
    applyCalls = [];
    deleteCalls = [];
    sleepCalls = 0;
  });

  // ── FIX 2: apply_failed must arm the move cooldown ────────────────────────

  it("FIX2: apply_failed arms move cooldown so next-tick evaluateMove skips the workload", async () => {
    const ctrl = makeController({
      deployWorkload: async (): Promise<void> => {
        throw new Error("cluster refused");
      },
    });
    snapshots.m2mini = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [],
    };

    const result = await ctrl.executeMove(makeProposal(), (e) => journal.push(e));
    expect(result).toBe("apply_failed");
    expect(ctrl.isInMoveCooldown("model-a")).toBe(true);
  });

  // ── FIX 1: executeMove must not block the tick ────────────────────────────

  it("FIX1: executeMove returns pending_health_check without sleeping when destination not yet healthy", async () => {
    const ctrl = makeController({ healthTimeoutMs: 60_000 });
    snapshots.m2mini = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [{ name: "model-a", reachable: false }],
    };

    const result = await ctrl.executeMove(makeProposal(), (e) => journal.push(e));
    expect(result).toBe("pending_health_check");
    expect(sleepCalls).toBe(0);
    expect(applyCalls).toHaveLength(1);
    expect(deleteCalls).toHaveLength(0);
  });

  it("FIX1: advancePendingHealthPolls executes the move when destination becomes reachable", async () => {
    const ctrl = makeController();
    snapshots.m2mini = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [{ name: "model-a", reachable: false }],
    };

    await ctrl.executeMove(makeProposal(), (e) => journal.push(e));
    expect(deleteCalls).toHaveLength(0);

    snapshots.m2mini = {
      ...snapshots.m2mini,
      workloads: [{ name: "model-a", reachable: true }],
    };

    await ctrl.advancePendingHealthPolls();
    expect(deleteCalls).toHaveLength(1);
    const executed = journal.find(
      (e): e is FleetExecutionEntry => e.kind === "fleet-execution" && e.status === "executed",
    );
    expect(executed).toBeTruthy();
    expect(executed?.proposalId).toBe("move-1");
  });

  it("FIX1: advancePendingHealthPolls journals timed_out failure when deadline passes without health", async () => {
    const ctrl = makeController({ healthTimeoutMs: 1_000 });
    snapshots.m2mini = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [{ name: "model-a", reachable: false }],
    };

    await ctrl.executeMove(makeProposal(), (e) => journal.push(e));
    nowMs += 2_000; // advance past healthTimeoutMs

    await ctrl.advancePendingHealthPolls();
    expect(deleteCalls).toHaveLength(0);
    const failed = journal.find(
      (e): e is FleetExecutionEntry =>
        e.kind === "fleet-execution" &&
        e.status === "failed" &&
        (e.reason ?? "").includes("timeout"),
    );
    expect(failed).toBeTruthy();
  });

  it("FIX1: advancePendingHealthPolls leaves poll pending when destination still unreachable within deadline", async () => {
    const ctrl = makeController({ healthTimeoutMs: 10_000 });
    snapshots.m2mini = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [{ name: "model-a", reachable: false }],
    };

    await ctrl.executeMove(makeProposal(), (e) => journal.push(e));

    // First advance: still not reachable, within deadline
    await ctrl.advancePendingHealthPolls();
    expect(deleteCalls).toHaveLength(0);
    expect(
      journal.find(
        (e): e is FleetExecutionEntry =>
          e.kind === "fleet-execution" && (e.status === "executed" || e.status === "failed"),
      ),
    ).toBeUndefined();
  });

  // ── FIX 3: pinned guard must work in the live path ────────────────────────

  it("FIX3: evaluateMigrationWorkloads never proposes a move for a workload with placement=pinned", async () => {
    const ctrl = makeController();
    snapshots.m2mini = {
      node: "m2mini",
      schedulerLeaseHolder: "m4pro",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [],
    };

    const workloads: WorkloadSnapshot[] = [
      {
        name: "model-pinned",
        kind: "ModelRun" as const,
        endpoint: "http://127.0.0.1:8080",
        priority: 50,
        rss_mb: null,
        request_rate_5m: null,
        error_rate_5m: 0,
        p50_ms: 100,
        p95_ms: 200,
        models: [],
        reachable: true,
        consecutiveErrors: 0,
        placement: "pinned",
      },
    ];

    const nodeMem: NodeMemSnapshot = {
      free_mb: 200,
      active_mb: 0,
      inactive_mb: 0,
      wired_mb: 0,
      compressor_mb: 0,
      swap_in: 0,
      swap_out: 0,
    };

    await evaluateMigrationWorkloads(
      new Date(nowMs).toISOString(),
      "m4pro",
      workloads,
      nodeMem,
      true,
      ctrl,
      (e) => journal.push(e),
    );

    expect(applyCalls).toHaveLength(0);
    expect(
      journal.filter((e) => e.kind === "fleet-proposal" && e.action.type === "move"),
    ).toHaveLength(0);
  });
});
