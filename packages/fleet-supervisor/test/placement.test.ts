import { describe, expect, test } from "bun:test";

import type { SnapshotRow } from "../src/aggregator-db.js";
import type { WorkloadSnapshot } from "../src/types.js";

import { chooseBestNode, scoreNodes } from "../src/placement.js";

const BASE_TS = "2026-05-25T12:00:00Z";

function workload(name: string, models: string[] = []): WorkloadSnapshot {
  return {
    name,
    kind: "ModelRun",
    endpoint: `http://127.0.0.1:8080`,
    priority: 50,
    rss_mb: 0,
    request_rate_5m: 0,
    error_rate_5m: 0,
    p50_ms: 10,
    p95_ms: 20,
    models,
    reachable: true,
    consecutiveErrors: 0,
  };
}

function snapshot(row: {
  node: string;
  freeMb: number;
  compressorMb: number;
  workloads?: WorkloadSnapshot[];
  ts?: string;
}): SnapshotRow {
  return {
    node: row.node,
    ts: row.ts ?? BASE_TS,
    receivedAt: row.ts ?? BASE_TS,
    snapshot: {
      kind: "fleet-snapshot",
      ts: row.ts ?? BASE_TS,
      node: row.node,
      node_mem: {
        free_mb: row.freeMb,
        active_mb: 0,
        inactive_mb: 0,
        wired_mb: 0,
        compressor_mb: row.compressorMb,
        swap_in: 0,
        swap_out: 0,
      },
      workloads: row.workloads ?? [],
    },
  };
}

describe("scoreNodes", () => {
  test("disqualifies HIGH-pressure nodes", () => {
    const rows = [snapshot({ node: "gpu1", freeMb: 2048, compressorMb: 3000 })];
    const scores = scoreNodes(rows, {
      workload: "qwen-run",
      targetModel: "qwen3.6-35b",
      expectedMemoryMb: 512,
    });
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({
      node: "gpu1",
      eligible: false,
      ineligibilityReason: "pressure",
      score: Number.NEGATIVE_INFINITY,
      pressureState: "HIGH",
    });
  });

  test("disqualifies null snapshot rows", () => {
    const scores = scoreNodes([null], {
      workload: "qwen-run",
      targetModel: "qwen3.6-35b",
      expectedMemoryMb: 512,
    });
    expect(scores).toEqual([
      {
        node: "unknown",
        score: Number.NEGATIVE_INFINITY,
        freeAfterMb: 0,
        freePenaltyMb: 0,
        compressorMb: 0,
        requestRate5m: 0,
        eligible: false,
        ineligibilityReason: "no_telemetry",
      },
    ]);
  });

  test("disqualifies insufficient headroom", () => {
    const rows = [snapshot({ node: "gpu1", freeMb: 600, compressorMb: 0 })];
    const scores = scoreNodes(rows, {
      workload: "qwen-run",
      targetModel: "qwen3.6-35b",
      expectedMemoryMb: 100,
      headroomMinMb: 512,
    });
    expect(scores[0]).toMatchObject({
      node: "gpu1",
      eligible: false,
      ineligibilityReason: "insufficient_headroom",
      freeAfterMb: 500,
    });
  });

  test("uses provided headroomMinMb when selecting eligible nodes", () => {
    const rows = [
      snapshot({ node: "gpu1", freeMb: 6000, compressorMb: 200 }),
      snapshot({ node: "gpu2", freeMb: 4000, compressorMb: 200 }),
    ];
    const scores = scoreNodes(rows, {
      workload: "qwen-run",
      targetModel: "qwen3.6-35b",
      expectedMemoryMb: 0,
      headroomMinMb: 5000,
    });

    expect(scores).toHaveLength(2);
    expect(scores[0]).toMatchObject({
      node: "gpu1",
      eligible: true,
      freeAfterMb: 6000,
    });
    expect(scores[1]).toMatchObject({
      node: "gpu2",
      eligible: false,
    });
  });

  test("ranks by highest free-after-memory first", () => {
    const rows = [
      snapshot({ node: "gpu1", freeMb: 5000, compressorMb: 1000 }),
      snapshot({ node: "gpu2", freeMb: 7000, compressorMb: 1500 }),
    ];
    const scores = scoreNodes(rows, {
      workload: "qwen-run",
      targetModel: "qwen3.6-35b",
      expectedMemoryMb: 0,
    });
    expect(chooseBestNode(scores)).toBe("gpu2");
  });

  test("tie-breaks on lower compressor before request_rate_5m", () => {
    const rows = [
      snapshot({
        node: "gpu1",
        freeMb: 8000,
        compressorMb: 1000,
        workloads: [
          {
            ...workload("w1"),
            request_rate_5m: 10,
          },
        ],
      }),
      snapshot({
        node: "gpu2",
        freeMb: 8000,
        compressorMb: 1500,
        workloads: [
          {
            ...workload("w2"),
            request_rate_5m: 1,
          },
        ],
      }),
    ];
    const scores = scoreNodes(rows, {
      workload: "qwen-run",
      targetModel: "qwen3.6-35b",
      expectedMemoryMb: 0,
    });
    expect(chooseBestNode(scores)).toBe("gpu1");
  });

  test("returns all nodes including disqualified ones", () => {
    const rows = [
      snapshot({ node: "gpu1", freeMb: 300, compressorMb: 3000 }),
      snapshot({ node: "gpu2", freeMb: 10000, compressorMb: 3000 }),
    ];
    const scores = scoreNodes(rows, {
      workload: "qwen-run",
      targetModel: "qwen3.6-35b",
      expectedMemoryMb: 128,
      headroomMinMb: 512,
    });
    expect(scores).toHaveLength(2);
    expect(scores.some((score) => !score.eligible)).toBe(true);
  });

  test("returns null when no nodes are eligible", () => {
    const rows = [
      snapshot({ node: "gpu1", freeMb: 300, compressorMb: 3000 }),
      snapshot({ node: "gpu2", freeMb: 400, compressorMb: 3000 }),
    ];
    const scores = scoreNodes(rows, {
      workload: "qwen-run",
      targetModel: "qwen3.6-35b",
      expectedMemoryMb: 0,
      headroomMinMb: 512,
    });
    expect(chooseBestNode(scores)).toBeNull();
  });

  test("applies model file penalty when target is missing on node", () => {
    const rows = [
      snapshot({
        node: "gpu1",
        freeMb: 8000,
        compressorMb: 500,
        workloads: [workload("alpha", ["qwen3.6-35b-MTP-Q4_0-Q6_K.gguf"])],
      }),
      snapshot({
        node: "gpu2",
        freeMb: 8000,
        compressorMb: 500,
        workloads: [workload("beta")],
      }),
    ];
    const scores = scoreNodes(rows, {
      workload: "qwen-run",
      targetModel: "/models/qwen3.6-35b-MTP-Q4_0-Q6_K.gguf",
      expectedMemoryMb: 0,
      modelFilePenaltyMb: 128,
      headroomMinMb: 128,
    });
    expect(scores.find((score) => score.node === "gpu1")?.eligible).toBe(true);
    expect(scores.find((score) => score.node === "gpu2")?.eligible).toBe(true);
    expect(scores.find((score) => score.node === "gpu1")?.freePenaltyMb).toBe(0);
    expect(scores.find((score) => score.node === "gpu2")?.freePenaltyMb).toBe(128);
    expect(chooseBestNode(scores)).toBe("gpu1");
  });
});
