import { describe, expect, test } from 'bun:test';
import { KubeConfig } from '@kubernetes/client-node';

import {
  KubernetesBackend,
  createKubernetesBackend,
} from '../src/runtime/kubernetes/backend.js';
import { RuntimeError } from '../src/runtime/errors.js';

/**
 * K8s Phase 2 — skeleton + ping() tests. Injects a stub KubeConfig so
 * nothing reads ~/.kube/config on the test host. Phases 3-5 will add
 * ensureService / removeService / inspectService / listServices.
 */

function stubKubeConfig(opts: {
  pingBehavior: 'ok' | 'throw';
  currentContext?: string;
  namespace?: string;
}): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: 'stub-cluster', server: 'https://example.invalid' }],
    users: [{ name: 'stub-user', token: 'test-token' }],
    contexts: [
      {
        name: opts.currentContext ?? 'stub-context',
        cluster: 'stub-cluster',
        user: 'stub-user',
        ...(opts.namespace !== undefined && { namespace: opts.namespace }),
      },
    ],
    currentContext: opts.currentContext ?? 'stub-context',
  });
  // Replace makeApiClient so our "ping" path doesn't hit the network.
  // The real method returns a typed API; we substitute a minimal object
  // with `getAPIResources` matching ping's expectation.
  const originalMake = kc.makeApiClient.bind(kc);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kc.makeApiClient = (apiClass: any): any => {
    const stub = originalMake(apiClass);
    // Override getAPIResources based on the test's intent.
    (stub as unknown as { getAPIResources: () => Promise<unknown> }).getAPIResources =
      opts.pingBehavior === 'ok'
        ? async () => ({ groupVersion: 'v1', resources: [] })
        : async () => {
            throw new Error('stub: connection refused');
          };
    return stub;
  };
  return kc;
}

describe('KubernetesBackend constructor', () => {
  test('reads current-context + namespace from the injected kubeconfig', () => {
    const backend = new KubernetesBackend({
      kubeConfig: stubKubeConfig({
        pingBehavior: 'ok',
        currentContext: 'my-ctx',
        namespace: 'my-ns',
      }),
    });
    expect(backend.kind).toBe('kubernetes');
    expect(backend.currentContext).toBe('my-ctx');
    expect(backend.namespaceFor('kb-stack')).toBe('llamactl-kb-stack');
  });

  test('default namespace prefix is `llamactl`', () => {
    const backend = new KubernetesBackend({
      kubeConfig: stubKubeConfig({ pingBehavior: 'ok' }),
    });
    expect(backend.namespaceFor('demo')).toBe('llamactl-demo');
  });

  test('namespacePrefix override', () => {
    const backend = new KubernetesBackend({
      kubeConfig: stubKubeConfig({ pingBehavior: 'ok' }),
      namespacePrefix: 'acme-llamactl',
    });
    expect(backend.namespaceFor('demo')).toBe('acme-llamactl-demo');
  });

  test('storageClassName defaults to undefined', () => {
    const backend = new KubernetesBackend({
      kubeConfig: stubKubeConfig({ pingBehavior: 'ok' }),
    });
    expect(backend.storageClassName).toBeUndefined();
  });

  test('storageClassName override', () => {
    const backend = new KubernetesBackend({
      kubeConfig: stubKubeConfig({ pingBehavior: 'ok' }),
      storageClassName: 'local-path',
    });
    expect(backend.storageClassName).toBe('local-path');
  });
});

describe('KubernetesBackend.ping', () => {
  test('resolves when cluster responds to getAPIResources', async () => {
    const backend = new KubernetesBackend({
      kubeConfig: stubKubeConfig({ pingBehavior: 'ok' }),
    });
    await backend.ping();
  });

  test('surfaces backend-unreachable with the cause attached', async () => {
    const backend = new KubernetesBackend({
      kubeConfig: stubKubeConfig({ pingBehavior: 'throw' }),
    });
    try {
      await backend.ping();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeError);
      expect((err as RuntimeError).code).toBe('backend-unreachable');
      expect((err as RuntimeError).message).toContain('kubernetes unreachable');
      expect((err as RuntimeError).message).toContain('connection refused');
    }
  });
});

describe('KubernetesBackend — unimplemented stubs throw cleanly', () => {
  test('ensureService throws backend-unreachable until Phase 3 lands', async () => {
    const backend = new KubernetesBackend({
      kubeConfig: stubKubeConfig({ pingBehavior: 'ok' }),
    });
    await expect(
      backend.ensureService({
        name: 'x',
        image: { repository: 'busybox', tag: '1' },
        specHash: 'h',
      }),
    ).rejects.toThrow(/not implemented yet/);
  });

  test('removeService, inspectService, listServices all throw not-implemented', async () => {
    const backend = new KubernetesBackend({
      kubeConfig: stubKubeConfig({ pingBehavior: 'ok' }),
    });
    await expect(backend.removeService({ name: 'x' })).rejects.toThrow(/not implemented/);
    await expect(backend.inspectService({ name: 'x' })).rejects.toThrow(/not implemented/);
    await expect(backend.listServices()).rejects.toThrow(/not implemented/);
  });
});

describe('createKubernetesBackend factory', () => {
  test('returns a RuntimeBackend instance with kind=kubernetes', () => {
    const backend = createKubernetesBackend({
      kubeConfig: stubKubeConfig({ pingBehavior: 'ok' }),
    });
    expect(backend.kind).toBe('kubernetes');
  });
});
