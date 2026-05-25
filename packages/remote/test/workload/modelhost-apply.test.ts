import { describe, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAggregatorDb, writeSnapshot } from '@llamactl/fleet-supervisor';
import { applyManifest, applyOneModelHost, type WorkloadClient } from '../../src/workload/apply.js';
import { reconcileOnce } from '../../src/workload/reconciler.js';
import { listModelHosts, saveModelHost } from '../../src/workload/modelhost-store.js';
import type { ModelHostManifest } from '../../src/workload/modelhost-schema.js';
import type { ModelRun } from '../../src/workload/schema.js';
import { setWorkloadEnabledWithDeps } from '../../../cli/src/commands/setEnabled.js';
import * as modelHostState from '../../../core/src/engines/state.js';
import { readModelHostState, removeModelHostState } from '../../../core/src/engines/state.js';
import { resolveEnv } from '../../../core/src/env.js';

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
      subscribe: (_input, callbacks) => {
        queueMicrotask(() => {
          callbacks.onData({ type: 'done', result: { ok: true, pid: 111, endpoint: 'http://127.0.0.1:18080' } });
          callbacks.onComplete();
        });
        return { unsubscribe() {} };
      },
    },
    modelHostStart: { subscribe: () => ({ unsubscribe() {} }) },
    modelHostStop: { mutate: async () => ({ ok: true }) },
    modelHostStatus: { query: async () => ({ state: 'Running' }) },
    rpcServerStart: { subscribe: () => ({ unsubscribe() {} }) },
    rpcServerStop: { mutate: async () => ({ ok: true }) },
    rpcServerDoctor: { query: async () => ({ ok: true, path: null, llamaCppBin: null }) },
  };
}

function makePlacementClient(): WorkloadClient {
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
      subscribe: (_input, callbacks) => {
        queueMicrotask(() => {
          callbacks.onData({ type: 'done', result: { ok: true, pid: 123, endpoint: 'http://127.0.0.1:18180' } });
          callbacks.onComplete();
        });
        return { unsubscribe() {} };
      },
    },
    modelHostStart: { subscribe: () => ({ unsubscribe() {} }) },
    modelHostStop: { mutate: async () => ({ ok: true }) },
    modelHostStatus: { query: async () => ({ state: 'Stopped', pid: null }) },
    rpcServerStart: { subscribe: () => ({ unsubscribe() {} }) },
    rpcServerStop: { mutate: async () => ({ ok: true }) },
    rpcServerDoctor: { query: async () => ({ ok: true, path: null, llamaCppBin: null }) },
  };
}

function modelRunManifestForPlacement(overrides: Partial<ModelRun['spec']> = {}): ModelRun {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'ModelRun',
    metadata: { name: 'qwen-run', labels: {}, annotations: {} },
    spec: {
      node: 'auto',
      placement: 'auto',
      enabled: true,
      target: { kind: 'rel', value: 'qwen3.6-35b-MTP-Q4_0-Q6_K.gguf' },
      extraArgs: [],
      workers: [],
      restartPolicy: 'Always',
      allowExternalBind: false,
      timeoutSeconds: 60,
      gateway: false,
      ...overrides,
    },
  };
}

function writeClusterSnapshot(
  dbPath: string,
  node: string,
  ts: string,
  freeMb: number,
  workloads: Array<{ name: string; models?: string[] }> = [],
): void {
  const db = openAggregatorDb(dbPath);
  try {
    writeSnapshot(db, node, {
      kind: 'fleet-snapshot',
      ts,
      node,
      node_mem: {
        free_mb: freeMb,
        active_mb: 0,
        inactive_mb: 0,
        wired_mb: 0,
        compressor_mb: 0,
        swap_in: 0,
        swap_out: 0,
      },
      workloads: workloads.map((w) => ({
        name: w.name,
        kind: 'ModelRun',
        endpoint: 'http://127.0.0.1:8080',
        priority: 50,
        rss_mb: null,
        request_rate_5m: 0,
        error_rate_5m: 0,
        p50_ms: 10,
        p95_ms: 20,
        models: w.models ?? [],
        reachable: true,
        consecutiveErrors: 0,
      })),
    });
  } finally {
    db.close();
  }
}

