import { describe, expect, test } from "bun:test";

import { numericTierFromInferred } from "../src/healer/severity.js";
import { gatePlan, type PlanLike, stepTier, tierOf } from "../src/index.js";

/**
 * Pins the healer severity ladder end to end: the inferred-tier →
 * numeric mapping, `tierOf` suffix classification and its check
 * order, `stepTier`, and the `gatePlan` threshold boundaries the
 * `--auto` / `--severity-threshold` flags rely on. Complements
 * severity-rag / severity-composite, which pin only their own tool
 * families.
 */

describe("numericTierFromInferred", () => {
  test("maps each inferred tier string to its numeric tier", () => {
    expect(numericTierFromInferred("read")).toBe(1);
    expect(numericTierFromInferred("mutation-dry-run-safe")).toBe(2);
    expect(numericTierFromInferred("mutation-destructive")).toBe(3);
  });
});

describe("tierOf verb suffixes not covered elsewhere", () => {
  test("classifies tier-1 verb suffixes as tier 1", () => {
    expect(tierOf("llamactl.node.show")).toBe(1);
    expect(tierOf("llamactl.journal.history")).toBe(1);
    expect(tierOf("llamactl.cost.snapshot")).toBe(1);
    expect(tierOf("llamactl.node.facts")).toBe(1);
    expect(tierOf("llamactl.fleet.overview")).toBe(1);
    expect(tierOf("llamactl.node.env")).toBe(1);
    expect(tierOf("llamactl.policy.simulate")).toBe(1);
    expect(tierOf("llamactl.logs.tail")).toBe(1);
  });

  test("classifies tier-2 verb suffixes as tier 2", () => {
    expect(tierOf("llamactl.server.start")).toBe(2);
    expect(tierOf("llamactl.server.stop")).toBe(2);
    expect(tierOf("llamactl.node.add")).toBe(2);
    expect(tierOf("llamactl.config.set")).toBe(2);
  });

  test("classifies llamactl.node.drain as tier 3", () => {
    expect(tierOf("llamactl.node.drain")).toBe(3);
  });

  test("classifies the onboard-new-gpu-node runbook override as tier 2", () => {
    expect(tierOf("onboard-new-gpu-node")).toBe(2);
  });
});

describe("tierOf check order and substring matching", () => {
  test("checks tier-3 suffixes before tier-1 suffixes", () => {
    expect(tierOf("nova.ops.remove.list")).toBe(3);
  });

  test("checks tier-3 suffixes before tier-2 suffixes", () => {
    expect(tierOf("llamactl.node.sync.delete")).toBe(3);
  });

  test("checks tier-2 suffixes before tier-1 suffixes", () => {
    expect(tierOf("llamactl.sync.status")).toBe(2);
  });

  test("matches suffixes as substrings anywhere in the tool name", () => {
    expect(tierOf("llamactl.node.removeAll")).toBe(3);
    expect(tierOf("llamactl.server.startAll")).toBe(2);
  });
});

describe("stepTier", () => {
  test("returns tier 3 for llamactl.node.remove even when dryRun is true", () => {
    expect(stepTier({ tool: "llamactl.node.remove", dryRun: true })).toBe(3);
  });

  test("returns tier 1 for llamactl.catalog.list with args", () => {
    expect(stepTier({ tool: "llamactl.catalog.list", args: { x: 1 } })).toBe(1);
  });
});

describe("gatePlan boundaries", () => {
  test("allows an empty plan at severity threshold 1", () => {
    const plan: PlanLike = { steps: [], reasoning: "r", requiresConfirmation: false };
    expect(gatePlan(plan, 1)).toEqual({ allowed: true, refusedSteps: [] });
  });

  test("refuses every step above the threshold and reports index, tool and tier", () => {
    const plan: PlanLike = {
      steps: [
        { tool: "llamactl.catalog.list" },
        { tool: "llamactl.catalog.promote" },
        { tool: "llamactl.node.remove" },
      ],
      reasoning: "r",
      requiresConfirmation: false,
    };
    expect(gatePlan(plan, 1)).toEqual({
      allowed: false,
      refusedSteps: [
        { index: 1, tool: "llamactl.catalog.promote", tier: 2 },
        { index: 2, tool: "llamactl.node.remove", tier: 3 },
      ],
    });
  });

  test("allows a tier-3 step when the threshold is 3", () => {
    const plan: PlanLike = {
      steps: [{ tool: "llamactl.node.remove" }],
      reasoning: "r",
      requiresConfirmation: false,
    };
    expect(gatePlan(plan, 3)).toEqual({ allowed: true, refusedSteps: [] });
  });

  test("treats an unknown tool as tier 3 in the gate", () => {
    const plan: PlanLike = {
      steps: [{ tool: "llamactl.mystery.action" }],
      reasoning: "r",
      requiresConfirmation: false,
    };
    expect(gatePlan(plan, 3)).toEqual({ allowed: true, refusedSteps: [] });
    expect(gatePlan(plan, 2)).toEqual({
      allowed: false,
      refusedSteps: [{ index: 0, tool: "llamactl.mystery.action", tier: 3 }],
    });
  });

  test("refuses when requiresConfirmation is true and a step exceeds the threshold", () => {
    const plan: PlanLike = {
      steps: [{ tool: "llamactl.node.remove" }],
      reasoning: "r",
      requiresConfirmation: true,
    };
    expect(gatePlan(plan, 2)).toEqual({
      allowed: false,
      refusedSteps: [{ index: 0, tool: "llamactl.node.remove", tier: 3 }],
    });
  });
});
