import { describe, expect, test } from 'bun:test';
import {
  AppsV1Api,
  CoreV1Api,
  KubeConfig,
  type V1Deployment,
  type V1Namespace,
  type V1PersistentVolumeClaim,
  type V1Secret,
  type V1Service,
  type V1StatefulSet,
} from '@kubernetes/client-node';

import {
  KubernetesBackend,
  createKubernetesBackend,
} from '../src/runtime/kubernetes/backend.js';
import { RuntimeError } from '../src/runtime/errors.js';
import {
  K8S_ANNOTATION_KEYS,
  K8S_LABEL_KEYS,
} from '../src/runtime/kubernetes/labels.js';
import type { ServiceDeployment } from '../src/runtime/backend.js';

/**
 * Phase 2 + 3 — backend tests. Phase 2 covers skeleton + ping(); Phase
 * 3 covers ensureService → Deployment path + ensureNamespace +
 * resolveSecrets. The stub KubeConfig keeps the real loader from
 * touching `~/.kube/config`. For Phase 3 we swap makeApiClient for a
 * recorded-call API stub so the tests can assert the exact k8s
 * client calls the backend made and the bodies it shipped.
 */

interface ApiStubOptions {
  pingBehavior?: 'ok' | 'throw';
  /**
   * Map of `resourceKey → handler`. Keys look like
   * `core.readNamespace`, `apps.createNamespacedDeployment`, etc.
   * Handlers return the canned response body or throw ApiException-
   * shaped errors. The stub records every invocation for assertion.
   */
  handlers?: Record<string, (params: Record<string, unknown>) => unknown>;
}

interface RecordedCall {
  api: 'core' | 'apps';
  method: string;
  params: Record<string, unknown>;
}

interface ApiStubInstance {
  kubeConfig: KubeConfig;
  calls: RecordedCall[];
}

/**
 * Build a stub KubeConfig whose `makeApiClient(Core|AppsV1Api)`
 * returns an object that records every method call into `calls[]`
 * and routes handlers through `handlers` by `<api>.<method>`.
 */
function stubKubeConfig(opts: ApiStubOptions = {}): ApiStubInstance {
  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: 'stub-cluster', server: 'https://example.invalid' }],
    users: [{ name: 'stub-user', token: 'test-token' }],
    contexts: [
      {
        name: 'stub-context',
        cluster: 'stub-cluster',
        user: 'stub-user',
      },
    ],
    currentContext: 'stub-context',
  });
  const calls: RecordedCall[] = [];
  const handlers = opts.handlers ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kc.makeApiClient = (apiClass: any): any => {
    const kind: 'core' | 'apps' =
      apiClass === AppsV1Api
        ? 'apps'
        : apiClass === CoreV1Api
          ? 'core'
          : 'core';
    // A Proxy wraps every method access — tests can swap handlers
    // without enumerating every method; missing handlers throw a
    // clear error so the backend's API-surface usage stays tight.
    return new Proxy(
      {},
      {
        get(_target, method: string) {
          if (method === 'getAPIResources') {
            // ping() codepath — keep the Phase 2 behaviour.
            return async () => {
              if (opts.pingBehavior === 'throw') {
                throw new Error('stub: connection refused');
              }
              return { groupVersion: 'v1', resources: [] };
            };
          }
          return async (params: Record<string, unknown> = {}) => {
            calls.push({ api: kind, method, params });
            const key = `${kind}.${method}`;
            const handler = handlers[key];
            if (!handler) {
              throw new Error(`no stub handler for '${key}'`);
            }
            return handler(params);
          };
        },
      },
    );
  };
  return { kubeConfig: kc, calls };
}

/** Shape of the ApiException thrown by @kubernetes/client-node 1.4.0. */
class StubApiException extends Error {
  constructor(
    public code: number,
    msg: string,
  ) {
    super(msg);
    this.name = 'ApiException';
  }
}

function notFound(msg = 'Not Found'): StubApiException {
  return new StubApiException(404, msg);
}

function sampleSpec(
  overrides: Partial<ServiceDeployment> = {},
): ServiceDeployment {
  return {
    name: 'chroma-main',
    image: { repository: 'chromadb/chroma', tag: '1.5.8' },
    specHash: 'hash-v1',
    ports: [{ containerPort: 8000 }],
    labels: { [K8S_LABEL_KEYS.composite]: 'kb' },
    ...overrides,
  };
}

function readyDeployment(spec: ServiceDeployment): V1Deployment {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: spec.name,
      namespace: 'llamactl-kb',
      annotations: { [K8S_ANNOTATION_KEYS.specHash]: spec.specHash },
      creationTimestamp: new Date('2026-04-20T15:00:00Z'),
    },
    status: { readyReplicas: 1, replicas: 1 },
  };
}

