// packages/remote/src/search/rag-node.ts
import { currentContext, loadConfig } from "@llamactl/core/config/kubeconfig";

export function resolveDefaultRagNode(): string | null {
  const cfg = loadConfig();
  let ctx;
  try {
    ctx = currentContext(cfg);
  } catch {
    return null;
  }
  const cluster = cfg.clusters.find((c) => c.name === ctx.cluster);
  if (!cluster) return null;

  for (const node of cluster.nodes) {
    if (isRagNode(node)) {
      return node.name;
    }
  }
  return null;
}

function isRagNode(node: unknown): node is { kind: "rag"; rag: unknown; name: string } {
  if (!node || typeof node !== "object") return false;
  const maybe = node as { kind?: unknown; rag?: unknown; name?: unknown };
  return maybe.kind === "rag" && !!maybe.rag && typeof maybe.name === "string";
}
