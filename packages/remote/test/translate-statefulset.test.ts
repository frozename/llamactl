import { describe, expect, test } from 'bun:test';

import type { ServiceDeployment } from '../src/runtime/backend.js';
import { translateToStatefulSet } from '../src/runtime/kubernetes/translate-statefulset.js';

/**
 * Phase 4 — pure translator tests. No mocked k8s client — we call
 * `translateToStatefulSet` directly and assert the emitted manifest
 * shapes against the spec in `composite-k8s-backend.md`.
 */

function pgvectorSpec(
  overrides: Partial<ServiceDeployment> = {},
): ServiceDeployment {
  const base: ServiceDeployment = {
    name: 'llamactl-pgvector-kb-main',
    image: { repository: 'pgvector/pgvector', tag: '0.8.2-pg18-trixie' },
    env: {
      POSTGRES_DB: 'kb',
      POSTGRES_USER: 'llamactl',
    },
    ports: [{ containerPort: 5432, hostPort: 5432, protocol: 'tcp' }],
    volumes: [{ hostPath: '/srv/pgdata', containerPath: '/var/lib/postgresql/data' }],
    labels: {
      'llamactl.composite': 'kb',
      'llamactl.service': 'main',
    },
    healthcheck: {
      test: ['CMD', 'pg_isready', '-U', 'llamactl'],
      intervalMs: 10_000,
      timeoutMs: 3_000,
      retries: 10,
    },
    restartPolicy: 'unless-stopped',
    controllerKind: 'statefulset',
    secrets: {
      POSTGRES_PASSWORD: { ref: 'env:PG_PASSWORD' },
    },
    specHash: 'sha256:deadbeefcafef00d',
  };
  return { ...base, ...overrides };
}

const baseOpts = {
  namespace: 'llamactl-kb',
  compositeName: 'kb',
  resolvedSecrets: { POSTGRES_PASSWORD: 'hunter2' },
};

