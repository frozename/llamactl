import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileOnce, type ReconcileResult } from '../../src/workload/reconciler.js';
import { saveWorkload } from '../../src/workload/store.js';
import { loadModelHostByName, saveModelHost } from '../../src/workload/modelhost-store.js';
import type { WorkloadClient } from '../../src/workload/apply.js';

function makeClient(): WorkloadClient {
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
    modelHostStart: {
      subscribe: async (_input, callbacks) => {
        queueMicrotask(() => {
          callbacks.onData({ type: 'done', result: { ok: true } });
          callbacks.onComplete();
        });
        return { unsubscribe() {} };
      },
    },
    modelHostStop: { mutate: async () => ({ ok: true }) },
    modelHostStatus: { query: async () => ({ state: 'Running' }) },
    rpcServerStart: { subscribe: async () => ({ unsubscribe() {} }) },
    rpcServerStop: { mutate: async () => ({ ok: true }) },
    rpcServerDoctor: { query: async () => ({ ok: true, path: null, llamaCppBin: null }) },
  };
}

function makeRunManifest() {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'ModelRun' as const,
    metadata: { name: 'run-a', labels: {}, annotations: {} },
    spec: {
      node: 'local',
      enabled: true,
      target: { kind: 'rel' as const, value: 'mlx-community/run-a.gguf' },
      extraArgs: [],
      workers: [],
      restartPolicy: 'Always' as const,
      timeoutSeconds: 60,
      gateway: false,
      allowExternalBind: false,
    },
  };
}

function makeHostManifest() {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'ModelHost' as const,
    metadata: { name: 'host-a' },
    spec: {
      engine: 'omlx' as const,
      node: 'local',
      enabled: true,
      binary: '/usr/bin/true',
      endpoint: { host: '127.0.0.1', port: 18094 },
      hostedModels: [{ rel: 'mlx-community/host-a' }],
      extraArgs: [],
      restartPolicy: 'Always' as const,
      timeoutSeconds: 60,
    },
  };
}

describe('reconcileOnce', () => {
  test('processes ModelRun and ModelHost manifests from the shared store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llamactl-reconciler-'));
    const previousRuntimeDir = process.env.LOCAL_AI_RUNTIME_DIR;
    try {
      saveWorkload(makeRunManifest(), dir);
      saveModelHost(makeHostManifest(), dir);
      process.env.LOCAL_AI_RUNTIME_DIR = dir;

      const result: ReconcileResult = await reconcileOnce({
        workloadsDir: dir,
        getClient: () => makeClient(),
      });

      expect(result.errors).toBe(0);
      expect(result.reports).toHaveLength(2);
      expect(result.reports.map((r) => r.name)).toEqual(['run-a', 'host-a']);
      expect(result.reports.map((r) => r.node)).toEqual(['local', 'local']);
      expect(result.reports.find((r) => r.name === 'host-a')?.action).toBe('started');
      expect(result.reports.find((r) => r.name === 'run-a')?.action).toBe('started');
    } finally {
      if (previousRuntimeDir === undefined) delete process.env.LOCAL_AI_RUNTIME_DIR;
      else process.env.LOCAL_AI_RUNTIME_DIR = previousRuntimeDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('persists ModelHost status returned by the reconciler outcome', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llamactl-reconciler-host-status-'));
    const previousRuntimeDir = process.env.LOCAL_AI_RUNTIME_DIR;
    try {
      saveModelHost(makeHostManifest(), dir);
      process.env.LOCAL_AI_RUNTIME_DIR = dir;

      await reconcileOnce({
        workloadsDir: dir,
        getClient: () => ({
          ...makeClient(),
          modelHostStatus: { query: async () => ({ state: 'Running', pid: 1234 }) },
        }),
      });

      const loaded = loadModelHostByName('host-a', dir);
      expect(loaded.status.phase).toBe('Running');
    } finally {
      if (previousRuntimeDir === undefined) delete process.env.LOCAL_AI_RUNTIME_DIR;
      else process.env.LOCAL_AI_RUNTIME_DIR = previousRuntimeDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
