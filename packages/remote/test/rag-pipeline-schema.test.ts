import { describe, expect, test } from 'bun:test';

import {
  FilesystemSourceSpecSchema,
  HttpSourceSpecSchema,
  MarkdownChunkTransformSchema,
  RagPipelineManifestSchema,
  RagPipelineSpecSchema,
  SourceSpecSchema,
  TransformSpecSchema,
} from '../src/rag/pipeline/schema.js';

describe('FilesystemSourceSpecSchema', () => {
  test('applies glob default and accepts tags', () => {
    const parsed = FilesystemSourceSpecSchema.parse({
      kind: 'filesystem',
      root: '/tmp/docs',
      tag: { team: 'platform' },
    });
    expect(parsed.glob).toBe('**/*');
    expect(parsed.tag).toEqual({ team: 'platform' });
  });

  test('rejects empty root', () => {
    expect(() =>
      FilesystemSourceSpecSchema.parse({ kind: 'filesystem', root: '' }),
    ).toThrow();
  });
});

describe('HttpSourceSpecSchema', () => {
  test('applies all defaults', () => {
    const parsed = HttpSourceSpecSchema.parse({
      kind: 'http',
      url: 'https://docs.example.com',
    });
    expect(parsed.max_depth).toBe(1);
    expect(parsed.same_origin).toBe(true);
    expect(parsed.ignore_robots).toBe(false);
    expect(parsed.rate_limit_per_sec).toBe(2);
    expect(parsed.timeout_ms).toBe(10_000);
  });

  test('rejects non-url', () => {
    expect(() =>
      HttpSourceSpecSchema.parse({ kind: 'http', url: 'not-a-url' }),
    ).toThrow();
  });

  test('rejects max_depth above 5', () => {
    expect(() =>
      HttpSourceSpecSchema.parse({
        kind: 'http',
        url: 'https://example.com',
        max_depth: 6,
      }),
    ).toThrow();
  });

  test('accepts auth.tokenRef', () => {
    const parsed = HttpSourceSpecSchema.parse({
      kind: 'http',
      url: 'https://example.com',
      auth: { tokenRef: 'env:DOCS_TOKEN' },
    });
    expect(parsed.auth?.tokenRef).toBe('env:DOCS_TOKEN');
  });
});

describe('SourceSpecSchema discriminated union', () => {
  test('routes by kind', () => {
    const fs = SourceSpecSchema.parse({
      kind: 'filesystem',
      root: '/tmp',
    });
    expect(fs.kind).toBe('filesystem');
    const http = SourceSpecSchema.parse({
      kind: 'http',
      url: 'https://example.com',
    });
    expect(http.kind).toBe('http');
  });

  test('rejects unknown kinds', () => {
    expect(() =>
      SourceSpecSchema.parse({ kind: 'git', url: 'https://example.com' }),
    ).toThrow();
  });
});

describe('MarkdownChunkTransformSchema', () => {
  test('applies defaults', () => {
    const parsed = MarkdownChunkTransformSchema.parse({
      kind: 'markdown-chunk',
    });
    expect(parsed.chunk_size).toBe(800);
    expect(parsed.overlap).toBe(150);
    expect(parsed.preserve_headings).toBe(true);
  });

  test('rejects zero chunk_size', () => {
    expect(() =>
      MarkdownChunkTransformSchema.parse({
        kind: 'markdown-chunk',
        chunk_size: 0,
      }),
    ).toThrow();
  });
});

describe('TransformSpecSchema', () => {
  test('routes by kind', () => {
    const t = TransformSpecSchema.parse({ kind: 'markdown-chunk' });
    expect(t.kind).toBe('markdown-chunk');
  });

  test('rejects unknown kinds', () => {
    expect(() => TransformSpecSchema.parse({ kind: 'html-chunk' })).toThrow();
  });
});

describe('RagPipelineSpecSchema', () => {
  test('applies transforms default + on_duplicate default', () => {
    const parsed = RagPipelineSpecSchema.parse({
      destination: { ragNode: 'kb-pg', collection: 'docs' },
      sources: [{ kind: 'filesystem', root: '/tmp' }],
    });
    expect(parsed.transforms).toEqual([]);
    expect(parsed.concurrency).toBe(4);
    expect(parsed.on_duplicate).toBe('skip');
  });

  test('requires at least one source', () => {
    expect(() =>
      RagPipelineSpecSchema.parse({
        destination: { ragNode: 'kb-pg', collection: 'docs' },
        sources: [],
      }),
    ).toThrow();
  });

  test('rejects concurrency above 32', () => {
    expect(() =>
      RagPipelineSpecSchema.parse({
        destination: { ragNode: 'kb-pg', collection: 'docs' },
        sources: [{ kind: 'filesystem', root: '/tmp' }],
        concurrency: 33,
      }),
    ).toThrow();
  });
});

describe('RagPipelineManifestSchema', () => {
  test('parses the example from the plan', () => {
    const parsed = RagPipelineManifestSchema.parse({
      apiVersion: 'llamactl/v1',
      kind: 'RagPipeline',
      metadata: { name: 'llamactl-docs' },
      spec: {
        destination: { ragNode: 'kb-pg', collection: 'llamactl_docs' },
        sources: [
          {
            kind: 'filesystem',
            root: '/Users/me/docs',
            glob: '**/*.md',
            tag: { source: 'local-docs', team: 'platform' },
          },
          {
            kind: 'http',
            url: 'https://docs.example.com',
            max_depth: 2,
            same_origin: true,
            ignore_robots: false,
            rate_limit_per_sec: 2,
            timeout_ms: 10000,
            auth: { tokenRef: 'keychain:example-docs/apikey' },
          },
        ],
        transforms: [
          {
            kind: 'markdown-chunk',
            chunk_size: 800,
            overlap: 150,
            preserve_headings: true,
          },
        ],
        concurrency: 4,
        on_duplicate: 'skip',
      },
    });
    expect(parsed.metadata.name).toBe('llamactl-docs');
    expect(parsed.spec.sources).toHaveLength(2);
    expect(parsed.spec.sources[0]!.kind).toBe('filesystem');
    expect(parsed.spec.sources[1]!.kind).toBe('http');
  });

  test('rejects wrong apiVersion', () => {
    expect(() =>
      RagPipelineManifestSchema.parse({
        apiVersion: 'llamactl/v2',
        kind: 'RagPipeline',
        metadata: { name: 'x' },
        spec: {
          destination: { ragNode: 'kb-pg', collection: 'docs' },
          sources: [{ kind: 'filesystem', root: '/tmp' }],
        },
      }),
    ).toThrow();
  });
});
