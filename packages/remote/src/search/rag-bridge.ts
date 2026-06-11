// packages/remote/src/search/rag-bridge.ts
import type { SearchResponse } from "@nova/contracts";

import type { KnowledgeHit, LogHit, SessionHit } from "./types.js";

import { createRagAdapter } from "../rag/index.js";
import { resolveRagNode } from "../rag/resolve.js";

export type RagCollection = "sessions" | "knowledge" | "logs";

type LegacyHitResponse = { hits?: unknown[] };

interface BridgeAdapter {
  search(input: {
    query: string;
    topK: number;
    collection: string;
  }): Promise<SearchResponse | LegacyHitResponse>;
  close(): Promise<void> | void;
}

export interface RagBridgeOpts {
  node: string;
  collection: RagCollection;
  query: string;
  topK?: number;
  signal?: AbortSignal;
  /** Test-only seam. */
  adapter?: BridgeAdapter;
}

export async function ragBridgeSearch(
  opts: RagBridgeOpts,
): Promise<(SessionHit | KnowledgeHit | LogHit)[]> {
  if (opts.signal?.aborted) throw new Error("aborted");
  let adapter: BridgeAdapter | undefined = opts.adapter;
  if (!adapter) {
    const { node, cfg } = resolveRagNode(opts.node);
    adapter = await createRagAdapter(node, { config: cfg });
  }
  try {
    const res = await adapter.search({
      query: opts.query,
      topK: opts.topK ?? 10,
      collection: opts.collection,
    });
    return normalizeHits(opts.collection, res);
  } finally {
    if (!opts.adapter) {
      await adapter.close();
    }
  }
}

function normalizeHits(
  collection: RagCollection,
  res: unknown,
): (SessionHit | KnowledgeHit | LogHit)[] {
  const hits = hitsFromResponse(res);
  if (collection === "sessions") {
    return hits.map((h) => {
      const hit = h as {
        id?: unknown;
        content?: unknown;
        score?: unknown;
        metadata?: Record<string, unknown>;
      };
      return {
        sessionId: stringOr(hit.metadata?.sessionId, stringOr(hit.id, "")),
        goal: stringOr(hit.metadata?.goal, ""),
        status: stringOr(hit.metadata?.status, "live") as SessionHit["status"],
        startedAt: stringOr(hit.metadata?.startedAt, ""),
        matches: [
          {
            where: stringOr(hit.metadata?.where, "session content"),
            snippet: stringOr(hit.content, "").slice(0, 200),
            spans: [],
          },
        ],
        score: typeof hit.score === "number" ? hit.score : 0,
      };
    });
  }
  if (collection === "knowledge") {
    return hits.map((h) => {
      const hit = h as {
        id?: unknown;
        content?: unknown;
        score?: unknown;
        metadata?: Record<string, unknown>;
      };
      return {
        entityId: stringOr(hit.metadata?.entityId, stringOr(hit.id, "")),
        title: stringOr(hit.metadata?.title, stringOr(hit.id, "")),
        matches: [
          {
            where: "body",
            snippet: stringOr(hit.content, "").slice(0, 200),
            spans: [],
          },
        ],
        score: typeof hit.score === "number" ? hit.score : 0,
      };
    });
  }
  return hits.map((h) => {
    const hit = h as {
      content?: unknown;
      score?: unknown;
      metadata?: Record<string, unknown>;
    };
    return {
      fileLabel: stringOr(hit.metadata?.fileLabel, "unknown"),
      filePath: stringOr(hit.metadata?.filePath, ""),
      matches: [
        {
          lineNumber: numberOr(hit.metadata?.lineNumber, 0),
          where: stringOr(hit.metadata?.where, ""),
          snippet: stringOr(hit.content, "").slice(0, 200),
          spans: [],
        },
      ],
      score: typeof hit.score === "number" ? hit.score : 0,
    };
  });
}

function hitsFromResponse(res: unknown): unknown[] {
  if (hasHits(res)) return res.hits;
  if (hasResults(res)) {
    return res.results.map((result) => ({
      id: result.document.id,
      content: result.document.content,
      metadata: result.document.metadata,
      score: result.score,
    }));
  }
  return [];
}

function hasHits(res: unknown): res is { hits: unknown[] } {
  return typeof res === "object" && res !== null && Array.isArray((res as { hits?: unknown }).hits);
}

function hasResults(res: unknown): res is SearchResponse {
  return (
    typeof res === "object" && res !== null && Array.isArray((res as { results?: unknown }).results)
  );
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}
