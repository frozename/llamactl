import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/lib/trpc';

/**
 * Title-bar dropdown that shows the kubeconfig's current default node
 * and lets the user switch between every registered node. On change,
 * updates the current context's `defaultNode` and invalidates every
 * query so modules refresh against the newly-selected node.
 *
 * Note: today most router procedures still execute on the local
 * machine — the selection is authoritative for modules that read
 * `defaultNode` explicitly (Nodes, Workloads) and for the CLI. A
 * follow-up slice will rewire per-module dispatch through the
 * selector end-to-end.
 */
export function NodeSelector(): React.JSX.Element | null {
  const qc = useQueryClient();
  const utils = trpc.useUtils();
  const list = trpc.nodeList.useQuery();
  const setDefault = trpc.nodeSetDefault.useMutation({
    onSuccess: () => {
      void utils.nodeList.invalidate();
      void qc.invalidateQueries();
    },
  });

  if (list.isLoading || !list.data) return null;
  const { nodes, defaultNode } = list.data;
  if (nodes.length <= 1) {
    // Single-node install — hide the control to avoid visual noise.
    return (
      <span className="font-mono text-[10px] text-[color:var(--color-fg-muted)]">
        {defaultNode}
      </span>
    );
  }

  return (
    <div
      className="flex items-center gap-1 text-xs"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <span className="text-[10px] text-[color:var(--color-fg-muted)]">node</span>
      <select
        value={defaultNode}
        disabled={setDefault.isPending}
        onChange={(e) => setDefault.mutate({ name: e.target.value })}
        className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 font-mono text-[11px] text-[color:var(--color-fg)] disabled:opacity-50"
      >
        {nodes.map((n) => (
          <option key={n.name} value={n.name}>
            {n.name}
          </option>
        ))}
      </select>
    </div>
  );
}
