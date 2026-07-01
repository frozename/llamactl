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
      selfNode: "m4pro",
      getLeaseHolder: (): string | null => "m4pro",
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
      tickIntervalMs: 30_000,
      healthTimeoutMs: 300_000,
      minDestinationFreeMb: 512,
    });
  });

  it("T1: evaluateMove returns null when the elected holder is not self", async () => {
    // Drive the real guard: getLeaseHolder names a peer, not selfNode.
    const notHolder = new MigrationController({
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
      selfNode: "m4pro",
      getLeaseHolder: (): string | null => "m2mini",
      getNowMs: (): number => nowMs,
      getCurrentTick: (): number => tick,
    });
    const result = await notHolder.evaluateMove(workload, sourceSnapshot);
    expect(result).toBeNull();
  });

  it("T1b: evaluateMove returns null when no holder is elected", async () => {
    const noHolder = new MigrationController({
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
      selfNode: "m4pro",
      getLeaseHolder: (): string | null => null,
      getNowMs: (): number => nowMs,
      getCurrentTick: (): number => tick,
    });
    const result = await noHolder.evaluateMove(workload, sourceSnapshot);
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
    snapshots["m2mini"] = {
      node: "m2mini",
      pressureState: "HIGH",
      nodeMem: { freeMb: 200 },
      workloads: [],
    };
    snapshots["m4pro"] = {
      node: "m4pro",
      pressureState: "HIGH",
      nodeMem: { freeMb: 100 },
      workloads: [],
    };

    const result = await controller.evaluateMove(workload, sourceSnapshot);
    expect(result).toBeNull();
  });

  it("T5: evaluateMove returns MoveProposal with from/to and ttl fields when destination exists", async () => {
    snapshots["m2mini"] = {
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
        pressureState: "NORMAL",
        nodeMem: { freeMb: 4096 },
        workloads: [],
      }),
      selfNode: "m4pro",
      getLeaseHolder: (): string | null => "m4pro",
      getNowMs: (): number => nowMs,
      moveCooldownTicks: 10,
      pollIntervalMs: 100,
      tickIntervalMs: 30_000,
      readRecentMoves: (): { workload: string; movedAtMs: number }[] => [
        { workload: "w1", movedAtMs: nowMs - 500 },
      ],
    });

    expect(seeded.isInMoveCooldown("w1")).toBe(true);
  });

  it("F25: live move cooldown fallback uses the supervisor tick interval", () => {
    const startMs = nowMs;
    const makeFallbackController = (): MigrationController =>
      new MigrationController({
        peers: ["m2mini"],
        fetchSnapshot: async (): Promise<NodeSnapshot> => ({
          node: "m2mini",
          pressureState: "NORMAL",
          nodeMem: { freeMb: 4096 },
          workloads: [],
        }),
        selfNode: "m4pro",
        getLeaseHolder: (): string | null => "m4pro",
        getNowMs: (): number => nowMs,
        moveCooldownTicks: 10,
        pollIntervalMs: 1_000,
        tickIntervalMs: 30_000,
      });

    const active = makeFallbackController();
    active.markMoveInFlight("w1");
    nowMs = startMs + 10 * 1_000 + 1;
    expect(active.isInMoveCooldown("w1")).toBe(true);

    nowMs = startMs;
    const expired = makeFallbackController();
    expired.markMoveInFlight("w1");
    nowMs = startMs + 10 * 30_000 + 1;
    expect(expired.isInMoveCooldown("w1")).toBe(false);
  });

  it("F26: restored move cooldown fallback uses the supervisor tick interval", () => {
    const startMs = nowMs;
    const makeRestoredController = (): MigrationController =>
      new MigrationController({
        peers: ["m2mini"],
        fetchSnapshot: async (): Promise<NodeSnapshot> => ({
          node: "m2mini",
          pressureState: "NORMAL",
          nodeMem: { freeMb: 4096 },
          workloads: [],
        }),
        selfNode: "m4pro",
        getLeaseHolder: (): string | null => "m4pro",
        getNowMs: (): number => nowMs,
        moveCooldownTicks: 10,
        pollIntervalMs: 1_000,
        tickIntervalMs: 30_000,
        readRecentMoves: (): { workload: string; movedAtMs: number }[] => [
          { workload: "w1", movedAtMs: startMs },
        ],
      });

    const active = makeRestoredController();
    nowMs = startMs + 10 * 1_000 + 1;
    expect(active.isInMoveCooldown("w1")).toBe(true);

    nowMs = startMs + 10 * 30_000 + 1;
    const expired = makeRestoredController();
    expect(expired.isInMoveCooldown("w1")).toBe(false);
  });

  it("T7: executeMove deploys then advancePendingHealthPolls writes skipped-evict and executed move", async () => {
    snapshots["m2mini"] = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [{ name: "model-a", reachable: true }],
    };

    const result = await controller.executeMove(proposal(), (entry) => journal.push(entry));

    expect(result).toBe("pending_health_check");
    expect(applyCalls).toHaveLength(1);
    expect(deleteCalls).toHaveLength(0);

    await controller.advancePendingHealthPolls();
    expect(deleteCalls).toHaveLength(1);

    const skipped = journal.filter(executionEntryMatches("skipped"));
    const executed = journal.filter(executionEntryMatches("executed"));

    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.proposalId).toBe("evict-1");
    expect(skipped[0]?.reason).toBe("evict suppressed by move move-1");
    expect(executed).toHaveLength(1);
    expect(executed[0]?.proposalId).toBe("move-1");
  });

  it("T7b: executeMove runs supplied deploy hook before source removal", async () => {
    const calls: string[] = [];
    const orderedController = new MigrationController({
      peers: ["m2mini", "m4pro"],
      fetchSnapshot: async (node): Promise<NodeSnapshot> =>
        node === "m2mini"
          ? {
              node: "m2mini",
              pressureState: "NORMAL",
              nodeMem: { freeMb: 8000 },
              workloads: [{ name: "model-a", reachable: true }],
            }
          : {
              node,
              pressureState: "NORMAL",
              nodeMem: { freeMb: 4096 },
              workloads: [],
            },
      deployWorkload: async (w, toNode): Promise<void> => {
        calls.push(`deploy:${w}:${toNode}`);
      },
      removeWorkload: async (w, fromNode): Promise<void> => {
        calls.push(`remove:${w}:${fromNode}`);
      },
      selfNode: "m4pro",
      getLeaseHolder: (): string | null => "m4pro",
      getNowMs: (): number => nowMs,
      getCurrentTick: (): number => tick,
      healthTimeoutMs: 5,
      pollIntervalMs: 1,
      sleep: async (): Promise<void> => {
        nowMs += 1;
      },
    });

    const result = await orderedController.executeMove(proposal(), (entry) => journal.push(entry));

    expect(result).toBe("pending_health_check");
    expect(calls).toEqual(["deploy:model-a:m2mini"]);

    await orderedController.advancePendingHealthPolls();
    expect(calls).toEqual(["deploy:model-a:m2mini", "remove:model-a:m4pro"]);
  });

  it("T7c: executeMove returns destination_unavailable when deploy deps are absent", async () => {
    const noDeployController = new MigrationController({
      peers: ["m2mini", "m4pro"],
      fetchSnapshot: async (node): Promise<NodeSnapshot> => ({
        node,
        pressureState: "NORMAL",
        nodeMem: { freeMb: 8000 },
        workloads: [{ name: "model-a", reachable: true }],
      }),
      selfNode: "m4pro",
      getLeaseHolder: (): string | null => "m4pro",
      getNowMs: (): number => nowMs,
      getCurrentTick: (): number => tick,
    });

    const result = await noDeployController.executeMove(proposal(), (entry) => journal.push(entry));

    expect(result).toBe("destination_unavailable");
    expect(journal).toHaveLength(0);
  });

  it("T8: advancePendingHealthPolls writes failed execution when destination never becomes reachable", async () => {
    snapshots["m2mini"] = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [{ name: "model-a", reachable: false }],
    };

    const result = await controller.executeMove(proposal(), (entry) => journal.push(entry));

    expect(result).toBe("pending_health_check");
    nowMs += 10; // advance past healthTimeoutMs (5ms)

    await controller.advancePendingHealthPolls();
    expect(deleteCalls).toEqual([{ workload: "model-a", fromNode: "m2mini" }]);
    const failed = journal.find(executionEntryMatches("failed"));
    expect(failed).toBeTruthy();
  });

  it("F1: advancePendingHealthPolls retains pending state and retries when source removal fails", async () => {
    let removeAttempts = 0;
    const retryController = new MigrationController({
      peers: ["m2mini", "m4pro"],
      fetchSnapshot: async (node): Promise<NodeSnapshot> =>
        node === "m2mini"
          ? {
              node: "m2mini",
              pressureState: "NORMAL",
              nodeMem: { freeMb: 8000 },
              workloads: [{ name: "model-a", reachable: true }],
            }
          : {
              node,
              pressureState: "NORMAL",
              nodeMem: { freeMb: 4096 },
              workloads: [],
            },
      deployWorkload: async (w, toNode): Promise<void> => {
        applyCalls.push({ workload: w, toNode });
      },
      removeWorkload: async (w, fromNode): Promise<void> => {
        removeAttempts += 1;
        if (removeAttempts === 1) throw new Error("source stop failed");
        deleteCalls.push({ workload: w, fromNode });
      },
      selfNode: "m4pro",
      getLeaseHolder: (): string | null => "m4pro",
      getNowMs: (): number => nowMs,
      getCurrentTick: (): number => tick,
      healthTimeoutMs: 5,
      pollIntervalMs: 1,
    });

    const result = await retryController.executeMove(proposal(), (entry) => journal.push(entry));

    expect(result).toBe("pending_health_check");
    await retryController.advancePendingHealthPolls();

    expect(deleteCalls).toHaveLength(0);
    expect(retryController.getInFlightMoves()).toHaveLength(1);
    const removeFailed = journal.find(
      (entry): entry is FleetExecutionEntry =>
        entry.kind === "fleet-execution" &&
        entry.proposalId === "move-1" &&
        entry.status === "failed" &&
        entry.reason?.includes("remove failed") === true,
    );
    expect(removeFailed?.reason).toContain("source stop failed");

    await retryController.advancePendingHealthPolls();

    expect(deleteCalls).toEqual([{ workload: "model-a", fromNode: "m4pro" }]);
    expect(retryController.getInFlightMoves()).toHaveLength(0);
    expect(journal.filter(executionEntryMatches("executed"))).toHaveLength(1);
  });

  it("F4: advancePendingHealthPolls cleans up destination deploy when health times out", async () => {
    snapshots["m2mini"] = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [{ name: "model-a", reachable: false }],
    };

    const result = await controller.executeMove(proposal(), (entry) => journal.push(entry));

    expect(result).toBe("pending_health_check");
    nowMs += 10;

    await controller.advancePendingHealthPolls();

    expect(deleteCalls).toEqual([{ workload: "model-a", fromNode: "m2mini" }]);
    const failed = journal.find(executionEntryMatches("failed"));
    expect(failed?.reason).toContain("timeout waiting for destination health");
  });

  it("M-fleet8: advancePendingHealthPolls retries timed-out destination cleanup after removal failure", async () => {
    const removeCalls: { workload: string; fromNode: string }[] = [];
    let removeAttempts = 0;
    const retryDestinationController = new MigrationController({
      peers: ["m2mini", "m4pro"],
      fetchSnapshot: async (node): Promise<NodeSnapshot> =>
        node === "m2mini"
          ? {
              node: "m2mini",
              pressureState: "NORMAL",
              nodeMem: { freeMb: 8000 },
              workloads: [{ name: "model-a", reachable: false }],
            }
          : {
              node,
              pressureState: "NORMAL",
              nodeMem: { freeMb: 4096 },
              workloads: [],
            },
      deployWorkload: async (w, toNode): Promise<void> => {
        applyCalls.push({ workload: w, toNode });
      },
      removeWorkload: async (w, fromNode): Promise<void> => {
        removeAttempts += 1;
        removeCalls.push({ workload: w, fromNode });
        if (removeAttempts === 1) throw new Error("destination stop failed");
      },
      selfNode: "m4pro",
      getLeaseHolder: (): string | null => "m4pro",
      getNowMs: (): number => nowMs,
      getCurrentTick: (): number => tick,
      healthTimeoutMs: 5,
      pollIntervalMs: 1,
    });

    const result = await retryDestinationController.executeMove(proposal(), (entry) =>
      journal.push(entry),
    );

    expect(result).toBe("pending_health_check");
    nowMs += 10;

    await retryDestinationController.advancePendingHealthPolls();

    expect(removeCalls).toEqual([{ workload: "model-a", fromNode: "m2mini" }]);
    const retryFailed = journal.find(
      (entry): entry is FleetExecutionEntry =>
        entry.kind === "fleet-execution" &&
        entry.proposalId === "move-1" &&
        entry.status === "failed" &&
        entry.reason?.includes("will retry") === true,
    );
    expect(retryFailed).toBeTruthy();
    expect(retryFailed?.reason).toContain("destination stop failed");

    await retryDestinationController.advancePendingHealthPolls();

    expect(removeCalls).toEqual([
      { workload: "model-a", fromNode: "m2mini" },
      { workload: "model-a", fromNode: "m2mini" },
    ]);
    const timedOut = journal.find(
      (entry): entry is FleetExecutionEntry =>
        entry.kind === "fleet-execution" &&
        entry.proposalId === "move-1" &&
        entry.status === "failed" &&
        entry.reason === "timeout waiting for destination health",
    );
    expect(timedOut).toBeTruthy();
  });

  it("T9: executeMove returns destination_unavailable and does not skip evict when destination headroom is lost", async () => {
    snapshots["m2mini"] = {
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
    snapshots["m2mini"] = {
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
      selfNode: "m4pro",
      getLeaseHolder: (): string | null => "m4pro",
      getNowMs: (): number => nowMs,
      getCurrentTick: (): number => tick,
      healthTimeoutMs: 5,
      pollIntervalMs: 1,
      sleep: async (): Promise<void> => {
        nowMs += 1;
      },
    });

    snapshots["m2mini"] = {
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
    // apply_failed now arms the cooldown to prevent tight per-tick retries
    expect(failingController.isInMoveCooldown("model-a")).toBe(true);
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
      selfNode: "m4pro",
      getLeaseHolder: (): string | null => "m4pro",
      getNowMs: (): number => nowMs,
      moveCooldownTicks: 2,
      pollIntervalMs: 100,
      tickIntervalMs: 100,
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
      selfNode: "m4pro",
      getLeaseHolder: (): string | null => "m4pro",
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
    snapshots["m2mini"] = {
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
    snapshots["m2mini"] = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: Number.NaN },
      workloads: [],
    };
    const result = await controller.evaluateMove(workload, sourceSnapshot);
    expect(result).toBeNull();
  });

  it("F13: executeMove returns destination_unavailable when destination freeMb is non-finite", async () => {
    snapshots["m2mini"] = {
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
    snapshots["m2mini"] = {
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
    snapshots["m2mini"] = {
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
    snapshots["m2mini"] = {
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
      selfNode: "m4pro",
      getLeaseHolder: (): string | null => "m4pro",
      getNowMs: (): number => nowMs,
      moveCooldownTicks: 2,
      pollIntervalMs: 100,
      tickIntervalMs: 100,
    });
    gcController.markMoveInFlight("model-a");
    expect(gcController.isInMoveCooldown("model-a")).toBe(true);
    nowMs += 500;
    expect(gcController.isInMoveCooldown("model-a")).toBe(false);
    expect(gcController.isInMoveCooldown("model-a")).toBe(false);
  });
});
