// packages/remote/src/search/rag-node.ts
import { loadConfig, currentContext } from '../config/kubeconfig.js';

export async function resolveDefaultRagNode(): Promise<string | null> {
  const cfg = loadConfig();
  let ctx;
  try {
    ctx = currentContext(cfg);
  } catch {
    return null;
  }
  const cluster = cfg.clusters.find((c) => c.name === ctx.cluster);
  if (!cluster) return null;

  for (const node of cluster.nodes ?? []) {
    if ((node as any).kind === 'rag' && (node as any).rag) {
      return (node as any).name as string;
    }
  }
  return null;
}