import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import type { RetrievalProvider } from '@nova/contracts';

import { router } from '../src/router.js';
import { saveConfig, upsertNode } from '../src/config/kubeconfig.js';
import { freshConfig } from '../src/config/schema.js';
import { FETCHERS } from '../src/rag/pipeline/fetchers/registry.js';
import {
  applyPipeline,
  pipelineDir,
} from '../src/rag/pipeline/store.js';
import type { RagPipelineManifest } from '../src/rag/pipeline/schema.js';
import type { Fetcher } from '../src/rag/pipeline/types.js';

/**
 * tRPC surfaces for `rag pipeline *`. Covers:
 *   - apply: YAML parse errors, schema errors, happy path (on-disk spec.yaml
 *     after the call)
 *   - run: NOT_FOUND when name isn't applied; dry vs wet summary; writeLastRun
 *     only fires on wet runs
 *   - list / get / remove: basic dispatch + error shapes
 *
 * We mock `../src/rag/index.js` so `createRagAdapter` returns a no-op
 * provider — the runtime walks the real FETCHERS.filesystem (we override
 * it to yield a known doc list), chunks via the real transforms, and
 * hands the result to our fake adapter. That's enough to prove the
 * router wires input/output correctly.
 */

let closeCount = 0;
let storeCalls = 0;
function makeFakeProvider(): RetrievalProvider {
  return {
    kind: 'fake',
    async search() {
      return { collection: 'default', results: [] };
    },
    async store(req) {
      storeCalls++;
      return { collection: req.collection ?? 'default', ids: req.documents.map((d) => d.id) };
    },
    async delete(req) {
      return { collection: req.collection ?? 'default', deleted: req.ids.length };
    },
    async listCollections() {
      return { collections: [] };
    },
    async close() {
      closeCount++;
    },
  };
}

mock.module('../src/rag/index.js', () => ({
  createRagAdapter: async () => makeFakeProvider(),
}));

const originalEnv = { ...process.env };
let tmp = '';
let pipelinesRoot = '';
let restoreFetcher: (() => void) | null = null;

function installStubFetcher(docs: Array<{ id: string; content: string }>): () => void {
  const original = FETCHERS.filesystem;
  const stub: Fetcher = {
    kind: 'filesystem',
    async *fetch() {
      for (const d of docs) yield { id: d.id, content: d.content, metadata: {} };
    },
  };
  (FETCHERS as Record<string, Fetcher>).filesystem = stub;
  return () => {
    if (original) (FETCHERS as Record<string, Fetcher>).filesystem = original;
    else delete (FETCHERS as Record<string, Fetcher>).filesystem;
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-router-rag-pipeline-'));
  pipelinesRoot = join(tmp, 'pipelines');
  Object.assign(process.env, {
    LLAMACTL_CONFIG: join(tmp, 'config'),
    LLAMACTL_RAG_PIPELINES_DIR: pipelinesRoot,
  });
  closeCount = 0;
  storeCalls = 0;
  restoreFetcher = null;

  let cfg = freshConfig();
  cfg = upsertNode(cfg, 'home', {
    name: 'kb-pg',
    endpoint: '',
    kind: 'rag',
    rag: {
      provider: 'pgvector',
      endpoint: 'postgres://kb@db.local:5432/kb',
      collection: 'docs',
      extraArgs: [],
    },
  });
  saveConfig(cfg, join(tmp, 'config'));
});

