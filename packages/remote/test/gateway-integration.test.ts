import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { applyOne, type WorkloadClient } from '../src/workload/apply.js';
import { dispatchGatewayApply } from '../src/workload/gateway-handlers/index.js';
import type { ClusterNode } from '../src/config/schema.js';
import type { ModelRun } from '../src/workload/schema.js';

/**
 * K.7.5 — full integration. Drives `applyOne` with a real gateway
 * dispatcher attached, asserts the whole path (applyOne → dispatcher
 * → sirius handler → fake reload server → manifest status)
 * round-trips coherently.
 */

async function startFakeGateway(
  path: string,
  status = 200,
): Promise<{
  url: string;
  calls: Array<{ method: string; url: string; auth: string | null; body: string }>;
  stop: () => Promise<void>;
}> {
  const calls: Array<{
    method: string;
    url: string;
    auth: string | null;
    body: string;
  }> = [];
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
        return new Response(status >= 200 && status < 300 ? '{"ok":true}' : 'fake failure', {
          status,
          headers: { 'content-type': 'application/json' },
        });
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
  runtimeDir = mkdtempSync(join(tmpdir(), 'llamactl-gateway-int-'));
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

function seedKubeconfig(nodes: ClusterNode[]): void {
  writeFileSync(
    join(runtimeDir, 'kubeconfig'),
    stringifyYaml({
      apiVersion: 'llamactl/v1',
      kind: 'Config',
      currentContext: 'default',
      contexts: [{ name: 'default', cluster: 'home', user: 'me' }],
      clusters: [{ name: 'home', nodes }],
      users: [{ name: 'me', token: 'integ-token' }],
    }),
  );
}

function manifest(node: string, target: string): ModelRun {
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

const unreachableClient = (): WorkloadClient => {
  throw new Error('should not call getClient on a gateway path');
};

describe('applyOne + gateway dispatch — sirius end-to-end', () => {
  test('2xx reload path lands phase=Running + action=started', async () => {
    const fake = await startFakeGateway('/providers/reload');
    try {
      const node: ClusterNode = {
        name: 'sirius-primary',
        endpoint: '',
        kind: 'gateway',
        cloud: { provider: 'sirius', baseUrl: fake.url },
      };
      seedKubeconfig([node]);
      writeFileSync(
        join(runtimeDir, 'sirius-providers.yaml'),
        stringifyYaml({
          apiVersion: 'llamactl/v1',
          kind: 'SiriusProviderList',
          providers: [{ name: 'openai', kind: 'openai' }],
        }),
      );
      const m = manifest('sirius-primary', 'openai/gpt-4o');
      const result = await applyOne(
        m,
        unreachableClient,
        undefined,
        (opts) =>
          dispatchGatewayApply({
            manifest: opts.manifest,
            getClient: opts.getClient,
            resolveNode: () => node,
            ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
          }),
      );
      expect(result.action).toBe('started');
      expect(result.statusSection.phase).toBe('Running');
      expect(result.statusSection.conditions[0]?.reason).toBe('SiriusReloaded');
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]!.auth).toBe('Bearer integ-token');
    } finally {
      await fake.stop();
    }
  });

  test('unknown node short-circuits before touching the handler', async () => {
    seedKubeconfig([]); // no gateway registered
    const m = manifest('ghost-gateway', 'openai/gpt-4o');
    const result = await applyOne(
      m,
      unreachableClient,
      undefined,
      (opts) =>
        dispatchGatewayApply({
          manifest: opts.manifest,
          getClient: opts.getClient,
          resolveNode: () => undefined,
          ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
        }),
    );
    expect(result.statusSection.phase).toBe('Pending');
    expect(result.statusSection.conditions[0]?.reason).toBe('GatewayNodeUnknown');
  });

  test('reload non-2xx surfaces as Failed + SiriusReloadFailed', async () => {
    const fake = await startFakeGateway('/providers/reload', 502);
    try {
      const node: ClusterNode = {
        name: 'sirius-primary',
        endpoint: '',
        kind: 'gateway',
        cloud: { provider: 'sirius', baseUrl: fake.url },
      };
      seedKubeconfig([node]);
      writeFileSync(
        join(runtimeDir, 'sirius-providers.yaml'),
        stringifyYaml({
          apiVersion: 'llamactl/v1',
          kind: 'SiriusProviderList',
          providers: [{ name: 'openai', kind: 'openai' }],
        }),
      );
      const result = await applyOne(
        manifest('sirius-primary', 'openai/gpt-4o'),
        unreachableClient,
        undefined,
        (opts) =>
          dispatchGatewayApply({
            manifest: opts.manifest,
            getClient: opts.getClient,
            resolveNode: () => node,
            ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
          }),
      );
      expect(result.statusSection.phase).toBe('Failed');
      expect(result.statusSection.conditions[0]?.reason).toBe('SiriusReloadFailed');
    } finally {
      await fake.stop();
    }
  });
});
