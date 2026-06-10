import { describe, expect, test } from "bun:test";

import { taskRefinerRubricWorkload } from "../src/index.js";

describe("task-refiner-rubric scorer", () => {
  test("parses judge JSON and computes composite", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '{"intent_preservation": 3, "contract_clarity": 2, "noise_removal": 2, "comment": "ok"}',
              },
            },
          ],
          usage: { completion_tokens: 20 },
        }),
        { headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;
    try {
      const result = await taskRefinerRubricWorkload.scorer({ input: "draft" }, "refined output");
      expect(result.metrics.intent_preservation).toBe(3);
      expect(result.metrics.contract_clarity).toBe(2);
      expect(result.metrics.noise_removal).toBe(2);
      expect(result.metrics.composite).toBeCloseTo(7 / 9, 5);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("handles @@metadata wrapper and code fences", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '@@metadata\n```json\n{"intent_preservation": 1, "contract_clarity": 1, "noise_removal": 1}\n```\n@@end',
              },
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;
    try {
      const result = await taskRefinerRubricWorkload.scorer({ input: "draft" }, "refined");
      expect(result.metrics.composite).toBeCloseTo(3 / 9, 5);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("empty output returns parse_error path", async () => {
    const origFetch = globalThis.fetch;
    let calledJudge = false;
    globalThis.fetch = (async () => {
      calledJudge = true;
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;
    try {
      const result = await taskRefinerRubricWorkload.scorer({ input: "draft" }, "   ");
      expect(result.metrics.parse_error).toBe(1);
      expect(calledJudge).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
