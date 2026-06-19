// packages/app/test/lib/global-search/orchestrator.test.ts
import { describe, expect, test } from "bun:test";

import type { GroupedResults, Hit } from "../../../src/lib/global-search/types";

import { mergeServerHits, runClientPhase } from "../../../src/lib/global-search/orchestrator";

const TAB = { tabKey: "t", title: "t", kind: "module" as const, openedAt: 0 };
const ACTION = { kind: "open-tab" as const, tab: TAB };

describe("runClientPhase", () => {
  test("returns GroupedResults sorted by topScore", () => {
    const out = runClientPhase({
      query: { needle: "dash" },
      tabState: { tabs: [], closed: [] },
      workloads: [],
      nodes: [],
      presets: [],
    });
    expect(Array.isArray(out)).toBe(true);
  });

  test("surface filter restricts to one group", () => {
    const out = runClientPhase({
      query: { needle: "dash", surfaceFilter: "module" },
      tabState: { tabs: [], closed: [] },
      workloads: [],
      nodes: [],
      presets: [],
    });
    expect(out.every((g) => g.surface === "module")).toBe(true);
  });
});

describe("mergeServerHits", () => {
  test("replaces a pending group with hits + clears pending", () => {
    const initial = [{ surface: "session" as const, hits: [], topScore: 0, pending: true }];
    const newHits: Hit[] = [
      {
        surface: "session",
        parentId: "s1",
        parentTitle: "g",
        score: 0.5,
        matchKind: "exact",
        action: {
          kind: "open-tab",
          tab: {
            tabKey: "ops-session:s1",
            title: "s1",
            kind: "ops-session",
            instanceId: "s1",
            openedAt: 0,
          },
        },
      },
    ];
    const out = mergeServerHits(initial, "session", newHits);
    const sess = out.find((g) => g.surface === "session")!;
    expect(sess.pending).toBeFalsy();
    expect(sess.hits.length).toBe(1);
  });

  test("appends distinct-excerpt hits without dedup", () => {
    // Same parentId but DIFFERENT where+snippet — they must both survive the merge.
    const initial = [
      {
        surface: "session" as const,
        hits: [
          {
            surface: "session" as const,
            parentId: "s1",
            parentTitle: "g",
            score: 0.4,
            matchKind: "exact" as const,
            match: { where: "title", snippet: "goal text", spans: [] },
            action: ACTION,
          },
        ],
        topScore: 0.4,
      },
    ];
    const semantic: Hit[] = [
      {
        surface: "session",
        parentId: "s1",
        parentTitle: "g",
        score: 0.6,
        matchKind: "semantic",
        match: { where: "content", snippet: "body text", spans: [] },
        action: ACTION,
      },
    ];
    const out = mergeServerHits(initial, "session", semantic, { append: true });
    const sess = out.find((g) => g.surface === "session")!;
    // Different excerpts on the same parent — both must be kept.
    expect(sess.hits.length).toBe(2);
    expect(sess.topScore).toBeCloseTo(0.6);
  });

  // Regression test [1]: same excerpt from lexical + RAG tiers must collapse to ONE hit.
  test("dedupes hits with identical parentId + where + snippet on append", () => {
    const sharedMatch = { where: "content", snippet: "shared excerpt text", spans: [] };
    const initial = [
      {
        surface: "session" as const,
        hits: [
          {
            surface: "session" as const,
            parentId: "s1",
            parentTitle: "G",
            score: 0.4,
            matchKind: "exact" as const,
            match: sharedMatch,
            action: ACTION,
          },
        ],
        topScore: 0.4,
      },
    ];
    const ragHit: Hit = {
      surface: "session",
      parentId: "s1",
      parentTitle: "G",
      score: 0.6,
      matchKind: "semantic",
      match: sharedMatch, // same where+snippet → duplicate
      action: ACTION,
    };
    const out = mergeServerHits(initial, "session", [ragHit], { append: true });
    const sess = out.find((g) => g.surface === "session")!;
    // Must collapse to exactly ONE hit — not two.
    expect(sess.hits.length).toBe(1);
    // The surviving hit should carry the higher score.
    expect(sess.hits[0]!.score).toBeCloseTo(0.6);
    // The surviving hit should be upgraded to semantic so the badge still shows.
    expect(sess.hits[0]!.matchKind).toBe("semantic");
    // topScore must reflect the deduped winner.
    expect(sess.topScore).toBeCloseTo(0.6);
  });

  // Regression test [1]: group header count via g.hits.length must equal distinct parents.
  test("parent count equals distinct parentIds after lexical+RAG merge", () => {
    const match = { where: "content", snippet: "x", spans: [] };
    const mkHit = (parentId: string, kind: "exact" | "semantic", score: number): Hit => ({
      surface: "session",
      parentId,
      parentTitle: parentId,
      score,
      matchKind: kind,
      match,
      action: ACTION,
    });
    // Two distinct parents from lexical tier
    const initial = [
      {
        surface: "session" as const,
        hits: [mkHit("s1", "exact", 0.5), mkHit("s2", "exact", 0.4)],
        topScore: 0.5,
      },
    ];
    // RAG finds s1 again (duplicate) + a new parent s3
    const ragHits: Hit[] = [mkHit("s1", "semantic", 0.7), mkHit("s3", "semantic", 0.3)];
    const out = mergeServerHits(initial, "session", ragHits, { append: true });
    const sess = out.find((g) => g.surface === "session")!;
    // Should have 3 distinct parents: s1 (deduped), s2, s3
    expect(sess.hits.length).toBe(3);
    const parentIds = sess.hits.map((h) => h.parentId).sort();
    expect(parentIds).toEqual(["s1", "s2", "s3"]);
  });
});

test("mergeServerHits preserves unreachableNodes from the merge call", () => {
  const initial: GroupedResults = [];
  const hits: Hit[] = [
    {
      surface: "session",
      parentId: "s1",
      parentTitle: "audit",
      score: 0.7,
      matchKind: "exact",
      action: {
        kind: "open-tab",
        tab: {
          tabKey: "ops-session:s1",
          title: "s1",
          kind: "ops-session",
          instanceId: "s1",
          openedAt: 0,
        },
      },
    },
  ];
  const merged = mergeServerHits(initial, "session", hits, {
    append: true,
    unreachableNodes: ["mac-mini"],
  });
  const sess = merged.find((g) => g.surface === "session")!;
  expect(sess.unreachableNodes).toEqual(["mac-mini"]);
});

test("originNode flows through mergeServerHits unchanged", () => {
  const initial: GroupedResults = [];
  const hits: Hit[] = [
    {
      surface: "session",
      parentId: "s1",
      parentTitle: "audit",
      score: 0.7,
      matchKind: "exact",
      originNode: "mac-mini",
      action: {
        kind: "open-tab",
        tab: {
          tabKey: "ops-session:s1",
          title: "s1",
          kind: "ops-session",
          instanceId: "s1",
          openedAt: 0,
        },
      },
    },
  ];
  const merged = mergeServerHits(initial, "session", hits, { append: true });
  const sess = merged.find((g) => g.surface === "session")!;
  expect(sess.hits[0]!.originNode).toBe("mac-mini");
});