describe('translateToStatefulSet — pgvector-shaped happy path', () => {
  const { statefulSet, headlessService, service, secret } = translateToStatefulSet(
    pgvectorSpec(),
    baseOpts,
  );

  test('StatefulSet carries apiVersion + kind + metadata', () => {
    expect(statefulSet.apiVersion).toBe('apps/v1');
    expect(statefulSet.kind).toBe('StatefulSet');
    expect(statefulSet.metadata?.name).toBe('llamactl-pgvector-kb-main');
    expect(statefulSet.metadata?.namespace).toBe('llamactl-kb');
  });

  test('StatefulSet.spec.serviceName matches the headless Service name', () => {
    expect(statefulSet.spec?.serviceName).toBe('llamactl-pgvector-kb-main');
    expect(headlessService.metadata?.name).toBe('llamactl-pgvector-kb-main');
    expect(statefulSet.spec?.serviceName).toBe(headlessService.metadata?.name);
  });

  test('replicas locked to 1 (v1 single-replica)', () => {
    expect(statefulSet.spec?.replicas).toBe(1);
  });

  test('Helm-style + llamactl labels stamped on every scope', () => {
    const expected = {
      'app.kubernetes.io/managed-by': 'llamactl',
      'app.kubernetes.io/instance': 'kb-llamactl-pgvector-kb-main',
      'app.kubernetes.io/part-of': 'kb',
      'llamactl.io/composite': 'kb',
      'llamactl.io/component': 'service',
      app: 'llamactl-pgvector-kb-main',
      'llamactl.composite': 'kb',
      'llamactl.service': 'main',
    };
    expect(statefulSet.metadata?.labels).toEqual(expected);
    expect(statefulSet.spec?.template.metadata?.labels).toEqual(expected);
    expect(headlessService.metadata?.labels).toEqual(expected);
    expect(service.metadata?.labels).toEqual(expected);
    expect(secret?.metadata?.labels).toEqual(expected);
  });

  test('spec-hash annotation present on StatefulSet + Services + pod template', () => {
    expect(statefulSet.metadata?.annotations).toEqual({
      'llamactl.io/spec-hash': 'sha256:deadbeefcafef00d',
    });
    expect(headlessService.metadata?.annotations).toEqual({
      'llamactl.io/spec-hash': 'sha256:deadbeefcafef00d',
    });
    expect(service.metadata?.annotations).toEqual({
      'llamactl.io/spec-hash': 'sha256:deadbeefcafef00d',
    });
    expect(statefulSet.spec?.template.metadata?.annotations).toEqual({
      'llamactl.io/spec-hash': 'sha256:deadbeefcafef00d',
    });
  });

  test('selector + app label consistent across StatefulSet + Services', () => {
    expect(statefulSet.spec?.selector.matchLabels).toEqual({
      app: 'llamactl-pgvector-kb-main',
    });
    expect(headlessService.spec?.selector).toEqual({
      app: 'llamactl-pgvector-kb-main',
    });
    expect(service.spec?.selector).toEqual({
      app: 'llamactl-pgvector-kb-main',
    });
  });

  test('pod template carries a single container named "container" with correct image', () => {
    const containers = statefulSet.spec?.template.spec?.containers ?? [];
    expect(containers).toHaveLength(1);
    expect(containers[0]?.name).toBe('container');
    expect(containers[0]?.image).toBe('pgvector/pgvector:0.8.2-pg18-trixie');
  });

  test('container ports mapped with protocol UPPERCASED', () => {
    const ports = statefulSet.spec?.template.spec?.containers?.[0]?.ports ?? [];
    expect(ports).toEqual([{ containerPort: 5432, protocol: 'TCP' }]);
  });

  test('env: static entries first, then secretKeyRef entries', () => {
    const env = statefulSet.spec?.template.spec?.containers?.[0]?.env ?? [];
    expect(env).toEqual([
      { name: 'POSTGRES_DB', value: 'kb' },
      { name: 'POSTGRES_USER', value: 'llamactl' },
      {
        name: 'POSTGRES_PASSWORD',
        valueFrom: {
          secretKeyRef: {
            name: 'llamactl-pgvector-kb-main-secrets',
            key: 'POSTGRES_PASSWORD',
          },
        },
      },
    ]);
  });

  test('livenessProbe translated from healthcheck (ms → seconds, test[1..])', () => {
    const probe = statefulSet.spec?.template.spec?.containers?.[0]?.livenessProbe;
    expect(probe).toEqual({
      exec: { command: ['pg_isready', '-U', 'llamactl'] },
      periodSeconds: 10,
      timeoutSeconds: 3,
      failureThreshold: 10,
    });
  });

  test('volumeClaimTemplates: RWO + 20Gi default + storageClassName OMITTED', () => {
    const templates = statefulSet.spec?.volumeClaimTemplates ?? [];
    expect(templates).toHaveLength(1);
    const t = templates[0];
    expect(t?.metadata?.name).toBe('data-0');
    expect(t?.spec?.accessModes).toEqual(['ReadWriteOnce']);
    expect(t?.spec?.resources?.requests?.storage).toBe('20Gi');
    // Field must NOT appear at all — not '', not 'default', not null.
    expect('storageClassName' in (t?.spec ?? {})).toBe(false);
  });

  test('container volumeMounts align with volumeClaimTemplates 1:1', () => {
    const mounts = statefulSet.spec?.template.spec?.containers?.[0]?.volumeMounts ?? [];
    expect(mounts).toEqual([
      { name: 'data-0', mountPath: '/var/lib/postgresql/data' },
    ]);
  });

  test('headless Service has clusterIP: "None"', () => {
    expect(headlessService.apiVersion).toBe('v1');
    expect(headlessService.kind).toBe('Service');
    expect(headlessService.spec?.clusterIP).toBe('None');
  });

  test('headless Service port mapping: hostPort → port, containerPort → targetPort', () => {
    expect(headlessService.spec?.ports).toEqual([
      { port: 5432, targetPort: 5432, protocol: 'TCP' },
    ]);
  });

  test('regular ClusterIP Service distinct-named and NOT headless', () => {
    expect(service.metadata?.name).toBe('llamactl-pgvector-kb-main-client');
    expect(service.metadata?.name).not.toBe(headlessService.metadata?.name);
    // Must NOT carry clusterIP at all (auto-alloc) — and certainly not 'None'.
    expect(service.spec?.clusterIP).toBeUndefined();
  });

  test('regular Service port mapping identical to headless', () => {
    expect(service.spec?.ports).toEqual([
      { port: 5432, targetPort: 5432, protocol: 'TCP' },
    ]);
  });

  test('Secret: apiVersion + kind + Opaque type + base64-encoded value', () => {
    expect(secret).not.toBeNull();
    expect(secret?.apiVersion).toBe('v1');
    expect(secret?.kind).toBe('Secret');
    expect(secret?.type).toBe('Opaque');
    expect(secret?.metadata?.name).toBe('llamactl-pgvector-kb-main-secrets');
    expect(secret?.metadata?.namespace).toBe('llamactl-kb');
    expect(secret?.data).toEqual({
      POSTGRES_PASSWORD: Buffer.from('hunter2', 'utf8').toString('base64'),
    });
  });
});

