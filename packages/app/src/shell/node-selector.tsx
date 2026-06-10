import * as React from "react";

import { trpc } from "@/lib/trpc";
import { useUIStore } from "@/stores/ui-store";
import { useSyncActiveNode } from "./node-selection";

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

export function NodeSelector(): React.JSX.Element | null {
  const list = trpc.nodeList.useQuery();
  const setActiveModule = useUIStore((s) => s.setActiveModule);
  useSyncActiveNode();

  if (list.isLoading || !list.data) return null;
  const nodes = list.data.nodes;
  const agentCount = nodes.filter((n) => n.effectiveKind === "agent").length;
  const gatewayCount = nodes.filter((n) => n.effectiveKind === "gateway").length;
  const totalCount = nodes.length;

  return (
    <button
      type="button"
      onClick={() => {
        setActiveModule("dashboard");
      }}
      className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[color:var(--color-text)] hover:border-[var(--color-ok)]"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      data-testid="node-selector-root"
      data-node-count={totalCount}
      title={`${String(totalCount)} node${totalCount === 1 ? "" : "s"} in the cluster (${String(agentCount)} agent, ${String(gatewayCount)} gateway) \u2014 click to open the cluster map`}
    >
      <span className="text-[10px] text-[color:var(--color-text-secondary)]">cluster</span>
      <span className="font-mono text-[11px]">
        {totalCount} node{totalCount === 1 ? "" : "s"}
      </span>
    </button>
  );
}
