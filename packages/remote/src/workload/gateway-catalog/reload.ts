// packages/remote/src/workload/gateway-catalog/reload.ts
import type { ClusterNode } from "@llamactl/core/config/schema";

import { loadConfig, resolveToken } from "@llamactl/core/config/kubeconfig";
import { resolveNodeKind } from "@llamactl/core/config/schema";

type GatewayKind = "sirius" | "embersynth";

/** POST the kind-specific reload endpoint on one gateway node; best-effort. */
async function reloadGatewayNode(node: ClusterNode, kind: GatewayKind): Promise<void> {
  if (resolveNodeKind(node) !== "gateway" || node.cloud?.provider !== kind || !node.cloud.baseUrl) {
    return;
  }
  const url = `${node.cloud.baseUrl}${kind === "sirius" ? "/providers/reload" : "/config/reload"}`;
  const bearer = node.cloud.apiKeyRef
    ? resolveToken({ name: node.cloud.apiKeyRef, tokenRef: node.cloud.apiKeyRef })
    : undefined;
  try {
    await fetch(url, {
      method: "POST",
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    });
  } catch {
    // swallow — destroy cleanup is best-effort
  }
}

export async function reloadAllGatewayNodesOfKind(kind: GatewayKind): Promise<void> {
  const cfg = loadConfig();
  for (const cluster of cfg.clusters) {
    for (const node of cluster.nodes) {
      await reloadGatewayNode(node, kind);
    }
  }
}
