import * as React from 'react';
import { useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';

/**
 * N.3.7 — cost dashboard. Surfaces the same data the cost-guardian
 * loop reasons over: current tier (noop/warn/force_private/
 * deregister), daily + weekly budget utilization, top providers +
 * models, and a tail of the tick journal. Read-only — mutations
 * (webhook fire, embersynth flip, sirius dry-run deregister) remain
 * the CLI/guardian loop's responsibility; this view exists so an
 * operator can *see* why the guardian is about to do something.
 */

type Tier = 'noop' | 'warn' | 'force_private' | 'deregister';

interface CostGroup {
  key: string;
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  recordsMissingPricing: number;
}

function tierColor(tier: Tier): string {
  switch (tier) {
    case 'deregister':
      return 'bg-[var(--color-danger)] text-[color:var(--color-fg-inverted)]';
    case 'force_private':
      return 'bg-[var(--color-warning,var(--color-accent))] text-[color:var(--color-fg-inverted)]';
    case 'warn':
      return 'bg-[var(--color-accent)] text-[color:var(--color-fg-inverted)]';
    default:
      return 'bg-[var(--color-surface-2)] text-[color:var(--color-fg-muted)]';
  }
}

function barColor(fraction: number | undefined, thresholds: {
  warn: number;
  force_private: number;
  deregister: number;
}): string {
  if (fraction === undefined) return 'bg-[var(--color-surface-3,var(--color-surface-2))]';
  if (fraction >= thresholds.deregister) return 'bg-[var(--color-danger)]';
  if (fraction >= thresholds.force_private) return 'bg-[var(--color-warning,var(--color-accent))]';
  if (fraction >= thresholds.warn) return 'bg-[var(--color-accent)]';
  return 'bg-[var(--color-success,var(--color-accent))]';
}

function fmtUsd(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtPercent(f: number | undefined): string {
  if (f === undefined || !Number.isFinite(f)) return '—';
  return `${(f * 100).toFixed(1)}%`;
}

function BudgetBar({
  label,
  spent,
  budget,
  fraction,
  thresholds,
  testId,
}: {
  label: string;
  spent: number | undefined;
  budget: number | undefined;
  fraction: number | undefined;
  thresholds: { warn: number; force_private: number; deregister: number };
  testId: string;
}): React.JSX.Element {
  const width = Math.min(100, Math.max(0, (fraction ?? 0) * 100));
  // Three explicit states for the right-hand readout:
  //   1. Budget undefined or 0 — cost-guardian config has no limit →
  //      say so directly so the operator doesn't mistake "— — —" for
  //      missing data.
  //   2. Budget present, spent undefined/NaN — no usage records yet in
  //      the window → "$0 / $BUDGET · 0.0%" rather than em-dashes.
  //   3. Regular case → spent / budget · percent.
  const hasBudget = budget !== undefined && Number.isFinite(budget) && budget > 0;
  const hasSpend = spent !== undefined && Number.isFinite(spent);
  let readout: React.ReactNode;
  if (!hasBudget) {
    readout = (
      <span className="italic">
        Not configured
      </span>
    );
  } else if (!hasSpend) {
    readout = (
      <>
        {fmtUsd(0)} / {fmtUsd(budget)} · {fmtPercent(0)}
      </>
    );
  } else {
    readout = (
      <>
        {fmtUsd(spent)} / {fmtUsd(budget)} · {fmtPercent(fraction)}
      </>
    );
  }
  return (
    <div data-testid={testId} className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-[color:var(--color-fg)]">{label}</span>
        <span className="text-xs text-[color:var(--color-fg-muted)]">{readout}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded bg-[var(--color-surface-2)]">
        <div
          className={`h-full ${barColor(fraction, thresholds)} transition-[width]`}
          style={{ width: `${width}%` }}
          data-testid={`${testId}-fill`}
        />
      </div>
    </div>
  );
}

function TopSpenders({
  title,
  groups,
  limit,
  testId,
}: {
  title: string;
  groups: CostGroup[];
  limit: number;
  testId: string;
}): React.JSX.Element {
  const rows = groups.slice(0, limit);
  if (rows.length === 0) {
    return (
      <div
        data-testid={`${testId}-empty`}
        className="rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-4 text-sm text-[color:var(--color-fg-muted)]"
      >
        {title}: no usage recorded yet.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-fg-muted)]">
        {title}
      </h3>
      <ul data-testid={testId} className="divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)] bg-[var(--color-surface-1)]">
        {rows.map((g) => (
          <li key={g.key} className="flex items-center justify-between px-3 py-2">
            <span className="truncate text-sm text-[color:var(--color-fg)]" title={g.key}>
              {g.key}
            </span>
            <span className="text-xs text-[color:var(--color-fg-muted)]">
              {fmtUsd(g.estimatedCostUsd)} · {g.requestCount} req · {g.totalTokens.toLocaleString()} tok
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function JournalPane(): React.JSX.Element {
  const [limit, setLimit] = useState(25);
  const journal = trpc.costJournalTail.useQuery({ limit });

  if (journal.isLoading) {
    return (
      <div data-testid="cost-journal-loading" className="text-sm text-[color:var(--color-fg-muted)]">
        Loading journal…
      </div>
    );
  }
  if (journal.error) {
    return (
      <div data-testid="cost-journal-error" className="text-sm text-[color:var(--color-danger)]">
        journal error: {journal.error.message}
      </div>
    );
  }
  const data = journal.data ?? { entries: [], path: '' };
  if (data.entries.length === 0) {
    return (
      <div data-testid="cost-journal-empty" className="rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-4 text-sm text-[color:var(--color-fg-muted)]">
        No guardian ticks recorded yet. Run <code>llamactl cost-guardian tick</code> or enable the loop
        to start populating <code>{data.path || '~/.llamactl/healer/cost-journal.jsonl'}</code>.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-fg-muted)]">
          Guardian journal
        </h3>
        <label className="flex items-center gap-2 text-xs text-[color:var(--color-fg-muted)]">
          last
          <select
            data-testid="cost-journal-limit"
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] px-1 py-0.5 text-xs"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          >
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </label>
      </div>
      <ul
        data-testid="cost-journal"
        className="max-h-80 overflow-y-auto divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] font-mono text-xs"
      >
        {data.entries.map((e, i) => (
          <li key={i} className="px-3 py-2">
            <JournalRow entry={e} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function JournalRow({ entry }: { entry: unknown }): React.JSX.Element {
  const e = entry as {
    kind: 'tick' | 'action' | 'error';
    ts?: string;
    decision?: { tier?: Tier; reason?: string; ts?: string };
    action?: string;
    ok?: boolean;
    error?: string;
    message?: string;
  };
  if (e.kind === 'tick') {
    const tier = (e.decision?.tier ?? 'noop') as Tier;
    return (
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tierColor(tier)}`}>
            {tier}
          </span>{' '}
          <span className="text-[color:var(--color-fg)]">{e.decision?.reason ?? ''}</span>
        </div>
        <time className="shrink-0 text-[color:var(--color-fg-muted)]">{e.decision?.ts?.slice(11, 19) ?? ''}</time>
      </div>
    );
  }
  if (e.kind === 'action') {
    return (
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            e.ok ? 'bg-[var(--color-success,var(--color-accent))] text-[color:var(--color-fg-inverted)]' : 'bg-[var(--color-danger)] text-[color:var(--color-fg-inverted)]'
          }`}>
            {e.action}
          </span>{' '}
          <span className="text-[color:var(--color-fg)]">{e.ok ? 'ok' : (e.error ?? 'failed')}</span>
        </div>
        <time className="shrink-0 text-[color:var(--color-fg-muted)]">{e.ts?.slice(11, 19) ?? ''}</time>
      </div>
    );
  }
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 text-[color:var(--color-danger)]">
        error: {e.message ?? 'unknown'}
      </div>
      <time className="shrink-0 text-[color:var(--color-fg-muted)]">{e.ts?.slice(11, 19) ?? ''}</time>
    </div>
  );
}

export default function CostDashboard(): React.JSX.Element {
  const status = trpc.costGuardianStatus.useQuery(undefined, { refetchInterval: 30_000 });
  const topN = 5;

  const providerRows = useMemo<CostGroup[]>(() => {
    return (status.data?.weekly.byProvider ?? []) as CostGroup[];
  }, [status.data]);
  const modelRows = useMemo<CostGroup[]>(() => {
    return (status.data?.weekly.byModel ?? []) as CostGroup[];
  }, [status.data]);

  if (status.isLoading) {
    return (
      <div data-testid="cost-loading" className="p-6 text-sm text-[color:var(--color-fg-muted)]">
        Loading cost snapshot…
      </div>
    );
  }
  if (status.error) {
    return (
      <div data-testid="cost-error" className="p-6 text-sm text-[color:var(--color-danger)]">
        Failed to load cost snapshot: {status.error.message}
      </div>
    );
  }

  const d = status.data!;
  const tier = d.decision.tier as Tier;

  return (
    <div
      data-testid="cost-root"
      className="flex h-full flex-col gap-4 overflow-y-auto p-6"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-[color:var(--color-fg)]">Cost dashboard</h1>
          <p className="text-sm text-[color:var(--color-fg-muted)]">
            Pricing-aware spend snapshot for the local usage corpus. Polls every 30s.
          </p>
        </div>
        <span
          data-testid="cost-tier"
          className={`rounded px-2 py-1 text-xs font-semibold uppercase tracking-wide ${tierColor(tier)}`}
          title={d.decision.reason}
        >
          {tier}
        </span>
      </header>

      <section
        data-testid="cost-budget"
        className="grid gap-4 rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4 sm:grid-cols-2"
      >
        <BudgetBar
          label="Daily budget"
          spent={d.decision.dailyUsd}
          budget={d.config.budget.daily_usd}
          fraction={d.decision.dailyFraction}
          thresholds={d.config.thresholds}
          testId="cost-budget-daily"
        />
        <BudgetBar
          label="Weekly budget"
          spent={d.decision.weeklyUsd}
          budget={d.config.budget.weekly_usd}
          fraction={d.decision.weeklyFraction}
          thresholds={d.config.thresholds}
          testId="cost-budget-weekly"
        />
        <div className="sm:col-span-2 text-xs text-[color:var(--color-fg-muted)]">
          Thresholds: warn ≥ {fmtPercent(d.config.thresholds.warn)} ·
          force_private ≥ {fmtPercent(d.config.thresholds.force_private)} ·
          deregister ≥ {fmtPercent(d.config.thresholds.deregister)}
          {d.config.hasWebhook ? ' · webhook wired' : ''}
          {d.config.autoForcePrivate ? ' · auto force_private on' : ''}
          {d.config.autoDeregister ? ' · auto deregister on' : ''}
        </div>
        <p className="sm:col-span-2 text-sm text-[color:var(--color-fg)]" data-testid="cost-reason">
          {d.decision.reason}
        </p>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <TopSpenders
          title="Top providers (7d)"
          groups={providerRows}
          limit={topN}
          testId="cost-top-providers"
        />
        <TopSpenders
          title="Top models (7d)"
          groups={modelRows}
          limit={topN}
          testId="cost-top-models"
        />
      </section>

      <section>
        <JournalPane />
      </section>

      <footer
        className="text-xs text-[color:var(--color-fg-muted)]"
        data-testid="cost-window"
      >
        Daily window: {d.daily.windowSince.slice(0, 19)}Z → {d.daily.windowUntil.slice(0, 19)}Z ·
        Weekly window: {d.weekly.windowSince.slice(0, 19)}Z → {d.weekly.windowUntil.slice(0, 19)}Z ·
        {d.weekly.pricingFilesLoaded} pricing file(s) loaded
        {d.weekly.recordsMissingPricing > 0 ? ` · ${d.weekly.recordsMissingPricing} request(s) had no pricing match` : ''}
      </footer>
    </div>
  );
}
