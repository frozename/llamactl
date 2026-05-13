import { expect, test } from 'bun:test';
import { applyOne, type WorkloadClient } from './apply.js';
import type { ModelRun } from './schema.js';

function makeClient(state: Map<string, { up: boolean; rel: string; args: string[] }>): WorkloadClient {
  return {
    serverStatus: {
      query: async ({ workload }: { workload: string }) => {
        const s = state.get(workload);
        return s
          ? { state: 'up', pid: 1, rel: s.rel, extraArgs: s.args, host: '127.0.0.1', port: 8181, binary: null, endpoint: 'http://127.0.0.1:8181' }
          : { state: 'down', pid: null, rel: null, extraArgs: [], host: null, port: null, binary: null, endpoint: 'http://127.0.0.1:8181' };
      },
    } as any,
    serverStop: {
      mutate: async ({ workload }: { workload: string }) => {
        state.delete(workload);
        return { stopped: true };
      },
    } as any,
    serverStart: {
      subscribe: async (
        { workload, target, extraArgs }: { workload: string; target: string; extraArgs?: string[] },
        callbacks: { onData: (e: unknown) => void; onError: (err: unknown) => void; onComplete: () => void },
      ) => {
        state.set(workload, { up: true, rel: target, args: extraArgs ?? [] });
        queueMicrotask(() => {
          callbacks.onData({ type: 'done', result: { ok: true, pid: 100, endpoint: 'http://127.0.0.1:8181' } });
          callbacks.onComplete();
        });
        return { unsubscribe() {} };
      },
    } as any,
    rpcServerStart: { subscribe: async () => ({ unsubscribe() {} }) } as any,
    rpcServerStop: { mutate: async () => ({ stopped: true }) } as any,
    rpcServerDoctor: { query: async () => ({ ok: true, path: '', llamaCppBin: '' }) } as any,
  } as any;
}

const mkManifest = (name: string, overrides: Partial<{
  annotations: Record<string, string>;
  enabled: boolean;
  port: number;
  ram: number;
  node: string;
}> = {}): ModelRun => ({
  apiVersion: 'llamactl/v1',
  kind: 'ModelRun',
  metadata: { name, labels: {}, annotations: overrides.annotations ?? {} },
  spec: {
    node: overrides.node ?? 'local',
    enabled: overrides.enabled ?? true,
    target: { kind: 'rel', value: `${name}.gguf` },
    extraArgs: [],
    workers: [],
    restartPolicy: 'Always',
    gateway: false,
    timeoutSeconds: 60,
    endpoint: { host: '127.0.0.1', port: overrides.port ?? 8181 },
    resources: { expectedMemoryGiB: overrides.ram ?? 8 },
  },
});

test('disabled manifest stops the server if running and reports Disabled', async () => {
  const state = new Map([['a', { up: true, rel: 'a.gguf', args: [] }]]);
  const result = await applyOne(
    mkManifest('a', { enabled: false }),
    () => makeClient(state),
  );
  expect(result.statusSection.phase).toBe('Stopped');
  expect(result.statusSection.conditions[0]?.reason).toBe('Disabled');
  expect(state.has('a')).toBe(false);
});

test('parallel apply does not stop other workloads on the node', async () => {
  const state = new Map([['a', { up: true, rel: 'a.gguf', args: [] }]]);
  const result = await applyOne(
    mkManifest('b', { port: 8090 }),
    () => makeClient(state),
  );
  expect(state.has('a')).toBe(true);
  expect(state.has('b')).toBe(true);
  expect(result.action).toBe('started');
});

test('evict annotation stops named workload before starting incoming', async () => {
  const state = new Map([['a', { up: true, rel: 'a.gguf', args: [] }]]);
  const result = await applyOne(
    mkManifest('b', { annotations: { 'llamactl.io/evict': 'a' }, port: 8090 }),
    () => makeClient(state),
    undefined,
    undefined,
    { listManifests: () => [mkManifest('a')] },
  );
  expect(state.has('a')).toBe(false);
  expect(state.has('b')).toBe(true);
  expect(result.action).toBe('started');
});

test('budget overflow returns pending with BudgetExceeded unless force-admit', async () => {
  const state = new Map([['a', { up: true, rel: 'a.gguf', args: [] }]]);
  const result = await applyOne(
    mkManifest('b', { port: 8090, ram: 8 }),
    () => makeClient(state),
    undefined,
    undefined,
    { getNodeBudgetGiB: () => 10, listManifests: () => [mkManifest('a', { ram: 8 })] },
  );
  expect(result.action).toBe('pending');
  expect(result.statusSection.conditions[0]?.reason).toBe('BudgetExceeded');
});

test('force-admit annotation bypasses the budget check', async () => {
  const state = new Map();
  const result = await applyOne(
    mkManifest('b', { annotations: { 'llamactl.io/force-admit': 'true' }, ram: 30, port: 8090 }),
    () => makeClient(state),
    undefined,
    undefined,
    { getNodeBudgetGiB: () => 1, listManifests: () => [] },
  );
  expect(result.action).toBe('started');
});
