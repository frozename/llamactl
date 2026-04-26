import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPipeline, loadPipeline, removePipeline } from '../src/rag/pipeline/store';
import type { RagPipelineManifest } from '../src/rag/pipeline/schema';

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
} as RagPipelineManifest;

describe('removePipeline ref-counted', () => {
  let tmp: string;
  let prev: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pipeline-rm-'));
    prev = process.env.DEV_STORAGE;
    process.env.DEV_STORAGE = tmp;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.DEV_STORAGE;
    else process.env.DEV_STORAGE = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('single-owner: composite removal deletes the pipeline', () => {
    applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'h' },
    });
    const r = removePipeline('docs-ingest', { compositeName: 'mc' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.deleted).toBe(true);
    expect(loadPipeline('docs-ingest')).toBeNull();
  });

  test('multi-owner: removal of one composite strips its name; entry stays', () => {
    applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'h' },
    });
    applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['other'], specHash: 'h' },
    });
    const r = removePipeline('docs-ingest', { compositeName: 'mc' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.deleted).toBe(false);
    const stored = loadPipeline('docs-ingest');
    expect(stored?.ownership?.compositeNames).toEqual(['other']);
  });

  test('operator-owned protected from composite-driven removal', () => {
    applyPipeline(baseManifest); // operator path
    const r = removePipeline('docs-ingest', { compositeName: 'mc' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.conflict.kind).toBe('name');
      if (r.conflict.kind === 'name') expect(r.conflict.existingOwner).toBe('operator');
    }
    expect(loadPipeline('docs-ingest')).not.toBeNull();
  });

  test('no-op when name not present', () => {
    const r = removePipeline('does-not-exist', { compositeName: 'mc' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.deleted).toBe(false);
  });

  test('operator path preserved: removePipeline(name) deletes regardless of owner', () => {
    applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'h' },
    });
    const ok = removePipeline('docs-ingest'); // legacy operator-side delete
    expect(ok).toBe(true);
    expect(loadPipeline('docs-ingest')).toBeNull();
  });

  test('legacy env-positional path: process.env-shape opts with stray compositeName key does not invoke composite removal', () => {
    // Operator-applied pipeline (no ownership marker).
    applyPipeline(baseManifest);
    // Simulate a shell env carrying a stray `compositeName` variable
    // alongside DEV_STORAGE. The legacy structural-typing discriminator
    // would have routed this through the composite path with
    // compositeName: 'evil', refusing to delete an operator-owned entry.
    const env = { ...process.env, compositeName: 'evil', DEV_STORAGE: tmp };
    const result = removePipeline('docs-ingest', { env });
    expect(typeof result).toBe('boolean');
    expect(result).toBe(true);
    expect(loadPipeline('docs-ingest', env)).toBeNull();
  });
});