describe('KubernetesBackend constructor', () => {
  test('reads current-context from the injected kubeconfig', () => {
    const backend = new KubernetesBackend({
      kubeConfig: stubKubeConfig({ pingBehavior: 'ok' }).kubeConfig,
    });
    expect(backend.kind).toBe('kubernetes');
    expect(backend.currentContext).toBe('stub-context');
    expect(backend.namespaceFor('kb-stack')).toBe('llamactl-kb-stack');
  });

  test('default namespace prefix is `llamactl`', () => {
    const backend = new KubernetesBackend({
      kubeConfig: stubKubeConfig({ pingBehavior: 'ok' }).kubeConfig,
    });
    expect(backend.namespaceFor('demo')).toBe('llamactl-demo');
  });

  test('namespacePrefix override', () => {
    const backend = new KubernetesBackend({
      kubeConfig: stubKubeConfig({ pingBehavior: 'ok' }).kubeConfig,
      namespacePrefix: 'acme-llamactl',
    });
    expect(backend.namespaceFor('demo')).toBe('acme-llamactl-demo');
  });

  test('storageClassName defaults to undefined', () => {
    const backend = new KubernetesBackend({
      kubeConfig: stubKubeConfig({ pingBehavior: 'ok' }).kubeConfig,
    });
    expect(backend.storageClassName).toBeUndefined();
  });

  test('storageClassName override', () => {
    const backend = new KubernetesBackend({
      kubeConfig: stubKubeConfig({ pingBehavior: 'ok' }).kubeConfig,
      storageClassName: 'local-path',
    });
    expect(backend.storageClassName).toBe('local-path');
  });
});

