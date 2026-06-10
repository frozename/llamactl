import { describe, expect, test } from "bun:test";
import { aggregateThroughput } from "../src/runners/throughput.js";

describe("aggregateThroughput", () => {
  test("computes mean / p10 / p90 over per-prompt tps", () => {
    const result = aggregateThroughput([
      { name: "a", predicted_per_second: 10, predicted_n: 100, wallMs: 10000 },
      { name: "b", predicted_per_second: 20, predicted_n: 100, wallMs: 5000 },
      { name: "c", predicted_per_second: 30, predicted_n: 100, wallMs: 3334 },
    ]);
    expect(result.mean_tps).toBeCloseTo(20, 5);
    expect(result.p10_tps).toBeLessThanOrEqual(result.mean_tps);
    expect(result.p90_tps).toBeGreaterThanOrEqual(result.mean_tps);
    expect(result.total_predicted).toBe(300);
  });
});
