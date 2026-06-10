import { describe, expect, test } from "bun:test";

import { projectAdmissionHeadroom } from "../src/policy.js";

describe("projectAdmissionHeadroom", () => {
  test("rejects when projected free drops below headroom minimum", () => {
    // 18 - (12 * 1.3) = 18 - 15.6 = 2.4 < 8 → reject
    const result = projectAdmissionHeadroom({
      currentFreeGiB: 18,
      expectedMemoryGiB: 12,
      headroomMinGiB: 8,
      safetyFactor: 1.3,
    });
    expect(result.projectedFreeGiB).toBeCloseTo(2.4, 5);
    expect(result).toMatchObject({
      allowed: false,
      reason: "projected_free_below_headroom",
      source: "declared",
    });
  });

  test("allows when projected free exceeds headroom minimum", () => {
    // 32 - (8 * 1.3) = 32 - 10.4 = 21.6 > 8 → allow
    const result = projectAdmissionHeadroom({
      currentFreeGiB: 32,
      expectedMemoryGiB: 8,
      headroomMinGiB: 8,
      safetyFactor: 1.3,
    });
    expect(result.allowed).toBe(true);
    expect(result.projectedFreeGiB).toBeCloseTo(21.6, 5);
    expect("reason" in result).toBe(false);
  });

  test("defaults safetyFactor to 1.3 when omitted", () => {
    const withExplicit = projectAdmissionHeadroom({
      currentFreeGiB: 20,
      expectedMemoryGiB: 5,
      headroomMinGiB: 4,
      safetyFactor: 1.3,
    });
    const withDefault = projectAdmissionHeadroom({
      currentFreeGiB: 20,
      expectedMemoryGiB: 5,
      headroomMinGiB: 4,
    });
    expect(withDefault.projectedFreeGiB).toBeCloseTo(withExplicit.projectedFreeGiB, 10);
  });
});
