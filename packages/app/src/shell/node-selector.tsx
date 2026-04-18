import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/lib/trpc';

/**
 * Title-bar dropdown that shows the current active node and lets the
 * user switch between every registered node. Every 30s it probes the
 * active (non-local) node via `nodeTest` and surfaces a green/red
 * health dot. When the remote node is unreachable, a "switch to local"
 * action appears so the user can reconnect UI traffic without editing
 * kubeconfig by hand.
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

  const defaultNode = list.data?.defaultNode;
  const isLocalSelection = defaultNode === 'local' || !defaultNode;

  // Probe the currently-selected node. Disabled for local (no HTTP
  // round-trip needed) and while the node list is still loading.
  const test = trpc.nodeTest.useQuery(
    { name: defaultNode ?? 'local' },
    {
      enabled: Boolean(defaultNode) && !isLocalSelection,
      refetchInterval: 30_000,
      retry: 0,
      staleTime: 15_000,
    },
  );

  if (list.isLoading || !list.data) return null;
  const { nodes } = list.data;
  if (nodes.length <= 1) {
    // Single-node install — hide the control to avoid visual noise.
    return (
      <span className="font-mono text-[10px] text-[color:var(--color-fg-muted)]">
        {defaultNode}
      </span>
    );
  }

  // Health state: green for local (always), probe result otherwise.
  // Undetermined during an in-flight probe; red when probe failed or
  // returned ok:false.
  const healthy = isLocalSelection
    ? true
    : test.data?.ok === true
      ? true
      : test.data?.ok === false || test.isError
        ? false
        : null;

  const dotClass =
    healthy === true
      ? 'bg-[var(--color-success)]'
      : healthy === false
        ? 'bg-[var(--color-danger)]'
        : 'bg-[var(--color-fg-muted)]';

  return (
    <div
      className="flex items-center gap-1 text-xs"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <span className="text-[10px] text-[color:var(--color-fg-muted)]">node</span>
      <span
        title={
          healthy === true
            ? 'reachable'
            : healthy === false
              ? (test.data && 'error' in test.data ? test.data.error : null) ??
                test.error?.message ??
                'unreachable'
              : 'probing…'
        }
        className={`h-1.5 w-1.5 rounded-full ${dotClass}`}
      />
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
      {healthy === false && !isLocalSelection && (
        <>
          <button
            type="button"
            onClick={() => test.refetch()}
            disabled={test.isFetching}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-fg)] disabled:opacity-50"
            title="probe the node again"
          >
            {test.isFetching ? '…' : 'retry'}
          </button>
          <button
            type="button"
            onClick={() => setDefault.mutate({ name: 'local' })}
            disabled={setDefault.isPending}
            className="rounded border border-[var(--color-border)] bg-[var(--color-danger)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-fg-inverted)] disabled:opacity-50"
            title="route UI traffic back to the local node"
          >
            switch to local
          </button>
        </>
      )}
    </div>
  );
}
