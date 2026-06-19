import { describe, expect, test } from "bun:test";

import { getLiveWorkloads } from "../../src/hooks/workload-selection";

describe("getLiveWorkloads — top-level phase field", () => {
  test("excludes a row whose top-level phase is Unreachable even when status.phase is Running", () => {
    const result = getLiveWorkloads([
      {
        name: "bad-model",
        phase: "Unreachable",
        spec: { enabled: true },
        status: { phase: "Running" },
      },
    ]);
    expect(result).toEqual([]);
  });

  test("includes a row whose top-level phase is Running when status is null", () => {
    const result = getLiveWorkloads([
      {
        name: "good-model",
        phase: "Running",
        spec: { enabled: true },
        status: null,
      },
    ]);
    expect(result).toEqual([{ name: "good-model", phase: "Running" }]);
  });
});
