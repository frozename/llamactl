import { describe, expect, test } from "bun:test";

import { memoryRecallWorkload, ndcgAtK } from "../src/matrix/workloads/memory-recall.js";

describe("ndcgAtK", () => {
  test("returns 1.0 when top-K matches all gold in order", () => {
    const ranking = ["a", "b", "c", "d", "e", "f", "g"];
    const gold = ["a", "b", "c"];
    expect(ndcgAtK(ranking, gold, 5)).toBeCloseTo(1.0, 6);
  });

  test("returns 0.0 when no gold appears in top-K", () => {
    const ranking = ["x", "y", "z", "w", "v", "a", "b"];
    const gold = ["a", "b"];
    expect(ndcgAtK(ranking, gold, 5)).toBe(0);
  });

  test("partial credit when gold appears below ideal positions", () => {
    const ranking = ["x", "a", "y", "b", "z"];
    const gold = ["a", "b"];
    // DCG = 1/log2(3) + 1/log2(5) ≈ 0.6309 + 0.4307 ≈ 1.0617
    // IDCG = 1/log2(2) + 1/log2(3) ≈ 1.0 + 0.6309 ≈ 1.6309
    // NDCG ≈ 0.6510
    expect(ndcgAtK(ranking, gold, 5)).toBeCloseTo(0.651, 3);
  });

  test("returns 0 when gold_ids is empty", () => {
    expect(ndcgAtK(["a", "b"], [], 5)).toBe(0);
  });

  test("K caps the evaluation window", () => {
    const ranking = ["x", "y", "z", "w", "v", "a"];
    const gold = ["a"];
    expect(ndcgAtK(ranking, gold, 5)).toBe(0);
    // At K=6, 'a' appears at position 6: DCG = 1/log2(7) ≈ 0.3562; IDCG = 1
    expect(ndcgAtK(ranking, gold, 6)).toBeCloseTo(1 / Math.log2(7), 4);
  });
});

describe("memoryRecallWorkload.scorer", () => {
  const row = {
    query: "q",
    candidates: [
      { id: "m1", text: "t1" },
      { id: "m2", text: "t2" },
      { id: "m3", text: "t3" },
    ],
    gold_ids: ["m1", "m2"],
  };

  test("exact-match ranking scores 1.0", async () => {
    const out = await memoryRecallWorkload.scorer(row, '{"ranking": ["m1", "m2", "m3"]}');
    expect(out.metrics.ndcg5).toBeCloseTo(1.0, 6);
    expect(out.metrics.parse_error).toBe(0);
  });

  test("parse error returns ndcg5=0 + parse_error=1", async () => {
    const out = await memoryRecallWorkload.scorer(row, "not json at all");
    expect(out.metrics.ndcg5).toBe(0);
    expect(out.metrics.parse_error).toBe(1);
    expect(out.prediction).toBe("__parse_error__");
  });

  test("handles markdown code fence", async () => {
    const out = await memoryRecallWorkload.scorer(
      row,
      '```json\n{"ranking": ["m1", "m2", "m3"]}\n```',
    );
    expect(out.metrics.ndcg5).toBeCloseTo(1.0, 6);
  });

  test("worst ranking (gold last) scores below ideal but above 0", async () => {
    const out = await memoryRecallWorkload.scorer(row, '{"ranking": ["m3", "m1", "m2"]}');
    expect(out.metrics.ndcg5).toBeGreaterThan(0);
    expect(out.metrics.ndcg5).toBeLessThan(1);
  });
});
