import { describe, expect, test } from 'bun:test';
import {
  ChromaServiceSpecSchema,
  GenericContainerServiceSpecSchema,
  PgvectorServiceSpecSchema,
  ServiceSpecSchema,
} from '../src/service/schema.js';

describe('ChromaServiceSpecSchema', () => {
  test('parses a minimal spec and fills defaults', () => {
    const parsed = ChromaServiceSpecSchema.parse({
      kind: 'chroma',
      name: 'kb',
      node: 'gpu1',
    });
    expect(parsed.runtime).toBe('docker');
    expect(parsed.port).toBe(8000);
    expect(parsed.image).toBeUndefined();
  });

  test('rejects empty name', () => {
    expect(() =>
      ChromaServiceSpecSchema.parse({ kind: 'chroma', name: '', node: 'gpu1' }),
    ).toThrow();
  });

  test('rejects non-positive port', () => {
    expect(() =>
      ChromaServiceSpecSchema.parse({
        kind: 'chroma',
        name: 'kb',
        node: 'gpu1',
        port: 0,
      }),
    ).toThrow();
  });

  test('fills nested image defaults when image object is provided', () => {
    const parsed = ChromaServiceSpecSchema.parse({
      kind: 'chroma',
      name: 'kb',
      node: 'gpu1',
      image: {},
    });
    expect(parsed.image?.repository).toBe('chromadb/chroma');
    expect(parsed.image?.tag).toBe('1.5.8');
  });

  test('accepts runtime=external with externalEndpoint', () => {
    const parsed = ChromaServiceSpecSchema.parse({
      kind: 'chroma',
      name: 'kb',
      node: 'cloud',
      runtime: 'external',
      externalEndpoint: 'http://chroma.internal:8000',
    });
    expect(parsed.runtime).toBe('external');
    expect(parsed.externalEndpoint).toBe('http://chroma.internal:8000');
  });
});

describe('PgvectorServiceSpecSchema', () => {
  test('parses minimal and fills defaults', () => {
    const parsed = PgvectorServiceSpecSchema.parse({
      kind: 'pgvector',
      name: 'pg',
      node: 'gpu1',
    });
    expect(parsed.runtime).toBe('docker');
    expect(parsed.port).toBe(5432);
    expect(parsed.database).toBe('postgres');
    expect(parsed.user).toBe('postgres');
  });

  test('honors overrides', () => {
    const parsed = PgvectorServiceSpecSchema.parse({
      kind: 'pgvector',
      name: 'pg',
      node: 'gpu1',
      database: 'rag',
      user: 'rag_user',
      passwordEnv: 'PGPASS',
    });
    expect(parsed.database).toBe('rag');
    expect(parsed.user).toBe('rag_user');
    expect(parsed.passwordEnv).toBe('PGPASS');
  });
});

describe('GenericContainerServiceSpecSchema', () => {
  test('requires explicit image repository + tag', () => {
    expect(() =>
      GenericContainerServiceSpecSchema.parse({
        kind: 'container',
        name: 'nginx',
        node: 'gpu1',
      }),
    ).toThrow();
  });

  test('parses with empty defaults for env/ports/volumes', () => {
    const parsed = GenericContainerServiceSpecSchema.parse({
      kind: 'container',
      name: 'nginx',
      node: 'gpu1',
      image: { repository: 'nginx', tag: 'alpine' },
    });
    expect(parsed.env).toEqual({});
    expect(parsed.ports).toEqual([]);
    expect(parsed.volumes).toEqual([]);
  });

  test('fills port protocol default to tcp', () => {
    const parsed = GenericContainerServiceSpecSchema.parse({
      kind: 'container',
      name: 'nginx',
      node: 'gpu1',
      image: { repository: 'nginx', tag: 'alpine' },
      ports: [{ containerPort: 80 }],
    });
    expect(parsed.ports[0]?.protocol).toBe('tcp');
  });

  test('fills volume readOnly default to false', () => {
    const parsed = GenericContainerServiceSpecSchema.parse({
      kind: 'container',
      name: 'nginx',
      node: 'gpu1',
      image: { repository: 'nginx', tag: 'alpine' },
      volumes: [{ containerPath: '/data' }],
    });
    expect(parsed.volumes[0]?.readOnly).toBe(false);
  });
});

describe('ServiceSpecSchema (discriminated union)', () => {
  test('routes by kind — chroma', () => {
    const parsed = ServiceSpecSchema.parse({
      kind: 'chroma',
      name: 'kb',
      node: 'gpu1',
    });
    expect(parsed.kind).toBe('chroma');
  });

  test('routes by kind — pgvector', () => {
    const parsed = ServiceSpecSchema.parse({
      kind: 'pgvector',
      name: 'pg',
      node: 'gpu1',
    });
    expect(parsed.kind).toBe('pgvector');
  });

  test('routes by kind — container', () => {
    const parsed = ServiceSpecSchema.parse({
      kind: 'container',
      name: 'nginx',
      node: 'gpu1',
      image: { repository: 'nginx', tag: 'alpine' },
    });
    expect(parsed.kind).toBe('container');
  });

  test('rejects unknown kind', () => {
    expect(() =>
      ServiceSpecSchema.parse({ kind: 'redis', name: 'r', node: 'gpu1' }),
    ).toThrow();
  });

  test('rejects missing kind discriminator', () => {
    expect(() =>
      ServiceSpecSchema.parse({ name: 'x', node: 'gpu1' } as unknown),
    ).toThrow();
  });
});
