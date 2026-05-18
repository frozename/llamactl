import { describe, expect, mock, test } from 'bun:test';
import { applyManifest, type WorkloadClient } from '../../src/workload/apply.js';

function makeModelRunClient(): WorkloadClient {
  return {
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
    serverStart: {
      subscribe: async (_input, callbacks) => {
        queueMicrotask(() => {
          callbacks.onData({ type: 'done', result: { ok: true, pid: 111, endpoint: 'http://127.0.0.1:18080' } });
          callbacks.onComplete();
        });
        return { unsubscribe() {} };
      },
    },
    rpcServerStart: { subscribe: async () => ({ unsubscribe() {} }) },
    rpcServerStop: { mutate: async () => ({ ok: true }) },
    rpcServerDoctor: { query: async () => ({ ok: true, path: null, llamaCppBin: null }) },
  };
}

describe('applyManifest — kind dispatch', () => {
  test('routes kind:ModelHost manifests to the engine adapter buildBootCommand', async () => {
    const captured: { cmd?: string; args?: string[] } = {};
    const fakeSpawn = mock((cmd: string, args: string[]) => {
      captured.cmd = cmd;
      captured.args = args;
      return { pid: 99999 } as any;
    });

    const manifest = {
      apiVersion: 'llamactl/v1',
      kind: 'ModelHost',
      metadata: { name: 'mlx-host-test' },
      spec: {
        engine: 'omlx',
        node: 'local',
        enabled: true,
        binary: '/usr/bin/true',
        endpoint: { host: '127.0.0.1', port: 18094 },
        hostedModels: [{ rel: 'mlx-community/Test-MLX-4bit' }],
        extraArgs: ['--max-concurrent-requests', '1'],
        restartPolicy: 'Always',
        timeoutSeconds: 60,
      },
    };

    const result = await applyManifest({ manifest, spawn: fakeSpawn as any });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe('ModelHost');
      expect(result.pid).toBe(99999);
      expect(result.endpoint).toBe('http://127.0.0.1:18094');
    }
    expect(captured.cmd).toBe('/usr/bin/true');
    expect(captured.args?.[0]).toBe('serve');
    expect(captured.args).toContain('--port');
    expect(captured.args).toContain('18094');
  });

  test('ModelRun manifests still take the legacy path', async () => {
    const fakeSpawn = mock(() => {
      throw new Error('spawn should not be called for ModelRun manifests');
    });
    const manifest = {
      apiVersion: 'llamactl/v1',
      kind: 'ModelRun',
      metadata: { name: 'modelrun-test', labels: {}, annotations: {} },
      spec: {
        node: 'local',
        enabled: true,
        target: { kind: 'rel', value: 'foo/bar.gguf' },
        extraArgs: [],
        workers: [],
        restartPolicy: 'Always',
        timeoutSeconds: 60,
        gateway: false,
      },
    };

    const result = await applyManifest({
      manifest,
      getClient: () => makeModelRunClient(),
      spawn: fakeSpawn as any,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe('ModelRun');
      expect(result.result.action).toBe('started');
    }
    expect(fakeSpawn).not.toHaveBeenCalled();
  });
});
