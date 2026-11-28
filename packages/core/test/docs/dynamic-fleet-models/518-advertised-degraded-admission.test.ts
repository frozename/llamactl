import { describe, expect, test } from "bun:test";

import { DOC, flat, readOrEmpty, sectionBody } from "./helpers.js";

const q = flat(sectionBody(/^## Qualification and promotion/) ?? "");

describe("#518 advertised degraded admission doc", () => {
  test("D1: the qualification section documents degraded-aware advertisement admission", () => {
    expect(readOrEmpty(DOC)).not.toBe("");
    expect(q).toContain("`admissionConflict` (`packages/core/src/routing/catalog.ts`)");
    expect(q).toContain("insertCandidate");
    expect(q).toMatch(
      /healthy advertisement[^.]*held only by degraded or experimental[^.]*candidates/i,
    );
    expect(q).toMatch(/local[^.]*routes? stays? authoritative/i);
  });

  test("D2: the qualification section no longer documents stable-only advertisement peers", () => {
    expect(readOrEmpty(DOC)).not.toBe("");
    expect(q).not.toContain("judges a stable advertisement only against stable peers");
  });
});
