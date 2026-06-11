import * as React from "react";
import { useMemo } from "react";

export interface BenchReport {
  ok: true;
  manifest: {
    apiVersion: string;
    kind: string;
    metadata: { name: string };
    spec: { node: string; collection?: string; topK: number; queries: Record<string, unknown>[] };
  };
  hitRate: number;
  mrr: number;
  totalQueries: number;
  hits: number;
  errors: number;
  perQuery: {
    query: string;
    topK: number;
    hitRank: number | null;
    hitKind: "doc_id" | "substring" | null;
    matchedDocId: string | null;
    error?: string;
  }[];
  elapsed_ms: number;
}

function hitRateBadge(rate: number): { cls: string; label: string } {
  const pct = Math.round(rate * 100);
  if (rate >= 0.9) return { cls: "bg-[var(--color-brand)] text-white", label: `${String(pct)}%` };
  if (rate >= 0.6) return { cls: "bg-[var(--color-warn)] text-white", label: `${String(pct)}%` };
  return { cls: "bg-[var(--color-err)] text-white", label: `${String(pct)}%` };
}

export function BenchReportView({ report }: { report: BenchReport }): React.JSX.Element {
  const badge = useMemo(() => hitRateBadge(report.hitRate), [report.hitRate]);
  return (
    <div className="space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-[color:var(--color-text-secondary)]">
        <span
          className={`rounded border border-[var(--color-border)] px-2 py-0.5 text-xs font-medium ${badge.cls}`}
        >
          hit rate {badge.label}
        </span>
        <span>
          MRR <span className="mono text-[color:var(--color-text)]">{report.mrr.toFixed(4)}</span>
        </span>
        <span>
          scored{" "}
          <span className="mono text-[color:var(--color-text)]">
            {report.hits}/{report.totalQueries - report.errors}
          </span>
        </span>
        {report.errors > 0 && (
          <span className="text-[color:var(--color-err)]">
            errors <span className="mono">{report.errors}</span>
          </span>
        )}
        <span>
          elapsed <span className="mono text-[color:var(--color-text)]">{report.elapsed_ms}ms</span>
        </span>
      </div>
      <div className="overflow-hidden rounded border border-[var(--color-border)]">
        <table className="w-full text-xs">
          <thead className="bg-[var(--color-surface-2)] text-left">
            <tr>
              <th className="w-12 px-2 py-1">#</th>
              <th>Query</th>
              <th className="w-20 px-2 py-1">Rank</th>
              <th className="w-20 px-2 py-1">Match</th>
              <th>Matched doc</th>
            </tr>
          </thead>
          <tbody>
            {report.perQuery.map((q, i) => (
              <tr key={i} className="border-t border-[var(--color-border)]">
                <td className="px-2 py-1 mono">{i + 1}</td>
                <td className="px-2 py-1">
                  {q.query}
                  {q.error && (
                    <span className="ml-2 text-[10px] text-[color:var(--color-err)]">
                      [{q.error}]
                    </span>
                  )}
                </td>
                <td className="px-2 py-1 mono">{q.hitRank ?? (q.error ? "—" : "miss")}</td>
                <td className="px-2 py-1 mono text-[10px]">{q.hitKind ?? "—"}</td>
                <td className="px-2 py-1 mono text-[10px] break-all">{q.matchedDocId ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
