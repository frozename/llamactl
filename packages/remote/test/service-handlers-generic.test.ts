import { describe, expect, test } from 'bun:test';
import type { ServiceInstance } from '../src/runtime/backend.js';
import { LABEL_KEYS, MANAGED_BY_VALUE } from '../src/runtime/labels.js';
import { ServiceError } from '../src/service/errors.js';
import { genericContainerHandler } from '../src/service/handlers/generic-handler.js';
import {
  DEFAULT_SERVICE_HANDLERS,
  findServiceHandler,
} from '../src/service/handlers/registry.js';
import {
  GenericContainerServiceSpecSchema,
  type GenericContainerServiceSpec,
} from '../src/service/schema.js';

function spec(
  overrides: Partial<GenericContainerServiceSpec> = {},
): GenericContainerServiceSpec {
  return GenericContainerServiceSpecSchema.parse({
    kind: 'container',
    name: 'nginx',
    node: 'gpu1',
    image: { repository: 'nginx', tag: 'alpine' },
    ...overrides,
  });
}

function dockerInstance(host = '127.0.0.1', port = 8080): ServiceInstance {
  return {
    ref: { name: 'llamactl-container-demo-nginx' },
    running: true,
    health: 'healthy',
    specHash: 'h',
    createdAt: '2026-04-20T12:00:00Z',
    endpoint: { host, port },
  };
}

describe('genericContainerHandler registry', () => {
  test('registered in DEFAULT_SERVICE_HANDLERS', () => {
    expect(DEFAULT_SERVICE_HANDLERS.some((h) => h.kind === 'container')).toBe(
      true,
    );
  });
  test('findServiceHandler returns generic handler', () => {
    expect(findServiceHandler(spec()).kind).toBe('container');
  });
});

describe('genericContainerHandler.validate', () => {
  test('accepts minimal spec', () => {
    expect(() => genericContainerHandler.validate(spec())).not.toThrow();
  });

  test('rejects volume with both hostPath and name', () => {
    const s = spec({
      volumes: [
        {
          hostPath: '/var/data',
          name: 'mydata',
          containerPath: '/data',
          readOnly: false,
        },
      ],
    });
    expect(() => genericContainerHandler.validate(s)).toThrow(ServiceError);
  });

  test('accepts volume with only hostPath', () => {
    const s = spec({
      volumes: [
        { hostPath: '/var/data', containerPath: '/data', readOnly: false },
      ],
    });
    expect(() => genericContainerHandler.validate(s)).not.toThrow();
  });

  test('accepts volume with only name', () => {
    const s = spec({
      volumes: [{ name: 'mydata', containerPath: '/data', readOnly: false }],
    });
    expect(() => genericContainerHandler.validate(s)).not.toThrow();
  });
});

