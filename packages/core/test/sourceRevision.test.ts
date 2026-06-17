import { describe, expect, it } from "bun:test";

import {
  checkSourceStale,
  findRepoRoot,
  getSourceRevision,
  stepStaleStreak,
} from "../src/sourceRevision.js";

describe("stepStaleStreak", () => {
  it("same rev -> streak 0, no reload", () => {
    expect(stepStaleStreak({ streak: 0 }, "aaa", "aaa", 2)).toEqual({
      state: { streak: 0 },
      shouldReload: false,
    });
  });

  it("changed once below threshold -> streak 1, no reload", () => {
    expect(stepStaleStreak({ streak: 0 }, "bbb", "aaa", 2)).toEqual({
      state: { streak: 1 },
      shouldReload: false,
    });
  });

  it("changed twice reaches threshold -> reload (debounce satisfied)", () => {
    expect(stepStaleStreak({ streak: 1 }, "bbb", "aaa", 2)).toEqual({
      state: { streak: 2 },
      shouldReload: true,
    });
  });

  it("null current rev -> streak UNCHANGED, no reload (fail-safe)", () => {
    // must be the SAME streak, not reset to 0 — a read error is not a rev change
    expect(stepStaleStreak({ streak: 1 }, null, "aaa", 2)).toEqual({
      state: { streak: 1 },
      shouldReload: false,
    });
  });

  it("empty-string rev treated as null -> streak unchanged, no reload", () => {
    expect(stepStaleStreak({ streak: 1 }, "", "aaa", 2)).toEqual({
      state: { streak: 1 },
      shouldReload: false,
    });
  });

  it("flips back to startupRev -> streak resets to 0", () => {
    expect(stepStaleStreak({ streak: 1 }, "aaa", "aaa", 2)).toEqual({
      state: { streak: 0 },
      shouldReload: false,
    });
  });
});

describe("getSourceRevision", () => {
  it("returns the trimmed sha when exec yields a sha with a newline", () => {
    expect(getSourceRevision({ exec: () => "abc123\n", repoRoot: "/repo" })).toBe("abc123");
  });

  it("returns null when exec throws (git failure / not a checkout)", () => {
    expect(
      getSourceRevision({
        exec: () => {
          throw new Error("not a git repository");
        },
        repoRoot: "/repo",
      }),
    ).toBeNull();
  });

  it("returns null when exec returns empty output", () => {
    expect(getSourceRevision({ exec: () => "  \n", repoRoot: "/repo" })).toBeNull();
  });

  it("returns null when there is no repo root", () => {
    expect(getSourceRevision({ exec: () => "abc", repoRoot: null })).toBeNull();
  });
});

describe("findRepoRoot", () => {
  it("finds the dir containing .git walking up", () => {
    const existsFn = (p: string): boolean => p === "/a/b/.git";
    expect(findRepoRoot("/a/b/c", { existsFn })).toBe("/a/b");
  });

  it("returns null when no .git ancestor", () => {
    expect(findRepoRoot("/a/b/c", { existsFn: () => false })).toBeNull();
  });
});

describe("checkSourceStale", () => {
  it("advances the streak and surfaces currentRev", () => {
    expect(
      checkSourceStale(
        "aaa",
        { streak: 1 },
        { readSourceRevision: () => "bbb", reloadStaleChecks: 2 },
      ),
    ).toEqual({ state: { streak: 2 }, shouldReload: true, currentRev: "bbb" });
  });

  it("null read -> not stale, streak unchanged", () => {
    const r = checkSourceStale("aaa", { streak: 1 }, { readSourceRevision: () => null });
    expect(r.shouldReload).toBe(false);
    expect(r.state).toEqual({ streak: 1 });
    expect(r.currentRev).toBeNull();
  });
});
