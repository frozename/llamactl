// packages/app/test/lib/global-search/surfaces/sessions.test.ts
import { describe, expect, test } from "bun:test";

import {
  mapSessionHits,
  type SessionServerHit,
} from "../../../../src/lib/global-search/surfaces/sessions";

describe("mapSessionHits", () => {
  test("a server hit with matches: [] yields no hits", () => {
    const hits: Parameters<typeof mapSessionHits>[0] = [
      {
        sessionId: "abc123",
        goal: "hello",
        status: "done",
        startedAt: "2026-01-01T00:00:00Z",
        matches: [],
        score: 0.9,
      },
    ];
    const out = mapSessionHits(hits);
    expect(out).toEqual([]);
  });

  test("a server hit with N matches yields N hits in match order, each with its own excerpt", () => {
    const hits: Parameters<typeof mapSessionHits>[0] = [
      {
        sessionId: "abc123",
        goal: "hello",
        status: "done",
        startedAt: "2026-01-01T00:00:00Z",
        matches: [
          { where: "goal", snippet: "hello world", spans: [{ start: 0, end: 5 }] },
          { where: "snippet", snippet: "world hello", spans: [{ start: 6, end: 11 }] },
        ],
        score: 0.9,
      },
    ];
    const out = mapSessionHits(hits);
    expect(out.length).toBe(2);
    expect(out[0]!.match).toEqual({
      where: "goal",
      snippet: "hello world",
      spans: [{ start: 0, end: 5 }],
    });
    expect(out[0]!.score).toBe(0.9);
    expect(out[1]!.match).toEqual({
      where: "snippet",
      snippet: "world hello",
      spans: [{ start: 6, end: 11 }],
    });
    expect(out[1]!.score).toBe(0.9);
  });

  test("parentTitle falls back to sessionId when goal is ''", () => {
    const hits: Parameters<typeof mapSessionHits>[0] = [
      {
        sessionId: "abc123",
        goal: "",
        status: "done",
        startedAt: "2026-01-01T00:00:00Z",
        matches: [{ where: "goal", snippet: "hello", spans: [{ start: 0, end: 5 }] }],
        score: 0.9,
      },
    ];
    const out = mapSessionHits(hits);
    expect(out[0]!.parentTitle).toBe("abc123");
  });

  test("parentTitle is the goal when it is non-empty", () => {
    const hits: Parameters<typeof mapSessionHits>[0] = [
      {
        sessionId: "abc123",
        goal: "write tests",
        status: "done",
        startedAt: "2026-01-01T00:00:00Z",
        matches: [{ where: "goal", snippet: "write tests", spans: [{ start: 0, end: 11 }] }],
        score: 0.9,
      },
    ];
    const out = mapSessionHits(hits);
    expect(out[0]!.parentTitle).toBe("write tests");
  });

  test("tab details: title, tabKey, kind, instanceId", () => {
    const hits: Parameters<typeof mapSessionHits>[0] = [
      {
        sessionId: "abcdefghi",
        goal: "hello",
        status: "done",
        startedAt: "2026-01-01T00:00:00Z",
        matches: [{ where: "goal", snippet: "hello", spans: [{ start: 0, end: 5 }] }],
        score: 0.9,
      },
    ];
    const out = mapSessionHits(hits);
    const [hit] = out;
    const a = hit!.action;
    expect(a.kind).toBe("open-tab");
    if (a.kind === "open-tab") {
      const tab = a.tab;
      expect(tab.title).toBe("Session abcdefgh");
      expect(tab.tabKey).toBe("ops-session:abcdefghi");
      expect(tab.kind).toBe("ops-session");
      expect(tab.instanceId).toBe("abcdefghi");
      expect(typeof tab.openedAt).toBe("number");
    }
  });

  test("originNode is copied when present", () => {
    const h: SessionServerHit & { originNode: string } = {
      sessionId: "abc123",
      goal: "hello",
      status: "done",
      startedAt: "2026-01-01T00:00:00Z",
      matches: [{ where: "goal", snippet: "hello", spans: [{ start: 0, end: 5 }] }],
      score: 0.9,
      originNode: "gpu1",
    };
    const hits: Parameters<typeof mapSessionHits>[0] = [h];
    const out = mapSessionHits(hits);
    expect(out[0]!.originNode).toBe("gpu1");
  });

  test("when input has no originNode, the hit has no originNode key", () => {
    const hits: Parameters<typeof mapSessionHits>[0] = [
      {
        sessionId: "abc123",
        goal: "hello",
        status: "done",
        startedAt: "2026-01-01T00:00:00Z",
        matches: [{ where: "goal", snippet: "hello", spans: [{ start: 0, end: 5 }] }],
        score: 0.9,
      },
    ];
    const out = mapSessionHits(hits);
    expect("originNode" in out[0]!).toBe(false);
  });

  test("surface is 'session' and matchKind is 'exact'", () => {
    const hits: Parameters<typeof mapSessionHits>[0] = [
      {
        sessionId: "abc123",
        goal: "hello",
        status: "done",
        startedAt: "2026-01-01T00:00:00Z",
        matches: [{ where: "goal", snippet: "hello", spans: [{ start: 0, end: 5 }] }],
        score: 0.9,
      },
    ];
    const out = mapSessionHits(hits);
    expect(out[0]!.surface).toBe("session");
    expect(out[0]!.matchKind).toBe("exact");
  });
});