describe('genericContainerHandler.computeSpecHash', () => {
  test('stable across calls', () => {
    const h1 = genericContainerHandler.computeSpecHash(spec());
    const h2 = genericContainerHandler.computeSpecHash(spec());
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  test('name changes do NOT change hash', () => {
    const h1 = genericContainerHandler.computeSpecHash(spec({ name: 'a' }));
    const h2 = genericContainerHandler.computeSpecHash(spec({ name: 'b' }));
    expect(h1).toBe(h2);
  });

  test('image tag change reshapes hash', () => {
    const h1 = genericContainerHandler.computeSpecHash(spec());
    const h2 = genericContainerHandler.computeSpecHash(
      spec({ image: { repository: 'nginx', tag: 'latest' } }),
    );
    expect(h1).not.toBe(h2);
  });

  test('env change reshapes hash', () => {
    const h1 = genericContainerHandler.computeSpecHash(spec());
    const h2 = genericContainerHandler.computeSpecHash(
      spec({ env: { FOO: 'bar' } }),
    );
    expect(h1).not.toBe(h2);
  });

  test('ports change reshapes hash', () => {
    const h1 = genericContainerHandler.computeSpecHash(spec());
    const h2 = genericContainerHandler.computeSpecHash(
      spec({
        ports: [{ containerPort: 80, hostPort: 8080, protocol: 'tcp' }],
      }),
    );
    expect(h1).not.toBe(h2);
  });

  test('key order in env does not affect hash', () => {
    const h1 = genericContainerHandler.computeSpecHash(
      spec({ env: { A: '1', B: '2' } }),
    );
    const h2 = genericContainerHandler.computeSpecHash(
      spec({ env: { B: '2', A: '1' } }),
    );
    expect(h1).toBe(h2);
  });
});

describe('genericContainerHandler.toDeployment', () => {
  test('emits deterministic name', () => {
    const d = genericContainerHandler.toDeployment(spec(), {
      compositeName: 'demo',
    });
    if (!d) throw new Error('expected deployment');
    expect(d.name).toBe('llamactl-container-demo-nginx');
  });

  test('maps ports 1:1', () => {
    const d = genericContainerHandler.toDeployment(
      spec({
        ports: [
          { containerPort: 80, hostPort: 8080, protocol: 'tcp' },
          { containerPort: 443, protocol: 'tcp' },
        ],
      }),
      { compositeName: 'demo' },
    );
    if (!d) throw new Error('expected deployment');
    expect(d.ports).toEqual([
      { containerPort: 80, hostPort: 8080, protocol: 'tcp' },
      { containerPort: 443, protocol: 'tcp' },
    ]);
  });

  test('maps volumes 1:1', () => {
    const d = genericContainerHandler.toDeployment(
      spec({
        volumes: [
          { hostPath: '/var/data', containerPath: '/data', readOnly: false },
          { name: 'cache', containerPath: '/cache', readOnly: true },
        ],
      }),
      { compositeName: 'demo' },
    );
    if (!d) throw new Error('expected deployment');
    expect(d.volumes).toEqual([
      { hostPath: '/var/data', containerPath: '/data', readOnly: false },
      { name: 'cache', containerPath: '/cache', readOnly: true },
    ]);
  });

  test('omits volumes key when empty', () => {
    const d = genericContainerHandler.toDeployment(spec(), {
      compositeName: 'demo',
    });
    if (!d) throw new Error('expected deployment');
    expect(d.volumes).toBeUndefined();
  });

  test('passes through healthcheck', () => {
    const d = genericContainerHandler.toDeployment(
      spec({
        healthcheck: {
          test: ['CMD', 'echo', 'ok'],
          intervalMs: 5_000,
          timeoutMs: 1_000,
          retries: 3,
        },
      }),
      { compositeName: 'demo' },
    );
    if (!d) throw new Error('expected deployment');
    expect(d.healthcheck).toEqual({
      test: ['CMD', 'echo', 'ok'],
      intervalMs: 5_000,
      timeoutMs: 1_000,
      retries: 3,
    });
  });

  test('stamps llamactl labels including spec.hash', () => {
    const d = genericContainerHandler.toDeployment(spec(), {
      compositeName: 'demo',
    });
    if (!d) throw new Error('expected deployment');
    expect(d.labels?.[LABEL_KEYS.managedBy]).toBe(MANAGED_BY_VALUE);
    expect(d.labels?.[LABEL_KEYS.composite]).toBe('demo');
    expect(d.labels?.[LABEL_KEYS.service]).toBe('nginx');
    expect(d.labels?.[LABEL_KEYS.specHash]).toBe(d.specHash);
  });

  test('passes env through', () => {
    const d = genericContainerHandler.toDeployment(
      spec({ env: { FOO: 'bar', BAR: 'baz' } }),
      { compositeName: 'demo' },
    );
    if (!d) throw new Error('expected deployment');
    expect(d.env).toEqual({ FOO: 'bar', BAR: 'baz' });
  });

  test('spec.secrets propagate to ServiceDeployment.secrets', () => {
    const d = genericContainerHandler.toDeployment(
      spec({
        secrets: {
          API_KEY: { ref: 'env:MY_API_KEY' },
          DB_PASSWORD: { ref: 'keychain:llamactl/db-main' },
        },
      }),
      { compositeName: 'demo' },
    );
    if (!d) throw new Error('expected deployment');
    expect(d.secrets).toEqual({
      API_KEY: { ref: 'env:MY_API_KEY' },
      DB_PASSWORD: { ref: 'keychain:llamactl/db-main' },
    });
  });

  test('specHash reflects secret-ref changes', () => {
    const h1 = genericContainerHandler.computeSpecHash(spec());
    const h2 = genericContainerHandler.computeSpecHash(
      spec({ secrets: { A: { ref: 'env:X' } } }),
    );
    const h3 = genericContainerHandler.computeSpecHash(
      spec({ secrets: { A: { ref: 'env:Y' } } }),
    );
    expect(h1).not.toBe(h2);
    expect(h2).not.toBe(h3);
  });
});

describe('genericContainerHandler.resolvedEndpoint', () => {
  test('resolves from instance when endpoint present', () => {
    const e = genericContainerHandler.resolvedEndpoint(
      spec({ ports: [{ containerPort: 80, hostPort: 8080, protocol: 'tcp' }] }),
      dockerInstance('10.0.0.1', 8080),
    );
    expect(e).toEqual({
      host: '10.0.0.1',
      port: 8080,
      url: 'http://10.0.0.1:8080',
    });
  });

  test('falls back to first declared hostPort when instance missing', () => {
    const e = genericContainerHandler.resolvedEndpoint(
      spec({ ports: [{ containerPort: 80, hostPort: 8080, protocol: 'tcp' }] }),
      null,
    );
    expect(e.host).toBe('127.0.0.1');
    expect(e.port).toBe(8080);
  });

  test('falls back to containerPort when hostPort omitted', () => {
    const e = genericContainerHandler.resolvedEndpoint(
      spec({ ports: [{ containerPort: 3000, protocol: 'tcp' }] }),
      null,
    );
    expect(e.port).toBe(3000);
  });

  test('throws endpoint-unresolvable when no ports declared', () => {
    try {
      genericContainerHandler.resolvedEndpoint(spec(), null);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('endpoint-unresolvable');
    }
  });
});
