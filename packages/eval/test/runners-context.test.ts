import { describe, expect, test } from "bun:test";

import { assembleHaystack } from "../src/runners/context-retrieval.js";

function tokenize(text: string): string[] {
  return text.trim().match(/[A-Za-z0-9']+|[^\sA-Za-z0-9']/g) ?? [];
}

function needleIndex(haystack: string, needle: string): number {
  const hayTokens = tokenize(haystack);
  const needleTokens = tokenize(needle);
  outer: for (let i = 0; i <= hayTokens.length - needleTokens.length; i++) {
    for (const [j, needleToken] of needleTokens.entries()) {
      if (hayTokens[i + j] !== needleToken) continue outer;
    }
    return i;
  }
  return -1;
}

describe("assembleHaystack", () => {
  const base =
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega.";
  const needle = "needle token sequence appears here";

  test("places the needle at the start for position 0", () => {
    const haystack = assembleHaystack(base, needle, 64, 0);
    expect(haystack.startsWith(needle)).toBe(true);
  });

  test("places the needle at the end for position 1", () => {
    const haystack = assembleHaystack(base, needle, 64, 1);
    expect(haystack.trimEnd().endsWith(needle)).toBe(true);
  });

  test("places the needle near the middle for position 0.5", () => {
    const haystack = assembleHaystack(base, needle, 128, 0.5);
    const hayTokens = tokenize(haystack);
    const idx = needleIndex(haystack, needle);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeGreaterThan(Math.floor(hayTokens.length * 0.3));
    expect(idx).toBeLessThan(Math.ceil(hayTokens.length * 0.7));
  });

  test("pads by repeating the base when the requested depth is larger than the base", () => {
    const haystack = assembleHaystack("short base only", needle, 256, 0.25);
    const tokens = tokenize(haystack);
    expect(tokens.length).toBeGreaterThanOrEqual(256);
    expect(haystack.includes(needle)).toBe(true);
  });
});
