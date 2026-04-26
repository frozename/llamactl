// packages/remote/src/workload/gateway-catalog/reload.ts
import { loadConfig, resolveToken } from '../../config/kubeconfig.js';
import { resolveNodeKind } from '../../config/schema.js';

export async function reloadAllGatewayNodesOfKind(kind: 'sirius' | 'embersynth'): Promise<void> {
  const cfg = loadConfig();
  for (const cluster of cfg.clusters) {
    for (const node of cluster.nodes ?? []) {
      if (resolveNodeKind(node as any) === 'gateway' && node.cloud?.provider === kind && node.cloud?.baseUrl) {
        const url = `${node.cloud.baseUrl}${kind === 'sirius' ? '/providers/reload' : '/config/reload'}`;
        const bearer = node.cloud.bearerRef ? resolveToken(node.cloud.bearerRef) : undefined;
        try {
          await fetch(url, {
            method: 'POST',
            headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
          });
        } catch {
          // swallow — destroy cleanup is best-effort
        }
      }
    }
  }
}