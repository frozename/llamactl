import { describe, expect, test } from "bun:test";

import type { NodeScore } from "../src/types.js";

import { makePlacementDecision } from "../src/placement.js";

function nodeScore(overrides: Partial<NodeScore> = {}): NodeScore {
  return {
    node: "default",
    score: 0,
    freeAfterMb: 0,
    compressorMb: 0,
    requestRate5m: 0,
    eligible: true,
    ...overrides,
  };
}

describe("makePlacementDecision", () => {
  test("(a) chosenNode is the FIRST eligible score in input order, not the highest-scoring", () => {
    const scores: NodeScore[] = [
      nodeScore({ node: "a", eligible: false, score: 0, ineligibilityReason: "pressure" }),
      nodeScore({ node: "b", score: 10 }),
      nodeScore({ node: "c", score: 100 }),
    ];
    const decision = makePlacementDecision({
      workloadName: "test-workload",
      requestedNode: "current",
      expectedMemoryMb: 512,
      scores,
    });
    expect(decision.chosenNode).toBe("b");
  });

  test("(b) with no eligible score, chosenNode is '' (empty string)", () => {
    const scores: NodeScore[] = [
      nodeScore({ node: "a", eligible: false, score: 0, ineligibilityReason: "pressure" }),
      nodeScore({ node: "b", eligible: false, score: 0, ineligibilityReason: "headroom" }),
    ];
    const decision = makePlacementDecision({
      workloadName: "test-workload",
      requestedNode: "current",
      expectedMemoryMb: 512,
      scores,
    });
    expect(decision.chosenNode).toBe("");
  });

  test("(c) headroomMinMb defaults to 512 when omitted", () => {
    const scores: NodeScore[] = [nodeScore({ node: "a" })];
    const decision = makePlacementDecision({
      workloadName: "test-workload",
      requestedNode: "current",
      expectedMemoryMb: 512,
      scores,
    });
    expect(decision.headroomMinMb).toBe(512);
  });

  test("(d) modelFilePenaltyMb defaults to 4096 when omitted", () => {
    const scores: NodeScore[] = [nodeScore({ node: "a" })];
    const decision = makePlacementDecision({
      workloadName: "test-workload",
      requestedNode: "current",
      expectedMemoryMb: 512,
      scores,
    });
    expect(decision.modelFilePenaltyMb).toBe(4096);
  });

  test("(e) explicit headroomMinMb and modelFilePenaltyMb pass through, including 0", () => {
    const scores: NodeScore[] = [nodeScore({ node: "a" })];
    const decision = makePlacementDecision({
      workloadName: "test-workload",
      requestedNode: "current",
      expectedMemoryMb: 512,
      scores,
      headroomMinMb: 0,
      modelFilePenaltyMb: 0,
    });
    expect(decision.headroomMinMb).toBe(0);
    expect(decision.modelFilePenaltyMb).toBe(0);
  });

  test("(f) workload equals workloadName; requestedNode and expectedMemoryMb copied; scores is same array reference", () => {
    const scores: NodeScore[] = [nodeScore({ node: "a" })];
    const decision = makePlacementDecision({
      workloadName: "my-workload",
      requestedNode: "node-x",
      expectedMemoryMb: 2048,
      scores,
    });
    expect(decision.workload).toBe("my-workload");
    expect(decision.requestedNode).toBe("node-x");
    expect(decision.expectedMemoryMb).toBe(2048);
    expect(decision.scores).toBe(scores);
  });
});
