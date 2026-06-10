/* eslint-disable @typescript-eslint/require-await -- Test doubles implement async migration contracts without artificial scheduling. */
import { beforeEach, describe, expect, it } from "bun:test";

import type { FleetExecutionEntry, FleetJournalEntry, MoveProposal } from "../src/types.js";

import {
  MIGRATION_POLICY_DEFAULTS,
  MigrationController,
  type NodeSnapshot,
} from "../src/migration-controller.js";

describe("MigrationController", () => {
  let nowMs = 1_700_000_000_000;
  let tick = 100;
  let snapshots: Record<string, NodeSnapshot>;
  let journal: FleetJournalEntry[];
  let applyCalls: { workload: string; toNode: string }[];
  let deleteCalls: { workload: string; fromNode: string }[];
  let controller: MigrationController;

  beforeEach(() => {
    nowMs = 1_700_000_000_000;
    tick = 100;
    snapshots = {};
    journal = [];
    applyCalls = [];
    deleteCalls = [];

    controller = new MigrationController({
      peers: ["m2mini", "m4pro"],
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
      healthTimeoutMs: 5,
      pollIntervalMs: 1,
      sleep: async (): Promise<void> => {
        nowMs += 1;
      },
    });
  });

  const workload = {
    name: "model-a",
    node: "m4pro",
    spec: { placement: "auto" },
    evictProposalId: "evict-1",
  };

  const sourceSnapshot: NodeSnapshot = {
    node: "m4pro",
    schedulerLeaseHolder: "m4pro",
    pressureState: "HIGH",
    nodeMem: { freeMb: 100 },
    workloads: [],
  };

  function proposal(overrides: Partial<MoveProposal> = {}): MoveProposal {
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

  function executionEntryMatches(
    status: FleetExecutionEntry["status"],
  ): (entry: FleetJournalEntry) => entry is FleetExecutionEntry {
    return (entry: FleetJournalEntry): entry is FleetExecutionEntry =>
      entry.kind === "fleet-execution" && entry.status === status;
  }

  it("F24: MIGRATION_POLICY_DEFAULTS exposes the policy baseline", () => {
    expect(MIGRATION_POLICY_DEFAULTS).toEqual({
      moveProposalTtlMs: 30_000,
      moveCooldownTicks: 10,
      healthTimeoutMs: 300_000,
      minDestinationFreeMb: 512,
    });
  });

  it("T1: evaluateMove returns null when not scheduler leaseholder", async () => {
    const result = await controller.evaluateMove(workload, {
      ...sourceSnapshot,
      schedulerLeaseHolder: "m2mini",
    });
    expect(result).toBeNull();
  });

  it("T2: evaluateMove returns null when workload is pinned (spec.placement: pinned)", async () => {
    const result = await controller.evaluateMove(
      { ...workload, spec: { placement: "pinned" as const } },
      sourceSnapshot,
    );
    expect(result).toBeNull();
  });

  it("T3: evaluateMove returns null while move cooldown is active", async () => {
    controller.markMoveInFlight(workload.name);
    tick += 5;
    const result = await controller.evaluateMove(workload, sourceSnapshot);
    expect(result).toBeNull();
  });

  it("T4: evaluateMove returns null when no viable destination node exists", async () => {
    snapshots.m2mini = {
      node: "m2mini",
      pressureState: "HIGH",
      nodeMem: { freeMb: 200 },
      workloads: [],
    };
    snapshots.m4pro = {
      node: "m4pro",
      pressureState: "HIGH",
      nodeMem: { freeMb: 100 },
      workloads: [],
    };

    const result = await controller.evaluateMove(workload, sourceSnapshot);
    expect(result).toBeNull();
  });

  it("T5: evaluateMove returns MoveProposal with from/to and ttl fields when destination exists", async () => {
    snapshots.m2mini = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [],
    };

    const result = await controller.evaluateMove(workload, sourceSnapshot);
    expect(result).not.toBeNull();
    expect(result?.fromNode).toBe("m4pro");
    expect(result?.toNode).toBe("m2mini");
    expect(result?.expiresAt).toBeTruthy();
    expect(result?.expiresAtMs).toBe(nowMs + MIGRATION_POLICY_DEFAULTS.moveProposalTtlMs);
  });

  it("T6: markMoveInFlight activates cooldown until moveCooldownTicks elapse", () => {
    expect(controller.isInMoveCooldown(workload.name)).toBe(false);
    controller.markMoveInFlight(workload.name);
    expect(controller.isInMoveCooldown(workload.name)).toBe(true);
    tick += 10;
    expect(controller.isInMoveCooldown(workload.name)).toBe(false);
  });

  it("F14: seeds in-flight cooldown from readRecentMoves on construction", () => {
    const seeded = new MigrationController({
      peers: ["m2mini"],
      fetchSnapshot: async (): Promise<NodeSnapshot> => ({
        node: "m2mini",
        schedulerLeaseHolder: "m4pro",
        pressureState: "NORMAL",
        nodeMem: { freeMb: 4096 },
        workloads: [],
      }),
      leaseholder: "m4pro",
      getNowMs: (): number => nowMs,
      moveCooldownTicks: 10,
      pollIntervalMs: 100,
      readRecentMoves: (): { workload: string; movedAtMs: number }[] => [
        { workload: "w1", movedAtMs: nowMs - 500 },
      ],
    });

    expect(seeded.isInMoveCooldown("w1")).toBe(true);
  });

  it("T7: executeMove writes one skipped-evict and one executed move record on success", async () => {
    snapshots.m2mini = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [{ name: "model-a", reachable: true }],
    };

    const result = await controller.executeMove(proposal(), (entry) => journal.push(entry));

    expect(result).toBe("executed");
    expect(applyCalls).toHaveLength(1);
    expect(deleteCalls).toHaveLength(1);

    const skipped = journal.filter(executionEntryMatches("skipped"));
    const executed = journal.filter(executionEntryMatches("executed"));

    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.proposalId).toBe("evict-1");
    expect(skipped[0]?.reason).toBe("evict suppressed by move move-1");
    expect(executed).toHaveLength(1);
    expect(executed[0]?.proposalId).toBe("move-1");
  });

  it("T8: executeMove writes failed execution and returns timed_out when destination never becomes reachable", async () => {
    snapshots.m2mini = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [{ name: "model-a", reachable: false }],
    };

    const result = await controller.executeMove(proposal(), (entry) => journal.push(entry));

    expect(result).toBe("timed_out");
    expect(deleteCalls).toHaveLength(0);
    const failed = journal.find(executionEntryMatches("failed"));
    expect(failed).toBeTruthy();
  });

  it("T9: executeMove returns destination_unavailable and does not skip evict when destination headroom is lost", async () => {
    snapshots.m2mini = {
      node: "m2mini",
      pressureState: "HIGH",
      nodeMem: { freeMb: 100 },
      workloads: [],
    };

    const result = await controller.executeMove(proposal(), (entry) => journal.push(entry));

    expect(result).toBe("destination_unavailable");
    expect(applyCalls).toHaveLength(0);
    expect(
      journal.find(
        (entry) =>
          entry.kind === "fleet-execution" &&
          entry.proposalId === "evict-1" &&
          entry.status === "skipped",
      ),
    ).toBeUndefined();
  });

  it("T10: onJournalEntry triggers evaluateMove on NORMAL→HIGH pressure transition", async () => {
    snapshots.m2mini = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [],
    };

    const triggered = await controller.onJournalEntry(
      {
        kind: "fleet-transition",
        ts: new Date(nowMs).toISOString(),
        node: "m4pro",
        subject: "node",
        subjectKind: "node",
        signal: "pressure",
        from: "NORMAL",
        to: "HIGH",
      },
      workload,
      sourceSnapshot,
    );

    expect(triggered).not.toBeNull();
    expect(triggered?.toNode).toBe("m2mini");
  });

  it("F17: onJournalEntry ignores fleet-placement entries and does not arm cooldown", async () => {
    const result = await controller.onJournalEntry({
      kind: "fleet-placement",
      ts: new Date(nowMs).toISOString(),
      node: "m4pro",
      decision: {
        workload: "model-a",
        requestedNode: "auto",
        chosenNode: "m2mini",
        expectedMemoryMb: 1024,
        headroomMinMb: 512,
        modelFilePenaltyMb: 2048,
        scores: [],
      },
    });

    expect(result).toBeNull();
    expect(controller.isInMoveCooldown("model-a")).toBe(false);
  });

  it("F1: executeMove does not journal move intent before deploy succeeds", async () => {
    const failingController = new MigrationController({
      peers: ["m2mini", "m4pro"],
      fetchSnapshot: async (node): Promise<NodeSnapshot> =>
        snapshots[node] ?? {
          node,
          pressureState: "NORMAL",
          nodeMem: { freeMb: 4096 },
          workloads: [],
        },
      deployWorkload: async (): Promise<void> => {
        throw new Error("apply failed");
      },
      removeWorkload: async (w, fromNode): Promise<void> => {
        deleteCalls.push({ workload: w, fromNode });
      },
      leaseholder: "m4pro",
      getNowMs: (): number => nowMs,
      getCurrentTick: (): number => tick,
      healthTimeoutMs: 5,
      pollIntervalMs: 1,
      sleep: async (): Promise<void> => {
        nowMs += 1;
      },
    });

    snapshots.m2mini = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [{ name: "model-a", reachable: true }],
    };

    const result = await failingController.executeMove(proposal(), (entry) => journal.push(entry));

    expect(result).toBe("apply_failed");
    expect(
      journal.some((entry) => entry.kind === "fleet-proposal" && entry.proposalId === "move-1"),
    ).toBe(false);
    expect(
      journal.some(
        (entry) =>
          entry.kind === "fleet-execution" &&
          entry.proposalId === "evict-1" &&
          entry.status === "skipped",
      ),
    ).toBe(false);
    expect(failingController.isInMoveCooldown("model-a")).toBe(false);
  });

  it("F2: cooldown clears without getCurrentTick by falling back to elapsed time", () => {
    const noTickController = new MigrationController({
      peers: ["m2mini"],
      fetchSnapshot: async (): Promise<NodeSnapshot> => ({
        node: "m2mini",
        pressureState: "NORMAL",
        nodeMem: { freeMb: 4096 },
        workloads: [],
      }),
      deployWorkload: async (): Promise<undefined> => undefined,
      removeWorkload: async (): Promise<undefined> => undefined,
      leaseholder: "m4pro",
      getNowMs: (): number => nowMs,
      moveCooldownTicks: 2,
      pollIntervalMs: 100,
    });

    noTickController.markMoveInFlight("model-a");
    expect(noTickController.isInMoveCooldown("model-a")).toBe(true);

    nowMs += 250;
    expect(noTickController.isInMoveCooldown("model-a")).toBe(false);
  });

  it("F4: evaluateMove fans out peer snapshot fetches in parallel", async () => {
    const deferred = new Map<
      string,
      { resolve: (value: NodeSnapshot) => void; promise: Promise<NodeSnapshot> }
    >();
    const peers = ["p1", "p2", "p3"];
    const started: string[] = [];

    for (const peer of peers) {
      let resolve!: (value: NodeSnapshot) => void;
      const promise = new Promise<NodeSnapshot>((res) => {
        resolve = res;
      });
      deferred.set(peer, { resolve, promise });
    }

    const parallelController = new MigrationController({
      peers,
      fetchSnapshot: async (node): Promise<NodeSnapshot> => {
        started.push(node);
        return await (deferred.get(node)?.promise ??
          Promise.resolve({
            node,
            pressureState: "NORMAL",
            nodeMem: { freeMb: 4096 },
            workloads: [],
          }));
      },
      deployWorkload: async (): Promise<undefined> => undefined,
      removeWorkload: async (): Promise<undefined> => undefined,
      leaseholder: "m4pro",
      getNowMs: (): number => nowMs,
      getCurrentTick: (): number => tick,
    });

    const evaluation = parallelController.evaluateMove(workload, sourceSnapshot);

    await Promise.resolve();
    await Promise.resolve();
    expect(started.sort()).toEqual(["p1", "p2", "p3"]);

    deferred
      .get("p1")
      ?.resolve({ node: "p1", pressureState: "NORMAL", nodeMem: { freeMb: 5000 }, workloads: [] });
    deferred
      .get("p2")
      ?.resolve({ node: "p2", pressureState: "NORMAL", nodeMem: { freeMb: 7000 }, workloads: [] });
    deferred
      .get("p3")
      ?.resolve({ node: "p3", pressureState: "NORMAL", nodeMem: { freeMb: 6000 }, workloads: [] });

    const result = await evaluation;
    expect(result?.toNode).toBe("p2");
  });

  it("F6: executeMove returns timed_out when legacy proposal has unparseable expiresAt", async () => {
    snapshots.m2mini = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [{ name: "model-a", reachable: true }],
    };

    const legacyProposal = {
      workload: "model-a",
      fromNode: "m4pro",
      toNode: "m2mini",
      proposalId: "move-nan",
      evictProposalId: "evict-1",
      expiresAt: "not-a-date",
    } as unknown as MoveProposal;

    const result = await controller.executeMove(legacyProposal, (entry) => journal.push(entry));
    expect(result).toBe("timed_out");
    expect(applyCalls.length).toBe(0);
  });

  it("F13: evaluateMove rejects peer with non-finite freeMb", async () => {
    snapshots.m2mini = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: Number.NaN },
      workloads: [],
    };
    const result = await controller.evaluateMove(workload, sourceSnapshot);
    expect(result).toBeNull();
  });

  it("F13: executeMove returns destination_unavailable when destination freeMb is non-finite", async () => {
    snapshots.m2mini = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: Number.NaN },
      workloads: [{ name: "model-a", reachable: true }],
    };

    const result = await controller.executeMove(
      proposal({ proposalId: "move-nan-dest" }),
      (entry) => journal.push(entry),
    );
    expect(result).toBe("destination_unavailable");
    expect(applyCalls.length).toBe(0);
  });

  it("F20: evaluateMove requires destination freeMb >= workload memory hint when provided", async () => {
    snapshots.m2mini = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 700 },
      workloads: [],
    };

    const result = await controller.evaluateMove(
      { ...workload, spec: { placement: "auto", resources: { memoryMb: 900 } } },
      sourceSnapshot,
    );

    expect(result).toBeNull();
  });

  it("F20: executeMove refuses destination when freeMb drops below workload memory hint", async () => {
    snapshots.m2mini = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 800 },
      workloads: [{ name: "model-a", reachable: true }],
    };

    const result = await controller.executeMove(proposal({ workloadMemoryMb: 900 }), (entry) =>
      journal.push(entry),
    );

    expect(result).toBe("destination_unavailable");
    expect(applyCalls).toHaveLength(0);
  });

  it("F12: onJournalEntry ignores fleet-transition with subjectKind=workload", async () => {
    snapshots.m2mini = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [],
    };
    const triggered = await controller.onJournalEntry(
      {
        kind: "fleet-transition",
        ts: new Date(nowMs).toISOString(),
        node: "m4pro",
        subject: "model-a",
        subjectKind: "workload",
        signal: "pressure",
        from: "NORMAL",
        to: "HIGH",
      },
      workload,
      sourceSnapshot,
    );
    expect(triggered).toBeNull();
  });

  it("F18: isInMoveCooldown drops entries after the cooldown elapses", () => {
    const gcController = new MigrationController({
      peers: ["m2mini"],
      fetchSnapshot: async (): Promise<NodeSnapshot> => ({
        node: "m2mini",
        pressureState: "NORMAL",
        nodeMem: { freeMb: 4096 },
        workloads: [],
      }),
      leaseholder: "m4pro",
      getNowMs: (): number => nowMs,
      moveCooldownTicks: 2,
      pollIntervalMs: 100,
    });
    gcController.markMoveInFlight("model-a");
    expect(gcController.isInMoveCooldown("model-a")).toBe(true);
    nowMs += 500;
    expect(gcController.isInMoveCooldown("model-a")).toBe(false);
    expect(gcController.isInMoveCooldown("model-a")).toBe(false);
  });
});
