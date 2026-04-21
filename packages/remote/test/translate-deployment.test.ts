import { describe, expect, test } from 'bun:test';

import { translateToDeployment } from '../src/runtime/kubernetes/translate-deployment.js';
import type { ServiceDeployment } from '../src/runtime/backend.js';
import {
  K8S_ANNOTATION_KEYS,
  K8S_LABEL_KEYS,
  MANAGED_BY_VALUE,
} from '../src/runtime/kubernetes/labels.js';

/**
 * Pure-translator tests. No kubeconfig, no mocks — the translator is
 * a deterministic map `ServiceDeployment → V1Deployment + V1Service?
 * + V1PersistentVolumeClaim? + V1Secret?`. Drives Phase 3's
 * idempotency-layer confidence: if these cases are right, the
 * backend's job is just "put this at the API" with read/create/
 * replace flow.
 */

function sampleSpec(overrides: Partial<ServiceDeployment> = {}): ServiceDeployment {
  return {
    name: 'chroma-main',
    image: { repository: 'chromadb/chroma', tag: '1.5.8' },
    specHash: 'hash-v1',
    ports: [{ containerPort: 8000 }],
    ...overrides,
  };
}

describe('translateToDeployment — Deployment shape', () => {
  test('apiVersion + kind + namespace + labels + single replica + Recreate strategy', () => {
    const { deployment } = translateToDeployment(sampleSpec(), {
      namespace: 'llamactl-kb',
      compositeName: 'kb',
      resolvedSecrets: {},
    });
    expect(deployment.apiVersion).toBe('apps/v1');
    expect(deployment.kind).toBe('Deployment');
    expect(deployment.metadata?.name).toBe('chroma-main');
    expect(deployment.metadata?.namespace).toBe('llamactl-kb');
    expect(deployment.spec?.replicas).toBe(1);
    expect(deployment.spec?.strategy?.type).toBe('Recreate');

    // Labels taxonomy on both metadata + pod template.
    const labels = deployment.metadata?.labels ?? {};
    expect(labels[K8S_LABEL_KEYS.managedBy]).toBe(MANAGED_BY_VALUE);
    expect(labels[K8S_LABEL_KEYS.instance]).toBe('kb-chroma-main');
    expect(labels[K8S_LABEL_KEYS.partOf]).toBe('kb');
    expect(labels[K8S_LABEL_KEYS.composite]).toBe('kb');
    expect(labels[K8S_LABEL_KEYS.component]).toBe('service');

    const podLabels = deployment.spec?.template.metadata?.labels ?? {};
    expect(podLabels.app).toBe('chroma-main');
    expect(podLabels[K8S_LABEL_KEYS.managedBy]).toBe(MANAGED_BY_VALUE);

    expect(deployment.spec?.selector?.matchLabels?.app).toBe('chroma-main');
  });

  test('spec-hash annotation drives drift detection', () => {
    const { deployment, service, pvc, secret } = translateToDeployment(
      sampleSpec({ specHash: 'hash-v7' }),
      { namespace: 'llamactl-kb', compositeName: 'kb', resolvedSecrets: {} },
    );
    expect(
      deployment.metadata?.annotations?.[K8S_ANNOTATION_KEYS.specHash],
    ).toBe('hash-v7');
    expect(service?.metadata?.annotations?.[K8S_ANNOTATION_KEYS.specHash])
      .toBe('hash-v7');
    expect(pvc).toBeNull();
    expect(secret).toBeNull();
  });

  test('caller-supplied labels merge into the resource labels', () => {
    const { deployment } = translateToDeployment(
      sampleSpec({
        labels: {
          'llamactl.io/service': 'main',
          'custom.key': 'value',
        },
      }),
      { namespace: 'llamactl-kb', compositeName: 'kb', resolvedSecrets: {} },
    );
    const labels = deployment.metadata?.labels ?? {};
    expect(labels['llamactl.io/service']).toBe('main');
    expect(labels['custom.key']).toBe('value');
    // Core taxonomy still present.
    expect(labels[K8S_LABEL_KEYS.managedBy]).toBe(MANAGED_BY_VALUE);
  });

  test('command array passes through', () => {
    const { deployment } = translateToDeployment(
      sampleSpec({ command: ['/bin/sh', '-c', 'echo hi'] }),
      { namespace: 'ns', compositeName: 'demo', resolvedSecrets: {} },
    );
    expect(deployment.spec?.template.spec?.containers[0]?.command).toEqual([
      '/bin/sh',
      '-c',
      'echo hi',
    ]);
  });
});