describe('KubernetesBackend.ping', () => {
  test('resolves when cluster responds to getAPIResources', async () => {
    const backend = new KubernetesBackend({
      kubeConfig: stubKubeConfig({ pingBehavior: 'ok' }).kubeConfig,
    });
    await backend.ping();
  });

  test('surfaces backend-unreachable with the cause attached', async () => {
    const backend = new KubernetesBackend({
      kubeConfig: stubKubeConfig({ pingBehavior: 'throw' }).kubeConfig,
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

describe('KubernetesBackend.ensureService — Deployment happy path', () => {
  test('fresh composite: namespace + deployment + service created, no pvc/secret', async () => {
    const spec = sampleSpec();
    const namespaceCreated: V1Namespace[] = [];
    const deploymentsCreated: V1Deployment[] = [];
    const servicesCreated: V1Service[] = [];
    let readsAfterCreate = 0;

    const stub = stubKubeConfig({
      handlers: {
        'core.readNamespace': () => {
          throw notFound();
        },
        'core.createNamespace': (p) => {
          namespaceCreated.push(p.body as V1Namespace);
          return p.body;
        },
        'core.readNamespacedService': () => {
          throw notFound();
        },
        'core.createNamespacedService': (p) => {
          servicesCreated.push(p.body as V1Service);
          return p.body;
        },
        'apps.readNamespacedDeployment': (p) => {
          // First call pre-create: 404. After create we poll — return
          // the created Deployment with readyReplicas = 1.
          if (deploymentsCreated.length === 0) throw notFound();
          readsAfterCreate++;
          return readyDeployment(spec);
        },
        'apps.createNamespacedDeployment': (p) => {
          deploymentsCreated.push(p.body as V1Deployment);
          return readyDeployment(spec);
        },
      },
    });
    const backend = new KubernetesBackend({
      kubeConfig: stub.kubeConfig,
      readinessPollMs: 1,
      readinessTimeoutMs: 500,
    });

    const instance = await backend.ensureService(spec);

    expect(namespaceCreated).toHaveLength(1);
    expect(namespaceCreated[0]?.metadata?.name).toBe('llamactl-kb');
    expect(deploymentsCreated).toHaveLength(1);
    expect(servicesCreated).toHaveLength(1);

    // No Secret nor PVC should have been touched.
    expect(
      stub.calls.filter((c) => c.method.includes('Secret')),
    ).toHaveLength(0);
    expect(
      stub.calls.filter((c) => c.method.includes('PersistentVolumeClaim')),
    ).toHaveLength(0);

    expect(instance.ref).toEqual({ name: 'chroma-main' });
    expect(instance.running).toBe(true);
    expect(instance.health).toBe('healthy');
    expect(instance.specHash).toBe('hash-v1');
    expect(instance.endpoint).toEqual({
      host: 'chroma-main.llamactl-kb.svc.cluster.local',
      port: 8000,
    });
    // Guard: we shouldn't be polling once the create returns a ready
    // deployment (it already reported readyReplicas=1).
    expect(readsAfterCreate).toBe(0);
  });

  test('with secrets: Secret created + deployment env uses secretKeyRef', async () => {
    const spec = sampleSpec({
      secrets: { POSTGRES_PASSWORD: { ref: 'env:TEST_SECRET_PW' } },
    });
    const previousValue = process.env.TEST_SECRET_PW;
    process.env.TEST_SECRET_PW = 'rotating-pw';

    const secretsCreated: V1Secret[] = [];
    const deploymentsCreated: V1Deployment[] = [];

    const stub = stubKubeConfig({
      handlers: {
        'core.readNamespace': () => ({ metadata: { name: 'llamactl-kb' } }),
        'core.readNamespacedSecret': () => {
          throw notFound();
        },
        'core.createNamespacedSecret': (p) => {
          secretsCreated.push(p.body as V1Secret);
          return p.body;
        },
        'core.readNamespacedService': () => {
          throw notFound();
        },
        'core.createNamespacedService': (p) => p.body,
        'apps.readNamespacedDeployment': () => {
          if (deploymentsCreated.length === 0) throw notFound();
          return readyDeployment(spec);
        },
        'apps.createNamespacedDeployment': (p) => {
          deploymentsCreated.push(p.body as V1Deployment);
          return readyDeployment(spec);
        },
      },
    });
    const backend = new KubernetesBackend({
      kubeConfig: stub.kubeConfig,
      readinessPollMs: 1,
      readinessTimeoutMs: 500,
    });

    try {
      await backend.ensureService(spec);
    } finally {
      if (previousValue === undefined) {
        delete process.env.TEST_SECRET_PW;
      } else {
        process.env.TEST_SECRET_PW = previousValue;
      }
    }

    expect(secretsCreated).toHaveLength(1);
    expect(secretsCreated[0]?.type).toBe('Opaque');
    expect(secretsCreated[0]?.data?.POSTGRES_PASSWORD).toBe(
      Buffer.from('rotating-pw', 'utf8').toString('base64'),
    );

    const env = deploymentsCreated[0]?.spec?.template.spec?.containers[0]?.env ?? [];
    const sref = env.find((e) => e.name === 'POSTGRES_PASSWORD');
    expect(sref?.valueFrom?.secretKeyRef?.name).toBe('chroma-main-secrets');
    expect(sref?.valueFrom?.secretKeyRef?.key).toBe('POSTGRES_PASSWORD');
    // Plain value must never be serialised into the Deployment env.
    expect(env.some((e) => e.value === 'rotating-pw')).toBe(false);
  });

  test('with volumes: PVC created; second apply same hash does NOT replace PVC', async () => {
    const spec = sampleSpec({
      volumes: [{ hostPath: '/var/lib/chroma', containerPath: '/data' }],
    });
    const pvcsCreated: V1PersistentVolumeClaim[] = [];
    let deploymentExists = false;
    const existingDeployment = () => readyDeployment(spec);

    const stub = stubKubeConfig({
      handlers: {
        'core.readNamespace': () => ({ metadata: { name: 'llamactl-kb' } }),
        'core.readNamespacedPersistentVolumeClaim': (p) => {
          // After first create, the PVC exists — return it so the
          // backend's "do not replace" branch runs.
          if (pvcsCreated.length === 0) throw notFound();
          return pvcsCreated[0];
        },
        'core.createNamespacedPersistentVolumeClaim': (p) => {
          pvcsCreated.push(p.body as V1PersistentVolumeClaim);
          return p.body;
        },
        'core.readNamespacedService': () => {
          if (!deploymentExists) throw notFound();
          return {
            apiVersion: 'v1',
            kind: 'Service',
            metadata: {
              name: 'chroma-main',
              annotations: { [K8S_ANNOTATION_KEYS.specHash]: spec.specHash },
            },
            spec: { ports: [{ port: 8000 }] },
          } as V1Service;
        },
        'core.createNamespacedService': (p) => p.body,
        'apps.readNamespacedDeployment': () => {
          if (!deploymentExists) throw notFound();
          return existingDeployment();
        },
        'apps.createNamespacedDeployment': (p) => {
          deploymentExists = true;
          return existingDeployment();
        },
      },
    });
    const backend = new KubernetesBackend({
      kubeConfig: stub.kubeConfig,
      readinessPollMs: 1,
      readinessTimeoutMs: 500,
    });

    await backend.ensureService(spec);
    expect(pvcsCreated).toHaveLength(1);
    expect(pvcsCreated[0]?.metadata?.name).toBe('chroma-main-data');

    // Reset call log, then apply AGAIN with the same hash.
    stub.calls.length = 0;
    await backend.ensureService(spec);

    // The PVC is read (idempotency check) but NEVER replaced on drift.
    const pvcCalls = stub.calls.filter((c) =>
      c.method.includes('PersistentVolumeClaim'),
    );
    expect(pvcCalls.map((c) => c.method)).toEqual([
      'readNamespacedPersistentVolumeClaim',
    ]);
    expect(pvcsCreated).toHaveLength(1);
  });
});

describe('KubernetesBackend.ensureService — idempotency + drift', () => {
  test('spec-hash match → no create/replace on deployment, returns running instance', async () => {
    const spec = sampleSpec();
    const stub = stubKubeConfig({
      handlers: {
        'core.readNamespace': () => ({ metadata: { name: 'llamactl-kb' } }),
        'core.readNamespacedService': () => ({
          apiVersion: 'v1',
          kind: 'Service',
          metadata: {
            name: 'chroma-main',
            annotations: { [K8S_ANNOTATION_KEYS.specHash]: 'hash-v1' },
          },
          spec: { ports: [{ port: 8000 }] },
        }),
        'apps.readNamespacedDeployment': () => readyDeployment(spec),
      },
    });
    const backend = new KubernetesBackend({
      kubeConfig: stub.kubeConfig,
      readinessPollMs: 1,
      readinessTimeoutMs: 500,
    });

    const instance = await backend.ensureService(spec);
    expect(instance.running).toBe(true);
    expect(instance.specHash).toBe('hash-v1');

    const methods = stub.calls.map((c) => `${c.api}.${c.method}`);
    expect(methods).not.toContain('apps.createNamespacedDeployment');
    expect(methods).not.toContain('apps.replaceNamespacedDeployment');
    expect(methods).not.toContain('core.createNamespacedService');
    expect(methods).not.toContain('core.replaceNamespacedService');
  });

  test('spec-hash drift → replaceNamespacedDeployment called', async () => {
    const spec = sampleSpec({ specHash: 'hash-v2' });
    const replaced: V1Deployment[] = [];
    const stub = stubKubeConfig({
      handlers: {
        'core.readNamespace': () => ({ metadata: { name: 'llamactl-kb' } }),
        'core.readNamespacedService': () => ({
          apiVersion: 'v1',
          kind: 'Service',
          metadata: {
            name: 'chroma-main',
            resourceVersion: '99',
            annotations: { [K8S_ANNOTATION_KEYS.specHash]: 'hash-v1' },
          },
          spec: { ports: [{ port: 8000 }], clusterIP: '10.0.0.1' },
        }),
        'core.replaceNamespacedService': (p) => p.body,
        'apps.readNamespacedDeployment': () => ({
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: {
            name: 'chroma-main',
            resourceVersion: '100',
            annotations: { [K8S_ANNOTATION_KEYS.specHash]: 'hash-v1' },
            creationTimestamp: new Date('2026-04-20T15:00:00Z'),
          },
          status: { readyReplicas: 1, replicas: 1 },
        }),
        'apps.replaceNamespacedDeployment': (p) => {
          replaced.push(p.body as V1Deployment);
          return readyDeployment(spec);
        },
      },
    });
    const backend = new KubernetesBackend({
      kubeConfig: stub.kubeConfig,
      readinessPollMs: 1,
      readinessTimeoutMs: 500,
    });

    const instance = await backend.ensureService(spec);
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.metadata?.resourceVersion).toBe('100');
    expect(instance.specHash).toBe('hash-v2');

    const methods = stub.calls.map((c) => `${c.api}.${c.method}`);
    expect(methods).toContain('apps.replaceNamespacedDeployment');
    expect(methods).toContain('core.replaceNamespacedService');
  });
});

describe('KubernetesBackend.ensureService — validation + failure modes', () => {
  test('missing secret ref → spec-invalid naming the env var', async () => {
    delete process.env.LL_TEST_MISSING_PW;
    const spec = sampleSpec({
      secrets: { POSTGRES_PASSWORD: { ref: 'env:LL_TEST_MISSING_PW' } },
    });
    const stub = stubKubeConfig({
      handlers: {
        'core.readNamespace': () => ({ metadata: { name: 'llamactl-kb' } }),
      },
    });
    const backend = new KubernetesBackend({
      kubeConfig: stub.kubeConfig,
    });

    try {
      await backend.ensureService(spec);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeError);
      const re = err as RuntimeError;
      expect(re.code).toBe('spec-invalid');
      expect(re.message).toContain("'POSTGRES_PASSWORD'");
      expect(re.message).toContain('LL_TEST_MISSING_PW');
    }
  });

  test('polling timeout → start-failed', async () => {
    const spec = sampleSpec();
    // Deployment create returns readyReplicas=0; each poll round-
    // trips through readNamespacedDeployment which also returns
    // readyReplicas=0. We keep the read branch (not 404) alive so
    // the "disappeared" branch doesn't trip.
    let reads = 0;
    const stub = stubKubeConfig({
      handlers: {
        'core.readNamespace': () => ({ metadata: { name: 'llamactl-kb' } }),
        'core.readNamespacedService': () => {
          throw notFound();
        },
        'core.createNamespacedService': (p) => p.body,
        'apps.readNamespacedDeployment': () => {
          reads++;
          if (reads === 1) throw notFound();
          return {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: {
              name: 'chroma-main',
              annotations: { [K8S_ANNOTATION_KEYS.specHash]: 'hash-v1' },
              creationTimestamp: new Date('2026-04-20T15:00:00Z'),
            },
            status: { readyReplicas: 0, replicas: 1 },
          } as V1Deployment;
        },
        'apps.createNamespacedDeployment': (p) => ({
          ...(p.body as V1Deployment),
          metadata: {
            ...((p.body as V1Deployment).metadata ?? {}),
            creationTimestamp: new Date('2026-04-20T15:00:00Z'),
          },
          status: { readyReplicas: 0, replicas: 1 },
        }),
      },
    });
    const backend = new KubernetesBackend({
      kubeConfig: stub.kubeConfig,
      readinessPollMs: 5,
      readinessTimeoutMs: 30,
    });

    try {
      await backend.ensureService(spec);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeError);
      const re = err as RuntimeError;
      expect(re.code).toBe('start-failed');
      expect(re.message).toContain('chroma-main');
      expect(re.message).toContain('not ready');
    }
  });

  test('empty image.tag rejected with spec-invalid', async () => {
    const backend = new KubernetesBackend({
      kubeConfig: stubKubeConfig({}).kubeConfig,
    });
    await expect(
      backend.ensureService({
        name: 'x',
        image: { repository: 'busybox', tag: '' },
        specHash: 'h',
      }),
    ).rejects.toThrow(/image.tag is required/);
  });

});

describe('KubernetesBackend.ensureService — StatefulSet happy path', () => {
  test('fresh pgvector: secret + 2 services + statefulset, volumeClaimTemplates inline', async () => {
    const spec = sampleSpec({
      name: 'pg-main',
      image: { repository: 'pgvector/pgvector', tag: '0.8.2-pg18-trixie' },
      specHash: 'hash-v1',
      ports: [{ containerPort: 5432 }],
      controllerKind: 'statefulset',
      volumes: [{ containerPath: '/var/lib/postgresql/data' }],
      secrets: {
        POSTGRES_PASSWORD: { ref: 'env:K8S_TEST_PG_PW' },
      },
    });
    process.env.K8S_TEST_PG_PW = 'super-secret';

    let statefulSetReadCount = 0;
    const servicesCreated: string[] = [];
    const secretCreated: V1Secret[] = [];
    const statefulSetsCreated: V1StatefulSet[] = [];

    const stub = stubKubeConfig({
      handlers: {
        'core.readNamespace': () => {
          throw notFound();
        },
        'core.createNamespace': (p) => p.body as V1Namespace,
        'core.readNamespacedSecret': () => {
          throw notFound();
        },
        'core.createNamespacedSecret': (p) => {
          const body = p.body as V1Secret;
          secretCreated.push(body);
          return body;
        },
        'core.readNamespacedService': () => {
          throw notFound();
        },
        'core.createNamespacedService': (p) => {
          const body = p.body as V1Service;
          if (body.metadata?.name) servicesCreated.push(body.metadata.name);
          return body;
        },
        'apps.readNamespacedStatefulSet': () => {
          statefulSetReadCount++;
          if (statefulSetReadCount === 1) throw notFound();
          const ss: V1StatefulSet = {
            apiVersion: 'apps/v1',
            kind: 'StatefulSet',
            metadata: {
              name: spec.name,
              namespace: 'llamactl-kb',
              annotations: { [K8S_ANNOTATION_KEYS.specHash]: spec.specHash },
              creationTimestamp: new Date('2026-04-21T10:00:00Z'),
            },
            status: { readyReplicas: 1, replicas: 1 },
          };
          return ss;
        },
        'apps.createNamespacedStatefulSet': (p) => {
          const body = p.body as V1StatefulSet;
          statefulSetsCreated.push(body);
          return body;
        },
      },
    });
    const backend = new KubernetesBackend({
      kubeConfig: stub.kubeConfig,
      readinessPollMs: 5,
      readinessTimeoutMs: 500,
    });

    const instance = await backend.ensureService(spec);

    expect(instance.running).toBe(true);
    expect(instance.health).toBe('healthy');
    expect(instance.specHash).toBe('hash-v1');
    // Headless + ClusterIP Service both created.
    expect(servicesCreated).toHaveLength(2);
    expect(servicesCreated).toContain('pg-main');
    // Secret materialized with base64 value — data keys include POSTGRES_PASSWORD.
    expect(secretCreated).toHaveLength(1);
    expect(secretCreated[0]?.data?.POSTGRES_PASSWORD).toBeDefined();
    // StatefulSet created with volumeClaimTemplates inline, not a separate PVC.
    expect(statefulSetsCreated).toHaveLength(1);
    const ss = statefulSetsCreated[0]!;
    expect(ss.spec?.volumeClaimTemplates?.length).toBeGreaterThan(0);
    // No PVC create call — StatefulSet owns its storage via templates.
    expect(
      stub.calls.some((c) => c.method === 'createNamespacedPersistentVolumeClaim'),
    ).toBe(false);

    delete process.env.K8S_TEST_PG_PW;
  });

  test('statefulset hash match → no replace', async () => {
    const spec = sampleSpec({
      name: 'pg-main',
      specHash: 'hash-v1',
      ports: [{ containerPort: 5432 }],
      controllerKind: 'statefulset',
    });
    let replaceCalled = false;
    const stub = stubKubeConfig({
      handlers: {
        'core.readNamespace': () => ({
          metadata: { name: 'llamactl-kb' },
        }),
        'core.readNamespacedService': (_p) => ({
          apiVersion: 'v1',
          kind: 'Service',
          metadata: {
            name: 'pg-main',
            namespace: 'llamactl-kb',
            annotations: { [K8S_ANNOTATION_KEYS.specHash]: 'hash-v1' },
            resourceVersion: '42',
          },
          spec: { ports: [{ port: 5432 }] },
        }),
        'apps.readNamespacedStatefulSet': () => ({
          apiVersion: 'apps/v1',
          kind: 'StatefulSet',
          metadata: {
            name: 'pg-main',
            namespace: 'llamactl-kb',
            annotations: { [K8S_ANNOTATION_KEYS.specHash]: 'hash-v1' },
            creationTimestamp: new Date('2026-04-21T10:00:00Z'),
            resourceVersion: '99',
          },
          status: { readyReplicas: 1, replicas: 1 },
        }),
        'apps.replaceNamespacedStatefulSet': (_p) => {
          replaceCalled = true;
          return {};
        },
      },
    });
    const backend = new KubernetesBackend({
      kubeConfig: stub.kubeConfig,
      readinessPollMs: 5,
      readinessTimeoutMs: 500,
    });

    const result = await backend.ensureService(spec);
    expect(result.specHash).toBe('hash-v1');
    expect(replaceCalled).toBe(false);
  });
});

describe('KubernetesBackend.removeService', () => {
  test('deletes Deployment + Services + Secret; no-op on missing', async () => {
    const deploymentDeletes: string[] = [];
    const serviceDeletes: string[] = [];
    const secretDeletes: string[] = [];
    const pvcDeletes: string[] = [];
    const stub = stubKubeConfig({
      handlers: {
        'apps.listDeploymentForAllNamespaces': () => ({
          items: [
            {
              apiVersion: 'apps/v1',
              kind: 'Deployment',
              metadata: {
                name: 'chroma-main',
                namespace: 'llamactl-kb',
                annotations: { [K8S_ANNOTATION_KEYS.specHash]: 'hash-v1' },
              },
            },
          ],
        }),
        'apps.deleteNamespacedDeployment': (p) => {
          deploymentDeletes.push(p.name as string);
          return { kind: 'Status', status: 'Success' };
        },
        'core.listNamespacedService': () => ({
          items: [
            { metadata: { name: 'chroma-main', namespace: 'llamactl-kb' } },
          ],
        }),
        'core.deleteNamespacedService': (p) => {
          serviceDeletes.push(p.name as string);
          return { kind: 'Status', status: 'Success' };
        },
        'core.deleteNamespacedSecret': (p) => {
          secretDeletes.push(p.name as string);
          return { kind: 'Status', status: 'Success' };
        },
        'core.deleteNamespacedPersistentVolumeClaim': (p) => {
          pvcDeletes.push(p.name as string);
          return { kind: 'Status', status: 'Success' };
        },
      },
    });
    const backend = new KubernetesBackend({
      kubeConfig: stub.kubeConfig,
      readinessPollMs: 5,
      readinessTimeoutMs: 500,
    });
    await backend.removeService({ name: 'chroma-main' });
    expect(deploymentDeletes).toEqual(['chroma-main']);
    expect(serviceDeletes).toEqual(['chroma-main']);
    expect(secretDeletes).toEqual(['chroma-main-secrets']);
    // purgeVolumes off by default → no PVC deletes
    expect(pvcDeletes).toEqual([]);
  });

  test('purgeVolumes=true deletes matching PVCs', async () => {
    const pvcDeletes: string[] = [];
    const stub = stubKubeConfig({
      handlers: {
        'apps.listDeploymentForAllNamespaces': () => ({
          items: [
            {
              apiVersion: 'apps/v1',
              kind: 'Deployment',
              metadata: {
                name: 'chroma-main',
                namespace: 'llamactl-kb',
              },
            },
          ],
        }),
        'apps.deleteNamespacedDeployment': () => ({}),
        'core.listNamespacedService': () => ({ items: [] }),
        'core.deleteNamespacedSecret': () => {
          throw notFound();
        },
        'core.listNamespacedPersistentVolumeClaim': () => ({
          items: [
            { metadata: { name: 'chroma-main-data', namespace: 'llamactl-kb' } },
            { metadata: { name: 'unrelated-data', namespace: 'llamactl-kb' } },
          ],
        }),
        'core.deleteNamespacedPersistentVolumeClaim': (p) => {
          pvcDeletes.push(p.name as string);
          return {};
        },
      },
    });
    const backend = new KubernetesBackend({
      kubeConfig: stub.kubeConfig,
      readinessPollMs: 5,
      readinessTimeoutMs: 500,
    });
    await backend.removeService(
      { name: 'chroma-main' },
      { purgeVolumes: true },
    );
    // Only the matching PVC deleted; unrelated PVC ignored.
    expect(pvcDeletes).toEqual(['chroma-main-data']);
  });

  test('falls back to StatefulSet when no Deployment matches', async () => {
    const ssDeletes: string[] = [];
    const stub = stubKubeConfig({
      handlers: {
        'apps.listDeploymentForAllNamespaces': () => ({ items: [] }),
        'apps.listStatefulSetForAllNamespaces': () => ({
          items: [
            {
              apiVersion: 'apps/v1',
              kind: 'StatefulSet',
              metadata: {
                name: 'pg-main',
                namespace: 'llamactl-kb',
              },
            },
          ],
        }),
        'apps.deleteNamespacedStatefulSet': (p) => {
          ssDeletes.push(p.name as string);
          return {};
        },
        'core.listNamespacedService': () => ({ items: [] }),
        'core.deleteNamespacedSecret': () => {
          throw notFound();
        },
      },
    });
    const backend = new KubernetesBackend({
      kubeConfig: stub.kubeConfig,
      readinessPollMs: 5,
      readinessTimeoutMs: 500,
    });
    await backend.removeService({ name: 'pg-main' });
    expect(ssDeletes).toEqual(['pg-main']);
  });

  test('missing service is a no-op', async () => {
    const stub = stubKubeConfig({
      handlers: {
        'apps.listDeploymentForAllNamespaces': () => ({ items: [] }),
        'apps.listStatefulSetForAllNamespaces': () => ({ items: [] }),
      },
    });
    const backend = new KubernetesBackend({
      kubeConfig: stub.kubeConfig,
      readinessPollMs: 5,
      readinessTimeoutMs: 500,
    });
    await backend.removeService({ name: 'does-not-exist' });
    // No delete calls issued.
    expect(
      stub.calls.filter((c) => c.method.startsWith('delete')),
    ).toHaveLength(0);
  });
});

describe('KubernetesBackend.inspectService', () => {
  test('returns running instance for a matched Deployment', async () => {
    const spec = sampleSpec();
    const stub = stubKubeConfig({
      handlers: {
        'apps.listDeploymentForAllNamespaces': () => ({
          items: [readyDeployment(spec)],
        }),
        'core.readNamespacedService': () => ({
          apiVersion: 'v1',
          kind: 'Service',
          metadata: {
            name: 'chroma-main',
            namespace: 'llamactl-kb',
          },
          spec: { ports: [{ port: 8000 }] },
        }),
      },
    });
    const backend = new KubernetesBackend({
      kubeConfig: stub.kubeConfig,
      readinessPollMs: 5,
      readinessTimeoutMs: 500,
    });
    const res = await backend.inspectService({ name: 'chroma-main' });
    expect(res).not.toBeNull();
    expect(res?.running).toBe(true);
    expect(res?.health).toBe('healthy');
    expect(res?.specHash).toBe('hash-v1');
    expect(res?.endpoint?.host).toBe('chroma-main.llamactl-kb.svc.cluster.local');
    expect(res?.endpoint?.port).toBe(8000);
  });

  test('returns null for unknown name', async () => {
    const stub = stubKubeConfig({
      handlers: {
        'apps.listDeploymentForAllNamespaces': () => ({ items: [] }),
        'apps.listStatefulSetForAllNamespaces': () => ({ items: [] }),
      },
    });
    const backend = new KubernetesBackend({
      kubeConfig: stub.kubeConfig,
      readinessPollMs: 5,
      readinessTimeoutMs: 500,
    });
    expect(await backend.inspectService({ name: 'nope' })).toBeNull();
  });

  test('StatefulSet inspect reads the -client ClusterIP service', async () => {
    const stub = stubKubeConfig({
      handlers: {
        'apps.listDeploymentForAllNamespaces': () => ({ items: [] }),
        'apps.listStatefulSetForAllNamespaces': () => ({
          items: [
            {
              apiVersion: 'apps/v1',
              kind: 'StatefulSet',
              metadata: {
                name: 'pg-main',
                namespace: 'llamactl-kb',
                annotations: { [K8S_ANNOTATION_KEYS.specHash]: 'pg-hash' },
                creationTimestamp: new Date('2026-04-21T10:00:00Z'),
              },
              status: { readyReplicas: 1, replicas: 1 },
            },
          ],
        }),
        'core.readNamespacedService': (p) => {
          expect(p.name).toBe('pg-main-client');
          return {
            apiVersion: 'v1',
            kind: 'Service',
            metadata: { name: 'pg-main-client', namespace: 'llamactl-kb' },
            spec: { ports: [{ port: 5432 }] },
          };
        },
      },
    });
    const backend = new KubernetesBackend({
      kubeConfig: stub.kubeConfig,
      readinessPollMs: 5,
      readinessTimeoutMs: 500,
    });
    const res = await backend.inspectService({ name: 'pg-main' });
    expect(res?.endpoint?.host).toBe(
      'pg-main-client.llamactl-kb.svc.cluster.local',
    );
    expect(res?.endpoint?.port).toBe(5432);
    expect(res?.specHash).toBe('pg-hash');
  });
});

describe('KubernetesBackend.listServices', () => {
  test('merges Deployments + StatefulSets from all namespaces', async () => {
    const stub = stubKubeConfig({
      handlers: {
        'apps.listDeploymentForAllNamespaces': () => ({
          items: [
            {
              apiVersion: 'apps/v1',
              kind: 'Deployment',
              metadata: {
                name: 'chroma-main',
                namespace: 'llamactl-kb',
                annotations: { [K8S_ANNOTATION_KEYS.specHash]: 'h1' },
              },
              status: { readyReplicas: 1, replicas: 1 },
            },
          ],
        }),
        'apps.listStatefulSetForAllNamespaces': () => ({
          items: [
            {
              apiVersion: 'apps/v1',
              kind: 'StatefulSet',
              metadata: {
                name: 'pg-main',
                namespace: 'llamactl-other',
                annotations: { [K8S_ANNOTATION_KEYS.specHash]: 'h2' },
              },
              status: { readyReplicas: 0, replicas: 1 },
            },
          ],
        }),
        'core.readNamespacedService': (p) => ({
          metadata: { name: p.name, namespace: p.namespace },
          spec: { ports: [{ port: 8000 }] },
        }),
      },
    });
    const backend = new KubernetesBackend({
      kubeConfig: stub.kubeConfig,
      readinessPollMs: 5,
      readinessTimeoutMs: 500,
    });
    const list = await backend.listServices();
    expect(list).toHaveLength(2);
    const byName = Object.fromEntries(list.map((l) => [l.ref.name, l]));
    expect(byName['chroma-main']?.running).toBe(true);
    expect(byName['chroma-main']?.health).toBe('healthy');
    expect(byName['pg-main']?.running).toBe(false);
    expect(byName['pg-main']?.health).toBe('starting');
  });

  test('filter.composite narrows the label selector', async () => {
    let capturedSelector: string | undefined;
    const stub = stubKubeConfig({
      handlers: {
        'apps.listDeploymentForAllNamespaces': (p) => {
          capturedSelector = p.labelSelector as string;
          return { items: [] };
        },
        'apps.listStatefulSetForAllNamespaces': () => ({ items: [] }),
      },
    });
    const backend = new KubernetesBackend({
      kubeConfig: stub.kubeConfig,
      readinessPollMs: 5,
      readinessTimeoutMs: 500,
    });
    await backend.listServices({ composite: 'kb' });
    expect(capturedSelector).toContain('llamactl.io/composite=kb');
  });
});

describe('createKubernetesBackend factory', () => {
  test('returns a RuntimeBackend instance with kind=kubernetes', () => {
    const backend = createKubernetesBackend({
      kubeConfig: stubKubeConfig({ pingBehavior: 'ok' }).kubeConfig,
    });
    expect(backend.kind).toBe('kubernetes');
  });
});
