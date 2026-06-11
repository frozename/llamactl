import * as React from "react";

import { trpc } from "@/lib/trpc";
import { APP_MODULES } from "@/modules/registry";

import { buildExplorerTree, type DynamicInstance, type ExplorerGroup } from "./registry-view";

interface WorkloadData {
  name?: string;
  phase?: string;
  modelRef?: string;
}

interface NodeData {
  name: string;
  effectiveKind?: string;
}

export function useExplorerTreeData(): {
  tree: ExplorerGroup[];
} {
  const workloads = trpc.workloadList.useQuery(undefined, { refetchInterval: 10_000 });
  const nodes = trpc.nodeList.useQuery(undefined, { refetchInterval: 30_000 });

  const wlInstances: DynamicInstance[] = React.useMemo(() => {
    const rows = (workloads.data ?? []) as WorkloadData[];
    return rows.map((w) => ({
      id: w.name ?? "unknown",
      title: `${w.name ?? "—"}${w.modelRef ? ` · ${w.modelRef}` : ""}`,
      tone: w.phase === "Running" ? "ok" : w.phase === "Failed" ? "err" : "warn",
    }));
  }, [workloads.data]);

  const nodeInstances: DynamicInstance[] = React.useMemo(() => {
    const rows = (nodes.data?.nodes ?? []) as NodeData[];
    return rows.map((n) => ({
      id: n.name,
      title: `${n.name} · ${n.effectiveKind ?? "agent"}`,
      tone: "ok" as const,
    }));
  }, [nodes.data]);

  const tree = React.useMemo(
    () => buildExplorerTree(APP_MODULES, { workloads: wlInstances, nodes: nodeInstances }),
    [wlInstances, nodeInstances],
  );

  return { tree };
}
