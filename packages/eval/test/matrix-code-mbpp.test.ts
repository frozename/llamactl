import { describe, expect, test } from "bun:test";

import { codeMbppWorkload, extractMbppCode } from "../src/matrix/workloads/code-mbpp.js";

const ROW = {
  task_id: 1,
  prompt: "Write a function add(a, b) that returns their sum.",
  code: "def add(a,b): return a+b",
  test_list: ["assert add(1, 2) == 3", "assert add(-1, 1) == 0"],
  test_imports: [],
};

describe("MBPP code extraction", () => {
  test("keeps a python fenced solution unchanged", () => {
    const code = `def add(a, b):
    return a + b
`;
    const completion = `\`\`\`python
${code}\`\`\``;

    expect(extractMbppCode(completion)).toBe(code);
  });

  test("extracts the last python block when several are present", () => {
    const first = `def add(a, b):
    return a - b
`;
    const last = `def add(a, b):
    return a + b
`;
    const completion = `\`\`\`python
${first}\`\`\`
\`\`\`py
${last}\`\`\``;

    expect(extractMbppCode(completion)).toBe(last);
  });

  test("falls back to the raw completion when unfenced", () => {
    const completion = `def add(a, b):
    return a + b`;

    expect(extractMbppCode(completion)).toBe(completion);
  });
});

describe("MBPP workload scorer", () => {
  test("scores a correct solution as pass", async () => {
    const result = await codeMbppWorkload.scorer(
      ROW,
      "```python\ndef add(a, b): return a + b\n```",
    );

    expect(result.prediction).toBe("pass");
    expect(result.gold).toBe("pass");
    expect(result.metrics["pass"]).toBe(1);
  });

  test("scores a wrong solution as fail", async () => {
    const result = await codeMbppWorkload.scorer(
      ROW,
      "```python\ndef add(a, b): return a - b\n```",
    );

    expect(result.prediction).toBe("fail");
    expect(result.gold).toBe("pass");
    expect(result.metrics["pass"]).toBe(0);
  });
});
