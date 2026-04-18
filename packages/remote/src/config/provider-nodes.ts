import { loadSiriusProviders, type SiriusProvider } from './sirius-providers.js';
import { loadEmbersynthConfig, listSyntheticModelIds } from './embersynth.js';
import {
  resolveNodeKind,
  type ClusterNode,
  type Config,
} from './schema.js';

/**
 * Synthesizes `kind: 'provider'` virtual nodes from gateway-specific
 * sources. One virtual node per (gateway, fanout-entry) pair, named
 * `<gateway>.<entry>`.
 *
 * Fanout sources by gateway provider label:
 *
 *   * `sirius`     → `sirius-providers.yaml` entries. One synth node
 *     per registered upstream provider; chat to the synth node hits
 *     sirius with the scoped provider's models.
 *   * `embersynth` → `embersynth.yaml`'s `syntheticModels:` map. One
 *     synth node per synthetic model (e.g., `fusion-auto`,
 *     `fusion-vision`); chat to the synth node hits embersynth with
 *     `model: fusion-<id>` and embersynth routes through the
 *     corresponding profile.
 *
 * Other gateway flavours (plain openai-compatible, OpenRouter, …)
 * are not fanned out yet — users chat with them through the flat
 * model picker on the gateway node itself.
 *
 * Synthesis is pure — no persistence, no caching. Called on every
 * `nodeList` read so edits to the underlying YAML show up
 * immediately without a restart.
 */

export function synthesizeProviderNodes(
  cfg: Config,
  loaders: {
    loadSirius?: () => SiriusProvider[];
    loadEmbersynth?: () => ReturnType<typeof loadEmbersynthConfig>;
  } = {},
): ClusterNode[] {
  const ctx = cfg.contexts.find((c) => c.name === cfg.currentContext);
  if (!ctx) return [];
  const cluster = cfg.clusters.find((c) => c.name === ctx.cluster);
  if (!cluster) return [];

  const gateways = cluster.nodes.filter((n) => resolveNodeKind(n) === 'gateway');
  if (gateways.length === 0) return [];

  const loadSirius = loaders.loadSirius ?? loadSiriusProviders;
  const loadEmbersynth = loaders.loadEmbersynth ?? (() => loadEmbersynthConfig());

  const virtual: ClusterNode[] = [];

  const siriusGateways = gateways.filter((g) => g.cloud?.provider === 'sirius');
  if (siriusGateways.length > 0) {
    let providers: SiriusProvider[] = [];
    try {
      providers = loadSirius();
    } catch {
      providers = [];
    }
    for (const gw of siriusGateways) {
      for (const p of providers) {
        virtual.push({
          name: `${gw.name}.${p.name}`,
          endpoint: '',
          kind: 'provider',
          provider: { gateway: gw.name, providerName: p.name },
        });
      }
    }
  }

  const embersynthGateways = gateways.filter(
    (g) => g.cloud?.provider === 'embersynth',
  );
  if (embersynthGateways.length > 0) {
    let eCfg: ReturnType<typeof loadEmbersynthConfig> = null;
    try {
      eCfg = loadEmbersynth();
    } catch {
      eCfg = null;
    }
    const synthModels = eCfg ? listSyntheticModelIds(eCfg) : [];
    for (const gw of embersynthGateways) {
      for (const m of synthModels) {
        virtual.push({
          name: `${gw.name}.${m}`,
          endpoint: '',
          kind: 'provider',
          provider: { gateway: gw.name, providerName: m },
        });
      }
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