describe('translateToStatefulSet — storageClassName override', () => {
  test('opts.storageClassName is carried onto every volumeClaimTemplate', () => {
    const { statefulSet } = translateToStatefulSet(pgvectorSpec(), {
      ...baseOpts,
      storageClassName: 'local-path',
    });
    const templates = statefulSet.spec?.volumeClaimTemplates ?? [];
    expect(templates).toHaveLength(1);
    expect(templates[0]?.spec?.storageClassName).toBe('local-path');
  });

  test('undefined opts.storageClassName → field omitted, no empty string leak', () => {
    const { statefulSet } = translateToStatefulSet(pgvectorSpec(), baseOpts);
    const templates = statefulSet.spec?.volumeClaimTemplates ?? [];
    for (const t of templates) {
      expect('storageClassName' in (t.spec ?? {})).toBe(false);
    }
  });
});

describe('translateToStatefulSet — secrets variations', () => {
  test('spec.secrets undefined → secret result is null, container env is static-only', () => {
    const spec = pgvectorSpec();
    delete spec.secrets;
    const { statefulSet, secret } = translateToStatefulSet(spec, {
      ...baseOpts,
      resolvedSecrets: {},
    });
    expect(secret).toBeNull();
    const env = statefulSet.spec?.template.spec?.containers?.[0]?.env ?? [];
    expect(env.every((e) => e.valueFrom === undefined)).toBe(true);
  });

  test('spec.secrets = {} → secret result is null', () => {
    const { secret } = translateToStatefulSet(pgvectorSpec({ secrets: {} }), {
      ...baseOpts,
      resolvedSecrets: {},
    });
    expect(secret).toBeNull();
  });

  test('multiple secret keys → Secret carries multiple base64 entries + env has one secretKeyRef per key', () => {
    const spec = pgvectorSpec({
      secrets: {
        POSTGRES_PASSWORD: { ref: 'env:PG_PASSWORD' },
        REPLICATION_TOKEN: { ref: 'env:REPL' },
      },
    });
    const { statefulSet, secret } = translateToStatefulSet(spec, {
      ...baseOpts,
      resolvedSecrets: {
        POSTGRES_PASSWORD: 'hunter2',
        REPLICATION_TOKEN: 'abc123',
      },
    });
    expect(secret?.data).toEqual({
      POSTGRES_PASSWORD: Buffer.from('hunter2', 'utf8').toString('base64'),
      REPLICATION_TOKEN: Buffer.from('abc123', 'utf8').toString('base64'),
    });
    const env = statefulSet.spec?.template.spec?.containers?.[0]?.env ?? [];
    const refs = env.filter((e) => e.valueFrom !== undefined);
    expect(refs).toHaveLength(2);
    const names = refs.map((e) => e.name).sort();
    expect(names).toEqual(['POSTGRES_PASSWORD', 'REPLICATION_TOKEN']);
    // Every secretKeyRef must point at the SAME Secret object.
    for (const e of refs) {
      expect(e.valueFrom?.secretKeyRef?.name).toBe(
        'llamactl-pgvector-kb-main-secrets',
      );
      expect(e.valueFrom?.secretKeyRef?.key).toBe(e.name);
    }
  });

  test('missing resolved secret value throws a loud error', () => {
    expect(() =>
      translateToStatefulSet(pgvectorSpec(), {
        ...baseOpts,
        resolvedSecrets: {}, // spec declares POSTGRES_PASSWORD but nothing resolved
      }),
    ).toThrow(/missing resolved secret for key 'POSTGRES_PASSWORD'/);
  });
});

