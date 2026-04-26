import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyPipeline,
  defaultPipelinesDir,
  journalPathFor,
  listPipelines,
  loadPipeline,
  pipelineDir,
  removePipeline,
  writeLastRun,
} from '../src/rag/pipeline/store.js';
import type { RagPipelineManifest } from '../src/rag/pipeline/schema.js';
import type { RunSummary } from '../src/rag/pipeline/runtime.js';

/**
 * On-disk persistence for RagPipeline manifests. Uses a tmpdir root
 * via the `LLAMACTL_RAG_PIPELINES_DIR` env override so tests never
 * touch the operator's real $DEV_STORAGE tree.
 */

let tmp = '';
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-rag-pipeline-store-'));
  env = { ...process.env, LLAMACTL_RAG_PIPELINES_DIR: tmp };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeManifest(name: string, overrides: Partial<RagPipelineManifest['spec']> = {}): RagPipelineManifest {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'RagPipeline',
    metadata: { name },
    spec: {
      destination: { ragNode: 'kb-pg', collection: 'docs' },
      sources: [{ kind: 'filesystem', root: '/tmp/x', glob: '**/*' }],
      transforms: [],
      concurrency: 4,
      on_duplicate: 'skip',
      ...overrides,
    },
  } as RagPipelineManifest;
}

describe('defaultPipelinesDir / pipelineDir / journalPathFor', () => {
  test('env override wins over DEV_STORAGE and home fallback', () => {
    const custom = { ...env, LLAMACTL_RAG_PIPELINES_DIR: '/custom/root' };
    expect(defaultPipelinesDir(custom)).toBe('/custom/root');
    expect(pipelineDir('foo', custom)).toBe('/custom/root/foo');
    expect(journalPathFor('foo', custom)).toBe('/custom/root/foo/journal.jsonl');
  });
  test('DEV_STORAGE used when no override', () => {
    const onlyDev = { DEV_STORAGE: '/dev/store' } as NodeJS.ProcessEnv;
    expect(defaultPipelinesDir(onlyDev)).toBe('/dev/store/rag-pipelines');
  });
});

describe('applyPipeline', () => {
  test('creates a fresh spec.yaml and reports changed=true', () => {
    const result = applyPipeline(makeManifest('a'), { env });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected conflict');
    expect(result.changed).toBe(true);
    expect(existsSync(result.path)).toBe(true);
    expect(result.path).toBe(join(tmp, 'a', 'spec.yaml'));
    expect(readFileSync(result.path, 'utf8')).toContain('kind: RagPipeline');
  });
  test('re-apply reports changed=true on shape change and overwrites', () => {
    const first = applyPipeline(makeManifest('a'), { env });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unexpected conflict');
    expect(first.changed).toBe(true);
    const second = applyPipeline(makeManifest('a', { concurrency: 9 }), { env });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unexpected conflict');
    expect(second.changed).toBe(true);
    // concurrency should have flipped to 9 on disk.
    const reloaded = loadPipeline('a', env);
    expect(reloaded?.spec.concurrency).toBe(9);
  });
  test('invalid manifest (missing destination) throws before write', () => {
    const bad = {
      apiVersion: 'llamactl/v1',
      kind: 'RagPipeline',
      metadata: { name: 'bad' },
      spec: { sources: [], transforms: [], concurrency: 4, on_duplicate: 'skip' },
    } as unknown as RagPipelineManifest;
    expect(() => applyPipeline(bad, { env })).toThrow();
    // Dir should not have been created.
    expect(existsSync(pipelineDir('bad', env))).toBe(false);
  });
});

describe('loadPipeline', () => {
  test('returns null when spec.yaml is absent', () => {
    expect(loadPipeline('nope', env)).toBeNull();
  });
  test('round-trips an applied manifest', () => {
    applyPipeline(makeManifest('round'), { env });
    const loaded = loadPipeline('round', env);
    expect(loaded?.metadata.name).toBe('round');
    expect(loaded?.spec.destination.ragNode).toBe('kb-pg');
  });
  test('returns null when spec.yaml is malformed', () => {
    applyPipeline(makeManifest('bent'), { env });
    writeFileSync(join(tmp, 'bent', 'spec.yaml'), 'not: [valid yaml\n', 'utf8');
    expect(loadPipeline('bent', env)).toBeNull();
  });
});

