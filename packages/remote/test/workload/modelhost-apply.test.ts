import { describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENGINES } from '../../../core/src/engines/index.js';
import { readModelHostState } from '../../../core/src/engines/state.js';
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
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-modelhost-'));
    const env = { ...process.env, LOCAL_AI_RUNTIME_DIR: tmp };
    const fakeSpawn = mock((cmd: string, args: string[]) => {
      captured.cmd = cmd;
      captured.args = args;
      return { pid: 99999 } as any;
    });
    const originalProbeReady = ENGINES.omlx.probeReady;
    ENGINES.omlx.probeReady = async () => ({ ready: true, modelIds: ['mlx-community/Test-MLX-4bit'] });

    try {
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

      const result = await applyManifest({ manifest, spawn: fakeSpawn as any, env });
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
    } finally {
      ENGINES.omlx.probeReady = originalProbeReady;
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
  });

  test('rejects ModelHost manifests targeting non-local nodes', async () => {
    const manifest = {
      apiVersion: 'llamactl/v1',
      kind: 'ModelHost',
      metadata: { name: 'remote-node-test' },
      spec: {
        engine: 'omlx',
        node: 'mac-mini',
        enabled: true,
        binary: '/usr/bin/true',
        endpoint: { host: '127.0.0.1', port: 18095 },
        hostedModels: [{ rel: 'mlx-community/Test-MLX-4bit' }],
        extraArgs: [],
        restartPolicy: 'Always',
        timeoutSeconds: 60,
      },
    };

    const result = await applyManifest({ manifest, spawn: mock(() => ({ pid: 99999 } as any)) as any });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/local nodes only/i);
  });

  test('waits for ModelHost readiness before reporting success', async () => {
    const fakeSpawn = mock(() => {
      const listeners: Record<string, Array<(...args: any[]) => void>> = {};
      return {
        pid: 4242,
        once(event: string, cb: (...args: any[]) => void) {
          listeners[event] ??= [];
          listeners[event].push(cb);
          if (event === 'exit') {
            queueMicrotask(() => {
              for (const listener of listeners.exit ?? []) listener(1, null);
            });
          }
          return this;
        },
      } as any;
    });

    const manifest = {
      apiVersion: 'llamactl/v1',
      kind: 'ModelHost',
      metadata: { name: 'crash-before-ready-test' },
      spec: {
        engine: 'omlx',
        node: 'local',
        enabled: true,
        binary: '/usr/bin/true',
        endpoint: { host: '127.0.0.1', port: 18096 },
        hostedModels: [{ rel: 'mlx-community/Test-MLX-4bit' }],
        extraArgs: [],
        restartPolicy: 'Always',
        timeoutSeconds: 2,
      },
    };

    const result = await applyManifest({ manifest, spawn: fakeSpawn as any });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/exited before readiness/i);
  });

  test('writes modelhost.state sidecar after readiness passes', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-modelhost-'));
    const env = { ...process.env, LOCAL_AI_RUNTIME_DIR: tmp };
    const originalProbeReady = ENGINES.omlx.probeReady;
    ENGINES.omlx.probeReady = async () => ({ ready: true, modelIds: ['mlx-community/Test-MLX-4bit'] });

    try {
      const manifest = {
        apiVersion: 'llamactl/v1',
        kind: 'ModelHost',
        metadata: { name: 'mlx-host-test-write' },
        spec: {
          engine: 'omlx',
          node: 'local',
          enabled: true,
          binary: '/usr/bin/true',
          endpoint: { host: '127.0.0.1', port: 18097 },
          hostedModels: [{ rel: 'mlx-community/Test-MLX-4bit' }],
          extraArgs: [],
          restartPolicy: 'Always',
          timeoutSeconds: 5,
        },
      };

      const result = await applyManifest({
        manifest,
        spawn: mock(() => ({ pid: 4242 } as any)) as any,
        env,
      });
      expect(result.ok).toBe(true);

      const state = readModelHostState({ name: 'mlx-host-test-write' }, { LOCAL_AI_RUNTIME_DIR: tmp } as any);
      expect(state).not.toBeNull();
      expect(state?.pid).toBe(4242);
      expect(state?.engine).toBe('omlx');
      expect(state?.modelAliases).toContain('mlx-community/Test-MLX-4bit');
      expect(state?.modelAliases).toContain('Test-MLX-4bit');
      expect(existsSync(join(tmp, 'workloads', 'mlx-host-test-write', 'modelhost.pid'))).toBe(true);
    } finally {
      ENGINES.omlx.probeReady = originalProbeReady;
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
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
