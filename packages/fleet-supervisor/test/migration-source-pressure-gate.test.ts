/* eslint-disable @typescript-eslint/require-await -- Test doubles implement async migration contracts without artificial scheduling. */
import { beforeEach, describe, expect, it } from "bun:test";

import { MigrationController, type NodeSnapshot } from "../src/migration-controller.js";

/**
 * Defect 2 — source-pressure gate. evaluateMove must early-return null when the
 * SOURCE node is not under HIGH pressure, even when a viable NORMAL destination
 * exists. Without the gate the supervisor proposes a 'rebalance' move every tick
 * regardless of whether the source is actually hot. The gate must apply ONLY to
 * NEW proposals — in-flight health-poll completion (advancePendingHealthPolls)
 * is exercised by the existing migration-safe-path suite and is unaffected.
 */
describe("evaluateMove source-pressure gate (Defect 2)", () => {
  let nowMs = 1_700_000_000_000;
  let snapshots: Record<string, NodeSnapshot>;
  let controller: MigrationController;

  const workload = {
    name: "model-a",
    node: "m4pro",
    spec: { placement: "auto" },
    evictProposalId: "evict-1",
  };

  beforeEach(() => {
    nowMs = 1_700_000_000_000;
    snapshots = {};
    controller = new MigrationController({
      peers: ["m2mini", "m4pro"],
      fetchSnapshot: async (node): Promise<NodeSnapshot> =>
        snapshots[node] ?? {
          node,
          pressureState: "NORMAL",
          nodeMem: { freeMb: 8000 },
          workloads: [],
        },
      deployWorkload: async (): Promise<void> => undefined,
      removeWorkload: async (): Promise<void> => undefined,
      selfNode: "m4pro",
      getLeaseHolder: (): string | null => "m4pro",
      getNowMs: (): number => nowMs,
    });
  });

  it("a: returns null when every candidate peer is HIGH (no viable destination)", async () => {
    snapshots["m2mini"] = {
      node: "m2mini",
      pressureState: "HIGH",
      nodeMem: { freeMb: 200 },
      workloads: [],
    };
    const sourceHigh: NodeSnapshot = {
      node: "m4pro",
      pressureState: "HIGH",
      nodeMem: { freeMb: 100 },
      workloads: [],
    };

    const result = await controller.evaluateMove(workload, sourceHigh);
    expect(result).toBeNull();
  });

  it("b: returns null when SOURCE is NORMAL even with a viable NORMAL destination", async () => {
    snapshots["m2mini"] = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [],
    };
    const sourceNormal: NodeSnapshot = {
      node: "m4pro",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [],
    };

    const result = await controller.evaluateMove(workload, sourceNormal);
    expect(result).toBeNull();
  });

  it("c: proposes a move to the NORMAL peer when SOURCE is HIGH and a peer has enough free", async () => {
    snapshots["m2mini"] = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [],
    };
    const sourceHigh: NodeSnapshot = {
      node: "m4pro",
      pressureState: "HIGH",
      nodeMem: { freeMb: 100 },
      workloads: [],
    };

    const result = await controller.evaluateMove(workload, sourceHigh);
    expect(result).not.toBeNull();
    expect(result?.fromNode).toBe("m4pro");
    expect(result?.toNode).toBe("m2mini");
  });
});
