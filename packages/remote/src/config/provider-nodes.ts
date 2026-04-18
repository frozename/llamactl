import { loadSiriusProviders, type SiriusProvider } from './sirius-providers.js';
import {
  resolveNodeKind,
  type ClusterNode,
  type Config,
} from './schema.js';

/**
 * Synthesizes `kind: 'provider'` virtual nodes from sirius-providers.yaml
 * for each gateway node in the cluster. One virtual node per (gateway,
 * provider) pair, named `<gateway>.<providerName>`.
 *
 * Synthesis is pure — no persistence, no caching. Called on every
 * `nodeList` read so changes to `sirius-providers.yaml` show up
 * immediately without a restart.
 *
 * Today provider-nodes only fan out from sirius gateways (the
 * `provider: 'sirius'` label in the binding). Future gateway kinds
 * that expose their own upstream catalog (e.g., OpenRouter's
 * `/v1/models` with `owned_by` labels) can opt in by reading their
 * own config source — route through this file so the rest of the
 * stack stays kind-agnostic.
 */

export function synthesizeProviderNodes(
  cfg: Config,
  loadProviders: () => SiriusProvider[] = loadSiriusProviders,
): ClusterNode[] {
  const ctx = cfg.contexts.find((c) => c.name === cfg.currentContext);
  if (!ctx) return [];
  const cluster = cfg.clusters.find((c) => c.name === ctx.cluster);
  if (!cluster) return [];

  const gateways = cluster.nodes.filter(
    (n) => resolveNodeKind(n) === 'gateway' && n.cloud?.provider === 'sirius',
  );
  if (gateways.length === 0) return [];

  let providers: SiriusProvider[];
  try {
    providers = loadProviders();
  } catch {
    return [];
  }

  const virtual: ClusterNode[] = [];
  for (const gw of gateways) {
    for (const p of providers) {
      virtual.push({
        name: `${gw.name}.${p.name}`,
        endpoint: '',
        kind: 'provider',
        provider: {
          gateway: gw.name,
          providerName: p.name,
        },
      });
    }
  }
  return virtual;
}

/**
 * Parse a provider-kind node name (`<gateway>.<provider>`) back into
 * its components. Returns null when the name doesn't match the
 * expected shape — callers treat that as "not a provider node".
 */
export function parseProviderNodeName(name: string): { gateway: string; providerName: string } | null {
  const dot = name.indexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return {
    gateway: name.slice(0, dot),
    providerName: name.slice(dot + 1),
  };
}
