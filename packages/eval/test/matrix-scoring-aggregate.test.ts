import { describe, expect, test } from "bun:test";

import { aggregateMetrics, percentile } from "../src/matrix/scoring.js";

describe("aggregateMetrics", () => {
  test("empty input", () => {
    expect(aggregateMetrics([])).toEqual({ macro_f1: 0, per_class: [] });
  });

  test("three-class mixed case pins sorted labels and per-class metrics", () => {
    const result = aggregateMetrics([
      { pred: "b", gold: "a" },
      { pred: "a", gold: "a" },
      { pred: "c", gold: "b" },
      { pred: "b", gold: "b" },
    ]);
    expect(result.per_class.map((metric) => metric.label)).toEqual(["a", "b", "c"]);

    const [a, b, c] = result.per_class;
    expect(a!.tp).toBe(1);
    expect(a!.fp).toBe(0);
    expect(a!.fn).toBe(1);
    expect(a!.precision).toBe(1);
    expect(a!.recall).toBeCloseTo(0.5, 10);
    expect(a!.f1).toBeCloseTo(2 / 3, 10);

    expect(b!.tp).toBe(1);
    expect(b!.fp).toBe(1);
    expect(b!.fn).toBe(1);
    expect(b!.precision).toBeCloseTo(0.5, 10);
    expect(b!.recall).toBeCloseTo(0.5, 10);
    expect(b!.f1).toBeCloseTo(0.5, 10);

    expect(c!.tp).toBe(0);
    expect(c!.fp).toBe(1);
    expect(c!.fn).toBe(0);
    expect(c!.precision).toBe(0);
    expect(c!.recall).toBe(0);
    expect(c!.f1).toBe(0);

    expect(result.macro_f1).toBeCloseTo((2 / 3 + 0.5 + 0) / 3, 10);
  });

  test("perfect single class", () => {
    const result = aggregateMetrics([
      { pred: "x", gold: "x" },
      { pred: "x", gold: "x" },
    ]);
    expect(result.macro_f1).toBe(1);
    expect(result.per_class).toEqual([
      { label: "x", precision: 1, recall: 1, f1: 1, tp: 2, fp: 0, fn: 0 },
    ]);
  });

  test("parse_error prediction is its own class", () => {
    const result = aggregateMetrics([
      { pred: "parse_error", gold: "a" },
      { pred: "a", gold: "a" },
    ]);
    expect(result.per_class.map((metric) => metric.label)).toEqual(["a", "parse_error"]);

    const [a, parseError] = result.per_class;
    expect(a!.tp).toBe(1);
    expect(a!.fp).toBe(0);
    expect(a!.fn).toBe(1);
    expect(a!.f1).toBeCloseTo(2 / 3, 10);

    expect(parseError!.tp).toBe(0);
    expect(parseError!.fp).toBe(1);
    expect(parseError!.fn).toBe(0);
    expect(parseError!.f1).toBe(0);

    expect(result.macro_f1).toBeCloseTo(1 / 3, 10);
  });

  test("gold-only class produces no NaN", () => {
    const result = aggregateMetrics([{ pred: "a", gold: "b" }]);
    expect(result.per_class.map((metric) => metric.label)).toEqual(["a", "b"]);

    const [a, b] = result.per_class;
    expect(a!.tp).toBe(0);
    expect(a!.fp).toBe(1);
    expect(a!.fn).toBe(0);
    expect(a!.f1).toBe(0);

    expect(b!.tp).toBe(0);
    expect(b!.fp).toBe(0);
    expect(b!.fn).toBe(1);
    expect(b!.recall).toBe(0);
    expect(b!.f1).toBe(0);

    expect(result.macro_f1).toBe(0);
    for (const metric of result.per_class) {
      expect(Number.isNaN(metric.f1)).toBe(false);
    }
  });
});

describe("percentile", () => {
  test("unsorted input interpolates", () => {
    const values = [40, 10, 30, 20];
    expect(percentile(values, 0)).toBe(10);
    expect(percentile(values, 100)).toBe(40);
    expect(percentile(values, 50)).toBeCloseTo(25, 10);
    expect(percentile(values, 95)).toBeCloseTo(38.5, 10);
  });

  test("does not mutate input", () => {
    const values = [40, 10, 30, 20];
    percentile(values, 50);
    expect(values).toEqual([40, 10, 30, 20]);
  });

  test("single element", () => {
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([7], 0)).toBe(7);
  });

  test("exact index needs no interpolation", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 25)).toBe(2);
  });

  test("mixed-digit values sort numerically, not lexicographically", () => {
    expect(percentile([100, 9, 20], 0)).toBe(9);
    expect(percentile([100, 9, 20], 100)).toBe(100);
    expect(percentile([3, 100, 20, 9], 50)).toBeCloseTo(14.5, 10);
  });
});
