import type { ClusterNode, Config } from "@llamactl/core/config/schema";

import * as kubecfg from "@llamactl/core/config/kubeconfig";
// packages/remote/src/rag/resolve.ts
import { TRPCError } from "@trpc/server";

export function resolveRagNode(nodeName: string): { node: ClusterNode; cfg: Config } {
  const cfg = kubecfg.loadConfig();
  const resolved = kubecfg.resolveNode(cfg, nodeName);
  if (!resolved.node.rag) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `node '${nodeName}' is not a RAG node`,
    });
  }
  return { node: resolved.node, cfg };
}