describe('translateToDeployment — container shape', () => {
  test('image repository:tag concatenated, container name stable', () => {
    const { deployment } = translateToDeployment(sampleSpec(), {
      namespace: 'ns',
      compositeName: 'demo',
      resolvedSecrets: {},
    });
    const c = deployment.spec?.template.spec?.containers[0];
    expect(c?.name).toBe('container');
    expect(c?.image).toBe('chromadb/chroma:1.5.8');
  });

  test('ports become containerPort entries with upper-case protocol', () => {
    const { deployment } = translateToDeployment(
      sampleSpec({
        ports: [
          { containerPort: 8000, protocol: 'tcp' },
          { containerPort: 7777, protocol: 'udp' },
        ],
      }),
      { namespace: 'ns', compositeName: 'demo', resolvedSecrets: {} },
    );
    const ports = deployment.spec?.template.spec?.containers[0]?.ports ?? [];
    expect(ports).toEqual([
      { containerPort: 8000, protocol: 'TCP' },
      { containerPort: 7777, protocol: 'UDP' },
    ]);
  });

  test('env entries pass through as {name, value}', () => {
    const { deployment } = translateToDeployment(
      sampleSpec({ env: { FOO: 'bar', BAZ: 'qux' } }),
      { namespace: 'ns', compositeName: 'demo', resolvedSecrets: {} },
    );
    const env = deployment.spec?.template.spec?.containers[0]?.env ?? [];
    expect(env).toContainEqual({ name: 'FOO', value: 'bar' });
    expect(env).toContainEqual({ name: 'BAZ', value: 'qux' });
  });

  test('secrets become secretKeyRef env entries — plain values never appear', () => {
    const { deployment, secret } = translateToDeployment(
      sampleSpec({
        secrets: { POSTGRES_PASSWORD: { ref: 'env:PG_PW' } },
      }),
      {
        namespace: 'ns',
        compositeName: 'demo',
        resolvedSecrets: { POSTGRES_PASSWORD: 'super-s3cret' },
      },
    );
    const env = deployment.spec?.template.spec?.containers[0]?.env ?? [];
    const secretEntry = env.find((e) => e.name === 'POSTGRES_PASSWORD');
    expect(secretEntry?.valueFrom?.secretKeyRef).toEqual({
      name: 'chroma-main-secrets',
      key: 'POSTGRES_PASSWORD',
    });
    // Raw value must NOT appear in the env.
    expect(env.some((e) => e.value === 'super-s3cret')).toBe(false);
    // But the Secret itself carries it, base64'd.
    expect(secret?.data?.POSTGRES_PASSWORD).toBe(
      Buffer.from('super-s3cret', 'utf8').toString('base64'),
    );
    expect(secret?.type).toBe('Opaque');
  });

  test('healthcheck maps to livenessProbe.exec with CMD prefix stripped', () => {
    const { deployment } = translateToDeployment(
      sampleSpec({
        healthcheck: {
          test: ['CMD', 'curl', '-f', 'http://localhost:8000/health'],
          intervalMs: 10_000,
          timeoutMs: 3_000,
          retries: 5,
        },
      }),
      { namespace: 'ns', compositeName: 'demo', resolvedSecrets: {} },
    );
    const probe =
      deployment.spec?.template.spec?.containers[0]?.livenessProbe;
    expect(probe?.exec?.command).toEqual([
      'curl',
      '-f',
      'http://localhost:8000/health',
    ]);
    expect(probe?.periodSeconds).toBe(10);
    expect(probe?.timeoutSeconds).toBe(3);
    expect(probe?.failureThreshold).toBe(5);
  });
});

