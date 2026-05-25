import { describe, expect, test } from 'bun:test';
import {
  resolveWorkloadTargetsAtStartup,
  resolveWorkloadUrl,
} from '../src/commands/supervisor.js';

function modelRun(
  useProxy: boolean | undefined,
): any {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'ModelRun',
    metadata: {
      name: 'demo',
      labels: {},
      annotations: {},
    },
    spec: {
      node: 'local',
      enabled: true,
      target: { kind: 'rel', value: 'demo.gguf' },
      extraArgs: [],
      workers: [],
      restartPolicy: 'Always',
      timeoutSeconds: 60,
      gateway: false,
      allowExternalBind: false,
      ...(useProxy === undefined ? {} : { useProxy }),
    },
  };
}

function modelHost(
  useProxy: boolean | undefined,
): any {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'ModelHost',
    metadata: {
      name: 'demo',
      labels: {},
    },
    spec: {
      engine: 'omlx',
      node: 'local',
      enabled: true,
      binary: '/tmp/omlx',
      endpoint: { host: '127.0.0.1', port: 8088 },
      hostedModels: [{ rel: 'demo.gguf' }],
      extraArgs: [],
      restartPolicy: 'Always',
      timeoutSeconds: 60,
      ...(useProxy === undefined ? {} : { useProxy }),
    },
  };
}

describe('supervisor useProxy startup routing', () => {
  test('useProxy=true resolves workload URL to internal proxy', () => {
    const out = resolveWorkloadUrl(
      'demo',
      'http://127.0.0.1:8088',
      {},
      {
        loadWorkloadByName: () => modelRun(true),
      },
    );
    expect(out).toBe('http://127.0.0.1:7944');
  });

  test('useProxy=false or omitted keeps configured workload URL', () => {
    const original = 'http://127.0.0.1:8088';
    const withFalse = resolveWorkloadUrl(
      'demo',
      original,
      {},
      {
        loadWorkloadByName: () => modelRun(false),
      },
    );
    const omitted = resolveWorkloadUrl(
      'demo',
      original,
      {},
      {
        loadWorkloadByName: () => modelRun(undefined),
      },
    );
    expect(withFalse).toBe(original);
    expect(omitted).toBe(original);
  });

  test('missing workload spec keeps configured URL and emits warning', () => {
    const warnings: string[] = [];
    const original = 'http://127.0.0.1:8088';
    const out = resolveWorkloadUrl(
      'missing',
      original,
      {},
      {
        loadWorkloadByName: () => {
          throw new Error('workload manifest not found: missing');
        },
        warn: (message) => warnings.push(message),
      },
    );
    expect(out).toBe(original);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('[supervisor] workload=missing failed to read deployed spec');
  });

  test('LLAMACTL_INTERNAL_PROXY_URL override is honored', () => {
    const out = resolveWorkloadUrl(
      'demo',
      'http://127.0.0.1:8088',
      { LLAMACTL_INTERNAL_PROXY_URL: 'http://127.0.0.1:8888' },
      {
        loadWorkloadByName: () => modelRun(true),
      },
    );
    expect(out).toBe('http://127.0.0.1:8888');
  });

  test('startup emits one-line proxy routing message when override engages', () => {
    const info: string[] = [];
    const out = resolveWorkloadTargetsAtStartup(
      [{ name: 'demo', endpoint: 'http://127.0.0.1:8088', kind: 'ModelRun' }],
      {},
      {
        loadWorkloadByName: () => modelRun(true),
        info: (message) => info.push(message),
      },
    );
    expect(out[0]?.endpoint).toBe('http://127.0.0.1:7944');
    expect(info).toEqual([
      '[supervisor] workload=demo routing via proxy http://127.0.0.1:7944 (was http://127.0.0.1:8088)',
    ]);
  });

  test('startup resolves ModelHost useProxy=true through the proxy', () => {
    const info: string[] = [];
    const out = resolveWorkloadTargetsAtStartup(
      [{ name: 'demo', endpoint: 'http://127.0.0.1:8088', kind: 'ModelHost' }],
      {},
      {
        loadWorkloadByNameAny: () => modelHost(true),
        info: (message) => info.push(message),
      },
    );
    expect(out[0]?.endpoint).toBe('http://127.0.0.1:7944');
    expect(info).toEqual([
      '[supervisor] workload=demo routing via proxy http://127.0.0.1:7944 (was http://127.0.0.1:8088)',
    ]);
  });

  test('startup leaves ModelHost without useProxy unchanged', () => {
    const out = resolveWorkloadTargetsAtStartup(
      [{ name: 'demo', endpoint: 'http://127.0.0.1:8088', kind: 'ModelHost' }],
      {},
      {
        loadWorkloadByNameAny: () => modelHost(undefined),
      },
    );
    expect(out[0]?.endpoint).toBe('http://127.0.0.1:8088');
  });

  test('startup still resolves ModelRun useProxy=true through the proxy', () => {
    const out = resolveWorkloadTargetsAtStartup(
      [{ name: 'demo', endpoint: 'http://127.0.0.1:8088', kind: 'ModelRun' }],
      {},
      {
        loadWorkloadByNameAny: () => modelRun(true),
      },
    );
    expect(out[0]?.endpoint).toBe('http://127.0.0.1:7944');
  });
});
