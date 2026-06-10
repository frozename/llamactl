import { healthGate } from "@llamactl/fleet-supervisor";
import { expect, test } from "bun:test";

import type { FleetSnapshotEntry, WorkloadSnapshot } from "../../fleet-supervisor/src/types.js";

function snapshot(reachable: boolean[]): FleetSnapshotEntry {
  const workload = (ok: boolean): WorkloadSnapshot => ({
    name: ok ? "up" : "down",
    kind: "ModelRun",
    endpoint: "http://127.0.0.1:8080",
    priority: 50,
    rss_mb: null,
    request_rate_5m: null,
    error_rate_5m: 0,
    p50_ms: 0,
    p95_ms: 0,
    models: [],
    reachable: ok,
    consecutiveErrors: ok ? 0 : 1,
  });
  return {
    kind: "fleet-snapshot",
    ts: new Date(0).toISOString(),
    node: "local",
    node_mem: {
      free_mb: 0,
      active_mb: 0,
      inactive_mb: 0,
      wired_mb: 0,
      compressor_mb: 0,
      swap_in: 0,
      swap_out: 0,
    },
    workloads: reachable.map(workload),
  };
}

test('T1: healthGate resolves "healthy" when all workloads reachable=true before timeout', async () => {
  let calls = 0;
  const fetchSnapshot = async (): Promise<FleetSnapshotEntry> => {
    await Promise.resolve();
    calls++;
    if (calls < 3) return snapshot([false, true]);
    return snapshot([true, true]);
  };
  const result = await healthGate(fetchSnapshot, { timeoutMs: 100, pollIntervalMs: 10 });
  expect(result).toBe("healthy");
  expect(calls).toBe(3);
});

test('T2: healthGate resolves "timeout" after timeoutMs without full health', async () => {
  let calls = 0;
  const fetchSnapshot = async (): Promise<FleetSnapshotEntry> => {
    await Promise.resolve();
    calls++;
    return snapshot([false, true]);
  };
  const result = await healthGate(fetchSnapshot, { timeoutMs: 50, pollIntervalMs: 10 });
  expect(result).toBe("timeout");
  expect(calls).toBeGreaterThan(1);
});
