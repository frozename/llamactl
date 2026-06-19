import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDispatcherRouter } from "../electron/trpc/dispatcher.js";

type ScanCaller = ReturnType<ReturnType<typeof buildDispatcherRouter>["createCaller"]> & {
  uiScanGitRepos: (input: {
    limit: number;
    maxDepth: number;
    root: string;
  }) => Promise<{
    repos: { mtimeMs: number; name: string; path: string }[];
    root: string;
  }>;
};

describe("uiScanGitRepos", () => {
  let root: string;

  beforeEach(() => {
    root = join(
      tmpdir(),
      `scan-${Date.now().toString()}-${Math.random().toString(36).slice(2)}`,
    );
    nodeFs.mkdirSync(join(root, "repo-alpha", ".git"), { recursive: true });
    nodeFs.mkdirSync(join(root, "repo-beta", ".git"), { recursive: true });
    nodeFs.mkdirSync(join(root, "plain-dir"), { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(root, { recursive: true, force: true });
  });

  test("walk is async: readdirSync is not called", async () => {
    const spy = spyOn(nodeFs, "readdirSync");
    try {
      const caller = buildDispatcherRouter().createCaller({}) as unknown as ScanCaller;
      await caller.uiScanGitRepos({ limit: 50, maxDepth: 2, root });
      // Fails before fix (readdirSync IS called); passes after fix (not called).
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("returns correct repos and excludes non-git dirs", async () => {
    const caller = buildDispatcherRouter().createCaller({}) as unknown as ScanCaller;
    const result = await caller.uiScanGitRepos({ limit: 50, maxDepth: 2, root });

    const names = result.repos.map((r) => r.name).sort();
    expect(names).toEqual(["repo-alpha", "repo-beta"]);
    expect(result.repos.every((r) => r.mtimeMs > 0)).toBe(true);
  });

  test("respects the limit parameter", async () => {
    const caller = buildDispatcherRouter().createCaller({}) as unknown as ScanCaller;
    const result = await caller.uiScanGitRepos({ limit: 1, maxDepth: 2, root });
    expect(result.repos).toHaveLength(1);
  });

  test("returns empty repos for a nonexistent root", async () => {
    const caller = buildDispatcherRouter().createCaller({}) as unknown as ScanCaller;
    const result = await caller.uiScanGitRepos({
      limit: 50,
      maxDepth: 2,
      root: "/nonexistent/xyz-llamactl-scan-test",
    });
    expect(result.repos).toHaveLength(0);
  });
});
