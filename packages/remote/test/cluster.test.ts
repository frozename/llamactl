import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { makeCluster, type Cluster } from './helpers.js';

describe('makeCluster', () => {
  let cluster: Cluster;

  beforeEach(async () => {
    cluster = await makeCluster({ nodes: 2 });
  });
  afterEach(async () => {
    await cluster.cleanup();
  });

  test('spawns N independent agents on random ports', () => {
    expect(cluster.nodes).toHaveLength(2);
    const ports = cluster.nodes.map((n) => n.port);
    expect(new Set(ports).size).toBe(2);
    for (const n of cluster.nodes) {
      expect(n.url.startsWith('https://')).toBe(true);
      expect(n.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  test('each client reaches its own agent for env query', async () => {
    for (const n of cluster.nodes) {
      const env = await n.client.env.query();
      expect(env).toBeDefined();
      expect(typeof env.LOCAL_AI_RUNTIME_DIR).toBe('string');
    }
  });

  test('each client reaches its own agent for nodeFacts query', async () => {
    for (const n of cluster.nodes) {
      const facts = await n.client.nodeFacts.query();
      expect(facts).toBeDefined();
      expect(typeof facts.nodeName).toBe('string');
      expect(typeof facts.platform).toBe('string');
    }
  });

  test('cluster config lists both nodes plus local', async () => {
    const { config: kubecfg } = await import('../src/index.js');
    const cfg = kubecfg.loadConfig(cluster.clusterConfigPath);
    const names = cfg.clusters
      .find((c) => c.name === 'home')
      ?.nodes.map((n) => n.name)
      .sort();
    expect(names).toEqual(['local', 'node1', 'node2']);
  });

  test('each agent has a unique fingerprint', () => {
    const fps = cluster.nodes.map((n) => n.fingerprint);
    expect(new Set(fps).size).toBe(fps.length);
  });

  test('named node spec is honored', async () => {
    const c = await makeCluster({ nodes: [{ name: 'alpha' }, { name: 'beta' }] });
    try {
      expect(c.nodes.map((n) => n.name)).toEqual(['alpha', 'beta']);
    } finally {
      await c.cleanup();
    }
  });
});
