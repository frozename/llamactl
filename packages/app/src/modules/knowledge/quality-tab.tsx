import * as React from 'react';
import { useMemo, useState } from 'react';
import { stringify as stringifyYaml } from 'yaml';
import { trpc } from '@/lib/trpc';

/**
 * Quality tab — the Electron-side of `llamactl rag bench`. Takes an
 * operator-supplied RagBench manifest (YAML textarea; optionally
 * prefilled from a "Starter" button that assembles a reasonable
 * scaffold from the current node + collection), runs it through the
 * `ragBench` tRPC procedure, and renders hit-rate / MRR / per-query
 * breakdown. Mirrors the Pipelines tab's draft-panel pattern.
 *
 * No persistence: a bench report is a point-in-time measurement and
 * the operator is free to tweak the YAML and re-run. If we grow a
 * "track quality over time" story it lives in a separate feature,
 * not here.
 */

interface BenchReport {
  ok: true;
  manifest: {
    apiVersion: string;
    kind: string;
    metadata: { name: string };
    spec: {
      node: string;
      collection?: string;
      topK: number;
      queries: Array<Record<string, unknown>>;
    };
  };
  hitRate: number;
  mrr: number;
  totalQueries: number;
  hits: number;
  errors: number;
  perQuery: Array<{
    query: string;
    topK: number;
    hitRank: number | null;
    hitKind: 'doc_id' | 'substring' | null;
    matchedDocId: string | null;
    error?: string;
  }>;
  elapsed_ms: number;
}

function starterYaml(nodeName: string, collection: string | null): string {
  const manifest = {
    apiVersion: 'llamactl/v1',
    kind: 'RagBench',
    metadata: { name: `${nodeName.replace(/[^a-z0-9-]/gi, '-')}-quality` },
    spec: {
      node: nodeName,
      ...(collection ? { collection } : {}),
      topK: 10,
      queries: [
        {
          query: 'replace with a question operators might ask',
          expected_substring: 'replace with a phrase the right chunk should contain',
        },
        {
          query: 'another likely query',
          expected_doc_id: 'replace with the doc id you expect to hit',
        },
      ],
    },
  };
  return stringifyYaml(manifest);
}

function hitRateBadge(rate: number): { cls: string; label: string } {
  const pct = Math.round(rate * 100);
  if (rate >= 0.9) {
    return {
      cls: 'bg-[var(--color-brand)] text-[color:var(--color-brand-contrast)]',
      label: `${pct}%`,
    };
  }
  if (rate >= 0.6) {
    return {
      cls: 'bg-[var(--color-warn,var(--color-ok))] text-[color:var(--color-text-inverse)]',
      label: `${pct}%`,
    };
  }
  return {
    cls: 'bg-[var(--color-err)] text-[color:var(--color-text-inverse)]',
    label: `${pct}%`,
  };
}

