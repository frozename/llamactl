import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeModelHostSpecHash } from '../../../core/src/engines/state.js';
import { saveModelHost } from './modelhost-store.js';
import { reconcileOnce } from './reconciler.js';
import type { WorkloadClient } from './apply.js';
import type { ModelHostManifest } from './modelhost-schema.js';

function makeManifest(name: string, extraArgs: string[] = []): ModelHostManifest {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'ModelHost',
    metadata: { name },
    spec: {
      engine: 'omlx',
      node: 'mac-mini',
      enabled: true,
      binary: '/usr/bin/true',
      endpoint: { host: '127.0.0.1', port: 18094 },
      hostedModels: [{ rel: `${name}.gguf` }],
      extraArgs,
      restartPolicy: 'Always',
      timeoutSeconds: 60,
    },
  };
}

test('reconcile uses remote modelHostStatus.specHash to avoid restarts and detect drift on remote node', async () => {
  const workloadsDir = mkdtempSync(join(tmpdir(), 'llamactl-reconcile-'));
  const name = 'remote-host';
  const manifest = makeManifest(name);
  saveModelHost(manifest, workloadsDir);

  const remoteState = {
    hash: computeModelHostSpecHash(manifest.spec),
    pid: 12345,
    starts: 0,
  };

  const client: WorkloadClient = {
    serverStatus: { query: async () => ({ state: 'down', rel: null, extraArgs: [], pid: null, host: null, port: null, binary: null, endpoint: '' }) },
    serverStop: { mutate: async () => ({ stopped: true }) },
    serverStart: { subscribe: () => ({ unsubscribe() {} }) },
    modelHostStatus: { query: async () => ({ state: 'Running', pid: remoteState.pid, specHash: remoteState.hash }) },
    modelHostStop: { mutate: async () => ({ stopped: true }) },
    modelHostStart: {
      subscribe: (_input, callbacks) => {
        remoteState.starts += 1;
        queueMicrotask(() => {
          callbacks.onData({ type: 'done', result: { ok: true, pid: remoteState.pid, state: 'Running' } });
          callbacks.onComplete();
        });
        return { unsubscribe() {} };
      },
    },
    rpcServerStart: { subscribe: () => ({ unsubscribe() {} }) },
    rpcServerStop: { mutate: async () => ({ stopped: true }) },
    rpcServerDoctor: { query: async () => ({ ok: true, path: '', llamaCppBin: '' }) },
  };

  const getClient = () => client;

  try {
    const first = await reconcileOnce({ workloadsDir, getClient });
    expect(first.errors).toBe(0);
    expect(first.reports).toEqual([{ name, node: 'mac-mini', action: 'unchanged' }]);
    expect(remoteState.starts).toBe(0);

    const drifted = makeManifest(name, ['--new-flag']);
    saveModelHost(drifted, workloadsDir);
    const second = await reconcileOnce({ workloadsDir, getClient });
    expect(second.errors).toBe(0);
    expect(second.reports).toEqual([{ name, node: 'mac-mini', action: 'restarted' }]);
    expect(remoteState.starts).toBe(1);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});
