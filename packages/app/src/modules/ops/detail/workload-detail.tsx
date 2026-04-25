import * as React from 'react';
import { Badge, Card, StatCard, StatusDot } from '@/ui';
import { trpc } from '@/lib/trpc';

interface Props {
  workloadId: string;
}

/**
 * Detail surface for a single workload. Subscribes to the live
 * status query and renders phase + model + stats + the raw row for
 * debugging. Minimal v1 — ops chat can deep-link into this and the
 * view earns its keep even without every field populated.
 */
export function WorkloadDetail({ workloadId }: Props): React.JSX.Element {
  const workloads = trpc.workloadList.useQuery(undefined, { refetchInterval: 5_000 });
  const row = (workloads.data ?? []).find(
    (w: { name?: string }) => w.name === workloadId,
  ) as
    | { name?: string; phase?: string; modelRef?: string; node?: string; tokensPerSec?: number }
    | undefined;

  if (!row) {
    return (
      <div data-testid="workload-detail-root" className="h-full" style={{ padding: 48, color: 'var(--color-text-secondary)' }}>
        <h2 style={{ fontSize: 20, margin: '0 0 8px', color: 'var(--color-text)' }}>
          Workload {workloadId}
        </h2>
        <p style={{ margin: 0, lineHeight: 1.6 }}>
          Not in the current workload list — it may have finished or been removed.
        </p>
      </div>
    );
  }

  const tone = row.phase === 'Running' ? 'ok' : row.phase === 'Failed' ? 'err' : 'warn';

  return (
    <div data-testid="workload-detail-root" style={{ padding: 48, maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 24 }}>
        <h2 style={{ fontSize: 28, margin: 0, fontWeight: 600, color: 'var(--color-text)' }}>
          {row.name}
        </h2>
        <StatusDot tone={tone} label={row.phase ?? 'unknown'} pulse={tone === 'ok'} />
        {row.modelRef && <Badge variant="brand">{row.modelRef}</Badge>}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 12,
          marginBottom: 32,
        }}
      >
        <StatCard label="Phase" value={row.phase ?? '—'} />
        <StatCard label="Node" value={row.node ?? '—'} />
        <StatCard
          label="t/s"
          value={row.tokensPerSec ? row.tokensPerSec.toFixed(1) : '—'}
          unit={row.tokensPerSec ? 't/s' : undefined}
        />
        <StatCard label="Model" value={row.modelRef ?? '—'} />
      </div>

      <Card>
        <h3 style={{ fontSize: 15, margin: '0 0 12px', color: 'var(--color-text)' }}>Raw</h3>
        <pre
          style={{
            margin: 0,
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--color-text-secondary)',
            background: 'var(--color-surface-2)',
            padding: 16,
            borderRadius: 'var(--r-md)',
            overflow: 'auto',
          }}
        >
          {JSON.stringify(row, null, 2)}
        </pre>
      </Card>
    </div>
  );
}
