// packages/remote/src/rag/resolve.ts
import { TRPCError } from '@trpc/server';
import * as kubecfg from '../config/kubeconfig.js';
import type { ClusterNode, Config } from '../config/kubeconfig.js';

export function resolveRagNode(
  nodeName: string,
): { node: ClusterNode; cfg: Config } {
  const cfg = kubecfg.loadConfig();
  const resolved = kubecfg.resolveNode(cfg, nodeName);
  if (!resolved.node.rag) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `node '${nodeName}' is not a RAG node`,
    });
  }
  return { node: resolved.node, cfg };
}