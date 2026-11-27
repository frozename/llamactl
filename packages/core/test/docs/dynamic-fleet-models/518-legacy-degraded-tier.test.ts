import { describe, expect, test } from "bun:test";

import { DOC, flat, readOrEmpty, sectionBody } from "./helpers.js";

// Part of #518: the legacy comparator's healthy/degraded/experimental order.
describe("#518 legacy degraded tier doc", () => {
  test("D1: the qualification section documents the legacy degraded ordering", () => {
    expect(readOrEmpty(DOC)).not.toBe("");
    const q = flat(sectionBody(/^## Qualification and promotion/) ?? "");
    expect(q).toContain("orderedProxyRoutes");
    expect(q).toContain("compareDeployments");
    expect(q).toMatch(/legacy[^.]*degraded[^.]*(behind|after)[^.]*healthy/i);
  });

  test("D2: the qualification section no longer documents degraded as ignored", () => {
    expect(readOrEmpty(DOC)).not.toBe("");
    const q = flat(sectionBody(/^## Qualification and promotion/) ?? "");
    expect(q).not.toMatch(/comparator[^.]*ignores degraded/i);
  });
});
