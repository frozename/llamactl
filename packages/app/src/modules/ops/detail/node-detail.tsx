import * as React from 'react';
import { Badge, Card, StatCard, StatusDot } from '@/ui';
import { trpc } from '@/lib/trpc';

interface Props {
  nodeName: string;
}

/**
 * Detail surface for a single fleet node. Mirrors WorkloadDetail —
 * phase, kind, endpoint, version, raw row. The cluster map refreshes
 * on a slower cadence since nodes are less volatile than workloads.
 */
export function NodeDetail({ nodeName }: Props): React.JSX.Element {
  const list = trpc.nodeList.useQuery(undefined, { refetchInterval: 15_000 });
  const node = (list.data?.nodes ?? []).find(
    (n: { name: string }) => n.name === nodeName,
  ) as
    | { name: string; effectiveKind?: string; endpoint?: string; version?: string; phase?: string }
    | undefined;

  if (!node) {
    return (
      <div data-testid="node-detail-root" className="h-full" style={{ padding: 48, color: 'var(--color-text-secondary)' }}>
        <h2 style={{ fontSize: 20, margin: '0 0 8px', color: 'var(--color-text)' }}>
          Node {nodeName}
        </h2>
        <p style={{ margin: 0, lineHeight: 1.6 }}>Not in the current cluster map.</p>
      </div>
    );
  }

  const tone = node.phase === 'Ready' || !node.phase ? 'ok' : 'warn';

  return (
    <div data-testid="node-detail-root" style={{ padding: 48, maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 24 }}>
        <h2 style={{ fontSize: 28, margin: 0, fontWeight: 600, color: 'var(--color-text)' }}>
          {node.name}
        </h2>
        <StatusDot tone={tone} label={node.phase ?? 'ready'} pulse={tone === 'ok'} />
        <Badge variant="default">{node.effectiveKind ?? 'agent'}</Badge>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 12,
          marginBottom: 32,
        }}
      >
        <StatCard label="Kind" value={node.effectiveKind ?? 'agent'} />
        <StatCard label="Endpoint" value={node.endpoint ?? '—'} />
        <StatCard label="Version" value={node.version ?? '—'} />
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
          {JSON.stringify(node, null, 2)}
        </pre>
      </Card>
    </div>
  );
}