describe('listPipelines', () => {
  test('returns [] when root dir is missing', () => {
    rmSync(tmp, { recursive: true, force: true });
    expect(listPipelines(env)).toEqual([]);
  });
  test('returns applied pipelines sorted by name', () => {
    applyPipeline(makeManifest('charlie'), { env });
    applyPipeline(makeManifest('alpha'), { env });
    applyPipeline(makeManifest('bravo'), { env });
    const names = listPipelines(env).map((r) => r.name);
    expect(names).toEqual(['alpha', 'bravo', 'charlie']);
  });
  test('skips directories that lack a valid spec.yaml', () => {
    applyPipeline(makeManifest('good'), { env });
    // Stray subdir with no spec.yaml.
    const strayDir = join(tmp, 'stray');
    require('node:fs').mkdirSync(strayDir, { recursive: true });
    const names = listPipelines(env).map((r) => r.name);
    expect(names).toEqual(['good']);
  });
  test('surfaces lastRun when state.json exists', () => {
    applyPipeline(makeManifest('metered'), { env });
    const summary: RunSummary = {
      total_docs: 2,
      total_chunks: 4,
      skipped_docs: 0,
      errors: 0,
      elapsed_ms: 100,
      per_source: [{ source: 'metered:0:filesystem', docs: 2, chunks: 4, errors: 0 }],
    };
    writeLastRun('metered', summary, env);
    const record = listPipelines(env).find((r) => r.name === 'metered');
    expect(record?.lastRun?.summary.total_chunks).toBe(4);
    expect(typeof record?.lastRun?.at).toBe('string');
  });
  test('malformed state.json is silently dropped (pipeline still listed)', () => {
    applyPipeline(makeManifest('glitched'), { env });
    writeFileSync(join(tmp, 'glitched', 'state.json'), 'not-json', 'utf8');
    const record = listPipelines(env).find((r) => r.name === 'glitched');
    expect(record).toBeDefined();
    expect(record?.lastRun).toBeUndefined();
  });
});

describe('removePipeline', () => {
  test('returns false when the dir does not exist', () => {
    expect(removePipeline('ghost', { env })).toBe(false);
  });
  test('wipes the pipeline dir and reports true', () => {
    applyPipeline(makeManifest('doomed'), { env });
    expect(existsSync(pipelineDir('doomed', env))).toBe(true);
    expect(removePipeline('doomed', { env })).toBe(true);
    expect(existsSync(pipelineDir('doomed', env))).toBe(false);
  });
});

describe('writeLastRun', () => {
  test('creates state.json with at + summary', () => {
    applyPipeline(makeManifest('wr'), { env });
    const summary: RunSummary = {
      total_docs: 1,
      total_chunks: 3,
      skipped_docs: 0,
      errors: 0,
      elapsed_ms: 42,
      per_source: [{ source: 'wr:0:filesystem', docs: 1, chunks: 3, errors: 0 }],
    };
    writeLastRun('wr', summary, env);
    const raw = JSON.parse(readFileSync(join(tmp, 'wr', 'state.json'), 'utf8')) as {
      at: string;
      summary: RunSummary;
    };
    expect(raw.summary.total_chunks).toBe(3);
    expect(new Date(raw.at).toString()).not.toBe('Invalid Date');
  });
  test('creates the dir if the pipeline has never been applied', () => {
    // Edge case — writeLastRun should mkdir recursively.
    const summary: RunSummary = {
      total_docs: 0,
      total_chunks: 0,
      skipped_docs: 0,
      errors: 0,
      elapsed_ms: 0,
      per_source: [],
    };
    writeLastRun('orphan', summary, env);
    expect(existsSync(join(tmp, 'orphan', 'state.json'))).toBe(true);
  });
});
