import { describe, expect, test } from 'bun:test';
import { freshConfig, type Config } from '../src/config/schema.js';
import {
  parseProviderNodeName,
  synthesizeProviderNodes,
} from '../src/config/provider-nodes.js';
import type { SiriusProvider } from '../src/config/sirius-providers.js';
import {
  DEFAULT_EMBERSYNTH_PROFILES,
  EmbersynthConfigSchema,
} from '../src/config/embersynth.js';

/**
 * Provider-kind nodes are virtual — synthesized from
 * (gateway × sirius-providers.yaml) on every `nodeList` read. Tests
 * cover both halves and the name-parser round-trip.
 */

function cfgWithSiriusGateway(): Config {
  const base = freshConfig();
  return {
    ...base,
    clusters: base.clusters.map((c) =>
      c.name === 'home'
        ? {
            ...c,
            nodes: [
              ...c.nodes,
              {
                name: 'sirius',
                endpoint: '',
                kind: 'gateway',
                cloud: {
                  provider: 'sirius',
                  baseUrl: 'http://localhost:3000/v1',
                },
              },
            ],
          }
        : c,
    ),
  };
}

const SAMPLE_PROVIDERS: SiriusProvider[] = [
  {
    name: 'openai',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyRef: '$OPENAI_API_KEY',
  },
  {
    name: 'anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKeyRef: '$ANTHROPIC_API_KEY',
  },
];

describe('provider-nodes', () => {
  test('synthesizeProviderNodes emits one node per (gateway, provider) pair', () => {
    const cfg = cfgWithSiriusGateway();
    const nodes = synthesizeProviderNodes(cfg, { loadSirius: () => SAMPLE_PROVIDERS });
    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.name)).toEqual(['sirius.openai', 'sirius.anthropic']);
    for (const n of nodes) {
      expect(n.kind).toBe('provider');
      expect(n.provider?.gateway).toBe('sirius');
    }
  });

  test('synthesizeProviderNodes returns empty when there are no sirius gateways', () => {
    const cfg = freshConfig();
    const nodes = synthesizeProviderNodes(cfg, { loadSirius: () => SAMPLE_PROVIDERS });
    expect(nodes).toEqual([]);
  });

  test('synthesizeProviderNodes is empty when sirius-providers.yaml is empty', () => {
    const cfg = cfgWithSiriusGateway();
    const nodes = synthesizeProviderNodes(cfg, { loadSirius: () => [] });
    expect(nodes).toEqual([]);
  });

  test('synthesizeProviderNodes survives a thrown loader (fail-soft)', () => {
    const cfg = cfgWithSiriusGateway();
    const nodes = synthesizeProviderNodes(cfg, {
      loadSirius: () => {
        throw new Error('yaml broken');
      },
    });
    expect(nodes).toEqual([]);
  });

  test('parseProviderNodeName round-trips a dotted name', () => {
    expect(parseProviderNodeName('sirius.openai')).toEqual({
      gateway: 'sirius',
      providerName: 'openai',
    });
    expect(parseProviderNodeName('sirius')).toBeNull();
    expect(parseProviderNodeName('.openai')).toBeNull();
    expect(parseProviderNodeName('sirius.')).toBeNull();
  });

  test('embersynth gateways fan out via syntheticModels', () => {
    const base = freshConfig();
    const cfg: Config = {
      ...base,
      clusters: base.clusters.map((c) =>
        c.name === 'home'
          ? {
              ...c,
              nodes: [
                ...c.nodes,
                {
                  name: 'ember',
                  endpoint: '',
                  kind: 'gateway',
                  cloud: {
                    provider: 'embersynth',
                    baseUrl: 'http://localhost:7777/v1',
                  },
                },
              ],
            }
          : c,
      ),
    };
    const ecfg = EmbersynthConfigSchema.parse({
      nodes: [],
      profiles: DEFAULT_EMBERSYNTH_PROFILES,
      syntheticModels: {
        'fusion-auto': 'auto',
        'fusion-vision': 'vision',
      },
    });
    const nodes = synthesizeProviderNodes(cfg, { loadEmbersynth: () => ecfg });
    expect(nodes.map((n) => n.name).sort()).toEqual([
      'ember.fusion-auto',
      'ember.fusion-vision',
    ]);
    for (const n of nodes) {
      expect(n.kind).toBe('provider');
      expect(n.provider?.gateway).toBe('ember');
    }
  });

  test('fans out across multiple gateways', () => {
    const cfg = cfgWithSiriusGateway();
    const multiGw: Config = {
      ...cfg,
      clusters: cfg.clusters.map((c) =>
        c.name === 'home'
          ? {
              ...c,
              nodes: [
                ...c.nodes,
                {
                  name: 'sirius-staging',
                  endpoint: '',
                  kind: 'gateway',
                  cloud: {
                    provider: 'sirius',
                    baseUrl: 'http://staging:3000/v1',
                  },
                },
              ],
            }
          : c,
      ),
    };
    const nodes = synthesizeProviderNodes(multiGw, {
      loadSirius: () => SAMPLE_PROVIDERS,
    });
    expect(nodes.map((n) => n.name).sort()).toEqual([
      'sirius-staging.anthropic',
      'sirius-staging.openai',
      'sirius.anthropic',
      'sirius.openai',
    ]);
  });
});
