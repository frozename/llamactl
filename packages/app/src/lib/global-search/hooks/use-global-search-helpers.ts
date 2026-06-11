// packages/app/src/lib/global-search/hooks/use-global-search-helpers.ts
import type * as React from "react";

import type { trpc } from "../../trpc";
import type { GroupedResults, ParsedQuery } from "../types";

import { mergeServerHits } from "../orchestrator";
import { mapKnowledgeRagHits } from "../surfaces/knowledge-rag";
import { mapLogRagHits } from "../surfaces/logs-rag";
import { mapSessionRagHits } from "../surfaces/sessions-rag";

export type RagResult = {
  document: {
    id: string;
    content: string;
    metadata?: Record<string, unknown>;
  };
  score: number;
  distance?: number;
};

export function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" ? value : null;
}

export function metadataNumber(
  metadata: Record<string, unknown> | undefined,
  key: string,
): number | null {
  const value = metadata?.[key];
  return typeof value === "number" ? value : null;
}

export function sessionStatus(value: string | null): "live" | "done" | "refused" | "aborted" {
  return value === "live" || value === "done" || value === "refused" || value === "aborted"
    ? value
    : "done";
}

export function ragSnippet(result: RagResult): { where: string; snippet: string; spans: never[] } {
  return { where: "content", snippet: result.document.content.slice(0, 240), spans: [] };
}

export async function runTier3Search(
  token: number,
  queryToken: React.RefObject<number>,
  parsed: ParsedQuery,
  ragStatus:
    | { defaultNode?: string | null; sessions?: boolean; knowledge?: boolean; logs?: boolean }
    | undefined,
  utils: ReturnType<typeof trpc.useUtils>,
  setResults: React.Dispatch<React.SetStateAction<GroupedResults>>,
): Promise<void> {
  if (queryToken.current !== token) return;
  const status = ragStatus;
  if (!status?.defaultNode) return;

  const allow = (s: string): boolean => !parsed.surfaceFilter || parsed.surfaceFilter === s;
  const tasks: Promise<unknown>[] = [];

  if (allow("session") && status.sessions) {
    tasks.push(
      utils.ragSearch
        .fetch({
          node: status.defaultNode,
          query: parsed.needle,
          collection: "sessions",
          topK: 10,
        })
        .then((res) => {
          if (queryToken.current !== token) return;
          const hits = (res.results as unknown as RagResult[]).map((result) => {
            const metadata = result.document.metadata;
            return {
              sessionId: metadataString(metadata, "sessionId") ?? result.document.id,
              goal: metadataString(metadata, "goal") ?? result.document.id,
              status: sessionStatus(metadataString(metadata, "status")),
              startedAt: metadataString(metadata, "startedAt") ?? "",
              matches: [ragSnippet(result)],
              score: result.score,
              ragDistance: result.distance,
            };
          });
          setResults((cur) =>
            mergeServerHits(cur, "session", mapSessionRagHits(hits), {
              append: true,
            }),
          );
        })
        .catch(() => undefined),
    );
  }

  if (allow("knowledge") && status.knowledge) {
    tasks.push(
      utils.ragSearch
        .fetch({
          node: status.defaultNode,
          query: parsed.needle,
          collection: "knowledge",
          topK: 10,
        })
        .then((res) => {
          if (queryToken.current !== token) return;
          const hits = (res.results as unknown as RagResult[]).map((result) => {
            const metadata = result.document.metadata;
            return {
              entityId: metadataString(metadata, "entityId") ?? result.document.id,
              title: metadataString(metadata, "title") ?? result.document.id,
              matches: [ragSnippet(result)],
              score: result.score,
              ragDistance: result.distance,
            };
          });
          setResults((cur) =>
            mergeServerHits(cur, "knowledge", mapKnowledgeRagHits(hits), {
              append: true,
            }),
          );
        })
        .catch(() => undefined),
    );
  }

  if (allow("logs") && status.logs) {
    tasks.push(
      utils.ragSearch
        .fetch({
          node: status.defaultNode,
          query: parsed.needle,
          collection: "logs",
          topK: 10,
        })
        .then((res) => {
          if (queryToken.current !== token) return;
          const hits = (res.results as unknown as RagResult[]).map((result) => {
            const metadata = result.document.metadata;
            const fileLabel = metadataString(metadata, "fileLabel") ?? result.document.id;
            return {
              fileLabel,
              filePath: metadataString(metadata, "filePath") ?? fileLabel,
              matches: [
                {
                  lineNumber: metadataNumber(metadata, "lineNumber") ?? 0,
                  ...ragSnippet(result),
                },
              ],
              score: result.score,
              ragDistance: result.distance,
            };
          });
          setResults((cur) =>
            mergeServerHits(cur, "logs", mapLogRagHits(hits), {
              append: true,
            }),
          );
        })
        .catch(() => undefined),
    );
  }

  await Promise.allSettled(tasks);
}
