// packages/app/test/lib/global-search/use-global-search-helpers.test.ts
import { describe, expect, test } from "bun:test";

import type { trpc } from "../../../src/lib/trpc";

import { runTier3Search } from "../../../src/lib/global-search/hooks/use-global-search-helpers";

type Utils = ReturnType<typeof trpc.useUtils>;

const noop = (): void => undefined;

function makeUtils(fetch?: () => Promise<{ results: unknown[] }>): Utils {
  return {
    ragSearch: {
      fetch: fetch ?? ((): Promise<{ results: unknown[] }> => Promise.resolve({ results: [] })),
    },
  } as unknown as Utils;
}

// Regression tests [2]: status must not go idle until tier3 settles.
// runTier3Search must always invoke its onComplete callback, regardless of
// whether RAG is enabled, so that the caller's pending-tier counter reaches
// zero only when both tier2 AND tier3 have truly settled.

describe("runTier3Search onComplete", () => {
  test("calls onComplete when ragStatus is undefined (RAG unavailable)", async () => {
    let called = false;
    const queryToken = { current: 1 } as React.RefObject<number>;
    await runTier3Search(1, queryToken, { needle: "test" }, undefined, makeUtils(), noop, () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  test("calls onComplete when ragStatus has no defaultNode", async () => {
    let called = false;
    const queryToken = { current: 1 } as React.RefObject<number>;
    await runTier3Search(
      1,
      queryToken,
      { needle: "test" },
      { sessions: true, knowledge: false, logs: false },
      makeUtils(),
      noop,
      () => {
        called = true;
      },
    );
    expect(called).toBe(true);
  });

  test("calls onComplete after tasks settle when RAG is enabled", async () => {
    let called = false;
    const queryToken = { current: 1 } as React.RefObject<number>;
    await runTier3Search(
      1,
      queryToken,
      { needle: "test" },
      { defaultNode: "node1", sessions: true, knowledge: false, logs: false },
      makeUtils(),
      noop,
      () => {
        called = true;
      },
    );
    expect(called).toBe(true);
  });

  test("calls onComplete even when token has expired", async () => {
    let called = false;
    const queryToken = { current: 99 } as React.RefObject<number>; // token=1 is stale
    await runTier3Search(
      1,
      queryToken,
      { needle: "test" },
      { defaultNode: "node1", sessions: true },
      makeUtils(),
      noop,
      () => {
        called = true;
      },
    );
    expect(called).toBe(true);
  });
});
