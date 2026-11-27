import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";

import { router } from "../src/router.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";
import { saveNodeRun } from "../src/workload/noderun-store.js";

const originalEnv = { ...process.env };
let tmp = "";

type BudgetSourceReadout = {
  budgetSource?: "computed" | "noderun";
  safetyMarginRatio?: { defaulted: boolean; value: number };
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-router-node-budget-source-"));
  Object.assign(process.env, {
    LLAMACTL_WORKLOADS_DIR: tmp,
    LLAMACTL_CONFIG: join(tmp, "config-missing"),
    LLAMACTL_RESIDENCY_STORE: join(tmp, "residency-operations.sqlite"),
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

describe("nodeBudget budgetSource", () => {
  test("NB1: a computed budget reports its source and explicit safety margin", async () => {
    // Kills: nodeBudget omitting budgetSource, or reporting the ratio as defaulted.
    saveNodeRun(
      {
        apiVersion: "llamactl/v1",
        kind: "NodeRun",
        metadata: { labels: {}, name: "local" },
        spec: { infra: [], node: "local", residency: { safetyMarginRatio: 0.5 } },
      },
      tmp,
    );

    const result = await router.createCaller({}).nodeBudget({ node: "local" });
    const view = result as typeof result & BudgetSourceReadout;

    expect(view.budgetSource).toBe("computed");
    expect(view.safetyMarginRatio).toEqual({ defaulted: false, value: 0.5 });
    expect(result.budget).toBeCloseTo((totalmem() / 1024 ** 3) * 0.5, 6);
  });

  test("NB2: an explicit NodeRun budget wins over the computed source", async () => {
    // Kills: budgetSource keyed off the residency block instead of spec.budget.memoryGiB.
    saveNodeRun(
      {
        apiVersion: "llamactl/v1",
        kind: "NodeRun",
        metadata: { labels: {}, name: "local" },
        spec: {
          budget: { memoryGiB: 36 },
          infra: [],
          node: "local",
          residency: { safetyMarginRatio: 0.5 },
        },
      },
      tmp,
    );

    const result = await router.createCaller({}).nodeBudget({ node: "local" });
    const view = result as typeof result & BudgetSourceReadout;

    expect(view.budgetSource).toBe("noderun");
    expect(result.budget).toBe(36);
    expect(view.safetyMarginRatio).toEqual({ defaulted: false, value: 0.5 });
  });

  test("NB3: a node without a NodeRun reports the default computed ratio", async () => {
    // Kills: the ratio being built without effectiveResidencyPolicy, or the field being dropped when no NodeRun matches.
    const result = await router.createCaller({}).nodeBudget({ node: "local" });
    const view = result as typeof result & BudgetSourceReadout;

    expect(view.budgetSource).toBe("computed");
    expect(view.safetyMarginRatio).toEqual({ defaulted: true, value: 0.75 });
  });

  test("NB4: an explicit budget without residency still reports the default ratio", async () => {
    // Kills: dropping safetyMarginRatio when spec.residency is absent, or mislabeling an explicit budget as computed.
    saveNodeRun(
      {
        apiVersion: "llamactl/v1",
        kind: "NodeRun",
        metadata: { labels: {}, name: "local" },
        spec: { budget: { memoryGiB: 20 }, infra: [], node: "local" },
      },
      tmp,
    );

    const result = await router.createCaller({}).nodeBudget({ node: "local" });
    const view = result as typeof result & BudgetSourceReadout;

    expect(view.budgetSource).toBe("noderun");
    expect(view.safetyMarginRatio).toEqual({ defaulted: true, value: 0.75 });
  });
});
