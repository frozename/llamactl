import { describe, expect, test } from "bun:test";

import { aggregateMeanPassAt1 } from "../src/matrix/runner.js";
import {
  buildProgram,
  codeHumanevalWorkload,
  extractCode,
  runCandidate,
} from "../src/matrix/workloads/code-humaneval.js";

const PROMPT_SOURCE = `from typing import List

def has_close_elements(numbers: List[float], threshold: float) -> bool:
    """Return True if any two numbers are closer than threshold."""
`;

const GOOD_BODY = `    for i, first in enumerate(numbers):
        for second in numbers[i + 1:]:
            if abs(first - second) < threshold:
                return True
    return False`;

const GOOD_FUNCTION = `${PROMPT_SOURCE}${GOOD_BODY}
`;

const WRONG_BODY = `    return False`;

const TEST_SOURCE = `METADATA = {}

def check(candidate):
    assert candidate([1.0, 2.0, 3.0], 0.5) == False
    assert candidate([1.0, 2.0, 3.0], 1.1) == True
`;

const ROW = {
  task_id: "HumanEval/0",
  prompt: PROMPT_SOURCE,
  canonical_solution: GOOD_BODY,
  test: TEST_SOURCE,
  entry_point: "has_close_elements",
};

describe("HumanEval code extraction", () => {
  test("keeps a python fenced full function unchanged", () => {
    const completion = `\`\`\`python
${GOOD_FUNCTION}\`\`\``;

    const code = extractCode(completion, ROW.entry_point, ROW.prompt);

    expect(code).toBe(GOOD_FUNCTION);
    expect(code).toContain(`def ${ROW.entry_point}`);
  });

  test("prepends the prompt when the completion only contains a body", () => {
    const code = extractCode(GOOD_BODY, ROW.entry_point, ROW.prompt);

    expect(code).toContain(`def ${ROW.entry_point}`);
    expect(code).toContain(GOOD_BODY);
  });

  test("extracts a plain fenced code block", () => {
    const completion = `\`\`\`
${GOOD_FUNCTION}\`\`\``;

    const code = extractCode(completion, ROW.entry_point, ROW.prompt);

    expect(code).toBe(GOOD_FUNCTION);
  });

  test("uses raw completions when there are no fences", () => {
    const code = extractCode(GOOD_FUNCTION, ROW.entry_point, ROW.prompt);

    expect(code).toBe(GOOD_FUNCTION);
  });

  test("prepends the prompt when the body contains a nested helper with same prefix", () => {
    // entry_point is "has_close_elements"
    // body contains "def has_close_elements_inner"
    const bodyWithNested = `    def has_close_elements_inner():
        return True
    return has_close_elements_inner()`;

    const code = extractCode(bodyWithNested, ROW.entry_point, ROW.prompt);

    // Should prepend because "def has_close_elements" (the entry point) is NOT defined at top level
    expect(code).toBe(`${ROW.prompt}${bodyWithNested}`);
  });

  test("extracts the last python block that defines the entry point", () => {
    const completion = `Here is an example:
\`\`\`python
def other_function():
    pass
\`\`\`
And the solution:
\`\`\`python
${GOOD_FUNCTION}\`\`\``;

    const code = extractCode(completion, ROW.entry_point, ROW.prompt);

    expect(code).toBe(GOOD_FUNCTION);
  });

  test("extracts code from an unclosed python fence", () => {
    const completion = `\`\`\`python
${GOOD_FUNCTION}`; // No closing fence

    const code = extractCode(completion, ROW.entry_point, ROW.prompt);

    expect(code).toBe(GOOD_FUNCTION);
  });
});

describe("HumanEval candidate execution", () => {
  test("passes a known-good full function", async () => {
    const program = buildProgram(GOOD_FUNCTION, ROW.test, ROW.entry_point);

    const result = await runCandidate(program);

    expect(result).toEqual({ passed: true, status: "pass" });
  });

  test("fails a known-wrong body", async () => {
    const code = extractCode(WRONG_BODY, ROW.entry_point, ROW.prompt);
    const program = buildProgram(code, ROW.test, ROW.entry_point);

    const result = await runCandidate(program);

    expect(result.passed).toBe(false);
    expect(result.status).toBe("fail");
    expect(result.detail).toBeString();
  });

  test("times out an infinite loop promptly", async () => {
    const code = extractCode("    while True:\n        pass", ROW.entry_point, ROW.prompt);
    const program = buildProgram(code, ROW.test, ROW.entry_point);
    const started = performance.now();

    const result = await runCandidate(program, { timeoutMs: 2500 });
    const elapsedMs = performance.now() - started;

    expect(result.passed).toBe(false);
    expect(result.status).toBe("timeout");
    expect(elapsedMs).toBeLessThan(5000);
  });
});

describe("HumanEval workload scorer", () => {
  test("scores a canonical full function as pass", async () => {
    const completion = `\`\`\`python
${GOOD_FUNCTION}\`\`\``;

    const result = await codeHumanevalWorkload.scorer(ROW, completion);

    expect(result.prediction).toBe("pass");
    expect(result.gold).toBe("pass");
    expect(result.metrics["pass"]).toBe(1);
  });

  test("scores a wrong completion as fail", async () => {
    const result = await codeHumanevalWorkload.scorer(ROW, WRONG_BODY);

    expect(result.prediction).toBe("fail");
    expect(result.gold).toBe("pass");
    expect(result.metrics["pass"]).toBe(0);
  });
});

describe("HumanEval scorer sandbox infra error", () => {
  test("sandbox infra error returns non-pass instead of throwing, keeping denominator intact", async () => {
    const origSpawn = Bun.spawn;
    (Bun as unknown as { spawn: unknown }).spawn = (): never => {
      throw new Error("mock-spawn-infra-failure");
    };

    try {
      const result = await codeHumanevalWorkload.scorer(ROW, GOOD_BODY);
      expect(result.metrics["pass"]).toBe(0);
    } finally {
      (Bun as unknown as { spawn: unknown }).spawn = origSpawn;
    }
  });
});

describe("HumanEval pass@1 aggregation", () => {
  test("averages pass metrics", () => {
    const result = aggregateMeanPassAt1([{ pass: 1 }, { pass: 0 }, { pass: 1 }]);

    expect(result.primary_metric_value).toBe(2 / 3);
    expect(JSON.parse(result.per_class_metrics_json)).toEqual({
      mean_pass_at_1: 2 / 3,
      n_scored: 3,
    });
  });
});
