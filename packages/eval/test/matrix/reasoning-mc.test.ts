import { describe, expect, test } from "bun:test";
import {
  buildReasoningMcWorkload,
  type ReasoningRow,
} from "../../src/matrix/workloads/reasoning-mc.js";

const wl = buildReasoningMcWorkload({ name: "reasoning-test", corpus_path: "/tmp/none.jsonl" });

function score(row: ReasoningRow, completion: string) {
  return wl.scorer(row, completion) as {
    metrics: Record<string, number>;
    prediction: string;
    gold: string;
  };
}

const mc: ReasoningRow = {
  id: "x",
  suite: "mmlu_pro",
  kind: "mc",
  question: "q",
  options: ["w", "x", "y", "z"],
  answer: "C",
};
const num: ReasoningRow = { id: "n", suite: "gsm8k", kind: "numeric", question: "q", answer: "18" };

describe("reasoning-mc scorer — multiple choice", () => {
  test('exact "Answer: C"', () => {
    expect(score(mc, "reasoning here\nAnswer: C").metrics.exact_match).toBe(1);
  });
  test('markdown-wrapped "Answer: **C**"', () => {
    expect(score(mc, "Answer: **C**").metrics.exact_match).toBe(1);
  });
  test('"Answer: C) the thing" captures the letter', () => {
    expect(score(mc, "Answer: C) the third option").metrics.exact_match).toBe(1);
  });
  test("wrong letter scores 0", () => {
    expect(score(mc, "Answer: A").metrics.exact_match).toBe(0);
  });
  test("takes the LAST Answer line", () => {
    expect(score(mc, "Answer: A\n...correction...\nAnswer: C").metrics.exact_match).toBe(1);
  });
  test('fallback to trailing "(C)" when no Answer line', () => {
    const r = score(mc, "I conclude the correct option is (C).");
    expect(r.metrics.exact_match).toBe(1);
  });
  test("out-of-range letter is not accepted (only A-D for 4 options)", () => {
    const r = score(mc, "Answer: G");
    expect(r.prediction).toBe("__no_answer__");
    expect(r.metrics.no_answer).toBe(1);
  });
});

describe("reasoning-mc scorer — numeric", () => {
  test('exact "Answer: 18"', () => {
    expect(score(num, "work...\nAnswer: 18").metrics.exact_match).toBe(1);
  });
  test('"18.0" equals "18"', () => {
    expect(score(num, "Answer: 18.0").metrics.exact_match).toBe(1);
  });
  test('strips $ and commas: "$72,000" vs gold 72000', () => {
    const r = score({ ...num, answer: "72000" }, "Answer: $72,000");
    expect(r.metrics.exact_match).toBe(1);
  });
  test("fallback to last number when no Answer line", () => {
    expect(score(num, "so 6+6+6 = 18 total").metrics.exact_match).toBe(1);
  });
  test("wrong number scores 0", () => {
    expect(score(num, "Answer: 17").metrics.exact_match).toBe(0);
  });
});
