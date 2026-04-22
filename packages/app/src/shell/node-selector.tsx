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
 * Sync the current override (if any) to Electron main so the
 * dispatcher picks it up. Only writes when an override is set;
 * absence means the dispatcher falls back to kubeconfig.defaultNode
 * \u2014 the happy path.
 */
export function useSyncActiveNode(): void {
  const qc = useQueryClient();
  const utils = trpc.useUtils();
  const { selectedNode } = useNodeSelection();
  useEffect(() => {
    if (!selectedNode) return;
    void trpcUIClient.uiSetActiveNode
      .mutate({ name: selectedNode })
      .then(() => {
        void utils.invalidate();
        void qc.invalidateQueries();
      })
      .catch(() => {
        /* main-side race \u2014 dispatcher falls back to kubeconfig */
      });
  }, [selectedNode, utils, qc]);
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
