import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPipeline, loadPipeline } from '../src/rag/pipeline/store.js';
import type { RagPipelineManifest } from '../src/rag/pipeline/schema.js';

const baseManifest: RagPipelineManifest = {
  apiVersion: 'llamactl/v1',
  kind: 'RagPipeline',
  metadata: { name: 'docs-ingest' },
  spec: {
    destination: { ragNode: 'kb', collection: 'd' },
    sources: [{ kind: 'filesystem', root: '/tmp/docs', glob: '**/*' }],
    transforms: [],
    concurrency: 4,
    on_duplicate: 'skip',
  },
};

describe('applyPipeline with ownership', () => {
  let tmp: string;
  let prevDevStorage: string | undefined;
  let prevPipelinesDir: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pipeline-apply-'));
    prevDevStorage = process.env.DEV_STORAGE;
    prevPipelinesDir = process.env.LLAMACTL_RAG_PIPELINES_DIR;
    process.env.DEV_STORAGE = tmp;
    // Ensure the tmp DEV_STORAGE is what defaultPipelinesDir uses by
    // clearing the more-specific override.
    delete process.env.LLAMACTL_RAG_PIPELINES_DIR;
  });
  afterEach(() => {
    if (prevDevStorage === undefined) delete process.env.DEV_STORAGE;
    else process.env.DEV_STORAGE = prevDevStorage;
    if (prevPipelinesDir === undefined) delete process.env.LLAMACTL_RAG_PIPELINES_DIR;
    else process.env.LLAMACTL_RAG_PIPELINES_DIR = prevPipelinesDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('brand-new write with ownership marker', () => {
    const r = applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'h1' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(true);
    const stored = loadPipeline('docs-ingest');
    expect(stored?.ownership?.compositeNames).toEqual(['mc']);
  });

  test('idempotent re-apply — same composite, same shape', () => {
    applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'h1' },
    });
    const r = applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'h1' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(false);
  });

  test('union compositeNames — same shape, different composite', () => {
    applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'h1' },
    });
    const r = applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['other'], specHash: 'h1' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(true);
    const stored = loadPipeline('docs-ingest');
    expect(stored?.ownership?.compositeNames.sort()).toEqual(['mc', 'other']);
  });

  test('shape mismatch — same name, different specHash from another composite', () => {
    applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'h1' },
    });
    const next: RagPipelineManifest = {
      ...baseManifest,
      spec: { ...baseManifest.spec, concurrency: 7 },
    };
    const r = applyPipeline(next, {
      ownership: { source: 'composite', compositeNames: ['other'], specHash: 'h2' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.conflict.kind).toBe('shape');
      expect(r.conflict.name).toBe('docs-ingest');
    }
  });

  test('composite trying to claim operator-owned pipeline → name collision', () => {
    applyPipeline(baseManifest); // operator path, no ownership param
    const r = applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'h1' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.conflict.kind).toBe('name');
      if (r.conflict.kind === 'name') expect(r.conflict.existingOwner).toBe('operator');
    }
  });

  test('operator trying to overwrite composite-managed pipeline → name collision', () => {
    applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'h1' },
    });
    const r = applyPipeline(baseManifest); // operator path, no ownership param
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.conflict.kind).toBe('name');
      if (r.conflict.kind === 'name') expect(r.conflict.existingOwner).toBe('composite');
    }
  });

  test('operator updating their own pipeline — no marker path unchanged', () => {
    applyPipeline(baseManifest);
    const next: RagPipelineManifest = {
      ...baseManifest,
      spec: { ...baseManifest.spec, concurrency: 8 },
    };
    const r = applyPipeline(next);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(true);
    const stored = loadPipeline('docs-ingest');
    expect(stored?.spec.concurrency).toBe(8);
    expect(stored?.ownership).toBeUndefined();
  });

  test('shape compared via entrySpecHash — semantically equal manifests no-op', () => {
    applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'h-computed' },
    });
    const r = applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'doesnt-matter' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(false);
  });
});
