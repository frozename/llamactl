import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ServiceInstance } from '../src/runtime/backend.js';
import { LABEL_KEYS, MANAGED_BY_VALUE } from '../src/runtime/labels.js';
import { ServiceError } from '../src/service/errors.js';
import {
  DEFAULT_SERVICE_HANDLERS,
  findServiceHandler,
} from '../src/service/handlers/registry.js';
import { pgvectorHandler } from '../src/service/handlers/pgvector-handler.js';
import {
  PgvectorServiceSpecSchema,
  type PgvectorServiceSpec,
} from '../src/service/schema.js';

const ENV_KEY = 'SERVICE_TEST_PGVECTOR_PASSWORD';

function spec(
  overrides: Partial<PgvectorServiceSpec> = {},
): PgvectorServiceSpec {
  return PgvectorServiceSpecSchema.parse({
    kind: 'pgvector',
    name: 'pg',
    node: 'gpu1',
    ...overrides,
  });
}

function dockerInstance(host = '127.0.0.1', port = 5500): ServiceInstance {
  return {
    ref: { name: 'llamactl-pgvector-demo-pg' },
    running: true,
    health: 'healthy',
    specHash: 'xyz',
    createdAt: '2026-04-20T12:00:00Z',
    endpoint: { host, port },
  };
}

describe('pgvectorHandler registry', () => {
  test('registered in DEFAULT_SERVICE_HANDLERS', () => {
    expect(DEFAULT_SERVICE_HANDLERS.some((h) => h.kind === 'pgvector')).toBe(
      true,
    );
  });
  test('findServiceHandler returns pgvector handler', () => {
    expect(findServiceHandler(spec()).kind).toBe('pgvector');
  });
});

describe('pgvectorHandler.validate', () => {
  test('accepts default docker runtime (no passwordEnv)', () => {
    expect(() => pgvectorHandler.validate(spec())).not.toThrow();
  });

  test('accepts passwordEnv when env var is set', () => {
    process.env[ENV_KEY] = 'supersecret';
    try {
      expect(() =>
        pgvectorHandler.validate(spec({ passwordEnv: ENV_KEY })),
      ).not.toThrow();
    } finally {
      delete process.env[ENV_KEY];
    }
  });

  test('validate no longer probes env at translate time', () => {
    // Handlers are pure. The missing-env error is surfaced by the
    // backend's unified secret resolver at apply time; covered in
    // runtime-docker-backend.test.ts.
    delete process.env[ENV_KEY];
    expect(() =>
      pgvectorHandler.validate(spec({ passwordEnv: ENV_KEY })),
    ).not.toThrow();
  });

  test('rejects external runtime without externalEndpoint', () => {
    expect(() => pgvectorHandler.validate(spec({ runtime: 'external' }))).toThrow(
      ServiceError,
    );
  });

  test('rejects external runtime with image override', () => {
    expect(() =>
      pgvectorHandler.validate(
        spec({
          runtime: 'external',
          externalEndpoint: 'postgres://pg.internal:5432/rag',
          image: { repository: 'pgvector/pgvector', tag: '0.8.2-pg18-trixie' },
        }),
      ),
    ).toThrow(ServiceError);
  });

  test('rejects docker runtime with externalEndpoint', () => {
    expect(() =>
      pgvectorHandler.validate(
        spec({ externalEndpoint: 'postgres://pg.internal:5432/rag' }),
      ),
    ).toThrow(ServiceError);
  });
});

