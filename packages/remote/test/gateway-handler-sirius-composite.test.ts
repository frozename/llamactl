import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { siriusHandler } from '../src/workload/gateway-handlers/sirius.js';
import { readGatewayCatalog } from '../src/workload/gateway-catalog/io.js';
import type { ApplyResult } from '../src/workload/apply.js';

const node = {
  name: 'sirius-1',
  kind: 'gateway',
  cloud: { provider: 'sirius', baseUrl: 'http://sirius.test' },
} as any;

const manifest = {
  apiVersion: 'llamactl/v1',
  kind: 'ModelRun',
  metadata: { name: 'm', labels: {} },
  spec: {
    node: 'sirius-1',
    target: { kind: 'rel' as const, value: 'mc-llama/x' },
    extraArgs: [],
    timeoutSeconds: 60,
    workers: [],
    gateway: true,
  },
} as any;

const composite = {
  compositeName: 'mc',
  upstreams: [{ name: 'llama', endpoint: 'http://h:1/v1', nodeName: 'mac' }],
  providerConfig: {},
};

describe('siriusHandler with composite context', () => {
  let tmp: string;
  let prevSp: string | undefined;
  let prevKc: string | undefined;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sh-'));
    prevSp = process.env.LLAMACTL_SIRIUS_PROVIDERS;
    prevKc = process.env.LLAMACTL_CONFIG;
    
    process.env.LLAMACTL_SIRIUS_PROVIDERS = join(tmp, 'sp.yaml');
    process.env.LLAMACTL_CONFIG = join(tmp, 'kubeconfig');
    
    writeFileSync(
      process.env.LLAMACTL_CONFIG,
      stringifyYaml({
        apiVersion: 'llamactl/v1',
        kind: 'Config',
        currentContext: 'default',
        contexts: [{ name: 'default', cluster: 'local', user: 'admin' }],
        users: [{ name: 'admin', token: 'mock-token' }],
        clusters: [{ name: 'local', server: 'http://localhost' }],
      }),
    );

    origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{"ok":true}', { status: 200 })) as any;
  });

  afterEach(() => {
    if (prevSp === undefined) delete process.env.LLAMACTL_SIRIUS_PROVIDERS;
    else process.env.LLAMACTL_SIRIUS_PROVIDERS = prevSp;
    
    if (prevKc === undefined) delete process.env.LLAMACTL_CONFIG;
    else process.env.LLAMACTL_CONFIG = prevKc;

    globalThis.fetch = origFetch;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('writes entries before reload', async () => {
    await siriusHandler.apply({
      manifest,
      node,
      getClient: (() => null) as any,
      composite,
    });
    const out = readGatewayCatalog('sirius');
    expect(out.find((e) => e.name === 'mc-llama')).toBeDefined();
  });

  test('returns Pending NameCollision when operator entry exists with same name', async () => {
    const path = join(tmp, 'sp.yaml');
    writeFileSync(
      path,
      'apiVersion: llamactl/v1\nkind: SiriusProviderList\nproviders:\n  - name: mc-llama\n    kind: openai\n    apiKeyRef: $K\n',
      'utf8',
    );
    const r = await siriusHandler.apply({
      manifest,
      node,
      getClient: (() => null) as any,
      composite,
    }) as ApplyResult;
    expect(r.action).toBe('pending');
    expect(r.statusSection.conditions[0]!.reason).toBe('SiriusUpstreamNameCollision');
  });

  test('idempotent re-apply skips reload', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      return new Response('{"ok":true}', { status: 200 });
    }) as any;
    await siriusHandler.apply({ manifest, node, getClient: (() => null) as any, composite });
    const before = calls.length;
    await siriusHandler.apply({ manifest, node, getClient: (() => null) as any, composite });
    expect(calls.length).toBe(before); // no new reload on second apply
  });
});
