import * as React from 'react';
import { useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Badge, EditorialHero } from '@/ui';

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

function tierToTone(tier: Tier): "default" | "ok" | "info" {
  switch (tier) {
    case "deregister": return "default";
    case "force_private": return "default";
    case "warn": return "default";
    default: return "info";
  }
}

function barColor(fraction: number | undefined, thresholds: {
  warn: number;
  force_private: number;
  deregister: number;
}): string {
  if (fraction === undefined) return 'var(--color-surface-3, var(--color-surface-2))';
  if (fraction >= thresholds.deregister) return 'var(--color-err)';
  if (fraction >= thresholds.force_private) return 'var(--color-warn, var(--color-ok))';
  if (fraction >= thresholds.warn) return 'var(--color-ok)';
  return 'var(--color-ok, var(--color-ok))';
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
  const hasBudget = budget !== undefined && Number.isFinite(budget) && budget > 0;
  const hasSpend = spent !== undefined && Number.isFinite(spent);
  let readout: React.ReactNode;
  if (!hasBudget) {
    readout = <>Not configured</>;
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
    <div data-testid={testId} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 14, color: 'var(--color-text)' }}>{label}</span>
        <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{readout}</span>
      </div>
      <div style={{ height: 8, width: '100%', overflow: 'hidden', borderRadius: 'var(--r-md)', background: 'var(--color-surface-2)' }}>
        <div
          style={{ height: '100%', transition: 'width 0.2s', width: `${width}%`, background: barColor(fraction, thresholds) }}
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
        style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', background: 'var(--color-surface-1)', padding: '16px 12px', fontSize: 14, color: 'var(--color-text-secondary)' }}
      >
        {title}: no usage recorded yet.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h3 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>
        {title}
      </h3>
      <ul data-testid={testId} style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', background: 'var(--color-surface-1)', margin: 0, padding: 0, listStyle: 'none' }}>
        {rows.map((g, i) => (
          <li key={g.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderTop: i > 0 ? '1px solid var(--color-border)' : 'none' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, color: 'var(--color-text)' }} title={g.key}>
              {g.key}
            </span>
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
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
      <div data-testid="cost-journal-loading" style={{ fontSize: 14, color: 'var(--color-text-secondary)' }}>
        Loading journal…
      </div>
    );
  }
  if (journal.error) {
    return (
      <div data-testid="cost-journal-error" style={{ fontSize: 14, color: 'var(--color-err)' }}>
        journal error: {journal.error.message}
      </div>
    );
  }
  const data = journal.data ?? { entries: [], path: '' };
  if (data.entries.length === 0) {
    return (
      <div data-testid="cost-journal-empty" style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', background: 'var(--color-surface-1)', padding: '16px 12px', fontSize: 14, color: 'var(--color-text-secondary)' }}>
        No guardian ticks recorded yet. Run <code style={{ fontFamily: 'var(--font-mono)' }}>llamactl cost-guardian tick</code> or enable the loop
        to start populating <code style={{ fontFamily: 'var(--font-mono)' }}>{data.path || '~/.llamactl/healer/cost-journal.jsonl'}</code>.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>
          Guardian journal
        </h3>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}>
          last
          <select
            data-testid="cost-journal-limit"
            style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', background: 'var(--color-surface-1)', padding: '2px 4px', fontSize: 12 }}
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
        style={{ maxHeight: 320, overflowY: 'auto', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', background: 'var(--color-surface-1)', fontFamily: 'var(--font-mono)', fontSize: 12, margin: 0, padding: 0, listStyle: 'none' }}
      >
        {data.entries.map((e, i) => (
          <li key={i} style={{ padding: '8px 12px', borderTop: i > 0 ? '1px solid var(--color-border)' : 'none' }}>
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
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <Badge variant={tier === "warn" ? "warn" : tier === "deregister" ? "err" : tier === "force_private" ? "warn" : "default"}>{tier}</Badge>{' '}
          <span style={{ color: 'var(--color-text)' }}>{e.decision?.reason ?? ''}</span>
        </div>
        <time style={{ flexShrink: 0, color: 'var(--color-text-secondary)' }}>{e.decision?.ts?.slice(11, 19) ?? ''}</time>
      </div>
    );
  }
  if (e.kind === 'action') {
    return (
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <Badge variant={e.ok ? "ok" : "err"}>{e.action || "action"}</Badge>{' '}
          <span style={{ color: 'var(--color-text)' }}>{e.ok ? 'ok' : (e.error ?? 'failed')}</span>
        </div>
        <time style={{ flexShrink: 0, color: 'var(--color-text-secondary)' }}>{e.ts?.slice(11, 19) ?? ''}</time>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
      <div style={{ minWidth: 0, color: 'var(--color-err)' }}>
        error: {e.message ?? 'unknown'}
      </div>
      <time style={{ flexShrink: 0, color: 'var(--color-text-secondary)' }}>{e.ts?.slice(11, 19) ?? ''}</time>
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
      <div data-testid="cost-loading" style={{ padding: 24, fontSize: 14, color: 'var(--color-text-secondary)' }}>
        Loading cost snapshot…
      </div>
    );
  }
  if (status.error) {
    return (
      <div data-testid="cost-error" style={{ padding: 24, fontSize: 14, color: 'var(--color-err)' }}>
        Failed to load cost snapshot: {status.error.message}
      </div>
    );
  }

  const d = status.data!;
  const tier = d.decision.tier as Tier;

  return (
    <div
      data-testid="cost-root"
      style={{ display: 'flex', height: '100%', flexDirection: 'column', gap: 16, overflowY: 'auto', padding: 24 }}
    >
      <EditorialHero
        title="Cost dashboard"
        lede="Pricing-aware spend snapshot for the local usage corpus. Polls every 30s."
        pills={[{ label: tier, tone: tierToTone(tier) }]}
      />

      <section
        data-testid="cost-budget"
        style={{ display: 'grid', gap: 16, borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', background: 'var(--color-surface-1)', padding: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}
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
        <div style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--color-text-secondary)' }}>
          Thresholds (% of budget): warn ≥ {fmtPercent(d.config.thresholds.warn)} ·
          force_private ≥ {fmtPercent(d.config.thresholds.force_private)} ·
          deregister ≥ {fmtPercent(d.config.thresholds.deregister)}
          {d.config.hasWebhook ? ' · webhook wired' : ''}
          {d.config.autoForcePrivate ? ' · auto force_private on' : ''}
          {d.config.autoDeregister ? ' · auto deregister on' : ''}
        </div>
        <p style={{ gridColumn: '1 / -1', fontSize: 14, color: 'var(--color-text)' }} data-testid="cost-reason">
          {d.decision.reason}
        </p>
      </section>

      <section style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
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
        style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
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
