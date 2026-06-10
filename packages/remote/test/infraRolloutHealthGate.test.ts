import { healthGate } from "@llamactl/fleet-supervisor";
import { expect, test } from "bun:test";

test('T1: healthGate resolves "healthy" when all workloads reachable=true before timeout', async () => {
  let calls = 0;
  const fetchSnapshot = async () => {
    calls++;
    if (calls < 3) return { workloads: [{ reachable: false }, { reachable: true }] } as any;
    return { workloads: [{ reachable: true }, { reachable: true }] } as any;
  };
  const result = await healthGate(fetchSnapshot, { timeoutMs: 100, pollIntervalMs: 10 });
  expect(result).toBe("healthy");
  expect(calls).toBe(3);
});

test('T2: healthGate resolves "timeout" after timeoutMs without full health', async () => {
  let calls = 0;
  const fetchSnapshot = async () => {
    calls++;
    return { workloads: [{ reachable: false }, { reachable: true }] } as any;
  };
  const result = await healthGate(fetchSnapshot, { timeoutMs: 50, pollIntervalMs: 10 });
  expect(result).toBe("timeout");
  expect(calls).toBeGreaterThan(1);
});
