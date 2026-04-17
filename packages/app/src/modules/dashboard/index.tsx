import { Suspense } from 'react';
import type { bench, schemas } from '@llamactl/core';
import { trpc } from '@/lib/trpc';

type BenchCompareRow = bench.BenchCompareRow;
type PresetOverride = schemas.PresetOverride;

function StatusCard({ title, body }: { title: string; body: string }): JSX.Element {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4">
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-fg-muted)]">
        {title}
      </div>
      <div className="mt-1 mono text-sm break-all text-[color:var(--color-fg)]">{body}</div>
    </div>
  );
}

function DashboardBody(): JSX.Element {
  const envQuery = trpc.env.useQuery();
  const compareQuery = trpc.benchCompare.useQuery();
  const promotionsQuery = trpc.promotions.useQuery();

  if (envQuery.isLoading || compareQuery.isLoading || promotionsQuery.isLoading) {
    return <div className="p-6 text-[color:var(--color-fg-muted)]">Loading…</div>;
  }

  const env = envQuery.data;
  const rows = compareQuery.data ?? [];
  const promotions = promotionsQuery.data ?? [];
  const topBench = [...rows]
    .filter((row: BenchCompareRow) => row.tuned)
    .sort((a: BenchCompareRow, b: BenchCompareRow) => {
      if (!a.tuned || !b.tuned) return 0;
      return Number.parseFloat(b.tuned.gen_tps) - Number.parseFloat(a.tuned.gen_tps);
    })
    .slice(0, 5);

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mb-1 text-xs uppercase tracking-widest text-[color:var(--color-fg-muted)]">
        Dashboard
      </div>
      <h1 className="mb-6 text-2xl font-semibold text-[color:var(--color-fg)]">Overview</h1>

      <div className="grid grid-cols-3 gap-3">
        <StatusCard title="Profile" body={env?.LLAMA_CPP_MACHINE_PROFILE ?? '—'} />
        <StatusCard title="Provider" body={env?.LOCAL_AI_PROVIDER ?? '—'} />
        <StatusCard title="Default Model" body={env?.LLAMA_CPP_DEFAULT_MODEL ?? '—'} />
        <StatusCard title="Active Model" body={env?.LOCAL_AI_MODEL ?? '—'} />
        <StatusCard title="Context Length" body={env?.LOCAL_AI_CONTEXT_LENGTH ?? '—'} />
        <StatusCard title="Provider URL" body={env?.LOCAL_AI_PROVIDER_URL ?? '—'} />
      </div>

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-fg-muted)]">
          Top benches (gen tps)
        </h2>
        {topBench.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-[color:var(--color-fg-muted)]">
            No tuned records yet.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
            <table className="w-full mono text-sm">
              <thead className="bg-[var(--color-surface-1)] text-left text-[color:var(--color-fg-muted)]">
                <tr>
                  <th className="px-3 py-2 font-medium">Model</th>
                  <th className="px-3 py-2 font-medium">Class</th>
                  <th className="px-3 py-2 text-right font-medium">Gen tps</th>
                  <th className="px-3 py-2 text-right font-medium">Prompt tps</th>
                  <th className="px-3 py-2 font-medium">Mode/Ctx</th>
                </tr>
              </thead>
              <tbody>
                {topBench.map((row: BenchCompareRow) => (
                  <tr
                    key={row.rel}
                    className="border-t border-[var(--color-border)] bg-[var(--color-surface-1)]"
                  >
                    <td className="px-3 py-2">{row.label}</td>
                    <td className="px-3 py-2 text-[color:var(--color-fg-muted)]">{row.class}</td>
                    <td className="px-3 py-2 text-right text-[color:var(--color-accent)]">
                      {row.tuned?.gen_tps ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right">{row.tuned?.prompt_tps ?? '—'}</td>
                    <td className="px-3 py-2 text-[color:var(--color-fg-muted)]">
                      {row.mode} / {row.ctx}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-fg-muted)]">
          Preset promotions ({promotions.length})
        </h2>
        {promotions.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-[color:var(--color-fg-muted)]">
            No preset overrides active.
          </div>
        ) : (
          <ul className="space-y-1 mono text-sm">
            {promotions.map((p: PresetOverride) => (
              <li
                key={`${p.profile}:${p.preset}`}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2"
              >
                <span className="text-[color:var(--color-brand)]">{p.profile}</span>
                <span className="mx-1 text-[color:var(--color-fg-muted)]">·</span>
                <span>{p.preset}</span>
                <span className="mx-2 text-[color:var(--color-fg-muted)]">→</span>
                <span className="text-[color:var(--color-accent)]">{p.rel}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default function Dashboard(): JSX.Element {
  return (
    <Suspense
      fallback={<div className="p-6 text-[color:var(--color-fg-muted)]">Loading…</div>}
    >
      <DashboardBody />
    </Suspense>
  );
}
