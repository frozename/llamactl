// packages/app/src/lib/global-search/hooks/use-global-search.ts
import * as React from "react";

import type { GroupedResults, ParsedQuery } from "../types";

import { useTabStore } from "../../../stores/tab-store.js";
import { trpc } from "../../trpc.js";
import { mergeServerHits, runClientPhase } from "../orchestrator";
import { parseQuery } from "../query";
import { mapLogHits } from "../surfaces/logs";
import { mapSessionHits } from "../surfaces/sessions";
import { runTier3Search } from "./use-global-search-helpers";

const TIER2_MS = 250;
const TIER3_MS = 400;

export function computeNextSchedule(
  now: number,
  opts: { tier2Ms?: number; tier3Ms?: number } = {},
): { tier2At: number; tier3At: number } {
  return {
    tier2At: now + (opts.tier2Ms ?? TIER2_MS),
    tier3At: now + (opts.tier3Ms ?? TIER3_MS),
  };
}

async function runTier2Search(
  token: number,
  queryToken: React.RefObject<number>,
  parsed: ParsedQuery,
  utils: ReturnType<typeof trpc.useUtils>,
  setResults: React.Dispatch<React.SetStateAction<GroupedResults>>,
  onComplete: () => void,
): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  const allow = (s: string): boolean => !parsed.surfaceFilter || parsed.surfaceFilter === s;

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
          setResults((cur) => mergeServerHits(cur, "logs", mapLogHits(res.hits), { append: true }));
        })
        .catch(() => {
          if (queryToken.current !== token) return;
        }),
    );
  }
  await Promise.allSettled(tasks);
  onComplete();
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

    // Both tiers are pre-counted so that cleanup can decrement for any
    // timer that is cleared before it fires, and only the final decrement
    // (when remaining reaches 0 with a matching token) sets idle.
    let remaining = 2;
    const onTierDone = (): void => {
      remaining--;
      if (remaining === 0 && queryToken.current === token) setStatus("idle");
    };

    tier2Timer.current = setTimeout(() => {
      tier2Timer.current = null;
      void runTier2Search(token, queryToken, parsed, utils, setResults, onTierDone);
    }, TIER2_MS);

    tier3Timer.current = setTimeout(() => {
      tier3Timer.current = null;
      void runTier3Search(token, queryToken, parsed, ragStatus.data, utils, setResults, onTierDone);
    }, TIER3_MS);

    return (): void => {
      if (tier2Timer.current) {
        clearTimeout(tier2Timer.current);
        tier2Timer.current = null;
        onTierDone();
      }
      if (tier3Timer.current) {
        clearTimeout(tier3Timer.current);
        tier3Timer.current = null;
        onTierDone();
      }
      ctrl.abort();
    };
  }, [input, tabs, closed, workloadsQ.data, nodesQ.data, ragStatus.data, utils]);

  return { results, status };
}
