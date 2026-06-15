import { describe, expect, test } from "bun:test";

import { SAFETY_TIERS } from "../src/safetyTier.js";

describe("safety-tier vocabulary", () => {
  test("the canonical string tiers are read → dry-run-safe → destructive", () => {
    expect(SAFETY_TIERS).toEqual(["read", "mutation-dry-run-safe", "mutation-destructive"]);
  });

  test("SAFETY_TIERS has exactly three values and no duplicates", () => {
    expect(SAFETY_TIERS.length).toBe(3);
    expect(new Set(SAFETY_TIERS).size).toBe(SAFETY_TIERS.length);
  });
});
