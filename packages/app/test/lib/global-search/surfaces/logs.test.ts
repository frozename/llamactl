// packages/app/test/lib/global-search/surfaces/logs.test.ts
import { describe, expect, test } from "bun:test";

import { type LogServerHit, mapLogHits } from "../../../../src/lib/global-search/surfaces/logs";

describe("mapLogHits", () => {
  test("each match becomes one hit: 2 matches = 2 hits, 0 matches = 0 hits", () => {
    const hits: Parameters<typeof mapLogHits>[0] = [
      {
        fileLabel: "server.log",
        filePath: "/var/log/server.log",
        matches: [
          { lineNumber: 42, where: "error", snippet: "oops", spans: [{ start: 0, end: 4 }] },
          { lineNumber: 100, where: "warn", snippet: "slow", spans: [{ start: 0, end: 4 }] },
        ],
        score: 0.7,
      },
      {
        fileLabel: "empty.log",
        filePath: "/var/log/empty.log",
        matches: [],
        score: 0.3,
      },
    ];
    const out = mapLogHits(hits);
    expect(out.length).toBe(2);
  });

  test("parentId and parentTitle equal '<fileLabel>:<lineNumber>'", () => {
    const hits: Parameters<typeof mapLogHits>[0] = [
      {
        fileLabel: "server.log",
        filePath: "/var/log/server.log",
        matches: [
          { lineNumber: 42, where: "error", snippet: "oops", spans: [{ start: 0, end: 4 }] },
        ],
        score: 0.7,
      },
    ];
    const out = mapLogHits(hits);
    expect(out[0]!.parentId).toBe("server.log:42");
    expect(out[0]!.parentTitle).toBe("server.log:42");
  });

  test("hit.match equals {where, snippet, spans} and does NOT contain lineNumber", () => {
    const hits: Parameters<typeof mapLogHits>[0] = [
      {
        fileLabel: "server.log",
        filePath: "/var/log/server.log",
        matches: [
          { lineNumber: 42, where: "error", snippet: "oops", spans: [{ start: 0, end: 4 }] },
        ],
        score: 0.7,
      },
    ];
    const out = mapLogHits(hits);
    expect(Object.keys(out[0]!.match!)).toEqual(["where", "snippet", "spans"]);
  });

  test("the score comes from the file-level score", () => {
    const hits: Parameters<typeof mapLogHits>[0] = [
      {
        fileLabel: "server.log",
        filePath: "/var/log/server.log",
        matches: [
          { lineNumber: 42, where: "error", snippet: "oops", spans: [{ start: 0, end: 4 }] },
        ],
        score: 0.7,
      },
    ];
    const out = mapLogHits(hits);
    expect(out[0]!.score).toBe(0.7);
  });

  test("originNode is copied when present and absent when not", () => {
    const hWith: LogServerHit & { originNode: string } = {
      fileLabel: "server.log",
      filePath: "/var/log/server.log",
      matches: [{ lineNumber: 42, where: "error", snippet: "oops", spans: [{ start: 0, end: 4 }] }],
      score: 0.7,
      originNode: "gpu1",
    };
    const withNode: Parameters<typeof mapLogHits>[0] = [hWith];
    const withoutNode: Parameters<typeof mapLogHits>[0] = [
      {
        fileLabel: "server.log",
        filePath: "/var/log/server.log",
        matches: [
          { lineNumber: 42, where: "error", snippet: "oops", spans: [{ start: 0, end: 4 }] },
        ],
        score: 0.7,
      },
    ];
    const outWith = mapLogHits(withNode);
    const outWithout = mapLogHits(withoutNode);
    expect(outWith[0]!.originNode).toBe("gpu1");
    expect("originNode" in outWithout[0]!).toBe(false);
  });

  test("every hit opens tabKey 'module:logs', title 'Logs', kind 'module'", () => {
    const hits: Parameters<typeof mapLogHits>[0] = [
      {
        fileLabel: "server.log",
        filePath: "/var/log/server.log",
        matches: [
          { lineNumber: 42, where: "error", snippet: "oops", spans: [{ start: 0, end: 4 }] },
        ],
        score: 0.7,
      },
    ];
    const out = mapLogHits(hits);
    const a = out[0]!.action;
    expect(a.kind).toBe("open-tab");
    if (a.kind === "open-tab") {
      const tab = a.tab;
      expect(tab.tabKey).toBe("module:logs");
      expect(tab.title).toBe("Logs");
      expect(tab.kind).toBe("module");
      expect(typeof tab.openedAt).toBe("number");
    }
  });

  test("hits from several files appear in file order, then match order", () => {
    const hits: Parameters<typeof mapLogHits>[0] = [
      {
        fileLabel: "a.log",
        filePath: "/var/log/a.log",
        matches: [
          { lineNumber: 1, where: "a", snippet: "a", spans: [{ start: 0, end: 1 }] },
          { lineNumber: 2, where: "b", snippet: "b", spans: [{ start: 0, end: 1 }] },
        ],
        score: 0.6,
      },
      {
        fileLabel: "b.log",
        filePath: "/var/log/b.log",
        matches: [{ lineNumber: 3, where: "c", snippet: "c", spans: [{ start: 0, end: 1 }] }],
        score: 0.8,
      },
    ];
    const out = mapLogHits(hits);
    expect(out.length).toBe(3);
    expect(out[0]!.parentId).toBe("a.log:1");
    expect(out[1]!.parentId).toBe("a.log:2");
    expect(out[2]!.parentId).toBe("b.log:3");
  });
});
