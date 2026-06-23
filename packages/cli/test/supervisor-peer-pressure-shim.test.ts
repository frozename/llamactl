import type { FleetSnapshotEntry, NodeMemSnapshot } from "@llamactl/fleet-supervisor";

import { describe, expect, test } from "bun:test";

import { peerSnapshotToNodeSnapshot } from "../src/commands/supervisor.js";

/**
 * Defect 1 — destination gate defeated. buildMigrationController's fetchSnapshot
 * shim used to return pressureState: "NORMAL" HARD-CODED for every peer, which
 * made findBestDestination's `pressureState === "NORMAL"` filter a no-op (every
 * peer always looked viable). The pressureState must be DERIVED from the fetched
 * snapshot's node_mem using the AND-gate consistent with isPressureHot:
 *   free_mb <= headroomMinMb (512) AND compressor_mb >= compressorWarnMb (2048).
 * This pins the extracted mapping helper the shim now delegates to, proving the
 * result is computed — HIGH when the AND-gate breaches, NORMAL otherwise — and
 * never a constant.
 */
describe("peerSnapshotToNodeSnapshot AND-gate pressure (Defect 1)", () => {
  function nodeMem(overrides: Partial<NodeMemSnapshot>): NodeMemSnapshot {
    return {
      free_mb: 8000,
      active_mb: 0,
      inactive_mb: 0,
      wired_mb: 0,
      compressor_mb: 0,
      swap_in: 0,
      swap_out: 0,
      ...overrides,
    };
  }

  function snapshot(mem: NodeMemSnapshot): FleetSnapshotEntry {
    return {
      kind: "fleet-snapshot",
      ts: new Date(1_700_000_000_000).toISOString(),
      node: "m2mini",
      node_mem: mem,
      workloads: [
        {
          name: "model-a",
          kind: "ModelRun",
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
        },
      ],
    };
  }

  test("reports HIGH only when BOTH free_mb <= 512 AND compressor_mb >= 2048", () => {
    // Both breach the AND-gate -> HIGH.
    const high = peerSnapshotToNodeSnapshot(
      snapshot(nodeMem({ free_mb: 200, compressor_mb: 3000 })),
    );
    expect(high.pressureState).toBe("HIGH");
  });

  test("reports NORMAL when only free_mb breaches (compressor below threshold)", () => {
    // free low but compressor below threshold -> AND-gate not met -> NORMAL.
    const result = peerSnapshotToNodeSnapshot(
      snapshot(nodeMem({ free_mb: 200, compressor_mb: 100 })),
    );
    expect(result.pressureState).toBe("NORMAL");
  });

  test("reports NORMAL when only compressor breaches (free above threshold)", () => {
    // compressor high but free above threshold -> AND-gate not met -> NORMAL.
    const result = peerSnapshotToNodeSnapshot(
      snapshot(nodeMem({ free_mb: 8000, compressor_mb: 4000 })),
    );
    expect(result.pressureState).toBe("NORMAL");
  });

  test("reports NORMAL when neither threshold breaches, and never a constant across inputs", () => {
    const normal = peerSnapshotToNodeSnapshot(
      snapshot(nodeMem({ free_mb: 8000, compressor_mb: 0 })),
    );
    const high = peerSnapshotToNodeSnapshot(
      snapshot(nodeMem({ free_mb: 100, compressor_mb: 5000 })),
    );
    expect(normal.pressureState).toBe("NORMAL");
    // The two inputs must NOT map to the same constant — proves it is computed.
    expect(high.pressureState).not.toBe(normal.pressureState);
  });

  test("carries through node id, freeMb, and workload reachability", () => {
    const result = peerSnapshotToNodeSnapshot(
      snapshot(nodeMem({ free_mb: 4096, compressor_mb: 0 })),
    );
    expect(result.node).toBe("m2mini");
    expect(result.nodeMem?.freeMb).toBe(4096);
    expect(result.workloads).toEqual([{ name: "model-a", reachable: true }]);
  });
});
