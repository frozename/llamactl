import { describe, expect, test } from "bun:test";

import {
  extractIdsByAppearance,
  memoryRecallWorkload,
  recallAtK,
} from "../src/matrix/workloads/memory-recall.js";

const row = {
  query: "q",
  candidates: [
    { id: "m1", text: "t1" },
    { id: "m2", text: "t2" },
    { id: "m3", text: "t3" },
  ],
  gold_ids: ["m1", "m2"],
};

describe("recallAtK", () => {
  // Mutation: change `hit / Math.min(k, goldSet.size)` to `hit / k`, giving 0.4.
  test("is order-insensitive within the top-k window", () => {
    expect(recallAtK(["m2", "x", "m1"], ["m1", "m2"], 5)).toBe(1);
  });

  // Mutation: change the denominator `Math.min(k, goldSet.size)` to `goldSet.size`, giving 5/7.
  test("caps the denominator at k when the gold set is larger than k", () => {
    const gold = ["g1", "g2", "g3", "g4", "g5", "g6", "g7"];
    expect(recallAtK(gold, gold, 5)).toBe(1);
  });

  // Mutation: change the denominator to `Math.min(k, goldIds.length)`, giving 0.5.
  test("de-duplicates repeated gold ids", () => {
    expect(recallAtK(["a", "x"], ["a", "a"], 5)).toBe(1);
  });

  // Mutation: change `ranking.slice(0, k)` to `ranking` (no slice).
  test("only counts gold ids inside the top-k window", () => {
    const ranking = ["x", "y", "z", "w", "v", "a"];
    expect(recallAtK(ranking, ["a"], 5)).toBe(0);
    expect(recallAtK(ranking, ["a"], 6)).toBe(1);
  });

  // Mutation: delete the `if (goldIds.length === 0) return 0;` guard, which yields NaN.
  test("returns 0 for an empty gold set", () => {
    expect(recallAtK(["a"], [], 5)).toBe(0);
  });
});

describe("extractIdsByAppearance", () => {
  // Mutation: delete `found.sort(...)`, giving ["m1","m3"].
  test("orders ids by first appearance in the text, not candidate order", () => {
    expect(extractIdsByAppearance("best is m3, then m1", row.candidates)).toEqual(["m3", "m1"]);
  });

  // Mutation: push every candidate (drop the `if (at >= 0)` guard).
  test("omits candidates that are never mentioned", () => {
    const out = extractIdsByAppearance("best is m3, then m1", row.candidates);
    expect(out).not.toBeNull();
    expect(out?.length).toBe(2);
    expect(out).not.toContain("m2");
  });

  // Mutation: change `if (found.length === 0) return null;` to return [].
  test("returns null when no candidate id appears", () => {
    expect(extractIdsByAppearance("no ids here", row.candidates)).toBeNull();
  });
});

describe("memoryRecallWorkload.scorer fallback and parsing", () => {
  // Mutation: set `fallback = 0` unconditionally in the fallback branch, or remove
  // the extractIdsByAppearance call, which turns it into a parse_error.
  test("recovers a prose ranking via the appearance fallback", async () => {
    const out = await memoryRecallWorkload.scorer(row, "I would put m2 first and then m1");
    expect(out.prediction).toBe("m2,m1");
    expect(out.metrics["fallback"]).toBe(1);
    expect(out.metrics["parse_error"]).toBe(0);
    expect(out.metrics["recall5"]).toBe(1);
  });

  // Mutation: initialise `let fallback = 1`.
  test("reports fallback 0 on the JSON path", async () => {
    const out = await memoryRecallWorkload.scorer(row, '{"ranking": ["m1","m2","m3"]}');
    expect(out.metrics["fallback"]).toBe(0);
    expect(out.metrics["recall5"]).toBe(1);
  });

  // Mutation: delete the `if (!r.every((v) => typeof v === "string")) return null;` line,
  // which gives fallback 0.
  test("rejects a non-string ranking element and falls back", async () => {
    const out = await memoryRecallWorkload.scorer(row, '{"ranking": ["m1", 2]}');
    expect(out.metrics["fallback"]).toBe(1);
    expect(out.prediction).toBe("m1");
  });

  // Mutation: make stripMetadataEnvelope return `s` unchanged; the first-{..last-} slice
  // then spans both objects, JSON.parse fails, and the prose fallback sets fallback 1.
  test("strips the @@metadata envelope before parsing", async () => {
    const out = await memoryRecallWorkload.scorer(
      row,
      '@@metadata {"ranking": ["m2","m1","m3"]} @@end {"note": "x"}',
    );
    expect(out.metrics["fallback"]).toBe(0);
    expect(out.prediction).toBe("m2,m1,m3");
  });

  // Mutation: change `parsed.slice(0, 5)` to `parsed`.
  test("truncates the prediction to the top 5 and comma-joins gold", async () => {
    const sevenRow = {
      query: "q",
      candidates: [
        { id: "m1", text: "t1" },
        { id: "m2", text: "t2" },
        { id: "m3", text: "t3" },
        { id: "m4", text: "t4" },
        { id: "m5", text: "t5" },
        { id: "m6", text: "t6" },
        { id: "m7", text: "t7" },
      ],
      gold_ids: ["m1", "m2"],
    };
    const out = await memoryRecallWorkload.scorer(
      sevenRow,
      '{"ranking": ["m1","m2","m3","m4","m5","m6","m7"]}',
    );
    expect(out.prediction).toBe("m1,m2,m3,m4,m5");
    expect(out.gold).toBe("m1,m2");
  });

  // Mutation: change the parse-error metrics literal `recall5: 0` to `recall5: 1`.
  test("zeroes recall5 and fallback on the parse-error path", async () => {
    const out = await memoryRecallWorkload.scorer(row, "nothing relevant");
    expect(out.metrics["recall5"]).toBe(0);
    expect(out.metrics["fallback"]).toBe(0);
    expect(out.metrics["parse_error"]).toBe(1);
    expect(out.gold).toBe("m1,m2");
  });
});

describe("memoryRecallWorkload.prompt_builder", () => {
  // Mutation: change the `ctx` ternary's false branch to "Context: \n\n".
  test("omits the Context block when the row has no context", () => {
    const messages = memoryRecallWorkload.prompt_builder(row).messages as {
      role: string;
      content: string;
    }[];
    expect(messages.length).toBe(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.content.startsWith("Query: q")).toBe(true);
    expect(messages[1]?.content.includes("Context:")).toBe(false);
  });

  // Mutation: drop `${ctx}` from the template.
  test("places context before the query when present", () => {
    const messages = memoryRecallWorkload.prompt_builder({ ...row, context: "ctx-here" })
      .messages as { role: string; content: string }[];
    expect(messages[1]?.content.startsWith("Context: ctx-here\n\nQuery: q")).toBe(true);
  });

  // Mutation: change `String(i + 1)` to `String(i)`.
  test("numbers candidates 1-based in brackets", () => {
    const messages = memoryRecallWorkload.prompt_builder(row).messages as {
      role: string;
      content: string;
    }[];
    expect(messages[1]?.content.includes("1. [m1] t1\n2. [m2] t2\n3. [m3] t3")).toBe(true);
  });
});
