import { describe, expect, test } from "bun:test";
import { composite } from "../src/score/compose.js";

describe("composite", () => {
  test("returns zero for all-zero inputs", () => {
    expect(
      composite({
        throughput_tps: 0,
        tool_call_score: 0,
        context_8k_score: 0,
        context_16k_score: 0,
        json_score: 0,
      }),
    ).toBe(0);
  });

  test("returns one for all-perfect inputs", () => {
    expect(
      composite({
        throughput_tps: 30,
        tool_call_score: 1,
        context_8k_score: 1,
        context_16k_score: 1,
        json_score: 1,
      }),
    ).toBe(1);
  });

  test("caps throughput at one and lets it dominate the weighted total", () => {
    expect(
      composite({
        throughput_tps: 60,
        tool_call_score: 0,
        context_8k_score: 0,
        context_16k_score: 0,
        json_score: 0,
      }),
    ).toBe(0.3);
  });

  test("falls back to the 8k score when the 16k score is missing", () => {
    const withFallback = composite({
      throughput_tps: 0,
      tool_call_score: 0,
      context_8k_score: 0.5,
      context_16k_score: null,
      json_score: 0,
    });

    expect(withFallback).toBeCloseTo(0.15, 6);
  });
});