afterEach(() => {
  if (restoreFetcher) restoreFetcher();
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

function makeManifest(name = 'demo'): RagPipelineManifest {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'RagPipeline',
    metadata: { name },
    spec: {
      destination: { ragNode: 'kb-pg', collection: 'docs' },
      sources: [{ kind: 'filesystem', root: '/tmp/x', glob: '**/*' }],
      transforms: [],
      concurrency: 2,
      on_duplicate: 'skip',
    },
  } as RagPipelineManifest;
}

describe('ragPipelineApply', () => {
  test('happy path writes spec.yaml and reports created=true', async () => {
    const caller = router.createCaller({});
    const yaml = stringifyYaml(makeManifest('apply-hp'));
    const res = await caller.ragPipelineApply({ manifestYaml: yaml });
    expect(res.ok).toBe(true);
    expect(res.name).toBe('apply-hp');
    expect(res.created).toBe(true);
    expect(existsSync(join(pipelinesRoot, 'apply-hp', 'spec.yaml'))).toBe(true);
  });
  test('re-apply reports created=false', async () => {
    const caller = router.createCaller({});
    const yaml = stringifyYaml(makeManifest('re'));
    await caller.ragPipelineApply({ manifestYaml: yaml });
    const res = await caller.ragPipelineApply({ manifestYaml: yaml });
    expect(res.created).toBe(false);
  });
  test('invalid YAML → BAD_REQUEST', async () => {
    const caller = router.createCaller({});
    await expect(
      caller.ragPipelineApply({ manifestYaml: 'not: [valid yaml\n' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
  test('schema-invalid (missing destination) → BAD_REQUEST', async () => {
    const caller = router.createCaller({});
    const bad = stringifyYaml({
      apiVersion: 'llamactl/v1',
      kind: 'RagPipeline',
      metadata: { name: 'bad' },
      spec: { sources: [], transforms: [] },
    });
    await expect(
      caller.ragPipelineApply({ manifestYaml: bad }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('ragPipelineRun', () => {
  test('NOT_FOUND when pipeline does not exist', async () => {
    const caller = router.createCaller({});
    await expect(
      caller.ragPipelineRun({ name: 'ghost', dryRun: false }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  test('wet run persists state.json with last summary', async () => {
    applyPipeline(makeManifest('wet'));
    restoreFetcher = installStubFetcher([
      { id: 'a.md', content: 'alpha' },
      { id: 'b.md', content: 'beta' },
    ]);
    const caller = router.createCaller({});
    const res = await caller.ragPipelineRun({ name: 'wet', dryRun: false });
    expect(res.ok).toBe(true);
    expect(res.dryRun).toBe(false);
    expect(res.summary.total_docs).toBe(2);
    expect(res.summary.total_chunks).toBe(2);
    expect(storeCalls).toBeGreaterThan(0);
    expect(closeCount).toBe(1);
    expect(existsSync(join(pipelineDir('wet'), 'state.json'))).toBe(true);
  });
  test('dry run does NOT write state.json', async () => {
    applyPipeline(makeManifest('dry'));
    restoreFetcher = installStubFetcher([
      { id: 'a.md', content: 'alpha' },
    ]);
    const caller = router.createCaller({});
    const res = await caller.ragPipelineRun({ name: 'dry', dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.dryRun).toBe(true);
    expect(res.summary.total_docs).toBe(1);
    expect(existsSync(join(pipelineDir('dry'), 'state.json'))).toBe(false);
  });
  test('default dryRun is false', async () => {
    // Input parser defaults dryRun to false — callers may omit it.
    applyPipeline(makeManifest('defaulted'));
    restoreFetcher = installStubFetcher([]);
    const caller = router.createCaller({});
    const res = await caller.ragPipelineRun({ name: 'defaulted' } as { name: string });
    expect(res.dryRun).toBe(false);
  });
});

describe('ragPipelineList', () => {
  test('empty registry → pipelines: []', async () => {
    const caller = router.createCaller({});
    const res = await caller.ragPipelineList();
    expect(res.pipelines).toEqual([]);
  });
  test('lists applied pipelines', async () => {
    applyPipeline(makeManifest('one'));
    applyPipeline(makeManifest('two'));
    const caller = router.createCaller({});
    const res = await caller.ragPipelineList();
    const names = res.pipelines.map((p) => p.name).sort();
    expect(names).toEqual(['one', 'two']);
  });
});

describe('ragPipelineGet', () => {
  test('NOT_FOUND when missing', async () => {
    const caller = router.createCaller({});
    await expect(
      caller.ragPipelineGet({ name: 'missing' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  test('returns manifest when present', async () => {
    applyPipeline(makeManifest('there'));
    const caller = router.createCaller({});
    const res = await caller.ragPipelineGet({ name: 'there' });
    expect(res.manifest.metadata.name).toBe('there');
    expect(res.manifest.spec.destination.ragNode).toBe('kb-pg');
  });
});

describe('ragPipelineDraft', () => {
  test('returns yaml + manifest + warnings', async () => {
    const caller = router.createCaller({});
    const res = await caller.ragPipelineDraft({
      description: 'crawl https://docs.example.com into kb-pg every 30 minutes',
    });
    expect(res.ok).toBe(true);
    expect(res.yaml).toContain('kind: RagPipeline');
    expect(res.yaml).toContain('@every 30m');
    expect(res.manifest.spec.destination.ragNode).toBe('kb-pg');
    expect(Array.isArray(res.warnings)).toBe(true);
  });
  test('threads availableRagNodes + nameOverride', async () => {
    const caller = router.createCaller({});
    const res = await caller.ragPipelineDraft({
      description: 'ingest https://x.dev into kb-chroma',
      availableRagNodes: ['kb-pg', 'kb-chroma'],
      nameOverride: 'my-pipe',
    });
    expect(res.manifest.metadata.name).toBe('my-pipe');
    expect(res.manifest.spec.destination.ragNode).toBe('kb-chroma');
  });
  test('empty description surfaces as a warning', async () => {
    const caller = router.createCaller({});
    const res = await caller.ragPipelineDraft({ description: '' });
    expect(res.warnings.some((w) => w.includes('empty'))).toBe(true);
  });
});

describe('ragPipelineRunning', () => {
  test('returns empty running[] when no pipeline is in flight', async () => {
    const { _resetPipelineEventsForTests } = await import(
      '../src/rag/pipeline/event-bus.js'
    );
    _resetPipelineEventsForTests();
    const caller = router.createCaller({});
    const res = await caller.ragPipelineRunning();
    expect(res.running).toEqual([]);
  });
  test('includes a pipeline between startRun and endRun', async () => {
    const { pipelineEvents, _resetPipelineEventsForTests } = await import(
      '../src/rag/pipeline/event-bus.js'
    );
    _resetPipelineEventsForTests();
    pipelineEvents.startRun('live', {
      sources: ['live:0:filesystem', 'live:1:http'],
    });
    const caller = router.createCaller({});
    const res = await caller.ragPipelineRunning();
    expect(res.running).toHaveLength(1);
    expect(res.running[0]!.name).toBe('live');
    expect(res.running[0]!.sources).toEqual(['live:0:filesystem', 'live:1:http']);
    expect(res.running[0]!.stale).toBe(false);
    expect(typeof res.running[0]!.startedAt).toBe('string');
    pipelineEvents.endRun('live');
    const after = await caller.ragPipelineRunning();
    expect(after.running).toEqual([]);
  });

  test('surfaces orphaned runs (journal unpaired run-started) as stale', async () => {
    const { _resetPipelineEventsForTests } = await import(
      '../src/rag/pipeline/event-bus.js'
    );
    _resetPipelineEventsForTests();
    applyPipeline(makeManifest('orphan-me'));
    const journalPath = join(pipelinesRoot, 'orphan-me', 'journal.jsonl');
    // Seed an 11-minute-old run-started with no matching run-complete.
    const oldTs = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    require('node:fs').writeFileSync(
      journalPath,
      `${JSON.stringify({
        kind: 'run-started',
        ts: oldTs,
        spec_hash: 'x',
        sources: ['orphan-me:0:filesystem'],
      })}\n`,
    );
    const caller = router.createCaller({});
    const res = await caller.ragPipelineRunning();
    const orphan = res.running.find((r) => r.name === 'orphan-me');
    expect(orphan).toBeDefined();
    expect(orphan!.stale).toBe(true);
    expect(orphan!.sources).toEqual(['orphan-me:0:filesystem']);
    expect(orphan!.startedAt).toBe(oldTs);
  });

  test('live signal wins over orphan signal for the same pipeline', async () => {
    const { pipelineEvents, _resetPipelineEventsForTests } = await import(
      '../src/rag/pipeline/event-bus.js'
    );
    _resetPipelineEventsForTests();
    applyPipeline(makeManifest('both'));
    // Seed an orphan journal entry.
    const journalPath = join(pipelinesRoot, 'both', 'journal.jsonl');
    const oldTs = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    require('node:fs').writeFileSync(
      journalPath,
      `${JSON.stringify({
        kind: 'run-started',
        ts: oldTs,
        spec_hash: 'x',
        sources: ['stale-src'],
      })}\n`,
    );
    // ALSO fire a live start — the freshness should win.
    pipelineEvents.startRun('both', { sources: ['live-src'] });
    const caller = router.createCaller({});
    const res = await caller.ragPipelineRunning();
    const rows = res.running.filter((r) => r.name === 'both');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stale).toBe(false);
    expect(rows[0]!.sources).toEqual(['live-src']);
  });
  test('distinguishes multiple in-flight pipelines', async () => {
    const { pipelineEvents, _resetPipelineEventsForTests } = await import(
      '../src/rag/pipeline/event-bus.js'
    );
    _resetPipelineEventsForTests();
    pipelineEvents.startRun('a', { sources: [] });
    pipelineEvents.startRun('b', { sources: [] });
    const caller = router.createCaller({});
    const res = await caller.ragPipelineRunning();
    const names = res.running.map((r) => r.name).sort();
    expect(names).toEqual(['a', 'b']);
  });
});

describe('ragPipelineLogs', () => {
  test('absent journal → entries: []', async () => {
    const caller = router.createCaller({});
    const res = await caller.ragPipelineLogs({ name: 'never-applied', tail: 50 });
    expect(res.ok).toBe(true);
    expect(res.entries).toEqual([]);
    expect(res.path).toContain('never-applied');
  });
  test('tails the last N parseable entries', async () => {
    applyPipeline(makeManifest('tailed'));
    const journalPath = join(pipelinesRoot, 'tailed', 'journal.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(
        JSON.stringify({
          kind: 'doc-ingested',
          ts: new Date().toISOString(),
          source: 'tailed:0:filesystem',
          doc_id: `d${i}`,
          sha: 'x',
          chunks: 1,
        }),
      );
    }
    require('node:fs').writeFileSync(journalPath, `${lines.join('\n')}\n`);
    const caller = router.createCaller({});
    const res = await caller.ragPipelineLogs({ name: 'tailed', tail: 3 });
    expect(res.entries).toHaveLength(3);
    // Tail = last 3 entries (d7, d8, d9).
    expect((res.entries[0] as { doc_id?: string }).doc_id).toBe('d7');
    expect((res.entries[2] as { doc_id?: string }).doc_id).toBe('d9');
  });
  test('skips malformed lines', async () => {
    applyPipeline(makeManifest('mixed'));
    const journalPath = join(pipelinesRoot, 'mixed', 'journal.jsonl');
    require('node:fs').writeFileSync(
      journalPath,
      [
        JSON.stringify({ kind: 'doc-ingested', ts: 't', source: 's', doc_id: 'good', sha: 'x', chunks: 1 }),
        '{not json',
        '',
        JSON.stringify({ kind: 'doc-ingested', ts: 't', source: 's', doc_id: 'also-good', sha: 'x', chunks: 1 }),
      ].join('\n'),
    );
    const caller = router.createCaller({});
    const res = await caller.ragPipelineLogs({ name: 'mixed', tail: 100 });
    expect(res.entries).toHaveLength(2);
  });
});

describe('ragPipelineRemove', () => {
  test('removed=false when absent', async () => {
    const caller = router.createCaller({});
    const res = await caller.ragPipelineRemove({ name: 'ghost' });
    expect(res.ok).toBe(true);
    expect(res.removed).toBe(false);
  });
  test('removed=true + dir gone when present', async () => {
    applyPipeline(makeManifest('bye'));
    expect(existsSync(pipelineDir('bye'))).toBe(true);
    const caller = router.createCaller({});
    const res = await caller.ragPipelineRemove({ name: 'bye' });
    expect(res.removed).toBe(true);
    expect(existsSync(pipelineDir('bye'))).toBe(false);
  });
});
