// packages/remote/test/search-rag-bridge.test.ts
import { describe, expect, test } from "bun:test";

import { ragBridgeSearch } from "../src/search/rag-bridge.js";

interface MockHit<M> {
  id: string;
  score: number;
  content: string;
  metadata: M;
}

type MockSearchResponse =
  | { hits: MockHit<{ sessionId: string; goal: string; status: string; startedAt: string }>[] }
  | { hits: MockHit<{ entityId: string; title: string }>[] }
  | { hits: MockHit<{ fileLabel: string; filePath: string; lineNumber: number }>[] }
  | { hits: never[] };

const mockAdapter = {
  search: async (opts: { collection: string }): Promise<MockSearchResponse> => {
    await Promise.resolve();
    if (opts.collection === "sessions") {
      return {
        hits: [
          {
            id: "s1",
            score: 0.9,
            content: "session snippet",
            metadata: { sessionId: "s1", goal: "goal", status: "done", startedAt: "ts" },
          },
        ],
      };
    }
    if (opts.collection === "knowledge") {
      return {
        hits: [
          {
            id: "k1",
            score: 0.8,
            content: "knowledge snippet",
            metadata: { entityId: "k1", title: "title" },
          },
        ],
      };
    }
    if (opts.collection === "logs") {
      return {
        hits: [
          {
            id: "l1",
            score: 0.7,
            content: "log snippet",
            metadata: { fileLabel: "app", filePath: "/app.log", lineNumber: 42 },
          },
        ],
      };
    }
    return { hits: [] };
  },
  close: (): Promise<undefined> => Promise.resolve(undefined),
};

describe("ragBridgeSearch", () => {
  test("normalizes sessions hits", async () => {
    const hits = await ragBridgeSearch({
      node: "n1",
      collection: "sessions",
      query: "foo",
      adapter: mockAdapter,
    });
    expect(hits.length).toBe(1);
    expect((hits[0] as { sessionId: string }).sessionId).toBe("s1");
    expect(hits[0]!.matches[0]!.snippet).toBe("session snippet");
  });

  test("normalizes knowledge hits", async () => {
    const hits = await ragBridgeSearch({
      node: "n1",
      collection: "knowledge",
      query: "foo",
      adapter: mockAdapter,
    });
    expect(hits.length).toBe(1);
    expect((hits[0] as { entityId: string }).entityId).toBe("k1");
  });

  test("normalizes logs hits", async () => {
    const hits = await ragBridgeSearch({
      node: "n1",
      collection: "logs",
      query: "foo",
      adapter: mockAdapter,
    });
    expect(hits.length).toBe(1);
    const hit = hits[0] as { fileLabel: string; matches: { lineNumber: number }[] };
    expect(hit.fileLabel).toBe("app");
    expect(hit.matches[0]!.lineNumber).toBe(42);
  });
});
