import { describe, expect, test } from 'bun:test';

import { draftPipeline } from '../src/rag/pipeline/draft.js';

/**
 * The drafter is pure — no I/O, no LLM, no disk. Tests drive NL
 * descriptions in and assert the parsed manifest + warnings shape.
 * The YAML string itself is incidental; we parse the returned
 * `manifest` object directly.
 */

describe('draftPipeline', () => {
  test('empty description → skeleton + "empty" warning + placeholder source', () => {
    const r = draftPipeline('');
    expect(r.manifest.metadata.name).toBe('draft');
    expect(r.manifest.spec.sources).toHaveLength(1);
    expect(r.manifest.spec.sources[0]!.kind).toBe('filesystem');
    expect(r.warnings.some((w) => w.includes('empty'))).toBe(true);
  });

  test('URL in description → http source + inferred name + collection from host', () => {
    const r = draftPipeline('crawl https://docs.pytorch.org into kb-pg');
    expect(r.manifest.spec.sources).toHaveLength(1);
    const src = r.manifest.spec.sources[0]!;
    expect(src.kind).toBe('http');
    if (src.kind === 'http') {
      expect(src.url).toBe('https://docs.pytorch.org');
      expect(src.max_depth).toBe(2);
      expect(src.same_origin).toBe(true);
    }
    expect(r.manifest.metadata.name).toBe('docs-pytorch-org');
    expect(r.manifest.spec.destination.collection).toBe('docs_pytorch_org');
    expect(r.manifest.spec.destination.ragNode).toBe('kb-pg');
  });

  test('absolute path → filesystem source + inferred name', () => {
    const r = draftPipeline('ingest /Users/alex/docs daily');
    expect(r.manifest.spec.sources).toHaveLength(1);
    const src = r.manifest.spec.sources[0]!;
    expect(src.kind).toBe('filesystem');
    if (src.kind === 'filesystem') {
      expect(src.root).toBe('/Users/alex/docs');
      expect(src.glob).toBe('**/*.md');
    }
    expect(r.manifest.metadata.name).toBe('docs');
    expect(r.manifest.spec.schedule).toBe('@daily');
  });

  test('mixed URL + path yields two sources in source order', () => {
    const r = draftPipeline(
      'crawl https://example.com and also ingest /tmp/notes into docs collection notes_combo',
    );
    expect(r.manifest.spec.sources).toHaveLength(2);
    expect(r.manifest.spec.sources[0]!.kind).toBe('http');
    expect(r.manifest.spec.sources[1]!.kind).toBe('filesystem');
    expect(r.manifest.spec.destination.collection).toBe('notes_combo');
  });

  test('@every 15m schedule is parsed', () => {
    const r = draftPipeline('run /docs every 15 minutes');
    expect(r.manifest.spec.schedule).toBe('@every 15m');
  });

  test('@every Nh schedule', () => {
    const r = draftPipeline('run /docs every 4 hours');
    expect(r.manifest.spec.schedule).toBe('@every 4h');
  });

  test('@hourly literal is preserved', () => {
    const r = draftPipeline('ingest /docs @hourly');
    expect(r.manifest.spec.schedule).toBe('@hourly');
  });

  test('no schedule keyword → no schedule field', () => {
    const r = draftPipeline('ingest /docs');
    expect(r.manifest.spec.schedule).toBeUndefined();
  });

  test('availableRagNodes: picks the first node whose name appears in the description', () => {
    const r = draftPipeline('stash https://site.io into kb-chroma please', {
      availableRagNodes: ['kb-pg', 'kb-chroma'],
    });
    expect(r.manifest.spec.destination.ragNode).toBe('kb-chroma');
  });

  test('availableRagNodes: none match → falls back + warns', () => {
    const r = draftPipeline('stash https://site.io', {
      availableRagNodes: ['kb-pg', 'kb-chroma'],
      defaultRagNode: 'kb-pg',
    });
    expect(r.manifest.spec.destination.ragNode).toBe('kb-pg');
    expect(r.warnings.some((w) => w.includes('no rag node'))).toBe(true);
  });

  test('nameOverride is used verbatim when provided', () => {
    const r = draftPipeline('ingest https://docs.example.com', {
      nameOverride: 'custom-name',
    });
    expect(r.manifest.metadata.name).toBe('custom-name');
  });

  test('collection can be set via explicit "collection <name>" phrase', () => {
    const r = draftPipeline('crawl https://site.io collection my_collection');
    expect(r.manifest.spec.destination.collection).toBe('my_collection');
  });

  test('emitted yaml round-trips through the schema', () => {
    const r = draftPipeline('crawl https://x.dev every 30 minutes');
    // The yaml is what a caller would hand to `rag pipeline apply`.
    // We already exercise the schema internally in draftPipeline(),
    // but assert once more that the output is parseable-as-literal.
    expect(r.yaml).toContain('kind: RagPipeline');
    expect(r.yaml).toContain('apiVersion: llamactl/v1');
    expect(r.yaml).toContain('@every 30m');
  });
});