describe('translateToDeployment — Service', () => {
  test('ClusterIP Service when ports is non-empty', () => {
    const { service } = translateToDeployment(
      sampleSpec({
        ports: [
          { containerPort: 8000, hostPort: 8001, protocol: 'tcp' },
        ],
      }),
      { namespace: 'ns', compositeName: 'demo', resolvedSecrets: {} },
    );
    expect(service?.apiVersion).toBe('v1');
    expect(service?.kind).toBe('Service');
    expect(service?.spec?.type).toBe('ClusterIP');
    expect(service?.spec?.selector).toEqual({ app: 'chroma-main' });
    expect(service?.spec?.ports?.[0]).toMatchObject({
      port: 8001,
      targetPort: 8000,
      protocol: 'TCP',
    });
  });

  test('falls back to containerPort when hostPort is unset', () => {
    const { service } = translateToDeployment(sampleSpec(), {
      namespace: 'ns',
      compositeName: 'demo',
      resolvedSecrets: {},
    });
    expect(service?.spec?.ports?.[0]?.port).toBe(8000);
  });

  test('null when ports is empty', () => {
    const { service } = translateToDeployment(sampleSpec({ ports: [] }), {
      namespace: 'ns',
      compositeName: 'demo',
      resolvedSecrets: {},
    });
    expect(service).toBeNull();
  });
});

describe('translateToDeployment — PVC + volumes', () => {
  test('bind-style hostPath volume → pod volume with hostPath + one PVC for the service', () => {
    const spec = sampleSpec({
      volumes: [
        { hostPath: '/var/lib/chroma', containerPath: '/data' },
      ],
    });
    const { deployment, pvc } = translateToDeployment(spec, {
      namespace: 'ns',
      compositeName: 'demo',
      resolvedSecrets: {},
    });
    const podVolumes = deployment.spec?.template.spec?.volumes ?? [];
    expect(podVolumes).toHaveLength(1);
    expect(podVolumes[0]?.hostPath).toEqual({
      path: '/var/lib/chroma',
      type: 'DirectoryOrCreate',
    });
    expect(pvc?.metadata?.name).toBe('chroma-main-data');
    expect(pvc?.spec?.accessModes).toEqual(['ReadWriteOnce']);
    expect(pvc?.spec?.resources?.requests?.storage).toBe('10Gi');
  });

  test('named volume → PVC claim reference', () => {
    const spec = sampleSpec({
      volumes: [{ name: 'data', containerPath: '/data' }],
    });
    const { deployment } = translateToDeployment(spec, {
      namespace: 'ns',
      compositeName: 'demo',
      resolvedSecrets: {},
    });
    const volumes = deployment.spec?.template.spec?.volumes ?? [];
    expect(volumes[0]?.persistentVolumeClaim?.claimName).toBe(
      'chroma-main-data',
    );
  });

  test('storageClassName option is passed through when set', () => {
    const { pvc } = translateToDeployment(
      sampleSpec({ volumes: [{ hostPath: '/data', containerPath: '/data' }] }),
      {
        namespace: 'ns',
        compositeName: 'demo',
        storageClassName: 'local-path',
        resolvedSecrets: {},
      },
    );
    expect(pvc?.spec?.storageClassName).toBe('local-path');
  });

  test('storageClassName omitted when option is unset — NEVER empty-string', () => {
    const { pvc } = translateToDeployment(
      sampleSpec({ volumes: [{ hostPath: '/data', containerPath: '/data' }] }),
      { namespace: 'ns', compositeName: 'demo', resolvedSecrets: {} },
    );
    expect(pvc?.spec?.storageClassName).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(
      pvc?.spec ?? {},
      'storageClassName',
    )).toBe(false);
  });

  test('volumeMount uses provided name, falling back to data-<i>', () => {
    const { deployment } = translateToDeployment(
      sampleSpec({
        volumes: [
          { name: 'cache', containerPath: '/cache' },
          { hostPath: '/data', containerPath: '/data' },
        ],
      }),
      { namespace: 'ns', compositeName: 'demo', resolvedSecrets: {} },
    );
    const mounts =
      deployment.spec?.template.spec?.containers[0]?.volumeMounts ?? [];
    expect(mounts[0]?.name).toBe('cache');
    expect(mounts[0]?.mountPath).toBe('/cache');
    expect(mounts[1]?.name).toBe('data-1');
    expect(mounts[1]?.mountPath).toBe('/data');
  });

  test('readOnly flag passes through on volumeMount', () => {
    const { deployment } = translateToDeployment(
      sampleSpec({
        volumes: [
          { hostPath: '/ro', containerPath: '/ro', readOnly: true },
        ],
      }),
      { namespace: 'ns', compositeName: 'demo', resolvedSecrets: {} },
    );
    const mount =
      deployment.spec?.template.spec?.containers[0]?.volumeMounts?.[0];
    expect(mount?.readOnly).toBe(true);
  });
});
