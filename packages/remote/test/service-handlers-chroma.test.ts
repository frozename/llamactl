import { describe, expect, test } from 'bun:test';
import type { ServiceInstance } from '../src/runtime/backend.js';
import { LABEL_KEYS, MANAGED_BY_VALUE } from '../src/runtime/labels.js';
import { ServiceError } from '../src/service/errors.js';
import { chromaHandler } from '../src/service/handlers/chroma-handler.js';
import {
  DEFAULT_SERVICE_HANDLERS,
  findServiceHandler,
} from '../src/service/handlers/registry.js';
import {
  ChromaServiceSpecSchema,
  type ChromaServiceSpec,
} from '../src/service/schema.js';

function spec(overrides: Partial<ChromaServiceSpec> = {}): ChromaServiceSpec {
  return ChromaServiceSpecSchema.parse({
    kind: 'chroma',
    name: 'kb',
    node: 'gpu1',
    ...overrides,
  });
}

function dockerInstance(host = '127.0.0.1', port = 8100): ServiceInstance {
  return {
    ref: { name: 'llamactl-chroma-demo-kb' },
    running: true,
    health: 'healthy',
    specHash: 'abc',
    createdAt: '2026-04-20T12:00:00Z',
    endpoint: { host, port },
  };
}

describe('chromaHandler registry', () => {
  test('registered in DEFAULT_SERVICE_HANDLERS', () => {
    expect(DEFAULT_SERVICE_HANDLERS.some((h) => h.kind === 'chroma')).toBe(true);
  });
  test('findServiceHandler returns chroma handler', () => {
    expect(findServiceHandler(spec()).kind).toBe('chroma');
  });
});

describe('chromaHandler.validate', () => {
  test('accepts default docker runtime', () => {
    expect(() => chromaHandler.validate(spec())).not.toThrow();
  });

  test('rejects external runtime without externalEndpoint', () => {
    const s = spec({ runtime: 'external' });
    expect(() => chromaHandler.validate(s)).toThrow(ServiceError);
  });

  test('rejects external runtime with image override', () => {
    const s = spec({
      runtime: 'external',
      externalEndpoint: 'http://chroma.internal:8000',
      image: { repository: 'chromadb/chroma', tag: '1.5.8' },
    });
    expect(() => chromaHandler.validate(s)).toThrow(ServiceError);
  });

  test('accepts external runtime with externalEndpoint', () => {
    const s = spec({
      runtime: 'external',
      externalEndpoint: 'http://chroma.internal:8000',
    });
    expect(() => chromaHandler.validate(s)).not.toThrow();
  });

  test('rejects docker runtime with externalEndpoint', () => {
    const s = spec({ externalEndpoint: 'http://chroma.internal:8000' });
    expect(() => chromaHandler.validate(s)).toThrow(ServiceError);
  });
});