export function QualityTab(props: {
  nodeName: string;
  collection: string;
}): React.JSX.Element {
  const { nodeName, collection } = props;
  const [yaml, setYaml] = useState<string>(() =>
    starterYaml(nodeName, collection.trim() ? collection.trim() : null),
  );
  const [report, setReport] = useState<BenchReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const bench = trpc.ragBench.useMutation({
    onSuccess: (data) => {
      setReport(data as BenchReport);
      setError(null);
      setRunning(false);
    },
    onError: (err) => {
      setReport(null);
      setError(err.message);
      setRunning(false);
    },
  });

  const onRun = (): void => {
    setError(null);
    setReport(null);
    setRunning(true);
    bench.mutate({ manifestYaml: yaml });
  };

  const onLoadStarter = (): void => {
    setYaml(starterYaml(nodeName, collection.trim() ? collection.trim() : null));
  };

  const rateBadge = useMemo(
    () => (report ? hitRateBadge(report.hitRate) : null),
    [report],
  );

  return (
    <div className="space-y-4" data-testid="knowledge-quality-root">
      <div className="flex flex-wrap items-baseline gap-2 text-xs text-[color:var(--color-text-secondary)]">
        <span>
          Measure retrieval quality: paste a{' '}
          <span className="mono text-[color:var(--color-text)]">RagBench</span>{' '}
          manifest, click Run, and scan the hit rate + per-query
          breakdown. No writes — purely a read-only gate against
          the named rag node.
        </span>
        <button
          type="button"
          onClick={onLoadStarter}
          data-testid="knowledge-quality-starter"
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text)]"
        >
          Load starter
        </button>
      </div>

      <div className="grid grid-cols-12 gap-3">
        <label className="col-span-9 text-sm">
          <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
            RagBench manifest (YAML)
          </span>
          <textarea
            value={yaml}
            onChange={(e) => {
              setYaml(e.target.value);
              setError(null);
            }}
            rows={14}
            data-testid="knowledge-quality-yaml"
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-text)]"
          />
        </label>
        <div className="col-span-3 flex flex-col items-stretch justify-start gap-2">
          <button
            type="button"
            onClick={onRun}
            disabled={running || !yaml.trim()}
            data-testid="knowledge-quality-run"
            className="rounded bg-[var(--color-brand)] px-3 py-2 text-sm font-medium text-[color:var(--color-surface-0)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? 'Running…' : 'Run bench'}
          </button>
          <span className="text-[10px] text-[color:var(--color-text-secondary)]">
            Targets <span className="mono">{nodeName}</span>
            {collection.trim() && (
              <>
                {' · '}
                <span className="mono">{collection.trim()}</span>
              </>
            )}
          </span>
        </div>
      </div>

      {error && (
        <div
          className="rounded-md border border-[var(--color-err)] bg-[var(--color-surface-1)] px-3 py-2 text-sm text-[color:var(--color-err)]"
          data-testid="knowledge-quality-error"
        >
          {error}
        </div>
      )}

      {report && rateBadge && (
        <div
          className="space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3"
          data-testid="knowledge-quality-report"
        >
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-[color:var(--color-text-secondary)]">
            <span
              className={`rounded border border-[var(--color-border)] px-2 py-0.5 text-xs font-medium ${rateBadge.cls}`}
              data-testid="knowledge-quality-hitrate"
            >
              hit rate {rateBadge.label}
            </span>
            <span>
              MRR{' '}
              <span
                className="mono text-[color:var(--color-text)]"
                data-testid="knowledge-quality-mrr"
              >
                {report.mrr.toFixed(4)}
              </span>
            </span>
            <span>
              scored{' '}
              <span className="mono text-[color:var(--color-text)]">
                {report.hits}/{report.totalQueries - report.errors}
              </span>
            </span>
            {report.errors > 0 && (
              <span className="text-[color:var(--color-err)]">
                errors{' '}
                <span className="mono">{report.errors}</span>
              </span>
            )}
            <span>
              elapsed{' '}
              <span className="mono text-[color:var(--color-text)]">
                {report.elapsed_ms}ms
              </span>
            </span>
          </div>

          <div
            className="overflow-hidden rounded border border-[var(--color-border)]"
            data-testid="knowledge-quality-per-query"
          >
            <table className="w-full text-xs">
              <thead className="bg-[var(--color-surface-2)] text-left text-[color:var(--color-text-secondary)]">
                <tr>
                  <th className="w-12 px-2 py-1 font-medium">#</th>
                  <th className="px-2 py-1 font-medium">Query</th>
                  <th className="w-20 px-2 py-1 font-medium">Rank</th>
                  <th className="w-20 px-2 py-1 font-medium">Match</th>
                  <th className="px-2 py-1 font-medium">Matched doc</th>
                </tr>
              </thead>
              <tbody>
                {report.perQuery.map((q, i) => {
                  const hit = q.hitRank !== null;
                  const err = q.error !== undefined;
                  const cls = err
                    ? 'text-[color:var(--color-err)]'
                    : hit
                      ? 'text-[color:var(--color-text)]'
                      : 'text-[color:var(--color-text-secondary)]';
                  return (
                    <tr
                      key={`${i}-${q.query}`}
                      className={`border-t border-[var(--color-border)] ${cls}`}
                    >
                      <td className="px-2 py-1 mono">{i + 1}</td>
                      <td className="px-2 py-1">
                        {q.query}
                        {err && (
                          <span
                            className="ml-2 text-[10px] text-[color:var(--color-err)]"
                            title={q.error}
                          >
                            [{q.error}]
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1 mono">
                        {hit ? q.hitRank : err ? '—' : 'miss'}
                      </td>
                      <td className="px-2 py-1 mono text-[10px]">
                        {q.hitKind ?? '—'}
                      </td>
                      <td className="px-2 py-1 mono text-[10px] break-all">
                        {q.matchedDocId ?? ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
