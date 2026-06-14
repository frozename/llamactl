import { describe, expect, test } from "bun:test";

import { SAFETY_TIERS, type SafetyTier } from "../src/safetyTier.js";

describe("safety-tier vocabulary", () => {
  test("the canonical string tiers are read → dry-run-safe → destructive", () => {
    expect(SAFETY_TIERS).toEqual(["read", "mutation-dry-run-safe", "mutation-destructive"]);
  });

  test("SafetyTier admits exactly the three canonical values", () => {
    const all: SafetyTier[] = ["read", "mutation-dry-run-safe", "mutation-destructive"];
    expect(new Set(all)).toEqual(new Set(SAFETY_TIERS));
  });
});
