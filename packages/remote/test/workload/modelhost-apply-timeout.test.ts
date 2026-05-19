import { describe, expect, test } from 'bun:test';
import { applyManifest, type WorkloadClient } from '../../src/workload/apply.js';

describe('applyManifest — ModelHost timeout cleanup', () => {
  test('unsubscribes the modelHostStart subscription when apply times out', async () => {
    let unsubscribed = false;
    const client: WorkloadClient = {
      serverStatus: {
        query: async () => ({
          state: 'down',
          rel: null,
          extraArgs: [],
          pid: null,
          host: null,
          port: null,
          binary: null,
          endpoint: '',
        }),
      },
      serverStop: { mutate: async () => ({ ok: true }) },
      serverStart: { subscribe: async () => ({ unsubscribe() {} }) },
      modelHostStart: {
        subscribe: () => ({
          unsubscribe: () => {
            unsubscribed = true;
          },
        }),
      },
      modelHostStop: { mutate: async () => ({ ok: true }) },
      modelHostStatus: { query: async () => ({ state: 'Running' }) },
      rpcServerStart: { subscribe: async () => ({ unsubscribe() {} }) },
      rpcServerStop: { mutate: async () => ({ ok: true }) },
      rpcServerDoctor: { query: async () => ({ ok: true, path: null, llamaCppBin: null }) },
    };

    const result = await applyManifest({
      manifest: {
        apiVersion: 'llamactl/v1',
        kind: 'ModelHost',
        metadata: { name: 'mlx-host-timeout' },
        spec: {
          engine: 'omlx',
          node: 'local',
          enabled: true,
          binary: '/usr/bin/true',
          endpoint: { host: '127.0.0.1', port: 18095 },
          hostedModels: [{ rel: 'mlx-community/Test-MLX-4bit' }],
          extraArgs: [],
          restartPolicy: 'Always',
          timeoutSeconds: 1,
        },
      },
      getClient: () => client,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('timed out');
    expect(unsubscribed).toBe(true);
  });
});
