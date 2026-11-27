import { expect, test } from "bun:test";

import * as schemaMod from "../../src/workload/noderun-schema.js";

const nodeRunKnobScopeMismatch = (schemaMod as Record<string, unknown>)[
  "nodeRunKnobScopeMismatch"
] as ((nr: unknown) => string | null) | undefined;

function nodeRunFixture(
  name: string,
  node: string,
  knobs: {
    budget?: { memoryGiB: number };
    residency?: { minResidencySeconds: number };
  } = {},
): unknown {
  return {
    metadata: { name, labels: {} },
    spec: {
      node,
      infra: [],
      ...knobs,
    },
  };
}

function mismatchFor(
  name: string,
  node: string,
  knobs: {
    budget?: { memoryGiB: number };
    residency?: { minResidencySeconds: number };
  } = {},
): string | null {
  expect(typeof nodeRunKnobScopeMismatch).toBe("function");
  if (typeof nodeRunKnobScopeMismatch !== "function") return null;
  return nodeRunKnobScopeMismatch(nodeRunFixture(name, node, knobs));
}

test("K1: a residency policy on a differently named NodeRun reports the node scope mismatch", () => {
  const result = mismatchFor("gpu1-infra", "gpu1", {
    residency: { minResidencySeconds: 300 },
  });

  expect(result).not.toBeNull();
  expect(result).toContain("NodeRun 'gpu1-infra'");
  expect(result).toContain("spec.residency");
  expect(result).toContain("metadata.name 'gpu1-infra' differs from spec.node 'gpu1'");
  expect(result).toContain("would apply to node 'gpu1-infra', not 'gpu1'");
});

test("K2: a budget-only mismatch names spec.budget without blaming spec.residency", () => {
  const result = mismatchFor("gpu1-infra", "gpu1", { budget: { memoryGiB: 24 } });

  expect(result).not.toBeNull();
  expect(result).toContain("sets spec.budget ");
  expect(result).not.toContain("spec.residency");
});

test("K3: budget and residency on a mismatched NodeRun are both named", () => {
  const result = mismatchFor("gpu1-infra", "gpu1", {
    budget: { memoryGiB: 24 },
    residency: { minResidencySeconds: 300 },
  });

  expect(result).not.toBeNull();
  expect(result).toContain("sets spec.budget and spec.residency");
});

test("K4: a NodeRun named for its node may carry budget and residency", () => {
  const result = mismatchFor("gpu1", "gpu1", {
    budget: { memoryGiB: 24 },
    residency: { minResidencySeconds: 300 },
  });

  expect(result).toBeNull();
});

test("K5: a differently named NodeRun without budget or residency is infra-only", () => {
  const result = mismatchFor("gpu1-infra", "gpu1");

  expect(result).toBeNull();
});
