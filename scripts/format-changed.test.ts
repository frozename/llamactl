import { describe, expect, test } from "bun:test";

import {
  changedFiles,
  type GitRunner,
  planFormatCheck,
  prettierArgs,
  resolveBaseRef,
} from "./format-changed.ts";

const UPSTREAM_LOOKUP = "rev-parse --abbrev-ref --symbolic-full-name @{upstream}";
const DIFF_CMD = "diff --name-only -z --diff-filter=ACMR abc123 HEAD";

type GitResult = { code: number; stdout: string };

function fakeGit(table: Record<string, GitResult>): { calls: string[][]; git: GitRunner } {
  const calls: string[][] = [];
  const git: GitRunner = (args) => {
    calls.push([...args]);
    return table[args.join(" ")] ?? { code: 1, stdout: "" };
  };
  return { calls, git };
}

describe("resolveBaseRef", () => {
  test("merge-bases against the branch upstream when one exists", () => {
    const { git } = fakeGit({
      [UPSTREAM_LOOKUP]: { code: 0, stdout: "origin/feat\n" },
      "merge-base origin/feat HEAD": { code: 0, stdout: "abc123\n" },
    });

    expect(resolveBaseRef(git)).toBe("abc123");
  });

  test("falls back to origin/main when the branch has no upstream", () => {
    const { git } = fakeGit({
      [UPSTREAM_LOOKUP]: { code: 128, stdout: "" },
      "merge-base origin/main HEAD": { code: 0, stdout: "def456\n" },
    });

    expect(resolveBaseRef(git)).toBe("def456");
  });

  test("returns null when neither upstream nor origin/main resolves", () => {
    const { git } = fakeGit({});

    expect(resolveBaseRef(git)).toBeNull();
  });
});

describe("changedFiles", () => {
  test("diffs base against HEAD and parses NUL-separated names", () => {
    const { calls, git } = fakeGit({
      [DIFF_CMD]: { code: 0, stdout: "a.ts\0dir/b.md\0\0" },
    });

    expect(changedFiles(git, "abc123")).toEqual(["a.ts", "dir/b.md"]);
    expect(calls).toEqual([["diff", "--name-only", "-z", "--diff-filter=ACMR", "abc123", "HEAD"]]);
  });

  test("returns an empty list for an empty diff", () => {
    const { git } = fakeGit({ [DIFF_CMD]: { code: 0, stdout: "" } });

    expect(changedFiles(git, "abc123")).toEqual([]);
  });

  test("throws an error mentioning git diff on a nonzero exit", () => {
    const { git } = fakeGit({ [DIFF_CMD]: { code: 2, stdout: "" } });

    let thrown: unknown;
    try {
      changedFiles(git, "abc123");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("git diff");
  });
});

describe("planFormatCheck", () => {
  test("keeps only files that still exist, in diff order", () => {
    const { git } = fakeGit({
      [UPSTREAM_LOOKUP]: { code: 0, stdout: "origin/feat\n" },
      "merge-base origin/feat HEAD": { code: 0, stdout: "abc123\n" },
      [DIFF_CMD]: { code: 0, stdout: "a.ts\0gone.ts\0c.json\0" },
    });

    const plan = planFormatCheck(git, (path) => path !== "gone.ts");

    expect(plan).toEqual({ base: "abc123", files: ["a.ts", "c.json"] });
  });

  test("returns an empty plan and never diffs when no base resolves", () => {
    const { calls, git } = fakeGit({});

    expect(planFormatCheck(git, () => true)).toEqual({ base: null, files: [] });
    expect(calls.some((args) => args[0] === "diff")).toBe(false);
  });
});

describe("prettierArgs", () => {
  test("builds a check invocation over the given files", () => {
    expect(prettierArgs(["a.ts", "b.md"])).toEqual([
      "--check",
      "--ignore-unknown",
      "--no-error-on-unmatched-pattern",
      "--",
      "a.ts",
      "b.md",
    ]);
  });

  test("returns no args when there is nothing to check", () => {
    expect(prettierArgs([])).toEqual([]);
  });
});
