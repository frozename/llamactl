import * as React from 'react';
import { StatusDot, TreeItem } from '@/ui';
import { trpc } from '@/lib/trpc';
import { useTabStore } from '@/stores/tab-store';

/**
 * Compact node list for quick context switching. Click a node to
 * open its detail tab. Real node/cluster selection — changing the
 * active fleet for downstream queries — still happens via
 * NodeSelector in the title bar; this view is a read-only quick-nav.
 */
export function FleetView(): React.JSX.Element {
  const list = trpc.nodeList.useQuery(undefined, { refetchInterval: 15_000 });
  const open = useTabStore((s) => s.open);
  const nodes = (list.data?.nodes ?? []) as Array<{
    name: string;
    effectiveKind?: string;
    phase?: string;
  }>;

  if (nodes.length === 0) {
    return (
      <div
        style={{
          padding: '14px 18px',
          color: 'var(--color-text-secondary)',
          fontSize: 13,
          lineHeight: 1.6,
        }}
      >
        No nodes in the current cluster. Add one via{' '}
        <code
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--color-text)',
          }}
        >
          llamactl node add
        </code>
        .
      </div>
    );
  }

  return (
    <div style={{ overflowY: 'auto', flex: 1, padding: '8px 0' }}>
      {nodes.map((n) => {
        const tone = n.phase === 'Ready' || !n.phase ? 'ok' : 'warn';
        return (
          <TreeItem
            key={n.name}
            label={n.name}
            trailing={<StatusDot tone={tone} />}
            onClick={() =>
              open({
                tabKey: `node:${n.name}`,
                title: `Node · ${n.name}`,
                kind: 'node',
                instanceId: n.name,
                openedAt: Date.now(),
              })
            }
          />
        );
      })}
    </div>
  );
}
