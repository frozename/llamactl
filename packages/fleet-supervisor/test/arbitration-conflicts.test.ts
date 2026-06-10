/* eslint-disable @typescript-eslint/require-await -- Test doubles implement async migration contracts without artificial scheduling. */
import { beforeEach, describe, expect, it } from "bun:test";

import type { FleetExecutionEntry, FleetJournalEntry, MoveProposal } from "../src/types.js";

import { MigrationController, type NodeSnapshot } from "../src/migration-controller.js";

describe("Arbitration conflicts", () => {
  let nowMs = 1_700_000_000_000;
  let snapshots: Record<string, NodeSnapshot>;
  let journal: FleetJournalEntry[];
  let applyCalls = 0;
  let controller: MigrationController;

  beforeEach(() => {
    nowMs = 1_700_000_000_000;
    snapshots = {};
    journal = [];
    applyCalls = 0;

    controller = new MigrationController({
      peers: ["m2mini"],
      fetchSnapshot: async (node): Promise<NodeSnapshot> =>
        snapshots[node] ?? {
          node,
          pressureState: "NORMAL",
          nodeMem: { freeMb: 4096 },
          workloads: [{ name: "model-a", reachable: true }],
        },
      deployWorkload: async (): Promise<void> => {
        applyCalls += 1;
      },
      removeWorkload: async (): Promise<undefined> => undefined,
      leaseholder: "m4pro",
      getNowMs: (): number => nowMs,
      healthTimeoutMs: 5,
      pollIntervalMs: 1,
      sleep: async (): Promise<void> => {
        nowMs += 1;
      },
    });
  });

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

  it("C1: destination re-check blocks move when destination is no longer viable", async () => {
    snapshots.m2mini = {
      node: "m2mini",
      pressureState: "HIGH",
      nodeMem: { freeMb: 100 },
      workloads: [],
    };

    const result = await controller.executeMove(proposal(), (entry) => journal.push(entry));

    expect(result).toBe("destination_unavailable");
    expect(applyCalls).toBe(0);
    expect(
      journal.some(
        (entry) =>
          entry.kind === "fleet-execution" &&
          entry.proposalId === "evict-1" &&
          entry.status === "skipped",
      ),
    ).toBe(false);
  });

  it("C1b: successful move writes exactly one skipped-evict and one executed move entry", async () => {
    snapshots.m2mini = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 9000 },
      workloads: [{ name: "model-a", reachable: true }],
    };

    const result = await controller.executeMove(proposal(), (entry) => journal.push(entry));

    expect(result).toBe("executed");
    expect(applyCalls).toBe(1);

    const skipped = journal.filter(
      (entry): entry is FleetExecutionEntry =>
        entry.kind === "fleet-execution" &&
        entry.status === "skipped" &&
        entry.proposalId === "evict-1",
    );
    const executed = journal.filter(
      (entry): entry is FleetExecutionEntry =>
        entry.kind === "fleet-execution" &&
        entry.status === "executed" &&
        entry.proposalId === "move-1",
    );

    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toBe("evict suppressed by move move-1");
    expect(executed).toHaveLength(1);
  });

  it("C2: stale move proposal (ts + 30s < now) is not executed", async () => {
    const stale = proposal({
      expiresAtMs: nowMs - 1_000,
      expiresAt: new Date(nowMs - 1_000).toISOString(),
    });

    const result = await controller.executeMove(stale, (entry) => journal.push(entry));

    expect(result).toBe("timed_out");
    expect(applyCalls).toBe(0);
  });

  it("F17: fleet-placement journal entries do not trigger move proposals", async () => {
    const triggered = await controller.onJournalEntry({
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

    expect(triggered).toBeNull();
    expect(journal).toHaveLength(0);
  });

  it("C4: HIGH-pressure destination refused even if it was NORMAL at proposal time", async () => {
    snapshots.m2mini = {
      node: "m2mini",
      pressureState: "HIGH",
      nodeMem: { freeMb: 120 },
      workloads: [],
    };

    const result = await controller.executeMove(proposal(), (entry) => journal.push(entry));

    expect(result).toBe("destination_unavailable");
    expect(applyCalls).toBe(0);
  });

  it("C5: supervisor restart action never cross-calls schedulePlacement", async () => {
    const restartEntry: FleetJournalEntry = {
      kind: "fleet-proposal",
      ts: new Date(nowMs).toISOString(),
      node: "m4pro",
      proposalId: "restart-1",
      transition: {
        subject: "model-a",
        subjectKind: "workload",
        signal: "degraded",
        from: "healthy",
        to: "degraded",
      },
      action: { type: "restart", workload: "model-a", reason: "degraded" },
    };

    const triggered = await controller.onJournalEntry(
      restartEntry,
      {
        name: "model-a",
        node: "m4pro",
        spec: { placement: "auto" },
        evictProposalId: "evict-1",
      },
      {
        node: "m4pro",
        schedulerLeaseHolder: "m4pro",
        pressureState: "HIGH",
        nodeMem: { freeMb: 100 },
        workloads: [],
      },
    );

    expect(triggered).toBeNull();
    expect(applyCalls).toBe(0);
  });
});