describe('translateToStatefulSet — healthcheck edge cases', () => {
  test('no healthcheck → no livenessProbe on container', () => {
    const spec = pgvectorSpec();
    delete spec.healthcheck;
    const { statefulSet } = translateToStatefulSet(spec, baseOpts);
    expect(
      statefulSet.spec?.template.spec?.containers?.[0]?.livenessProbe,
    ).toBeUndefined();
  });

  test('healthcheck with startPeriodMs → initialDelaySeconds (ms → seconds)', () => {
    const { statefulSet } = translateToStatefulSet(
      pgvectorSpec({
        healthcheck: {
          test: ['CMD', 'pg_isready'],
          startPeriodMs: 15_000,
        },
      }),
      baseOpts,
    );
    const probe = statefulSet.spec?.template.spec?.containers?.[0]?.livenessProbe;
    expect(probe?.initialDelaySeconds).toBe(15);
    expect(probe?.exec?.command).toEqual(['pg_isready']);
  });

  test('sub-1000ms interval rounds up to 1 (k8s minimum periodSeconds)', () => {
    const { statefulSet } = translateToStatefulSet(
      pgvectorSpec({
        healthcheck: { test: ['CMD', 'x'], intervalMs: 400, timeoutMs: 100 },
      }),
      baseOpts,
    );
    const probe = statefulSet.spec?.template.spec?.containers?.[0]?.livenessProbe;
    expect(probe?.periodSeconds).toBeGreaterThanOrEqual(1);
    expect(probe?.timeoutSeconds).toBeGreaterThanOrEqual(1);
  });
});

describe('translateToStatefulSet — volumes variations', () => {
  test('no volumes → no volumeClaimTemplates and no volumeMounts', () => {
    const spec = pgvectorSpec();
    delete spec.volumes;
    const { statefulSet } = translateToStatefulSet(spec, baseOpts);
    expect(statefulSet.spec?.volumeClaimTemplates).toBeUndefined();
    expect(
      statefulSet.spec?.template.spec?.containers?.[0]?.volumeMounts,
    ).toBeUndefined();
  });

  test('named volume → template.metadata.name = v.name, mount uses same name', () => {
    const spec = pgvectorSpec({
      volumes: [
        { name: 'pgdata', containerPath: '/var/lib/postgresql/data' },
      ],
    });
    const { statefulSet } = translateToStatefulSet(spec, baseOpts);
    const templates = statefulSet.spec?.volumeClaimTemplates ?? [];
    const mounts =
      statefulSet.spec?.template.spec?.containers?.[0]?.volumeMounts ?? [];
    expect(templates[0]?.metadata?.name).toBe('pgdata');
    expect(mounts[0]?.name).toBe('pgdata');
    expect(mounts[0]?.mountPath).toBe('/var/lib/postgresql/data');
  });

  test('multiple volumes → one template + one mount per volume', () => {
    const spec = pgvectorSpec({
      volumes: [
        { name: 'pgdata', containerPath: '/var/lib/postgresql/data' },
        { containerPath: '/tmp/extra' }, // unnamed → data-1
      ],
    });
    const { statefulSet } = translateToStatefulSet(spec, baseOpts);
    const templates = statefulSet.spec?.volumeClaimTemplates ?? [];
    const mounts =
      statefulSet.spec?.template.spec?.containers?.[0]?.volumeMounts ?? [];
    expect(templates.map((t) => t.metadata?.name)).toEqual([
      'pgdata',
      'data-1',
    ]);
    expect(mounts.map((m) => m.name)).toEqual(['pgdata', 'data-1']);
  });

  test('readOnly flag propagates to the volumeMount', () => {
    const spec = pgvectorSpec({
      volumes: [
        { name: 'ro', containerPath: '/ro', readOnly: true },
      ],
    });
    const { statefulSet } = translateToStatefulSet(spec, baseOpts);
    const mounts =
      statefulSet.spec?.template.spec?.containers?.[0]?.volumeMounts ?? [];
    expect(mounts[0]?.readOnly).toBe(true);
  });

  test('configMap volume → pod-level volume (not a volumeClaimTemplate) with mount', () => {
    const spec = pgvectorSpec({
      volumes: [
        {
          configMap: { name: 'pg-config', data: { 'pg.conf': 'max_connections=20' } },
          containerPath: '/etc/pg',
        },
      ],
    });
    const { statefulSet } = translateToStatefulSet(spec, baseOpts);
    // No volumeClaimTemplates — configMap doesn't back storage.
    expect(statefulSet.spec?.volumeClaimTemplates ?? []).toHaveLength(0);
    // Pod template exposes the configMap at the expected source.
    const podVolumes = statefulSet.spec?.template.spec?.volumes ?? [];
    expect(podVolumes).toHaveLength(1);
    expect(podVolumes[0]?.configMap?.name).toBe('pg-config');
    // Container mounts it at the declared containerPath.
    const mounts =
      statefulSet.spec?.template.spec?.containers?.[0]?.volumeMounts ?? [];
    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.mountPath).toBe('/etc/pg');
    expect(mounts[0]?.name).toBe(podVolumes[0]?.name);
  });
});

