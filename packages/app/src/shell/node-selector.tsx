import * as React from 'react';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { trpc, trpcUIClient } from '@/lib/trpc';

/**
 * Title-bar dropdown that shows the currently-selected node and lets
 * the user switch between every registered node. Every 30s it probes
 * the active (non-local) node via `nodeTest` and surfaces a green/red
 * health dot. When the remote node is unreachable, a "switch to local"
 * action appears so the user can route UI traffic home without editing
 * kubeconfig by hand.
 *
 * The renderer's selection is separate from kubeconfig's `defaultNode`
 * (which controls the CLI's default). We persist the selection in a
 * per-renderer zustand store and sync it to Electron main via the
 * `uiSetActiveNode` UI-only tRPC procedure — the dispatcher there
 * reads this override first when deciding whether a call forwards to
 * a remote agent or runs locally.
 */

interface NodeSelectionStore {
  selectedNode: string | null;
  setSelectedNode: (name: string | null) => void;
}

export const useNodeSelection = create<NodeSelectionStore>()(
  persist(
    (set) => ({
      selectedNode: null,
      setSelectedNode: (name) => set({ selectedNode: name }),
    }),
    { name: 'llamactl-node-selection' },
  ),
);

type SelectorNode = {
  name: string;
  effectiveKind?: 'agent' | 'gateway' | 'provider' | 'rag';
};

interface SelectorGroup {
  /** Empty string renders ungrouped (flat options); non-empty wraps in
   *  an `<optgroup label=…>`. */
  label: string;
  items: SelectorNode[];
}

/**
 * Lay out the flat node list into selector groups that make the
 * dropdown readable when provider nodes fan out from a gateway.
 * Everything non-provider goes first as a flat list (agents + gateways
 * + local); each gateway with provider children gets its own
 * `<optgroup>` immediately after, labelled with the gateway's name.
 */
function groupNodesForSelector(nodes: readonly SelectorNode[]): SelectorGroup[] {
  const kindOf = (n: SelectorNode): 'agent' | 'gateway' | 'provider' | 'rag' =>
    n.effectiveKind ?? 'agent';

  const roots = nodes.filter((n) => kindOf(n) !== 'provider');
  const providerChildrenByGateway = new Map<string, SelectorNode[]>();
  for (const n of nodes) {
    if (kindOf(n) !== 'provider') continue;
    const gatewayName = n.name.split('.')[0] ?? '';
    if (!gatewayName) continue;
    const bucket = providerChildrenByGateway.get(gatewayName) ?? [];
    bucket.push(n);
    providerChildrenByGateway.set(gatewayName, bucket);
  }

  const groups: SelectorGroup[] = [{ label: '', items: roots }];
  // Order provider optgroups by the gateway's position in the top list.
  for (const root of roots) {
    const children = providerChildrenByGateway.get(root.name);
    if (children && children.length > 0) {
      groups.push({ label: `via ${root.name}`, items: children });
    }
  }
  // Orphan provider nodes (parent gateway was hidden/removed) — put
  // them in a labelled bucket so they don't vanish.
  for (const [gw, children] of providerChildrenByGateway.entries()) {
    if (!roots.some((r) => r.name === gw)) {
      groups.push({ label: `via ${gw} (missing)`, items: children });
    }
  }
  return groups;
}

export function NodeSelector(): React.JSX.Element | null {
  const qc = useQueryClient();
  const utils = trpc.useUtils();
  const list = trpc.nodeList.useQuery();
  const { selectedNode, setSelectedNode } = useNodeSelection();

  // Resolve the effective selection: explicit override → kubeconfig
  // default → `local`. Kept outside the store so when a user hasn't
  // picked anything yet we still show something sensible.
  const effective = selectedNode ?? list.data?.defaultNode ?? 'local';
  const isLocalSelection = effective === 'local';

  // On first mount (and whenever the selection changes) push the
  // override into main so the dispatcher picks it up. No-op when the
  // renderer-picked value already matches what main has.
  useEffect(() => {
    if (!effective) return;
    void trpcUIClient.uiSetActiveNode
      .mutate({ name: effective })
      .then(() => {
        void utils.invalidate();
        void qc.invalidateQueries();
      })
      .catch(() => {
        // Main-side error (cert tamper, etc.) — the dispatcher falls
        // back to kubeconfig anyway.
      });
  }, [effective, utils, qc]);

  // Probe the currently-selected remote node. Disabled for local.
  const test = trpc.nodeTest.useQuery(
    { name: effective },
    {
      enabled: !isLocalSelection && Boolean(list.data),
      refetchInterval: 30_000,
      retry: 0,
      staleTime: 15_000,
    },
  );

  if (list.isLoading || !list.data) return null;
  const { nodes } = list.data;
  if (nodes.length <= 1) {
    return (
      <span className="font-mono text-[10px] text-[color:var(--color-fg-muted)]">
        {effective}
      </span>
    );
  }

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
      data-testid="node-selector-root"
      data-active-node={effective}
      data-healthy={healthy === true ? 'true' : healthy === false ? 'false' : 'probing'}
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
        value={effective}
        onChange={(e) => setSelectedNode(e.target.value)}
        data-testid="node-selector"
        className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 font-mono text-[11px] text-[color:var(--color-fg)]"
      >
        {groupNodesForSelector(nodes).map((group) =>
          group.label ? (
            <optgroup key={group.label} label={group.label}>
              {group.items.map((n) => (
                <option key={n.name} value={n.name}>
                  {n.name}
                </option>
              ))}
            </optgroup>
          ) : (
            group.items.map((n) => (
              <option key={n.name} value={n.name}>
                {n.name}
              </option>
            ))
          ),
        )}
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
            onClick={() => setSelectedNode('local')}
            className="rounded border border-[var(--color-border)] bg-[var(--color-danger)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-fg-inverted)]"
            title="route UI traffic back to the local node"
          >
            switch to local
          </button>
        </>
      )}
    </div>
  );
}
