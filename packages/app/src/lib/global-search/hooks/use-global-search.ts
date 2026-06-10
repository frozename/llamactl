// packages/app/src/lib/global-search/hooks/use-global-search.ts
import * as React from "react";

import type { GroupedResults } from "../types";

import { useTabStore } from "../../../stores/tab-store.js";
import { trpc } from "../../trpc.js";
import { mergeServerHits, runClientPhase } from "../orchestrator";
import { parseQuery } from "../query";
import { mapKnowledgeRagHits } from "../surfaces/knowledge-rag";
import { mapLogHits } from "../surfaces/logs";
import { mapLogRagHits } from "../surfaces/logs-rag";
import { mapSessionHits } from "../surfaces/sessions";
import { mapSessionRagHits } from "../surfaces/sessions-rag";

const TIER2_MS = 250;
const TIER3_MS = 400;

type RagResult = {
  document: {
    id: string;
    content: string;
    metadata?: Record<string, unknown>;
  };
  score: number;
  distance?: number;
};

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" ? value : null;
}

function metadataNumber(metadata: Record<string, unknown> | undefined, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === "number" ? value : null;
}

function sessionStatus(value: string | null): "live" | "done" | "refused" | "aborted" {
  return value === "live" || value === "done" || value === "refused" || value === "aborted"
    ? value
    : "done";
}

function ragSnippet(result: RagResult): { where: string; snippet: string; spans: never[] } {
  return { where: "content", snippet: result.document.content.slice(0, 240), spans: [] };
}

export function computeNextSchedule(
  now: number,
  opts: { tier2Ms?: number; tier3Ms?: number } = {},
): { tier2At: number; tier3At: number } {
  return {
    tier2At: now + (opts.tier2Ms ?? TIER2_MS),
    tier3At: now + (opts.tier3Ms ?? TIER3_MS),
  };
}

export function useGlobalSearch(input: string): {
  results: GroupedResults;
  status: "idle" | "searching";
} {
  const [results, setResults] = React.useState<GroupedResults>([]);
  const [status, setStatus] = React.useState<"idle" | "searching">("idle");
  const tabs = useTabStore((s) => s.tabs);
  const closed = useTabStore((s) => s.closed);
  const utils = trpc.useUtils();
  const ragStatus = trpc.globalSearchRagStatus.useQuery(undefined, {
    staleTime: 60_000,
  });

  // Cached client-side lists for client surfaces.
  const workloadsQ = trpc.workloadList.useQuery(undefined, { staleTime: 30_000 });
  const nodesQ = trpc.nodeList.useQuery(undefined, { staleTime: 30_000 });

  const queryToken = React.useRef(0);
  const ctrlRef = React.useRef<AbortController | null>(null);
  const tier2Timer = React.useRef<NodeJS.Timeout | null>(null);
  const tier3Timer = React.useRef<NodeJS.Timeout | null>(null);

  React.useEffect(() => {
    if (tier2Timer.current) clearTimeout(tier2Timer.current);
    if (tier3Timer.current) clearTimeout(tier3Timer.current);
    if (ctrlRef.current) ctrlRef.current.abort();

    const token = ++queryToken.current;
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;

    const parsed = parseQuery(input);
    if (!parsed.needle) {
      queueMicrotask(() => {
        setResults([]);
        setStatus("idle");
      });
      return;
    }
    const initial = runClientPhase({
      query: parsed,
      tabState: { tabs, closed: closed.map((tab) => ({ ...tab, closedAt: tab.openedAt })) },
      workloads: workloadsQ.data ?? [],
      nodes: nodesQ.data?.nodes ?? [],
      presets: [],
    });
    queueMicrotask(() => {
      setStatus("searching");
      setResults(initial);
    });

    const allow = (s: string): boolean => !parsed.surfaceFilter || parsed.surfaceFilter === s;

    tier2Timer.current = setTimeout(() => {
      void (async () => {
        const tasks: Promise<unknown>[] = [];
        if (allow("session")) {
          tasks.push(
            utils.opsSessionSearch
              .fetch({ query: parsed.needle })
              .then((res) => {
                if (queryToken.current !== token) return;
                setResults((cur) =>
                  mergeServerHits(cur, "session", mapSessionHits(res.hits), {
                    append: true,
                  }),
                );
              })
              .catch((e: unknown) => {
                if (queryToken.current !== token) return;
                setResults((cur) =>
                  mergeServerHits(cur, "session", [], {
                    error: e instanceof Error ? e.message : JSON.stringify(e),
                  }),
                );
              }),
          );
        }
        if (allow("logs")) {
          tasks.push(
            utils.logsSearch
              .fetch({ query: parsed.needle })
              .then((res) => {
                if (queryToken.current !== token) return;
                setResults((cur) =>
                  mergeServerHits(cur, "logs", mapLogHits(res.hits), { append: true }),
                );
              })
              .catch(() => {
                if (queryToken.current !== token) return;
              }),
          );
        }
        await Promise.allSettled(tasks);
        if (queryToken.current === token) setStatus("idle");
      })();
    }, TIER2_MS);

    tier3Timer.current = setTimeout(() => {
      void (async () => {
        if (queryToken.current !== token) return;
        const status = ragStatus.data;
        if (!status?.defaultNode) return;
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
                const hits = res.results.map((result) => {
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
              .catch(() => {
                return undefined;
              }),
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
                const hits = res.results.map((result) => {
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
              .catch(() => {
                return undefined;
              }),
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
                const hits = res.results.map((result) => {
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
              .catch(() => {
                return undefined;
              }),
          );
        }
        await Promise.allSettled(tasks);
      })();
    }, TIER3_MS);

    return () => {
      if (tier2Timer.current) clearTimeout(tier2Timer.current);
      if (tier3Timer.current) clearTimeout(tier3Timer.current);
      ctrl.abort();
    };
  }, [input, tabs, closed, workloadsQ.data, nodesQ.data, ragStatus.data, utils]);

  return { results, status };
}
