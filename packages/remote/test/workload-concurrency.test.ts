import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOne, type WorkloadClient } from '../src/workload/apply.js';
import { reconcileOnce } from '../src/workload/reconciler.js';
import {
  loadWorkloadByName,
  parseWorkload,
  saveWorkload,
  withWorkloadsMutex,
} from '../src/workload/store.js';
import type { ModelRun } from '../src/workload/schema.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'llamactl-workload-concurrency-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeManifest(name: string, node = 'gpu1', port = 8181): ModelRun {
  return parseWorkload(`
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: ${name}
spec:
  node: ${node}
  target:
    kind: rel
    value: llama-7b.gguf
  endpoint:
    host: 0.0.0.0
    port: ${port}
`);
}

function makeClient(): WorkloadClient {
  return {
    serverStatus: {
      async query() {
        return {
          state: 'stopped',
          rel: null,
          extraArgs: [],
          pid: null,
          host: null,
          port: null,
          binary: null,
          endpoint: '',
        };
      },
    },
    serverStop: { async mutate() { return {}; } },
    serverStart: {
      subscribe(_input, callbacks) {
        queueMicrotask(() => {
          callbacks.onData({
            type: 'done',
            result: { ok: true, pid: 1234, endpoint: 'http://127.0.0.1:8181' },
          });
          callbacks.onComplete();
        });
        return { unsubscribe() {} };
      },
    },
    rpcServerStart: {
      subscribe(_input, callbacks) {
        queueMicrotask(() => {
          callbacks.onData({ type: 'done', result: { ok: true, pid: 2222, endpoint: '' } });
          callbacks.onComplete();
        });
        return { unsubscribe() {} };
      },
    },
    rpcServerStop: { async mutate() { return {}; } },
    rpcServerDoctor: {
      async query() {
        return { ok: true, path: '/usr/local/bin/rpc-server', llamaCppBin: '/usr/local/bin/llama-server' };
      },
    },
  };
}

/**
 * Mirrors the router.ts:workloadApply transaction: lock-list-check-apply-save
 * under the per-dir mutex. Returns the result section as the router does.
 */
async function applyAndPersist(
  manifest: ModelRun,
  workloadsDir: string,
  resolveNodeIdentity?: (n: string) => string | null,
) {
  return withWorkloadsMutex(workloadsDir, async () => {
    const client = makeClient();
    const result = await applyOne(
      manifest,
      () => client,
      undefined,
      undefined,
      { workloadsDir, ...(resolveNodeIdentity ? { resolveNodeIdentity } : {}) },
    );
    if (!result.error) {
      saveWorkload({ ...manifest, status: result.statusSection }, workloadsDir);
    }
    return result;
  });
}

describe('workload apply concurrency', () => {
  test('two concurrent applies on the same node:port — exactly one wins', async () => {
    const a = makeManifest('alpha');
    const b = makeManifest('beta');

    const [r1, r2] = await Promise.all([
      applyAndPersist(a, dir),
      applyAndPersist(b, dir),
    ]);

    const winners = [r1, r2].filter((r) => !r.error);
    const losers = [r1, r2].filter((r) => r.error);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.error).toContain('port collision');
    expect(losers[0]!.statusSection.phase).toBe('Failed');
    expect(losers[0]!.statusSection.conditions[0]?.reason).toBe('PortCollision');
  });

  test('cross-node alias: different node names resolving to the same endpoint collide', async () => {
    const a = makeManifest('alpha', 'local');
    const b = makeManifest('beta', 'mac-mini');

    // Both names resolve to the same physical agent.
    const aliasResolver = (_n: string) => 'https://127.0.0.1:7843';

    const r1 = await applyAndPersist(a, dir, aliasResolver);
    expect(r1.error).toBeUndefined();

    const r2 = await applyAndPersist(b, dir, aliasResolver);
    expect(r2.error).toContain('port collision');
    expect(r2.statusSection.conditions[0]?.reason).toBe('PortCollision');
  });

  test('distinct nodes resolving to distinct endpoints do not collide', async () => {
    const a = makeManifest('alpha', 'gpu1');
    const b = makeManifest('beta', 'gpu2');

    const resolver = (n: string) =>
      n === 'gpu1' ? 'https://10.0.0.1:7843' : 'https://10.0.0.2:7843';

    const r1 = await applyAndPersist(a, dir, resolver);
    const r2 = await applyAndPersist(b, dir, resolver);
    expect(r1.error).toBeUndefined();
    expect(r2.error).toBeUndefined();
  });

  test('reconcileOnce treats aliased nodes as the same physical node for port collision', async () => {
    saveWorkload(makeManifest('alpha', 'local'), dir);
    saveWorkload(makeManifest('beta', 'mac-mini'), dir);

    const resolveNodeIdentity = (n: string): string | null => {
      if (n === 'local' || n === 'mac-mini') return 'https://127.0.0.1:7843';
      return null;
    };

    const result = await reconcileOnce({
      workloadsDir: dir,
      getClient: () => makeClient(),
      resolveNodeIdentity,
    });

    expect(result.errors).toBe(1);
    expect(result.reports).toHaveLength(2);
    expect(result.reports.filter((r) => r.error)).toHaveLength(1);

    const alpha = loadWorkloadByName('alpha', dir);
    const beta = loadWorkloadByName('beta', dir);
    expect(alpha.status?.phase).toBe('Failed');
    expect(alpha.status?.conditions[0]?.reason).toBe('PortCollision');
    expect(beta.status?.phase).not.toBe('Failed');
  });
});
