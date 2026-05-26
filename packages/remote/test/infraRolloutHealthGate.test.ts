import { test, expect } from "bun:test";
import { healthGate } from "@llamactl/fleet-supervisor";
import type { FleetSnapshotEntry } from "../../fleet-supervisor/src/types.js";

function snapshot(workloads: Array<{ reachable: boolean }>): FleetSnapshotEntry {
  return {
    kind: 'fleet-snapshot',
    ts: new Date().toISOString(),
    node: 'node-a',
    node_mem: {
      free_mb: 1,
      active_mb: 1,
      inactive_mb: 1,
      wired_mb: 1,
      compressor_mb: 1,
      swap_in: 0,
      swap_out: 0,
    },
    workloads: workloads.map((workload, index) => ({
      name: `w${index}`,
      kind: 'ModelHost',
      endpoint: 'http://127.0.0.1',
      priority: 50,
      rss_mb: null,
      request_rate_5m: null,
      error_rate_5m: 0,
      p50_ms: 0,
      p95_ms: 0,
      models: [],
      reachable: workload.reachable,
      consecutiveErrors: 0,
    })),
  };
}

test("healthGate resolves healthy when all workloads reachable=true before timeout", async () => {
  let calls = 0;
  const fetchSnapshot = async () => {
    calls++;
    if (calls < 3) {
      return snapshot([{ reachable: false }, { reachable: true }]);
    }
    return snapshot([{ reachable: true }, { reachable: true }]);
  };

  const result = await healthGate(fetchSnapshot, { timeoutMs: 100, pollIntervalMs: 10 });
  expect(result).toBe("healthy");
  expect(calls).toBe(3);
});

test("healthGate resolves timeout after timeoutMs without full health", async () => {
  let calls = 0;
  const fetchSnapshot = async () => {
    calls++;
    return snapshot([{ reachable: false }, { reachable: true }]);
  };

  const result = await healthGate(fetchSnapshot, { timeoutMs: 50, pollIntervalMs: 10 });
  expect(result).toBe("timeout");
  expect(calls).toBeGreaterThan(1);
});
