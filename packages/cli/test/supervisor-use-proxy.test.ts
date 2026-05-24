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
});
