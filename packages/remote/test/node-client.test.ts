import { describe, expect, test } from 'bun:test';
import { createNodeClient } from '../src/client/node-client.js';
import { freshConfig } from '../src/config/schema.js';
import { upsertNode as upsertNodeInConfig } from '../src/config/kubeconfig.js';

describe('createNodeClient (local sentinel path)', () => {
  test('local node dispatches in-process via router.createCaller', async () => {
    const cfg = freshConfig();
    const client = createNodeClient(cfg);
    const env = await client.env.query();
    expect(env).toBeDefined();
    expect(typeof env.LOCAL_AI_RUNTIME_DIR).toBe('string');
  });

  test('explicit --node local is equivalent to default', async () => {
    const cfg = freshConfig();
    const client = createNodeClient(cfg, { nodeName: 'local' });
    expect(await client.env.query()).toBeDefined();
  });

  test('unknown nodeName throws', () => {
    const cfg = freshConfig();
    expect(() => createNodeClient(cfg, { nodeName: 'does-not-exist' }))
      .toThrow(/not found/);
  });

  test('resolves remote node definitions without opening a connection yet', () => {
    let cfg = freshConfig();
    cfg = upsertNodeInConfig(cfg, 'home', {
      name: 'gpu1',
      endpoint: 'https://gpu1.lan:7843',
      certificateFingerprint: 'sha256:aa',
    });
    // Client construction for a remote node must not throw just because
    // the host is unreachable — we only connect on first call.
    const client = createNodeClient(cfg, { nodeName: 'gpu1' });
    expect(client).toBeDefined();
  });
});

