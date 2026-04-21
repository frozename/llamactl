import { describe, expect, test } from 'bun:test';
import {
  ClusterNodeSchema,
  RagBindingSchema,
  RagProviderKindSchema,
  resolveNodeKind,
} from '../src/config/schema.js';

describe('RAG schema', () => {
  test('RagProviderKindSchema accepts chroma + pgvector', () => {
    expect(RagProviderKindSchema.parse('chroma')).toBe('chroma');
    expect(RagProviderKindSchema.parse('pgvector')).toBe('pgvector');
    expect(() => RagProviderKindSchema.parse('qdrant')).toThrow();
  });

  test('RagBindingSchema requires provider + endpoint', () => {
    expect(() => RagBindingSchema.parse({ provider: 'chroma' })).toThrow();
    expect(() =>
      RagBindingSchema.parse({ provider: 'chroma', endpoint: '' }),
    ).toThrow();
    const ok = RagBindingSchema.parse({
      provider: 'chroma',
      endpoint: 'chroma-mcp run --persist-directory /data',
    });
    expect(ok.provider).toBe('chroma');
    expect(ok.extraArgs).toEqual([]);
  });

  test('RagBindingSchema carries optional auth + embedModel + extraArgs', () => {
    const parsed = RagBindingSchema.parse({
      provider: 'pgvector',
      endpoint: 'postgres://kb@db.local:5432/kb_main',
      collection: 'docs',
      auth: { tokenEnv: 'PG_PASSWORD' },
      embedModel: 'nomic-embed-text-v1.5',
      extraArgs: ['--ssl'],
    });
    expect(parsed.collection).toBe('docs');
    expect(parsed.auth?.tokenEnv).toBe('PG_PASSWORD');
    expect(parsed.embedModel).toBe('nomic-embed-text-v1.5');
    expect(parsed.extraArgs).toEqual(['--ssl']);
  });

  test('ClusterNodeSchema accepts a rag-kind chroma node', () => {
    const node = ClusterNodeSchema.parse({
      name: 'kb-chroma',
      endpoint: '',
      kind: 'rag',
      rag: {
        provider: 'chroma',
        endpoint: 'chroma-mcp run --persist-directory /data/chroma',
      },
    });
    expect(resolveNodeKind(node)).toBe('rag');
    expect(node.rag?.provider).toBe('chroma');
  });

  test('ClusterNodeSchema accepts a rag-kind pgvector node', () => {
    const node = ClusterNodeSchema.parse({
      name: 'kb-pg',
      endpoint: '',
      kind: 'rag',
      rag: {
        provider: 'pgvector',
        endpoint: 'postgres://kb@db.local:5432/kb_main',
        collection: 'documents',
      },
    });
    expect(resolveNodeKind(node)).toBe('rag');
    expect(node.rag?.provider).toBe('pgvector');
    expect(node.rag?.collection).toBe('documents');
  });

  test('ClusterNodeSchema rejects rag-kind without rag block', () => {
    expect(() =>
      ClusterNodeSchema.parse({
        name: 'kb-broken',
        endpoint: '',
        kind: 'rag',
      }),
    ).toThrow();
  });

  test('ClusterNodeSchema rejects non-rag node carrying a rag block', () => {
    expect(() =>
      ClusterNodeSchema.parse({
        name: 'mixed',
        endpoint: 'https://agent.local:7843',
        kind: 'agent',
        rag: {
          provider: 'chroma',
          endpoint: 'chroma-mcp run',
        },
      }),
    ).toThrow();
  });

  test('ClusterNodeSchema rejects unknown rag provider', () => {
    expect(() =>
      ClusterNodeSchema.parse({
        name: 'kb-unknown',
        endpoint: '',
        kind: 'rag',
        rag: {
          provider: 'milvus',
          endpoint: 'http://milvus.local:19530',
        },
      }),
    ).toThrow();
  });

  test('resolveNodeKind infers rag from binding when kind is absent', () => {
    const node = ClusterNodeSchema.parse({
      name: 'kb-implicit',
      endpoint: '',
      rag: {
        provider: 'chroma',
        endpoint: 'chroma-mcp run',
      },
    });
    expect(resolveNodeKind(node)).toBe('rag');
  });

  test('RagBindingSchema accepts an optional embedder binding', () => {
    const node = ClusterNodeSchema.parse({
      name: 'kb-with-embedder',
      endpoint: '',
      kind: 'rag',
      rag: {
        provider: 'pgvector',
        endpoint: 'postgres://kb@db.local:5432/kb_main',
        collection: 'docs',
        embedder: {
          node: 'sirius-gateway',
          model: 'text-embedding-3-small',
        },
      },
    });
    expect(node.rag?.embedder?.node).toBe('sirius-gateway');
    expect(node.rag?.embedder?.model).toBe('text-embedding-3-small');
  });

  test('RagBindingSchema rejects an embedder missing its model', () => {
    expect(() =>
      ClusterNodeSchema.parse({
        name: 'kb-broken-embedder',
        endpoint: '',
        kind: 'rag',
        rag: {
          provider: 'pgvector',
          endpoint: 'postgres://kb@db.local:5432/kb_main',
          embedder: { node: 'sirius-gateway' },
        },
      }),
    ).toThrow();
  });
});
