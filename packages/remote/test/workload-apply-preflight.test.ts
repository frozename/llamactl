import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { applyOne, type WorkloadClient } from '../src/workload/apply.js';
import { parseWorkload } from '../src/workload/store.js';
import type { ModelRun } from '../src/workload/schema.js';

/**
 * Slice E.1 preflight: before any `rpcServerStart` spawn, apply asks
 * each worker node's `rpcServerDoctor` procedure for rpc-server
 * readiness. One failing node must abort the whole apply with a
 * composed, grep-stable error — and `rpcServerStart` / `rpcServerStop`
 * must never be invoked on any worker when preflight fails.
 */

interface RpcDoctorResult {
  ok: boolean;
  path: string | null;
  llamaCppBin: string | null;
  reason?:
    | 'LLAMA_CPP_BIN-unset'
    | 'LLAMA_CPP_BIN-missing'
    | 'rpc-server-missing'
    | 'rpc-server-not-executable';
  hint?: string;
}

interface MockTrace {
  rpcServerStartCalls: string[];
  rpcServerStopCalls: string[];
  rpcServerDoctorCalls: string[];
  serverStatusCalls: string[];
  serverStartCalls: string[];
  serverStopCalls: string[];
}

function makeMockClient(
  nodeName: string,
  doctorResult: RpcDoctorResult,
  trace: MockTrace,
): WorkloadClient {
  return {
    serverStatus: {
      async query() {
        trace.serverStatusCalls.push(nodeName);
      return {
        state: 'down',
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
    serverStop: {
      async mutate() {
        trace.serverStopCalls.push(nodeName);
        return { stopped: true };
      },
    },
    serverStart: {
      subscribe(_input, callbacks) {
        trace.serverStartCalls.push(nodeName);
        queueMicrotask(() => {
          callbacks.onData({
            type: 'done',
            result: { ok: true, pid: 42, endpoint: '127.0.0.1:8080' },
          });
          callbacks.onComplete();
        });
        return { unsubscribe() {} };
      },
    },
    rpcServerStart: {
      subscribe(_input, callbacks) {
        trace.rpcServerStartCalls.push(nodeName);
        queueMicrotask(() => {
          callbacks.onData({
            type: 'done',
            result: { ok: true, pid: 99, endpoint: '127.0.0.1:50052' },
          });
          callbacks.onComplete();
        });
        return { unsubscribe() {} };
      },
    },
    rpcServerStop: {
      async mutate() {
        trace.rpcServerStopCalls.push(nodeName);
        return { stopped: true };
      },
    },
    rpcServerDoctor: {
      async query() {
        trace.rpcServerDoctorCalls.push(nodeName);
        return doctorResult;
      },
    },
  };
}

function manifest(): ModelRun {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'ModelRun',
    metadata: { name: 'tp-split', labels: {}, annotations: {} },
    spec: {
      node: 'coordinator',
      enabled: true,
      gateway: false,
      target: { kind: 'rel', value: 'tiny.gguf' },
      extraArgs: [],
      restartPolicy: 'Always',
      timeoutSeconds: 30,
      workers: [
        {
          node: 'worker1',
          rpcHost: '10.0.0.21',
          rpcPort: 50052,
          extraArgs: [],
          timeoutSeconds: 20,
        },
        {
          node: 'worker2',
          rpcHost: '10.0.0.22',
          rpcPort: 50052,
          extraArgs: [],
          timeoutSeconds: 20,
        },
      ],
    },
  };
}

function tempWorkloadsDir(): string {
  return mkdtempSync(join(tmpdir(), 'llamactl-workloads-'));
}

function writeManifest(dir: string, workload: ModelRun): void {
  writeFileSync(join(dir, `${workload.metadata.name}.yaml`), stringifyYaml(workload), 'utf8');
}

describe('applyOne preflight — worker rpcServerDoctor', () => {
  test('all workers ok → apply proceeds to startWorkers + serverStart', async () => {
    const trace: MockTrace = {
      rpcServerStartCalls: [],
      rpcServerStopCalls: [],
      rpcServerDoctorCalls: [],
      serverStatusCalls: [],
      serverStartCalls: [],
      serverStopCalls: [],
    };
    const okDoctor: RpcDoctorResult = {
      ok: true,
      path: '/fake/bin/rpc-server',
      llamaCppBin: '/fake/bin',
    };
    const getClient = (node: string): WorkloadClient =>
      makeMockClient(node, okDoctor, trace);
    const result = await applyOne(manifest(), getClient);
    expect(result.error).toBeUndefined();
    expect(result.action).toBe('started');
    expect(result.statusSection.phase).toBe('Running');
    // Both workers asked, both started.
    expect(trace.rpcServerDoctorCalls.sort()).toEqual(['worker1', 'worker2']);
    expect(trace.rpcServerStartCalls).toEqual(['worker1', 'worker2']);
    expect(trace.serverStartCalls).toEqual(['coordinator']);
  });

  test('one failing worker → apply aborts, no rpcServerStart invoked, error is composed', async () => {
    const trace: MockTrace = {
      rpcServerStartCalls: [],
      rpcServerStopCalls: [],
      rpcServerDoctorCalls: [],
      serverStatusCalls: [],
      serverStartCalls: [],
      serverStopCalls: [],
    };
    const getClient = (node: string): WorkloadClient => {
      if (node === 'worker2') {
        return makeMockClient(
          node,
          {
            ok: false,
            path: null,
            llamaCppBin: '/opt/llama.cpp/build/bin',
            reason: 'rpc-server-missing',
            hint:
              'rpc-server is built only when llama.cpp is configured with ' +
              '-DGGML_RPC=ON. From your llama.cpp source tree: ' +
              'cmake -B build -DGGML_RPC=ON && cmake --build build --target rpc-server',
          },
          trace,
        );
      }
      return makeMockClient(
        node,
        {
          ok: true,
          path: '/opt/llama.cpp/build/bin/rpc-server',
          llamaCppBin: '/opt/llama.cpp/build/bin',
        },
        trace,
      );
    };
    const events: Array<{ type: string; message: string }> = [];
    const result = await applyOne(manifest(), getClient, (e) => events.push(e));
    expect(result.error).toBeDefined();
    expect(result.statusSection.phase).toBe('Failed');
    // Composed error names the failing node and includes both the
    // reason and the cmake hint for copy-paste.
    expect(result.error).toContain('rpc-server not available');
    expect(result.error).toContain('worker2');
    expect(result.error).toContain('rpc-server-missing');
    expect(result.error).toContain('-DGGML_RPC=ON');
    // Both doctors were asked (Promise.all), but NO rpcServerStart
    // fired on either worker, and the coordinator's serverStart also
    // never ran.
    expect(trace.rpcServerDoctorCalls.sort()).toEqual(['worker1', 'worker2']);
    expect(trace.rpcServerStartCalls).toEqual([]);
    expect(trace.serverStartCalls).toEqual([]);
    // A worker-preflight event surfaced so operators see the gate
    // in the apply log output.
    expect(events.some((e) => e.type === 'worker-preflight')).toBe(true);
  });

  test('multiple failing workers → error lists every one', async () => {
    const trace: MockTrace = {
      rpcServerStartCalls: [],
      rpcServerStopCalls: [],
      rpcServerDoctorCalls: [],
      serverStatusCalls: [],
      serverStartCalls: [],
      serverStopCalls: [],
    };
    const getClient = (node: string): WorkloadClient =>
      makeMockClient(
        node,
        node === 'worker1'
          ? {
              ok: false,
              path: null,
              llamaCppBin: null,
              reason: 'LLAMA_CPP_BIN-unset',
              hint: 'set $LLAMA_CPP_BIN to the llama.cpp build/bin directory',
            }
          : {
              ok: false,
              path: null,
              llamaCppBin: '/bogus',
              reason: 'LLAMA_CPP_BIN-missing',
              hint: 'LLAMA_CPP_BIN=/bogus does not exist',
            },
        trace,
      );
    const result = await applyOne(manifest(), getClient);
    expect(result.error).toContain('2 worker node(s)');
    expect(result.error).toContain('worker1');
    expect(result.error).toContain('worker2');
    expect(result.error).toContain('LLAMA_CPP_BIN-unset');
    expect(result.error).toContain('LLAMA_CPP_BIN-missing');
    expect(trace.rpcServerStartCalls).toEqual([]);
  });

  test('zero-worker workload skips preflight entirely', async () => {
    const trace: MockTrace = {
      rpcServerStartCalls: [],
      rpcServerStopCalls: [],
      rpcServerDoctorCalls: [],
      serverStatusCalls: [],
      serverStartCalls: [],
      serverStopCalls: [],
    };
    const m: ModelRun = {
      ...manifest(),
      spec: { ...manifest().spec, workers: [] },
    };
    const getClient = (node: string): WorkloadClient =>
      makeMockClient(node, { ok: true, path: '/x', llamaCppBin: '/y' }, trace);
    const result = await applyOne(m, getClient);
    expect(result.error).toBeUndefined();
    expect(result.action).toBe('started');
    expect(trace.rpcServerDoctorCalls).toEqual([]);
  });

  test('changing only the endpoint port forces a restart', async () => {
    const trace: MockTrace = {
      rpcServerStartCalls: [],
      rpcServerStopCalls: [],
      rpcServerDoctorCalls: [],
      serverStatusCalls: [],
      serverStartCalls: [],
      serverStopCalls: [],
    };
    const getClient = (node: string): WorkloadClient => ({
      serverStatus: {
        async query() {
          trace.serverStatusCalls.push(node);
          return {
            state: 'up',
            rel: 'tiny.gguf',
            extraArgs: [],
            pid: 123,
            host: '127.0.0.1',
            port: 8080,
            binary: '/fake/bin/llama-server',
            endpoint: 'http://127.0.0.1:8080',
          };
        },
      },
      serverStop: {
        async mutate() {
          trace.serverStopCalls.push(node);
          return { stopped: true };
        },
      },
      serverStart: {
        subscribe(_input, callbacks) {
          trace.serverStartCalls.push(node);
          queueMicrotask(() => {
            callbacks.onData({
              type: 'done',
              result: { ok: true, pid: 42, endpoint: 'http://127.0.0.1:8181' },
            });
            callbacks.onComplete();
          });
          return { unsubscribe() {} };
        },
      },
      rpcServerStart: {
        subscribe(_input, callbacks) {
          trace.rpcServerStartCalls.push(node);
          queueMicrotask(() => {
            callbacks.onData({
              type: 'done',
              result: { ok: true, pid: 99, endpoint: '127.0.0.1:50052' },
            });
            callbacks.onComplete();
          });
          return { unsubscribe() {} };
        },
      },
      rpcServerStop: {
        async mutate() {
          trace.rpcServerStopCalls.push(node);
          return { stopped: true };
        },
      },
      rpcServerDoctor: {
        async query() {
          trace.rpcServerDoctorCalls.push(node);
          return {
            ok: true,
            path: '/fake/bin/rpc-server',
            llamaCppBin: '/fake/bin',
          };
        },
      },
    });
    const m: ModelRun = {
      ...manifest(),
      spec: {
        ...manifest().spec,
        endpoint: { host: '127.0.0.1', port: 8181 },
      },
    };
    const result = await applyOne(m, getClient);
    expect(result.action).toBe('restarted');
    expect(trace.serverStopCalls).toEqual(['coordinator']);
    expect(trace.serverStartCalls).toEqual(['coordinator']);
  });

  test('port collision — same node, same port → rejected with PortCollision', async () => {
    const dir = tempWorkloadsDir();
    const current: ModelRun = {
      ...manifest(),
      spec: {
        ...manifest().spec,
        endpoint: { host: '127.0.0.1', port: 8181 },
      },
    };
    writeManifest(dir, current);
    writeManifest(dir, {
      ...current,
      metadata: { ...current.metadata, name: 'other' },
      spec: {
        ...current.spec,
        target: { kind: 'rel', value: 'different.gguf' },
        endpoint: { host: '127.0.0.1', port: 8181 },
      },
    });
    const trace: MockTrace = {
      rpcServerStartCalls: [],
      rpcServerStopCalls: [],
      rpcServerDoctorCalls: [],
      serverStatusCalls: [],
      serverStartCalls: [],
      serverStopCalls: [],
    };
    const result = await applyOne(
      current,
      (node) => makeMockClient(node, { ok: true, path: '/x', llamaCppBin: '/y' }, trace),
      undefined,
      undefined,
      { workloadsDir: dir },
    );
    expect(result.action).toBe('pending');
    expect(result.error).toContain('port collision: other already claims 127.0.0.1:8181 on node coordinator');
    expect(result.statusSection.phase).toBe('Failed');
    expect(result.statusSection.conditions[0]).toMatchObject({ reason: 'PortCollision' });
    expect(trace.serverStatusCalls).toEqual([]);
  });

  test('same name re-apply allowed', async () => {
    const dir = tempWorkloadsDir();
    const current: ModelRun = {
      ...manifest(),
      spec: {
        ...manifest().spec,
        endpoint: { host: '127.0.0.1', port: 8181 },
      },
    };
    writeManifest(dir, current);
    const trace: MockTrace = {
      rpcServerStartCalls: [],
      rpcServerStopCalls: [],
      rpcServerDoctorCalls: [],
      serverStatusCalls: [],
      serverStartCalls: [],
      serverStopCalls: [],
    };
    const result = await applyOne(
      current,
      (node) => makeMockClient(node, { ok: true, path: '/x', llamaCppBin: '/y' }, trace),
      undefined,
      undefined,
      { workloadsDir: dir },
    );
    expect(result.error).toBeUndefined();
    expect(result.action).toBe('started');
  });

  test('different ports — same node → both succeed', async () => {
    const dir = tempWorkloadsDir();
    const current: ModelRun = {
      ...manifest(),
      spec: {
        ...manifest().spec,
        endpoint: { host: '127.0.0.1', port: 8181 },
      },
    };
    writeManifest(dir, {
      ...current,
      metadata: { ...current.metadata, name: 'other' },
      spec: {
        ...current.spec,
        endpoint: { host: '127.0.0.1', port: 8182 },
      },
    });
    const trace: MockTrace = {
      rpcServerStartCalls: [],
      rpcServerStopCalls: [],
      rpcServerDoctorCalls: [],
      serverStatusCalls: [],
      serverStartCalls: [],
      serverStopCalls: [],
    };
    const result = await applyOne(
      current,
      (node) => makeMockClient(node, { ok: true, path: '/x', llamaCppBin: '/y' }, trace),
      undefined,
      undefined,
      { workloadsDir: dir },
    );
    expect(result.error).toBeUndefined();
    expect(result.action).toBe('started');
  });

  test('unset port — current manifest has no endpoint.port → skip check', async () => {
    const dir = tempWorkloadsDir();
    const current = parseWorkload(stringifyYaml({
      ...manifest(),
      spec: {
        ...manifest().spec,
        endpoint: { host: '127.0.0.1' },
      },
    }));
    writeManifest(dir, {
      ...manifest(),
      metadata: { ...manifest().metadata, name: 'other' },
      spec: {
        ...manifest().spec,
        endpoint: { host: '127.0.0.1', port: 8181 },
      },
    });
    const trace: MockTrace = {
      rpcServerStartCalls: [],
      rpcServerStopCalls: [],
      rpcServerDoctorCalls: [],
      serverStatusCalls: [],
      serverStartCalls: [],
      serverStopCalls: [],
    };
    const result = await applyOne(
      current,
      (node) => makeMockClient(node, { ok: true, path: '/x', llamaCppBin: '/y' }, trace),
      undefined,
      undefined,
      { workloadsDir: dir },
    );
    expect(result.error).toBeUndefined();
    expect(result.action).toBe('started');
  });

  test('::1 localhost collides with 127.0.0.1', async () => {
    const dir = tempWorkloadsDir();
    const current: ModelRun = {
      ...manifest(),
      spec: {
        ...manifest().spec,
        endpoint: { host: '127.0.0.1', port: 8181 },
      },
    };
    writeManifest(dir, {
      ...current,
      metadata: { ...current.metadata, name: 'other' },
      spec: {
        ...current.spec,
        endpoint: { host: '::1', port: 8181 },
      },
    });
    const trace: MockTrace = {
      rpcServerStartCalls: [],
      rpcServerStopCalls: [],
      rpcServerDoctorCalls: [],
      serverStatusCalls: [],
      serverStartCalls: [],
      serverStopCalls: [],
    };
    const result = await applyOne(
      current,
      (node) => makeMockClient(node, { ok: true, path: '/x', llamaCppBin: '/y' }, trace),
      undefined,
      undefined,
      { workloadsDir: dir },
    );
    expect(result.error).toContain('port collision');
    expect(result.statusSection.conditions[0]).toMatchObject({ reason: 'PortCollision' });
  });

  test('failed PortCollision candidate is ignored on subsequent preflight', async () => {
    const dir = tempWorkloadsDir();
    const current: ModelRun = {
      ...manifest(),
      spec: {
        ...manifest().spec,
        endpoint: { host: '127.0.0.1', port: 8181 },
      },
    };
    writeManifest(dir, current);
    writeManifest(dir, {
      ...current,
      metadata: { ...current.metadata, name: 'other' },
      status: {
        phase: 'Failed',
        serverPid: null,
        endpoint: null,
        lastTransitionTime: new Date().toISOString(),
        conditions: [
          {
            type: 'Applied',
            status: 'False',
            reason: 'PortCollision',
            message: 'port 8181 already claimed by tp-split',
            lastTransitionTime: new Date().toISOString(),
          },
        ],
      },
      spec: {
        ...current.spec,
        endpoint: { host: '127.0.0.1', port: 8181 },
      },
    });
    const trace: MockTrace = {
      rpcServerStartCalls: [],
      rpcServerStopCalls: [],
      rpcServerDoctorCalls: [],
      serverStatusCalls: [],
      serverStartCalls: [],
      serverStopCalls: [],
    };
    const result = await applyOne(
      current,
      (node) => makeMockClient(node, { ok: true, path: '/x', llamaCppBin: '/y' }, trace),
      undefined,
      undefined,
      { workloadsDir: dir },
    );
    expect(result.error).toBeUndefined();
    expect(result.action).toBe('started');
  });

  test('different nodes — same port → both succeed', async () => {
    const dir = tempWorkloadsDir();
    const current: ModelRun = {
      ...manifest(),
      spec: {
        ...manifest().spec,
        endpoint: { host: '127.0.0.1', port: 8181 },
      },
    };
    writeManifest(dir, {
      ...current,
      metadata: { ...current.metadata, name: 'other' },
      spec: {
        ...current.spec,
        node: 'different-node',
        endpoint: { host: '127.0.0.1', port: 8181 },
      },
    });
    const trace: MockTrace = {
      rpcServerStartCalls: [],
      rpcServerStopCalls: [],
      rpcServerDoctorCalls: [],
      serverStatusCalls: [],
      serverStartCalls: [],
      serverStopCalls: [],
    };
    const result = await applyOne(
      current,
      (node) => makeMockClient(node, { ok: true, path: '/x', llamaCppBin: '/y' }, trace),
      undefined,
      undefined,
      { workloadsDir: dir },
    );
    expect(result.error).toBeUndefined();
    expect(result.action).toBe('started');
  });

  test('0.0.0.0 wildcard host collides with 127.0.0.1', async () => {
    const dir = tempWorkloadsDir();
    const current: ModelRun = {
      ...manifest(),
      spec: {
        ...manifest().spec,
        endpoint: { host: '127.0.0.1', port: 8181 },
      },
    };
    writeManifest(dir, {
      ...current,
      metadata: { ...current.metadata, name: 'other' },
      spec: {
        ...current.spec,
        endpoint: { host: '0.0.0.0', port: 8181 },
      },
    });
    const trace: MockTrace = {
      rpcServerStartCalls: [],
      rpcServerStopCalls: [],
      rpcServerDoctorCalls: [],
      serverStatusCalls: [],
      serverStartCalls: [],
      serverStopCalls: [],
    };
    const result = await applyOne(
      current,
      (node) => makeMockClient(node, { ok: true, path: '/x', llamaCppBin: '/y' }, trace),
      undefined,
      undefined,
      { workloadsDir: dir },
    );
    expect(result.error).toContain('port collision: other already claims 0.0.0.0:8181 on node coordinator');
    expect(result.statusSection.conditions[0]).toMatchObject({ reason: 'PortCollision' });
  });
});
