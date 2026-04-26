import { describe, expect, test } from 'bun:test';
import { CompositeSchema, CompositeSpecSchema, PipelineCompositeEntrySchema } from '../src/composite/schema';
import { RagPipelineManifestSchema } from '../src/rag/pipeline/schema';

describe('PipelineCompositeEntrySchema', () => {
  test('accepts a valid entry', () => {
    const out = PipelineCompositeEntrySchema.safeParse({
      name: 'docs-ingest',
      spec: {
        destination: { ragNode: 'kb-chroma', collection: 'docs' },
        sources: [{ kind: 'filesystem', root: '/tmp/docs' }],
      },
    });
    expect(out.success).toBe(true);
  });

  test('rejects uppercase or invalid name', () => {
    expect(
      PipelineCompositeEntrySchema.safeParse({
        name: 'DocsIngest',
        spec: { destination: { ragNode: 'kb', collection: 'd' }, sources: [{ kind: 'filesystem', root: '/x' }] },
      }).success,
    ).toBe(false);
  });
});

describe('CompositeSpecSchema with pipelines', () => {
  test('pipelines field defaults to []', () => {
    const out = CompositeSpecSchema.parse({});
    expect(out.pipelines).toEqual([]);
  });

  test('rejects duplicate pipeline names within a composite', () => {
    const result = CompositeSchema.safeParse({
      apiVersion: 'llamactl/v1',
      kind: 'Composite',
      metadata: { name: 'mc' },
      spec: {
        pipelines: [
          { name: 'docs', spec: { destination: { ragNode: 'kb', collection: 'd' }, sources: [{ kind: 'filesystem', root: '/x' }] } },
          { name: 'docs', spec: { destination: { ragNode: 'kb', collection: 'd' }, sources: [{ kind: 'filesystem', root: '/x' }] } },
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  test('allows the same name across different kinds (per-kind namespace)', () => {
    const result = CompositeSchema.safeParse({
      apiVersion: 'llamactl/v1',
      kind: 'Composite',
      metadata: { name: 'mc' },
      spec: {
        services: [{ kind: 'chroma', name: 'docs', node: 'n1' }],
        pipelines: [
          { name: 'docs', spec: { destination: { ragNode: 'kb', collection: 'd' }, sources: [{ kind: 'filesystem', root: '/x' }] } },
        ],
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('RagPipelineManifestSchema with ownership', () => {
  test('round-trips ownership marker', () => {
    const out = RagPipelineManifestSchema.parse({
      apiVersion: 'llamactl/v1',
      kind: 'RagPipeline',
      metadata: { name: 'docs' },
      spec: { destination: { ragNode: 'kb', collection: 'd' }, sources: [{ kind: 'filesystem', root: '/x' }] },
      ownership: {
        source: 'composite',
        compositeNames: ['mc'],
        specHash: 'abc',
      },
    });
    expect(out.ownership?.compositeNames).toEqual(['mc']);
  });

  test('parses operator manifest without ownership marker', () => {
    const out = RagPipelineManifestSchema.parse({
      apiVersion: 'llamactl/v1',
      kind: 'RagPipeline',
      metadata: { name: 'docs' },
      spec: { destination: { ragNode: 'kb', collection: 'd' }, sources: [{ kind: 'filesystem', root: '/x' }] },
    });
    expect(out.ownership).toBeUndefined();
  });
});
