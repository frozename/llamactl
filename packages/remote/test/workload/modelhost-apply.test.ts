import { describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyManifest, type WorkloadClient } from '../../src/workload/apply.js';
import { reconcileOnce } from '../../src/workload/reconciler.js';
import { listModelHosts, saveModelHost } from '../../src/workload/modelhost-store.js';
import { setWorkloadEnabledWithDeps } from '../../../cli/src/commands/setEnabled.js';
import { readModelHostState, removeModelHostState } from '../../../core/src/engines/state.js';

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
    modelHostStart: { subscribe: async () => ({ unsubscribe() {} }) },
    modelHostStop: { mutate: async () => ({ ok: true }) },
    modelHostStatus: { query: async () => ({ state: 'Running' }) },
    rpcServerStart: { subscribe: async () => ({ unsubscribe() {} }) },
    rpcServerStop: { mutate: async () => ({ ok: true }) },
    rpcServerDoctor: { query: async () => ({ ok: true, path: null, llamaCppBin: null }) },
  };
}

describe('applyManifest — kind dispatch', () => {
  test('applyOneModelHost persists status and uses node dispatch client methods', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-modelhost-'));
    const captured: { spawnCalls: number; startInput?: unknown; statusCalls: number } = {
      spawnCalls: 0,
      statusCalls: 0,
    };
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
        subscribe: async (input, callbacks) => {
          captured.startInput = input;
          queueMicrotask(() => {
            callbacks.onData({ type: 'done', result: { ok: true } });
            callbacks.onComplete();
          });
          return { unsubscribe() {} };
        },
      },
      modelHostStop: { mutate: async () => ({ ok: true }) },
      modelHostStatus: {
        query: async () => {
          captured.statusCalls += 1;
          return { state: 'Running', pid: 3333 };
        },
      },
      rpcServerStart: { subscribe: async () => ({ unsubscribe() {} }) },
      rpcServerStop: { mutate: async () => ({ ok: true }) },
      rpcServerDoctor: { query: async () => ({ ok: true, path: null, llamaCppBin: null }) },
    };
    const fakeSpawn = mock(() => {
      captured.spawnCalls += 1;
      return { pid: 99999 } as any;
    });

    const manifest = {
      apiVersion: 'llamactl/v1',
      kind: 'ModelHost',
      metadata: { name: 'mlx-host-test' },
      spec: {
        engine: 'omlx',
        node: 'mac-mini',
        enabled: true,
        binary: '/usr/bin/true',
        endpoint: { host: '127.0.0.1', port: 18094 },
        hostedModels: [{ rel: 'mlx-community/Test-MLX-4bit' }],
        extraArgs: ['--max-concurrent-requests', '1'],
        restartPolicy: 'Always',
        timeoutSeconds: 60,
      },
    };

    try {
      const result = await applyManifest({
        manifest,
        getClient: () => client,
        spawn: fakeSpawn as any,
        env: { ...process.env, LOCAL_AI_RUNTIME_DIR: tmp },
      });

      expect(fakeSpawn).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.kind).toBe('ModelHost');
      expect(result.pid).toBe(3333);
      expect(result.manifest.status.phase).toBe('Running');
      expect(captured.spawnCalls).toBe(0);
      expect(captured.statusCalls).toBe(1);
      expect(captured.startInput).toEqual({
        workload: 'mlx-host-test',
        target: 'mlx-community/Test-MLX-4bit',
        extraArgs: ['--max-concurrent-requests', '1'],
        endpoint: { host: '127.0.0.1', port: 18094 },
        binary: '/usr/bin/true',
        timeoutSeconds: 60,
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
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

  test('smoke flow: apply ModelHost, list it, disable it, then reconcile after kill -9', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-modelhost-smoke-'));
    const workloadsDir = join(tmp, 'workloads');
    const runtimeDir = join(tmp, 'runtime');
    const fakeBinary = join(tmp, 'omlx');
    const previousRuntimeDir = process.env.LOCAL_AI_RUNTIME_DIR;
    const runtimeEnv = { ...process.env, LOCAL_AI_RUNTIME_DIR: runtimeDir };

    let pid = 4242;
    const client: WorkloadClient = {
      serverStatus: {
        query: async () => ({
          state: readModelHostState({ name: 'mlx-host-smoke' }, runtimeEnv) ? 'up' : 'down',
          rel: null,
          extraArgs: [],
          pid: readModelHostState({ name: 'mlx-host-smoke' }, runtimeEnv)?.pid ?? null,
          host: '127.0.0.1',
          port: 8094,
          binary: '/tmp/omlx',
          endpoint: 'http://127.0.0.1:8094',
        }),
      },
      serverStop: {
        mutate: async () => {
          removeModelHostState({ name: 'mlx-host-smoke' }, { runtimeDir });
          return { ok: true };
        },
      },
      serverStart: { subscribe: async () => ({ unsubscribe() {} }) },
      modelHostStart: {
        subscribe: async (_input, callbacks) => {
          queueMicrotask(() => {
            callbacks.onData({ type: 'done', result: { ok: true, pid: pid++, endpoint: 'http://127.0.0.1:8094' } });
            callbacks.onComplete();
          });
          return { unsubscribe() {} };
        },
      },
      modelHostStop: {
        mutate: async () => {
          removeModelHostState({ name: 'mlx-host-smoke' }, runtimeEnv);
          return { ok: true };
        },
      },
      modelHostStatus: {
        query: async () => ({
          state: readModelHostState({ name: 'mlx-host-smoke' }, runtimeEnv) ? 'Running' : 'Stopped',
          pid: readModelHostState({ name: 'mlx-host-smoke' }, runtimeEnv)?.pid ?? null,
        }),
      },
      rpcServerStart: { subscribe: async () => ({ unsubscribe() {} }) },
      rpcServerStop: { mutate: async () => ({ ok: true }) },
      rpcServerDoctor: { query: async () => ({ ok: true, path: null, llamaCppBin: null }) },
    };

    const manifest = {
      apiVersion: 'llamactl/v1',
      kind: 'ModelHost',
      metadata: { name: 'mlx-host-smoke' },
      spec: {
        engine: 'omlx',
        node: 'local',
        enabled: true,
        binary: fakeBinary,
        endpoint: { host: '127.0.0.1', port: 8094 },
        hostedModels: [{ rel: 'mlx-community/Qwen3-8B-MLX-4bit' }],
        extraArgs: [],
        restartPolicy: 'Always',
        timeoutSeconds: 60,
      },
    };

    try {
      process.env.LOCAL_AI_RUNTIME_DIR = runtimeDir;
      await Bun.write(fakeBinary, '');

      const applied = await applyManifest({
        manifest,
        workloadsDir,
        env: { ...process.env, LOCAL_AI_RUNTIME_DIR: runtimeDir },
        getClient: () => client,
      });

      expect(applied.ok).toBe(true);
      if (!applied.ok) return;

      saveModelHost(manifest, workloadsDir);

      expect(listModelHosts(workloadsDir).map((m) => m.metadata.name)).toEqual(['mlx-host-smoke']);

      const disabled = await setWorkloadEnabledWithDeps('mlx-host-smoke', false, {
        loadModelHostByName: (name: string) => {
          const found = listModelHosts(workloadsDir).find((m) => m.metadata.name === name);
          if (!found) throw new Error(`missing modelhost ${name}`);
          return found;
        },
        saveModelHost: (m) => saveModelHost(m, workloadsDir),
        getNodeClientByName: () => client,
      });
      expect(disabled.code).toBe(0);
      expect(readModelHostState({ name: 'mlx-host-smoke' }, runtimeEnv)).toBeNull();

      removeModelHostState({ name: 'mlx-host-smoke' }, runtimeEnv);

      const reconciled = await reconcileOnce({
        workloadsDir,
        getClient: () => client,
      });

      expect(reconciled.errors).toBe(0);
      expect(reconciled.reports.find((r) => r.name === 'mlx-host-smoke')?.action).toBeOneOf(['started', 'restarted']);
    } finally {
      if (previousRuntimeDir === undefined) delete process.env.LOCAL_AI_RUNTIME_DIR;
      else process.env.LOCAL_AI_RUNTIME_DIR = previousRuntimeDir;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
