import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { siriusHandler } from '../src/workload/gateway-handlers/sirius.js';
import { embersynthHandler } from '../src/workload/gateway-handlers/embersynth.js';
import type { ClusterNode } from '../src/config/schema.js';
import type { ModelRun } from '../src/workload/schema.js';

/**
 * K.7.2 / K.7.3 — handlers actually POST the reload endpoint and
 * translate the response to a ModelRun status. A Bun.serve mini-server
 * on 127.0.0.1:0 stands in for a real sirius / embersynth so the
 * tests stay hermetic.
 */

interface ReloadRequest {
  method: string;
  url: string;
  auth: string | null;
  body: string;
}

async function startFakeGateway(
  path: string,
  options: { status?: number; bodyOnFailure?: string } = {},
): Promise<{ url: string; calls: ReloadRequest[]; stop: () => Promise<void> }> {
  const calls: ReloadRequest[] = [];
  const { status = 200, bodyOnFailure = 'faked gateway failure' } = options;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (new URL(req.url).pathname === path) {
        calls.push({
          method: req.method,
          url: req.url,
          auth: req.headers.get('authorization'),
          body: await req.text(),
        });
        if (status >= 200 && status < 300) {
          return new Response('{"ok":true}', {
            status,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(bodyOnFailure, { status });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    stop: async () => {
      server.stop(true);
    },
  };
}

let runtimeDir = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'llamactl-gateway-reload-'));
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: runtimeDir,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LLAMACTL_CONFIG: join(runtimeDir, 'kubeconfig'),
    LLAMACTL_SIRIUS_PROVIDERS: join(runtimeDir, 'sirius-providers.yaml'),
    LLAMACTL_EMBERSYNTH_CONFIG: join(runtimeDir, 'embersynth.yaml'),
  });
});

afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

function gatewayManifest(node: string, target: string): ModelRun {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'ModelRun',
    metadata: { name: `register-${node}`, labels: {} },
    spec: {
      node,
      gateway: true,
      target: { kind: 'rel', value: target },
      extraArgs: [],
      workers: [],
      restartPolicy: 'Always',
      timeoutSeconds: 60,
    },
  };
}

function seedKubeconfig(): void {
  writeFileSync(
    join(runtimeDir, 'kubeconfig'),
    stringifyYaml({
      apiVersion: 'llamactl/v1',
      kind: 'Config',
      currentContext: 'default',
      contexts: [{ name: 'default', cluster: 'home', user: 'me' }],
      clusters: [{ name: 'home', nodes: [] }],
      users: [{ name: 'me', token: 'fake-demo-token' }],
    }),
  );
}

describe('siriusHandler — reload flow', () => {
  test('2xx reload → Running + Applied:True and records the POST', async () => {
    seedKubeconfig();
    writeFileSync(
      join(runtimeDir, 'sirius-providers.yaml'),
      stringifyYaml({
        apiVersion: 'llamactl/v1',
        kind: 'SiriusProviderList',
        providers: [{ name: 'openai', kind: 'openai' }],
      }),
    );
    const server = await startFakeGateway('/providers/reload');
    try {
      const node: ClusterNode = {
        name: 'sirius-primary',
        endpoint: '',
        kind: 'gateway',
        cloud: { provider: 'sirius', baseUrl: server.url },
      };
      const result = await siriusHandler.apply({
        manifest: gatewayManifest('sirius-primary', 'openai/gpt-4o'),
        node,
        getClient: () => {
          throw new Error('should not call getClient for sirius path');
        },
      });
      expect(result.statusSection.phase).toBe('Running');
      expect(result.statusSection.conditions[0]?.reason).toBe('SiriusReloaded');
      expect(result.statusSection.endpoint).toContain('/v1/chat/completions');

      expect(server.calls).toHaveLength(1);
      const call = server.calls[0]!;
      expect(call.method).toBe('POST');
      expect(call.auth).toBe('Bearer fake-demo-token');
      const payload = JSON.parse(call.body) as { source: string; name: string };
      expect(payload.source).toBe('llamactl-workload');
      expect(payload.name).toBe('register-sirius-primary');
    } finally {
      await server.stop();
    }
  });

  test('non-2xx reload → Failed + SiriusReloadFailed carrying the status', async () => {
    seedKubeconfig();
    writeFileSync(
      join(runtimeDir, 'sirius-providers.yaml'),
      stringifyYaml({
        apiVersion: 'llamactl/v1',
        kind: 'SiriusProviderList',
        providers: [{ name: 'openai', kind: 'openai' }],
      }),
    );
    const server = await startFakeGateway('/providers/reload', {
      status: 503,
      bodyOnFailure: 'sirius is reloading',
    });
    try {
      const node: ClusterNode = {
        name: 'sirius-primary',
        endpoint: '',
        kind: 'gateway',
        cloud: { provider: 'sirius', baseUrl: server.url },
      };
      const result = await siriusHandler.apply({
        manifest: gatewayManifest('sirius-primary', 'openai/gpt-4o'),
        node,
        getClient: () => {
          throw new Error('unreachable');
        },
      });
      expect(result.statusSection.phase).toBe('Failed');
      expect(result.statusSection.conditions[0]?.reason).toBe('SiriusReloadFailed');
      expect(result.statusSection.conditions[0]?.message).toContain('503');
    } finally {
      await server.stop();
    }
  });
});

describe('embersynthHandler — reload flow', () => {
  test('2xx reload → Running + Applied:True', async () => {
    seedKubeconfig();
    writeFileSync(
      join(runtimeDir, 'embersynth.yaml'),
      stringifyYaml({
        server: { host: '127.0.0.1', port: 7777 },
        nodes: [],
        profiles: [],
        syntheticModels: { 'fusion-vision': 'vision' },
      }),
    );
    const server = await startFakeGateway('/config/reload');
    try {
      const node: ClusterNode = {
        name: 'embersynth-primary',
        endpoint: '',
        kind: 'gateway',
        cloud: { provider: 'embersynth', baseUrl: server.url },
      };
      const result = await embersynthHandler.apply({
        manifest: gatewayManifest('embersynth-primary', 'fusion-vision'),
        node,
        getClient: () => {
          throw new Error('unreachable');
        },
      });
      expect(result.statusSection.phase).toBe('Running');
      expect(result.statusSection.conditions[0]?.reason).toBe('EmbersynthReloaded');
      expect(server.calls).toHaveLength(1);
      const payload = JSON.parse(server.calls[0]!.body) as {
        syntheticModel: string;
      };
      expect(payload.syntheticModel).toBe('fusion-vision');
    } finally {
      await server.stop();
    }
  });

  test('unknown synthetic → Pending + EmbersynthSyntheticMissing', async () => {
    seedKubeconfig();
    writeFileSync(
      join(runtimeDir, 'embersynth.yaml'),
      stringifyYaml({
        server: { host: '127.0.0.1', port: 7777 },
        nodes: [],
        profiles: [],
        syntheticModels: { 'fusion-auto': 'auto' },
      }),
    );
    const node: ClusterNode = {
      name: 'embersynth-primary',
      endpoint: '',
      kind: 'gateway',
      cloud: { provider: 'embersynth', baseUrl: 'http://not-reached' },
    };
    const result = await embersynthHandler.apply({
      manifest: gatewayManifest('embersynth-primary', 'fusion-vision'),
      node,
      getClient: () => {
        throw new Error('unreachable');
      },
    });
    expect(result.statusSection.phase).toBe('Pending');
    expect(result.statusSection.conditions[0]?.reason).toBe('EmbersynthSyntheticMissing');
  });
});