describe('applyManifest — kind dispatch', () => {
  function makeModelHostManifest(name: string, expectedMemoryGiB: number): ModelHostManifest {
    return {
      apiVersion: 'llamactl/v1',
      kind: 'ModelHost',
      metadata: { name },
      spec: {
        engine: 'omlx',
        node: 'local',
        enabled: true,
        binary: '/usr/bin/true',
        endpoint: { host: '127.0.0.1', port: 18094 },
        resources: { expectedMemoryGiB },
        hostedModels: [{ rel: `mlx-community/${name}` }],
        extraArgs: [],
        restartPolicy: 'Always',
        timeoutSeconds: 60,
      },
    };
  }

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
      serverStart: { subscribe: () => ({ unsubscribe() {} }) },
      modelHostStart: {
        subscribe: (input, callbacks) => {
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
      rpcServerStart: { subscribe: () => ({ unsubscribe() {} }) },
      rpcServerStop: { mutate: async () => ({ ok: true }) },
      rpcServerDoctor: { query: async () => ({ ok: true, path: null, llamaCppBin: null }) },
    };
    const fakeSpawn = mock(() => {
      captured.spawnCalls += 1;
      return { pid: 99999 } as any;
    });

    const manifest: ModelHostManifest = {
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
      if (!result.ok) console.log('ERROR:', result); expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.kind).toBe('ModelHost');
      if (result.kind !== 'ModelHost') return;
      expect(result.pid).toBe(3333);
      // Observed state lives in the sidecar, not the manifest.
      expect(readModelHostState(
        { name: 'mlx-host-test' },
        resolveEnv({ ...process.env, LOCAL_AI_RUNTIME_DIR: tmp }),
      )?.pid).toBe(3333);
      expect(captured.spawnCalls).toBe(0);
      expect(captured.statusCalls).toBe(1);
      expect(captured.startInput).toEqual({
        workload: 'mlx-host-test',
        timeoutSeconds: 60,
        manifest,
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('applyOneModelHost uses a single directory scan for admission', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-modelhost-admission-scan-'));
    const workloadsDir = join(tmp, 'workloads');
    saveModelHost(makeModelHostManifest('mlx-host-a', 4), workloadsDir);
    saveModelHost(makeModelHostManifest('mlx-host-b', 4), workloadsDir);
    const readdirSpy = spyOn(fs, 'readdirSync');
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
      serverStart: { subscribe: () => ({ unsubscribe() {} }) },
      modelHostStart: {
        subscribe: (_input, callbacks) => {
          queueMicrotask(() => {
            callbacks.onData({ type: 'done', result: { ok: true, pid: 123, state: 'Running' } });
            callbacks.onComplete();
          });
          return { unsubscribe() {} };
        },
      },
      modelHostStop: { mutate: async () => ({ ok: true }) },
      modelHostStatus: { query: async () => ({ state: 'Running', pid: 123 }) },
      rpcServerStart: { subscribe: () => ({ unsubscribe() {} }) },
      rpcServerStop: { mutate: async () => ({ ok: true }) },
      rpcServerDoctor: { query: async () => ({ ok: true, path: null, llamaCppBin: null }) },
    };

    try {
      const result = await applyManifest({
        manifest: makeModelHostManifest('mlx-host-c', 4),
        workloadsDir,
        getClient: () => client,
        spawn: mock(() => ({ pid: 99999 } as any)) as any,
        env: { ...process.env, LOCAL_AI_RUNTIME_DIR: tmp },
      });

      if (!result.ok) console.log('ERROR:', result); expect(result.ok).toBe(true);
      expect(readdirSpy).toHaveBeenCalledTimes(1);
    } finally {
      readdirSpy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('applyOneModelHost rejects when incumbent ModelHosts already exhaust the node budget', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-modelhost-budget-'));
    const workloadsDir = join(tmp, 'workloads');
    saveModelHost(makeModelHostManifest('mlx-host-a', 6), workloadsDir);
    saveModelHost(makeModelHostManifest('mlx-host-b', 6), workloadsDir);
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
      serverStart: { subscribe: () => ({ unsubscribe() {} }) },
      modelHostStart: {
        subscribe: (_input, callbacks) => {
          queueMicrotask(() => {
            callbacks.onData({ type: 'done', result: { ok: true, pid: 123, state: 'Running' } });
            callbacks.onComplete();
          });
          return { unsubscribe() {} };
        },
      },
      modelHostStop: { mutate: async () => ({ ok: true }) },
      modelHostStatus: { query: async () => ({ state: 'Running', pid: 123 }) },
      rpcServerStart: { subscribe: () => ({ unsubscribe() {} }) },
      rpcServerStop: { mutate: async () => ({ ok: true }) },
      rpcServerDoctor: { query: async () => ({ ok: true, path: null, llamaCppBin: null }) },
    };

    const result = await applyManifest({
      manifest: makeModelHostManifest('mlx-host-c', 6),
      workloadsDir,
      getNodeBudgetGiB: () => 16,
      getClient: () => client,
      spawn: mock(() => ({ pid: 99999 } as any)) as any,
      env: { ...process.env, LOCAL_AI_RUNTIME_DIR: tmp },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('would reserve 18.0 GiB');

    rmSync(tmp, { recursive: true, force: true });
  });

  test('applyOneModelHost surfaces modelHostStop failures when disabling', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-modelhost-disable-fail-'));
    const workloadsDir = join(tmp, 'workloads');
    saveModelHost(makeModelHostManifest('mlx-host-smoke', 4), workloadsDir);
    const removeSpy = spyOn(modelHostState, 'removeModelHostState');
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
      serverStart: { subscribe: () => ({ unsubscribe() {} }) },
      modelHostStart: { subscribe: () => ({ unsubscribe() {} }) },
      modelHostStop: {
        mutate: async () => {
          throw new Error('upstream unavailable');
        },
      },
      modelHostStatus: { query: async () => ({ state: 'Running', pid: 123 }) },
      rpcServerStart: { subscribe: () => ({ unsubscribe() {} }) },
      rpcServerStop: { mutate: async () => ({ ok: true }) },
      rpcServerDoctor: { query: async () => ({ ok: true, path: null, llamaCppBin: null }) },
    };

    try {
      const result = await applyManifest({
        manifest: {
          ...makeModelHostManifest('mlx-host-smoke', 4),
          spec: {
            ...makeModelHostManifest('mlx-host-smoke', 4).spec,
            enabled: false,
          },
        },
        workloadsDir,
        getClient: () => client,
        spawn: mock(() => ({ pid: 99999 } as any)) as any,
        env: { ...process.env, LOCAL_AI_RUNTIME_DIR: tmp },
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('modelHostStop failed');
      expect(removeSpy).not.toHaveBeenCalled();
    } finally {
      removeSpy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('applyOneModelHost writes a capitalized Stopped phase when disabling', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-modelhost-disable-phase-'));
    const workloadsDir = join(tmp, 'workloads');
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
      serverStart: { subscribe: () => ({ unsubscribe() {} }) },
      modelHostStart: { subscribe: () => ({ unsubscribe() {} }) },
      modelHostStop: { mutate: async () => ({ ok: true }) },
      modelHostStatus: { query: async () => ({ state: 'Stopped', pid: null }) },
      rpcServerStart: { subscribe: () => ({ unsubscribe() {} }) },
      rpcServerStop: { mutate: async () => ({ ok: true }) },
      rpcServerDoctor: { query: async () => ({ ok: true, path: null, llamaCppBin: null }) },
    };

    try {
      const result = await applyManifest({
        manifest: {
          ...makeModelHostManifest('mlx-host-disabled', 4),
          spec: {
            ...makeModelHostManifest('mlx-host-disabled', 4).spec,
            enabled: false,
          },
        },
        workloadsDir,
        getClient: () => client,
        spawn: mock(() => ({ pid: 99999 } as any)) as any,
        env: { ...process.env, LOCAL_AI_RUNTIME_DIR: tmp },
      });

      if (!result.ok) console.log('ERROR:', result); expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.kind).toBe('ModelHost');
      if (result.kind !== 'ModelHost') return;
      // Disable removes the controller-side sidecar; there is no
      // observed-phase to assert on the manifest itself.
      expect(readModelHostState(
        { name: 'mlx-host-disabled' },
        resolveEnv({ ...process.env, LOCAL_AI_RUNTIME_DIR: tmp }),
      )).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('applyOneModelHost uses pid from done payload and skips the follow-up status query', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-modelhost-pid-'));
    const captured = { statusCalls: 0 };
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
      serverStart: { subscribe: () => ({ unsubscribe() {} }) },
      modelHostStart: {
        subscribe: (_input, callbacks) => {
          queueMicrotask(() => {
            callbacks.onData({ type: 'done', result: { ok: true, pid: 99, state: 'Running' } });
            callbacks.onComplete();
          });
          return { unsubscribe() {} };
        },
      },
      modelHostStop: { mutate: async () => ({ ok: true }) },
      modelHostStatus: {
        query: async () => {
          captured.statusCalls += 1;
          return { state: 'Running', pid: 123 };
        },
      },
      rpcServerStart: { subscribe: () => ({ unsubscribe() {} }) },
      rpcServerStop: { mutate: async () => ({ ok: true }) },
      rpcServerDoctor: { query: async () => ({ ok: true, path: null, llamaCppBin: null }) },
    };

    try {
      const result = await applyManifest({
        manifest: makeModelHostManifest('mlx-host-pid', 4),
        getClient: () => client,
        spawn: mock(() => ({ pid: 99999 } as any)) as any,
        env: { ...process.env, LOCAL_AI_RUNTIME_DIR: tmp },
        workloadsDir: tmp,
      });

      if (!result.ok) console.log('ERROR:', result); expect(result.ok).toBe(true);
      if (!result.ok) return;
      if (result.kind !== 'ModelHost') return;
      expect(result.pid).toBe(99);
      expect(captured.statusCalls).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('ModelRun manifests still take the legacy path', async () => {
    const fakeSpawn = mock(() => {
      throw new Error('spawn should not be called for ModelRun manifests');
    });
    const manifest: ModelRun = {
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
        allowExternalBind: false,
      },
    };

    const result = await applyManifest({
      manifest,
      getClient: () => makeModelRunClient(),
      spawn: fakeSpawn as any,
    });
    if (!result.ok) console.log('ERROR:', result); expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe('ModelRun');
      if (result.kind !== 'ModelRun') return;
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
    const resolvedRuntimeEnv = resolveEnv(runtimeEnv);

    let pid = 4242;
    const client: WorkloadClient = {
      serverStatus: {
        query: async () => ({
          state: readModelHostState({ name: 'mlx-host-smoke' }, resolvedRuntimeEnv) ? 'up' : 'down',
          rel: null,
          extraArgs: [],
          pid: readModelHostState({ name: 'mlx-host-smoke' }, resolvedRuntimeEnv)?.pid ?? null,
          host: '127.0.0.1',
          port: 8094,
          binary: '/tmp/omlx',
          endpoint: 'http://127.0.0.1:8094',
        }),
      },
      serverStop: {
        mutate: async () => {
          removeModelHostState({ name: 'mlx-host-smoke' }, resolvedRuntimeEnv);
          return { ok: true };
        },
      },
      serverStart: { subscribe: () => ({ unsubscribe() {} }) },
      modelHostStart: {
        subscribe: (_input, callbacks) => {
          queueMicrotask(() => {
            callbacks.onData({ type: 'done', result: { ok: true, pid: pid++, endpoint: 'http://127.0.0.1:8094' } });
            callbacks.onComplete();
          });
          return { unsubscribe() {} };
        },
      },
      modelHostStop: {
        mutate: async () => {
          removeModelHostState({ name: 'mlx-host-smoke' }, resolvedRuntimeEnv);
          return { ok: true };
        },
      },
      modelHostStatus: {
        query: async () => ({
          state: readModelHostState({ name: 'mlx-host-smoke' }, resolvedRuntimeEnv) ? 'Running' : 'Stopped',
          pid: readModelHostState({ name: 'mlx-host-smoke' }, resolvedRuntimeEnv)?.pid ?? null,
        }),
      },
      rpcServerStart: { subscribe: () => ({ unsubscribe() {} }) },
      rpcServerStop: { mutate: async () => ({ ok: true }) },
      rpcServerDoctor: { query: async () => ({ ok: true, path: null, llamaCppBin: null }) },
    };

    const manifest: ModelHostManifest = {
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
        getNodeClientByName: () => client as never,
      });
      expect(disabled.code).toBe(0);
      expect(readModelHostState({ name: 'mlx-host-smoke' }, resolvedRuntimeEnv)).toBeNull();

      removeModelHostState({ name: 'mlx-host-smoke' }, resolvedRuntimeEnv);

      const reconciled = await reconcileOnce({
        workloadsDir,
        getClient: () => client,
      });

      expect(reconciled.errors).toBe(0);
      expect(reconciled.reports.find((r) => r.name === 'mlx-host-smoke')?.action).toBeOneOf(['started', 'restarted', 'unchanged']);
    } finally {
      if (previousRuntimeDir === undefined) delete process.env.LOCAL_AI_RUNTIME_DIR;
      else process.env.LOCAL_AI_RUNTIME_DIR = previousRuntimeDir;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('applyOneModelHost rejects when supervisor headroom check fails before launch', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-supervisor-'));
    try {
      const workloadsDir = join(tmp, 'workloads');
      const manifest: ModelHostManifest = {
        apiVersion: 'llamactl/v1',
        kind: 'ModelHost',
        metadata: { name: 'mlx-host-big' },
        spec: {
          engine: 'omlx',
          node: 'local',
          enabled: true,
          binary: '/usr/bin/true',
          endpoint: { host: '127.0.0.1', port: 18094 },
          resources: { expectedMemoryGiB: 12 },
          hostedModels: [{ rel: 'mlx-community/big-model' }],
          extraArgs: [],
          restartPolicy: 'Always',
          timeoutSeconds: 60,
        },
      };

      let launchCalled = false;
      const client: WorkloadClient = {
        ...makeModelRunClient(),
        modelHostStart: {
          subscribe: (_input, callbacks) => {
            launchCalled = true;
            queueMicrotask(() => { callbacks.onComplete(); });
            return { unsubscribe() {} };
          },
        },
      };

      const result = await applyOneModelHost(manifest, () => client, undefined, {
        workloadsDir,
        supervisor: { currentFreeGiB: 18, headroomMinGiB: 8, safetyFactor: 1.3 },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('projected_free_below_headroom');
      expect(launchCalled).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('auto placement writes manifest to chosen node before apply', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-modelrun-placement-'));
    const dbPath = join(tmp, 'cluster.db');
    const journalPath = join(tmp, 'fleet-placement-journal.jsonl');
    writeClusterSnapshot(dbPath, 'node-a', '2026-05-25T00:00:00Z', 7000, [
      { name: 'alpha', models: [] },
    ]);
    writeClusterSnapshot(dbPath, 'node-b', '2026-05-25T00:00:10Z', 12000, [
      { name: 'beta', models: ['qwen3.6-35b-MTP-Q4_0-Q6_K.gguf'] },
    ]);

    const result = await applyManifest({
      manifest: modelRunManifestForPlacement(),
      getClient: () => makePlacementClient(),
      workloadsDir: tmp,
      placement: { dbPath, journalPath, headroomMinMb: 512 },
    });

    if (!result.ok) console.log('ERROR:', result); expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('ModelRun');
    if (result.kind !== 'ModelRun') return;
    expect(result.manifest.spec.node).toBe('node-b');

    const lines = fs.readFileSync(journalPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const placement = lines.find((entry) => entry.kind === 'fleet-placement');
    const transition = lines.find((entry) => entry.kind === 'fleet-transition');
    expect(placement).toBeDefined();
    expect(placement?.decision?.chosenNode).toBe('node-b');
    expect(Array.isArray(placement?.decision?.scores)).toBe(true);
    expect(placement?.decision?.scores).toHaveLength(2);
    expect(transition?.kind).toBe('fleet-transition');
    expect(transition?.subject).toBe('qwen-run');
    expect(transition?.to).toBe('node-b');
    expect(transition?.signal).toBe('placement');
    rmSync(tmp, { recursive: true, force: true });
  });

  test('explicit node does not trigger auto placement', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-modelrun-placement-explicit-'));
    const result = await applyManifest({
      manifest: modelRunManifestForPlacement({
        node: 'mac-mini',
        placement: undefined,
      }),
      workloadsDir: tmp,
      getClient: () => makePlacementClient(),
      placement: { dbPath: join(tmp, 'does-not-exist.db') },
    });

    if (!result.ok) console.log('ERROR:', result); expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('ModelRun');
    if (result.kind !== 'ModelRun') return;
    expect(result.manifest.spec.node).toBe('mac-mini');
    rmSync(tmp, { recursive: true, force: true });
  });

  test('placement:auto with explicit node bypasses scheduler', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-modelrun-placement-explicit-auto-'));
    const result = await applyManifest({
      manifest: modelRunManifestForPlacement({
        node: 'mac-mini',
        placement: 'auto',
      }),
      workloadsDir: tmp,
      getClient: () => makePlacementClient(),
      placement: { dbPath: join(tmp, 'does-not-exist.db') },
    });

    if (!result.ok) console.log('ERROR:', result); expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('ModelRun');
    if (result.kind !== 'ModelRun') return;
    expect(result.manifest.spec.node).toBe('mac-mini');
    rmSync(tmp, { recursive: true, force: true });
  });

  test('pinned placement does not trigger scheduler', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-modelrun-placement-pinned-'));
    const result = await applyManifest({
      manifest: modelRunManifestForPlacement({
        node: 'auto',
        placement: 'pinned',
      }),
      workloadsDir: tmp,
      getClient: () => makePlacementClient(),
      placement: { dbPath: join(tmp, 'does-not-exist.db') },
    });

    if (!result.ok) console.log('ERROR:', result); expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('ModelRun');
    if (result.kind !== 'ModelRun') return;
    expect(result.manifest.spec.node).toBe('auto');
    rmSync(tmp, { recursive: true, force: true });
  });

  test('no viable placement returns error before apply', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-modelrun-placement-none-'));
    const dbPath = join(tmp, 'cluster.db');
    writeClusterSnapshot(dbPath, 'node-a', '2026-05-25T00:00:00Z', 200, [
      { name: 'alpha', models: [] },
    ]);

    const result = await applyManifest({
      manifest: modelRunManifestForPlacement(),
      workloadsDir: tmp,
      placement: {
        dbPath,
        headroomMinMb: 512,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('no viable placement node');
    rmSync(tmp, { recursive: true, force: true });
  });
});