describe('translateToStatefulSet — ports variations', () => {
  test('no ports → no container ports and no Service ports', () => {
    const spec = pgvectorSpec();
    delete spec.ports;
    const { statefulSet, headlessService, service } = translateToStatefulSet(
      spec,
      baseOpts,
    );
    expect(
      statefulSet.spec?.template.spec?.containers?.[0]?.ports,
    ).toBeUndefined();
    expect(headlessService.spec?.ports).toBeUndefined();
    expect(service.spec?.ports).toBeUndefined();
  });

  test('port without hostPort → service.port falls back to containerPort', () => {
    const spec = pgvectorSpec({
      ports: [{ containerPort: 5432, protocol: 'tcp' }],
    });
    const { headlessService } = translateToStatefulSet(spec, baseOpts);
    expect(headlessService.spec?.ports).toEqual([
      { port: 5432, targetPort: 5432, protocol: 'TCP' },
    ]);
  });
});

describe('translateToStatefulSet — serviceType override', () => {
  test('default (undefined) → headless stays None, -client has no `type` (ClusterIP)', () => {
    const { headlessService, service } = translateToStatefulSet(
      pgvectorSpec(),
      baseOpts,
    );
    expect(headlessService.spec?.clusterIP).toBe('None');
    expect(service.spec?.type).toBeUndefined();
  });

  test('NodePort override → -client Service type=NodePort; headless ALWAYS clusterIP: None', () => {
    const { headlessService, service } = translateToStatefulSet(
      pgvectorSpec({ serviceType: 'NodePort' }),
      baseOpts,
    );
    // Headless companion MUST stay headless — StatefulSet.serviceName
    // contract depends on it.
    expect(headlessService.spec?.clusterIP).toBe('None');
    expect(headlessService.spec?.type).toBeUndefined();
    // -client picks up the override.
    expect(service.spec?.type).toBe('NodePort');
    // nodePort is left for k8s to assign.
    for (const p of service.spec?.ports ?? []) {
      expect((p as { nodePort?: number }).nodePort).toBeUndefined();
    }
  });

  test('LoadBalancer override → -client Service type=LoadBalancer; headless unaffected', () => {
    const { headlessService, service } = translateToStatefulSet(
      pgvectorSpec({ serviceType: 'LoadBalancer' }),
      baseOpts,
    );
    expect(headlessService.spec?.clusterIP).toBe('None');
    expect(service.spec?.type).toBe('LoadBalancer');
  });
});

describe('translateToStatefulSet — no-empty-strings sanity', () => {
  test('every metadata.namespace is set from opts.namespace', () => {
    const { statefulSet, headlessService, service, secret } =
      translateToStatefulSet(pgvectorSpec(), baseOpts);
    expect(statefulSet.metadata?.namespace).toBe('llamactl-kb');
    expect(headlessService.metadata?.namespace).toBe('llamactl-kb');
    expect(service.metadata?.namespace).toBe('llamactl-kb');
    expect(secret?.metadata?.namespace).toBe('llamactl-kb');
  });

  test('storageClassName is never an empty string', () => {
    const { statefulSet } = translateToStatefulSet(pgvectorSpec(), baseOpts);
    for (const t of statefulSet.spec?.volumeClaimTemplates ?? []) {
      expect(t.spec?.storageClassName).not.toBe('');
    }
  });

  test('clusterIP on the regular Service is never the string "None"', () => {
    const { service } = translateToStatefulSet(pgvectorSpec(), baseOpts);
    expect(service.spec?.clusterIP).not.toBe('None');
  });

  test('headless Service clusterIP is exactly the string "None"', () => {
    const { headlessService } = translateToStatefulSet(pgvectorSpec(), baseOpts);
    expect(headlessService.spec?.clusterIP).toBe('None');
  });
});