describe('pgvectorHandler.computeSpecHash', () => {
  test('stable across calls', () => {
    const h1 = pgvectorHandler.computeSpecHash(spec());
    const h2 = pgvectorHandler.computeSpecHash(spec());
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  test('name changes do NOT change hash', () => {
    const h1 = pgvectorHandler.computeSpecHash(spec({ name: 'pg' }));
    const h2 = pgvectorHandler.computeSpecHash(spec({ name: 'other' }));
    expect(h1).toBe(h2);
  });

  test('database change reshapes hash', () => {
    const h1 = pgvectorHandler.computeSpecHash(spec());
    const h2 = pgvectorHandler.computeSpecHash(spec({ database: 'rag' }));
    expect(h1).not.toBe(h2);
  });

  test('user change reshapes hash', () => {
    const h1 = pgvectorHandler.computeSpecHash(spec());
    const h2 = pgvectorHandler.computeSpecHash(spec({ user: 'rag_user' }));
    expect(h1).not.toBe(h2);
  });

  test('passwordEnv name change reshapes hash (password value does not)', () => {
    const h1 = pgvectorHandler.computeSpecHash(spec({ passwordEnv: 'A' }));
    const h2 = pgvectorHandler.computeSpecHash(spec({ passwordEnv: 'B' }));
    expect(h1).not.toBe(h2);
  });
});

describe('pgvectorHandler.toDeployment', () => {
  beforeEach(() => {
    process.env[ENV_KEY] = 'secret123';
  });
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  test('returns null for runtime=external', () => {
    const d = pgvectorHandler.toDeployment(
      spec({
        runtime: 'external',
        externalEndpoint: 'postgres://pg.internal:5432/rag',
      }),
      { compositeName: 'demo' },
    );
    expect(d).toBeNull();
  });

  test('emits deterministic name + defaults + env + exec healthcheck', () => {
    const d = pgvectorHandler.toDeployment(
      spec({ passwordEnv: ENV_KEY }),
      { compositeName: 'demo' },
    );
    if (!d) throw new Error('expected deployment');
    expect(d.name).toBe('llamactl-pgvector-demo-pg');
    expect(d.image.repository).toBe('pgvector/pgvector');
    expect(d.image.tag).toBe('0.8.2-pg18-trixie');
    expect(d.ports).toEqual([
      { containerPort: 5432, hostPort: 5432, protocol: 'tcp' },
    ]);
    expect(d.env).toEqual({
      POSTGRES_DB: 'postgres',
      POSTGRES_USER: 'postgres',
    });
    // POSTGRES_PASSWORD lives in `secrets` now — the backend resolves
    // the ref at apply time (Docker → env entry; k8s → Secret +
    // secretKeyRef).
    expect(d.secrets?.POSTGRES_PASSWORD).toEqual({ ref: `env:${ENV_KEY}` });
    expect(d.controllerKind).toBe('statefulset');
    // Exec form — no shell substitution at container runtime.
    expect(d.healthcheck?.test).toEqual(['CMD', 'pg_isready', '-U', 'postgres']);
    expect(d.restartPolicy).toBe('unless-stopped');
  });

  test('omits POSTGRES_PASSWORD secret when passwordEnv unset', () => {
    const d = pgvectorHandler.toDeployment(spec(), { compositeName: 'demo' });
    if (!d) throw new Error('expected deployment');
    expect(d.secrets?.POSTGRES_PASSWORD).toBeUndefined();
  });

  test('stamps llamactl labels including spec.hash', () => {
    const d = pgvectorHandler.toDeployment(spec(), { compositeName: 'demo' });
    if (!d) throw new Error('expected deployment');
    expect(d.labels?.[LABEL_KEYS.managedBy]).toBe(MANAGED_BY_VALUE);
    expect(d.labels?.[LABEL_KEYS.composite]).toBe('demo');
    expect(d.labels?.[LABEL_KEYS.service]).toBe('pg');
    expect(d.labels?.[LABEL_KEYS.specHash]).toBe(d.specHash);
  });

  test('translate emits a secret ref regardless of whether the env is currently set', () => {
    // Handlers are pure: they don't read process.env at translate
    // time. The backend's secret resolver handles the env lookup at
    // apply time, so the missing-env error surfaces from the backend
    // layer — covered in the runtime-docker-backend tests.
    delete process.env[ENV_KEY];
    const d = pgvectorHandler.toDeployment(
      spec({ passwordEnv: ENV_KEY }),
      { compositeName: 'demo' },
    );
    expect(d?.secrets?.POSTGRES_PASSWORD).toEqual({ ref: `env:${ENV_KEY}` });
  });

  test('honors custom user in pg_isready test', () => {
    const d = pgvectorHandler.toDeployment(
      spec({ user: 'rag_user' }),
      { compositeName: 'demo' },
    );
    if (!d) throw new Error('expected deployment');
    expect(d.healthcheck?.test).toEqual([
      'CMD',
      'pg_isready',
      '-U',
      'rag_user',
    ]);
  });

  test('emits bind mount when persistence configured', () => {
    const d = pgvectorHandler.toDeployment(
      spec({
        persistence: {
          volume: '/var/llamactl/pgdata',
          mountPath: '/var/lib/postgresql/data',
        },
      }),
      { compositeName: 'demo' },
    );
    if (!d) throw new Error('expected deployment');
    expect(d.volumes).toEqual([
      {
        hostPath: '/var/llamactl/pgdata',
        containerPath: '/var/lib/postgresql/data',
      },
    ]);
  });
});

describe('pgvectorHandler.resolvedEndpoint', () => {
  test('docker runtime with instance endpoint — redacted postgres URL', () => {
    const e = pgvectorHandler.resolvedEndpoint(
      spec({ database: 'rag', user: 'rag_user' }),
      dockerInstance('127.0.0.1', 5500),
    );
    expect(e.host).toBe('127.0.0.1');
    expect(e.port).toBe(5500);
    expect(e.url).toBe('postgres://rag_user:REDACTED@127.0.0.1:5500/rag');
  });

  test('docker runtime without instance → endpoint-unresolvable', () => {
    try {
      pgvectorHandler.resolvedEndpoint(spec(), null);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('endpoint-unresolvable');
    }
  });

  test('external runtime parses postgres URL', () => {
    const e = pgvectorHandler.resolvedEndpoint(
      spec({
        runtime: 'external',
        externalEndpoint: 'postgres://user:pass@pg.internal:6543/rag',
      }),
      null,
    );
    expect(e.host).toBe('pg.internal');
    expect(e.port).toBe(6543);
    expect(e.url).toBe('postgres://user:pass@pg.internal:6543/rag');
  });

  test('external runtime with no port defaults to 5432', () => {
    const e = pgvectorHandler.resolvedEndpoint(
      spec({
        runtime: 'external',
        externalEndpoint: 'postgres://user:pass@pg.internal/rag',
      }),
      null,
    );
    expect(e.port).toBe(5432);
  });

  test('external runtime with invalid URL throws spec-invalid', () => {
    try {
      pgvectorHandler.resolvedEndpoint(
        spec({ runtime: 'external', externalEndpoint: '::not-a-url::' }),
        null,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('spec-invalid');
    }
  });
});
