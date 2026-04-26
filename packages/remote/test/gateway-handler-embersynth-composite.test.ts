import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { embersynthHandler } from '../src/workload/gateway-handlers/embersynth.js';
import { readGatewayCatalog } from '../src/workload/gateway-catalog/io.js';
import type { ApplyResult } from '../src/workload/apply.js';

const node = {
  name: 'em-1',
  kind: 'gateway',
  cloud: { provider: 'embersynth', baseUrl: 'http://em.test' },
} as any;

const manifest = {
  apiVersion: 'llamactl/v1',
  kind: 'ModelRun',
  metadata: { name: 'm', labels: {} },
  spec: {
    node: 'em-1',
    target: { kind: 'rel' as const, value: 'fusion-vision' },
    extraArgs: [],
    timeoutSeconds: 60,
    workers: [],
    gateway: true,
  },
} as any;

const composite = {
  compositeName: 'mc',
  upstreams: [{ name: 'llama', endpoint: 'http://h:1/v1', nodeName: 'mac' }],
  providerConfig: { tags: ['vision'], priority: 3 },
};

describe('embersynthHandler with composite context', () => {
  let tmp: string;
  let prevEm: string | undefined;
  let prevKc: string | undefined;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'eh-'));
    prevEm = process.env.LLAMACTL_EMBERSYNTH_CONFIG;
    prevKc = process.env.LLAMACTL_CONFIG;
    
    process.env.LLAMACTL_EMBERSYNTH_CONFIG = join(tmp, 'em.yaml');
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
    if (prevEm === undefined) delete process.env.LLAMACTL_EMBERSYNTH_CONFIG;
    else process.env.LLAMACTL_EMBERSYNTH_CONFIG = prevEm;
    
    if (prevKc === undefined) delete process.env.LLAMACTL_CONFIG;
    else process.env.LLAMACTL_CONFIG = prevKc;

    globalThis.fetch = origFetch;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('writes a node entry before reload', async () => {
    await embersynthHandler.apply({
      manifest,
      node,
      getClient: (() => null) as any,
      composite,
    });
    const nodes = readGatewayCatalog('embersynth');
    const found = nodes.find((n) => n.id === 'mc-llama');
    expect(found).toBeDefined();
    expect(found!.tags).toEqual(['vision']);
    expect(found!.priority).toBe(3);
  });

  test('returns Pending NameCollision when operator entry exists with same id', async () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      join(tmp, 'em.yaml'),
      `nodes:
  - id: mc-llama
    label: hand-edited
    endpoint: http://other:1/v1
    transport: http
    enabled: true
    capabilities: []
    tags: []
    providerType: openai-compatible
    modelId: default
    priority: 5
profiles: []
syntheticModels: {}
server:
  host: 127.0.0.1
  port: 7777
`,
      'utf8',
    );
    const r = await embersynthHandler.apply({
      manifest,
      node,
      getClient: (() => null) as any,
      composite,
    }) as ApplyResult;
    expect(r.action).toBe('pending');
    expect(r.statusSection.conditions[0]!.reason).toBe('EmbersynthUpstreamNameCollision');
  });

  test('idempotent re-apply skips reload', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      return new Response('{"ok":true}', { status: 200 });
    }) as any;
    await embersynthHandler.apply({ manifest, node, getClient: (() => null) as any, composite });
    const before = calls.length;
    await embersynthHandler.apply({ manifest, node, getClient: (() => null) as any, composite });
    expect(calls.length).toBe(before);
  });
});
