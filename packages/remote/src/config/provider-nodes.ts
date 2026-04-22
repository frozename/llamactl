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
  // NOTE: do not early-return here — the CLI-binding synthesis
  // below emits virtual nodes from agent nodes, independent of
  // whether any gateways exist. The sirius + embersynth blocks
  // below both tolerate an empty `gateways` list.

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

  // CLI subscription backends declared on agent nodes. Same
  // projection shape — one virtual provider-kind node per
  // (agent, cli-binding) pair — but the `provider.source: 'cli'`
  // discriminator tells the factory to build a subprocess adapter
  // instead of an OpenAI-compat one.
  const agentsWithCli = cluster.nodes.filter(
    (n) => resolveNodeKind(n) === 'agent' && (n.cli?.length ?? 0) > 0,
  );
  for (const agent of agentsWithCli) {
    for (const binding of agent.cli ?? []) {
      virtual.push({
        name: `${agent.name}.${binding.name}`,
        endpoint: '',
        kind: 'provider',
        provider: {
          gateway: agent.name,
          providerName: binding.name,
          source: 'cli',
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

/**
 * Find the CLI binding behind a virtual `<agent>.<cli-name>`
 * provider-kind node. Returns the binding + its hosting agent, or
 * null when the node doesn't resolve to a CLI binding (e.g. it's a
 * sirius/embersynth synthesis instead). Consumers use this to
 * decide whether to construct a `CliSubprocessAdapter` or fall
 * back to the default cloud-compat path.
 */
export function findCliBindingForNode(
  cfg: Config,
  nodeName: string,
): { agentName: string; binding: import('./schema.js').CliBinding } | null {
  const parsed = parseProviderNodeName(nodeName);
  if (!parsed) return null;
  const ctx = cfg.contexts.find((c) => c.name === cfg.currentContext);
  if (!ctx) return null;
  const cluster = cfg.clusters.find((c) => c.name === ctx.cluster);
  if (!cluster) return null;
  const agent = cluster.nodes.find(
    (n) => n.name === parsed.gateway && resolveNodeKind(n) === 'agent',
  );
  if (!agent || !agent.cli) return null;
  const binding = agent.cli.find((b) => b.name === parsed.providerName);
  if (!binding) return null;
  return { agentName: agent.name, binding };
}
