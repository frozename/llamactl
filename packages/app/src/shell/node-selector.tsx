import * as React from 'react';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { trpc, trpcUIClient } from '@/lib/trpc';
import { useUIStore } from '@/stores/ui-store';

/**
 * Cluster chip that sits in the title bar. Shows the kubeconfig
 * context's node count. Click = jumps to the dashboard's cluster
 * map where the operator can drill into any node.
 *
 * Previously this was a global "active node" dropdown — the
 * semantics confused operators ("all nodes are active in a
 * cluster; why do I keep picking one?"). Now:
 *
 *   - The useNodeSelection store still exists as a low-level
 *     escape hatch for scoped operations that explicitly want to
 *     override the dispatcher target. Default state = null =
 *     dispatcher uses kubeconfig.defaultNode.
 *   - Per-functionality pickers (Chat's conversation-node selector,
 *     Knowledge's RAG-node dropdown, ModelRun's spec.node field)
 *     remain where they always were.
 *   - The chip is a navigation primitive, not a state mutator.
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

/**
 * Clear any stale active-node override on boot. The dispatcher
 * honors an override-first policy, and a persisted value from the
 * old dropdown-era UX silently routed every tRPC call to whatever
 * was last picked \u2014 even after the UI dropped the dropdown and
 * the user thought they were back on local. Reset to null on mount
 * so every module defaults to kubeconfig.defaultNode. Scoped
 * per-feature pickers (chat conversation, RAG-node dropdown) drive
 * their own routing with explicit inputs \u2014 they don't need the
 * global override.
 */
export function useSyncActiveNode(): void {
  const qc = useQueryClient();
  const utils = trpc.useUtils();
  const { selectedNode, setSelectedNode } = useNodeSelection();
  useEffect(() => {
    // Clear the persisted override exactly once on boot. If the
    // user picks a node again via the dashboard map's detail-card
    // "set as active" action (which navigates instead of overriding
    // in the new UX), no re-sync fires and the override stays null.
    if (selectedNode !== null) {
      setSelectedNode(null);
      void trpcUIClient.uiSetActiveNode.mutate({ name: 'local' }).catch(() => {});
      void utils.invalidate();
      void qc.invalidateQueries();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function NodeSelector(): React.JSX.Element | null {
  const list = trpc.nodeList.useQuery();
  const setActiveModule = useUIStore((s) => s.setActiveModule);
  useSyncActiveNode();

  if (list.isLoading || !list.data) return null;
  const nodes = list.data.nodes ?? [];
  const agentCount = nodes.filter(
    (n) => (n.effectiveKind ?? 'agent') === 'agent',
  ).length;
  const gatewayCount = nodes.filter((n) => n.effectiveKind === 'gateway').length;
  const totalCount = nodes.length;

  return (
    <button
      type="button"
      onClick={() => setActiveModule('dashboard')}
      className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[color:var(--color-fg)] hover:border-[var(--color-accent)]"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      data-testid="node-selector-root"
      data-node-count={totalCount}
      title={`${totalCount} node${totalCount === 1 ? '' : 's'} in the cluster (${agentCount} agent, ${gatewayCount} gateway) \u2014 click to open the cluster map`}
    >
      <span className="text-[10px] text-[color:var(--color-fg-muted)]">cluster</span>
      <span className="font-mono text-[11px]">
        {totalCount} node{totalCount === 1 ? '' : 's'}
      </span>
    </button>
  );
}
