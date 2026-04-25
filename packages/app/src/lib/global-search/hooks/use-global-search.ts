// packages/app/src/lib/global-search/hooks/use-global-search.ts
import * as React from 'react';
import { trpc } from '../../trpc.js';
import { useTabStore } from '../../../stores/tab-store.js';
import type { GroupedResults } from '../types';
import { runClientPhase, mergeServerHits } from '../orchestrator';
import { parseQuery } from '../query';
import { mapSessionHits } from '../surfaces/sessions';
import { mapKnowledgeHits } from '../surfaces/knowledge';
import { mapLogHits } from '../surfaces/logs';
import { mapSessionRagHits } from '../surfaces/sessions-rag';
import { mapKnowledgeRagHits } from '../surfaces/knowledge-rag';
import { mapLogRagHits } from '../surfaces/logs-rag';

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

export function useGlobalSearch(input: string): {
  results: GroupedResults;
  status: 'idle' | 'searching';
} {
  const [results, setResults] = React.useState<GroupedResults>([]);
  const [status, setStatus] = React.useState<'idle' | 'searching'>('idle');
  const tabs = useTabStore((s) => s.tabs);
  const closed = useTabStore((s) => s.closed);
  const utils = trpc.useUtils();
  const ragStatus = trpc.globalSearchRagStatus.useQuery(undefined, {
    staleTime: 60_000,
  });

  // Cached client-side lists for client surfaces.
  const workloadsQ = trpc.workloadList.useQuery(undefined, { staleTime: 30_000 });
  const nodesQ = trpc.nodeList.useQuery(undefined, { staleTime: 30_000 });
  const presetsQ = trpc.presetList.useQuery(undefined, { staleTime: 30_000 });

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
      setResults([]);
      setStatus('idle');
      return;
    }
    setStatus('searching');

    const initial = runClientPhase({
      query: parsed,
      tabState: { tabs, closed },
      workloads: ((workloadsQ.data as any)?.workloads ?? []) as any[],
      nodes: ((nodesQ.data as any)?.nodes ?? []) as any[],
      presets: ((presetsQ.data as any)?.presets ?? []) as any[],
    });
    setResults(initial);

    const allow = (s: string): boolean =>
      !parsed.surfaceFilter || parsed.surfaceFilter === s;

    tier2Timer.current = setTimeout(async () => {
      const tasks: Promise<unknown>[] = [];
      if (allow('session')) {
        tasks.push(
          utils.opsSessionSearch
            .fetch({ query: parsed.needle }, { signal: ctrl.signal })
            .then((res) => {
              if (queryToken.current !== token) return;
              setResults((cur) =>
                mergeServerHits(cur, 'session', mapSessionHits((res as any).hits ?? []), {
                  append: true,
                }),
              );
            })
            .catch((e) => {
              if (queryToken.current !== token) return;
              setResults((cur) =>
                mergeServerHits(cur, 'session', [], { error: String((e as Error).message) }),
              );
            }),
        );
      }
      if (allow('logs')) {
        tasks.push(
          utils.logsSearch
            .fetch({ query: parsed.needle }, { signal: ctrl.signal })
            .then((res) => {
              if (queryToken.current !== token) return;
              setResults((cur) =>
                mergeServerHits(cur, 'logs', mapLogHits((res as any).hits ?? []), { append: true }),
              );
            })
            .catch(() => {
              if (queryToken.current !== token) return;
            }),
        );
      }
      if (allow('knowledge')) {
        tasks.push(
          utils.knowledgeSearch
            .fetch({ query: parsed.needle }, { signal: ctrl.signal })
            .then((res) => {
              if (queryToken.current !== token) return;
              setResults((cur) =>
                mergeServerHits(cur, 'knowledge', mapKnowledgeHits((res as any).hits ?? []), {
                  append: true,
                }),
              );
            })
            .catch(() => {}),
        );
      }
      await Promise.allSettled(tasks);
      if (queryToken.current === token) setStatus('idle');
    }, TIER2_MS);

    tier3Timer.current = setTimeout(async () => {
      if (queryToken.current !== token) return;
      const status = ragStatus.data;
      if (!status || !status.defaultNode) return;
      const tasks: Promise<unknown>[] = [];
      if (allow('session') && status.sessions) {
        tasks.push(
          utils.ragSearch
            .fetch(
              { node: status.defaultNode, query: parsed.needle, collection: 'sessions', topK: 10 },
              { signal: ctrl.signal },
            )
            .then((res) => {
              if (queryToken.current !== token) return;
              setResults((cur) =>
                mergeServerHits(cur, 'session', mapSessionRagHits((res as any).hits ?? []), {
                  append: true,
                }),
              );
            })
            .catch(() => {}),
        );
      }
      if (allow('knowledge') && status.knowledge) {
        tasks.push(
          utils.ragSearch
            .fetch(
              { node: status.defaultNode, query: parsed.needle, collection: 'knowledge', topK: 10 },
              { signal: ctrl.signal },
            )
            .then((res) => {
              if (queryToken.current !== token) return;
              setResults((cur) =>
                mergeServerHits(cur, 'knowledge', mapKnowledgeRagHits((res as any).hits ?? []), {
                  append: true,
                }),
              );
            })
            .catch(() => {}),
        );
      }
      if (allow('logs') && status.logs) {
        tasks.push(
          utils.ragSearch
            .fetch(
              { node: status.defaultNode, query: parsed.needle, collection: 'logs', topK: 10 },
              { signal: ctrl.signal },
            )
            .then((res) => {
              if (queryToken.current !== token) return;
              setResults((cur) =>
                mergeServerHits(cur, 'logs', mapLogRagHits((res as any).hits ?? []), {
                  append: true,
                }),
              );
            })
            .catch(() => {}),
        );
      }
      await Promise.allSettled(tasks);
    }, TIER3_MS);

    return () => {
      if (tier2Timer.current) clearTimeout(tier2Timer.current);
      if (tier3Timer.current) clearTimeout(tier3Timer.current);
      ctrl.abort();
    };
  }, [input, tabs, closed, workloadsQ.data, nodesQ.data, presetsQ.data, ragStatus.data, utils]);

  return { results, status };
}