describe('chromaHandler.computeSpecHash', () => {
  test('stable across calls', () => {
    const h1 = chromaHandler.computeSpecHash(spec());
    const h2 = chromaHandler.computeSpecHash(spec());
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  test('name changes do NOT change hash (identity-only)', () => {
    const h1 = chromaHandler.computeSpecHash(spec({ name: 'kb' }));
    const h2 = chromaHandler.computeSpecHash(spec({ name: 'other' }));
    expect(h1).toBe(h2);
  });

  test('image tag change reshapes hash', () => {
    const h1 = chromaHandler.computeSpecHash(spec());
    const h2 = chromaHandler.computeSpecHash(
      spec({ image: { repository: 'chromadb/chroma', tag: '1.5.9' } }),
    );
    expect(h1).not.toBe(h2);
  });

  test('port change reshapes hash', () => {
    const h1 = chromaHandler.computeSpecHash(spec());
    const h2 = chromaHandler.computeSpecHash(spec({ port: 9000 }));
    expect(h1).not.toBe(h2);
  });

  test('persistence change reshapes hash', () => {
    const h1 = chromaHandler.computeSpecHash(spec());
    const h2 = chromaHandler.computeSpecHash(
      spec({ persistence: { volume: '/var/data', mountPath: '/data' } }),
    );
    expect(h1).not.toBe(h2);
  });
});

describe('chromaHandler.toDeployment', () => {
  test('returns null for runtime=external', () => {
    const d = chromaHandler.toDeployment(
      spec({
        runtime: 'external',
        externalEndpoint: 'http://chroma.internal:8000',
      }),
      { compositeName: 'demo' },
    );
    expect(d).toBeNull();
  });

  test('emits deterministic name + default image + healthcheck', () => {
    const d = chromaHandler.toDeployment(spec(), { compositeName: 'demo' });
    expect(d).not.toBeNull();
    if (!d) return;
    expect(d.name).toBe('llamactl-chroma-demo-kb');
    expect(d.image.repository).toBe('chromadb/chroma');
    expect(d.image.tag).toBe('1.5.8');
    expect(d.ports).toEqual([
      { containerPort: 8000, hostPort: 8000, protocol: 'tcp' },
    ]);
    expect(d.healthcheck?.test).toEqual([
      'CMD',
      'curl',
      '-f',
      'http://localhost:8000/api/v1/heartbeat',
    ]);
    expect(d.restartPolicy).toBe('unless-stopped');
  });

  test('stamps llamactl labels including spec.hash', () => {
    const d = chromaHandler.toDeployment(spec(), { compositeName: 'demo' });
    if (!d) throw new Error('expected deployment');
    expect(d.labels?.[LABEL_KEYS.managedBy]).toBe(MANAGED_BY_VALUE);
    expect(d.labels?.[LABEL_KEYS.composite]).toBe('demo');
    expect(d.labels?.[LABEL_KEYS.service]).toBe('kb');
    expect(d.labels?.[LABEL_KEYS.specHash]).toBe(d.specHash);
  });

  test('omits volumes when persistence not configured', () => {
    const d = chromaHandler.toDeployment(spec(), { compositeName: 'demo' });
    if (!d) throw new Error('expected deployment');
    expect(d.volumes).toBeUndefined();
  });

  test('emits bind mount when persistence.volume set', () => {
    const d = chromaHandler.toDeployment(
      spec({ persistence: { volume: '/var/llamactl/chroma', mountPath: '/data' } }),
      { compositeName: 'demo' },
    );
    if (!d) throw new Error('expected deployment');
    expect(d.volumes).toEqual([
      { hostPath: '/var/llamactl/chroma', containerPath: '/data' },
    ]);
  });

  test('honors custom mountPath', () => {
    const d = chromaHandler.toDeployment(
      spec({
        persistence: { volume: '/var/llamactl/chroma', mountPath: '/chroma' },
      }),
      { compositeName: 'demo' },
    );
    if (!d) throw new Error('expected deployment');
    expect(d.volumes?.[0]?.containerPath).toBe('/chroma');
  });

  test('honors image override', () => {
    const d = chromaHandler.toDeployment(
      spec({ image: { repository: 'ghcr.io/me/chroma', tag: '2.0.0' } }),
      { compositeName: 'demo' },
    );
    if (!d) throw new Error('expected deployment');
    expect(d.image.repository).toBe('ghcr.io/me/chroma');
    expect(d.image.tag).toBe('2.0.0');
  });

  test('spec.secrets propagates to ServiceDeployment.secrets', () => {
    const d = chromaHandler.toDeployment(
      spec({
        secrets: {
          CHROMA_AUTH_TOKEN: { ref: 'keychain:llamactl/chroma-main' },
        },
      }),
      { compositeName: 'kb' },
    );
    if (!d) throw new Error('expected deployment');
    expect(d.secrets).toEqual({
      CHROMA_AUTH_TOKEN: { ref: 'keychain:llamactl/chroma-main' },
    });
  });

  test('specHash changes when secret refs change', () => {
    const h1 = chromaHandler.computeSpecHash(spec());
    const h2 = chromaHandler.computeSpecHash(
      spec({ secrets: { X: { ref: 'env:FOO' } } }),
    );
    const h3 = chromaHandler.computeSpecHash(
      spec({ secrets: { X: { ref: 'env:BAR' } } }),
    );
    expect(h1).not.toBe(h2);
    expect(h2).not.toBe(h3);
  });
});

describe('chromaHandler.resolvedEndpoint', () => {
  test('docker runtime with instance endpoint', () => {
    const e = chromaHandler.resolvedEndpoint(spec(), dockerInstance('10.0.0.5', 8100));
    expect(e).toEqual({
      host: '10.0.0.5',
      port: 8100,
      url: 'http://10.0.0.5:8100',
    });
  });

  test('docker runtime without instance → endpoint-unresolvable', () => {
    try {
      chromaHandler.resolvedEndpoint(spec(), null);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('endpoint-unresolvable');
    }
  });

  test('docker runtime with instance but no endpoint → endpoint-unresolvable', () => {
    const inst: ServiceInstance = { ...dockerInstance(), endpoint: null };
    try {
      chromaHandler.resolvedEndpoint(spec(), inst);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('endpoint-unresolvable');
    }
  });

  test('external runtime parses http URL with explicit port', () => {
    const e = chromaHandler.resolvedEndpoint(
      spec({
        runtime: 'external',
        externalEndpoint: 'http://chroma.internal:9001',
      }),
      null,
    );
    expect(e).toEqual({
      host: 'chroma.internal',
      port: 9001,
      url: 'http://chroma.internal:9001',
    });
  });

  test('external runtime defaults port to 8000 for http', () => {
    const e = chromaHandler.resolvedEndpoint(
      spec({ runtime: 'external', externalEndpoint: 'http://chroma.internal' }),
      null,
    );
    expect(e.port).toBe(8000);
  });

  test('external runtime defaults port to 443 for https', () => {
    const e = chromaHandler.resolvedEndpoint(
      spec({
        runtime: 'external',
        externalEndpoint: 'https://chroma.example.com',
      }),
      null,
    );
    expect(e.port).toBe(443);
  });

  test('external runtime with invalid URL throws spec-invalid', () => {
    try {
      chromaHandler.resolvedEndpoint(
        spec({ runtime: 'external', externalEndpoint: 'not-a-url' }),
        null,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('spec-invalid');
    }
  });
});
