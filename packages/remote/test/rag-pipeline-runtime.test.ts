import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DeleteRequest, DeleteResponse, StoreRequest, StoreResponse } from '@nova/contracts';

import { runPipeline } from '../src/rag/pipeline/runtime.js';
import { FETCHERS } from '../src/rag/pipeline/fetchers/registry.js';
import type { RagPipelineManifest } from '../src/rag/pipeline/schema.js';
import type { Fetcher, RawDoc } from '../src/rag/pipeline/types.js';

let tmp = '';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-pipeline-runtime-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface StubFetcherOptions {
  docs: RawDoc[];
  throwOnce?: boolean;
}

/**
 * Swap the real `filesystem` fetcher for a stub. Tests feed a
 * filesystem-shaped source spec through the schema (root: /tmp) and
 * the runtime dispatches to the stub instead of walking the disk.
 */
function installStubFetcher(opts: StubFetcherOptions): () => void {
  const original = FETCHERS.filesystem;
  let thrown = false;
  const stub: Fetcher = {
    kind: 'filesystem',
    async *fetch() {
      if (opts.throwOnce && !thrown) {
        thrown = true;
        throw new Error('fetcher init boom');
      }
      for (const d of opts.docs) yield d;
    },
  };
  (FETCHERS as Record<string, Fetcher>).filesystem = stub;
  return () => {
    if (original) (FETCHERS as Record<string, Fetcher>).filesystem = original;
    else delete (FETCHERS as Record<string, Fetcher>).filesystem;
  };
}

interface StoreCall {
  collection: string | undefined;
  ids: string[];
  count: number;
}

interface DeleteCall {
  collection: string | undefined;
  ids: string[];
}

function makeMockAdapter(options: { withDelete?: boolean } = {}): {
  open: () => Promise<{
    store: (req: StoreRequest) => Promise<StoreResponse>;
    delete?: (req: DeleteRequest) => Promise<DeleteResponse>;
    close: () => Promise<void>;
  }>;
  calls: StoreCall[];
  deletes: DeleteCall[];
  closed: number;
} {
  const calls: StoreCall[] = [];
  const deletes: DeleteCall[] = [];
  let closed = 0;
  // `withDelete` defaults true — most tests exercise the replace
  // path. Pass false to assert graceful fallback when a custom
  // adapter doesn't expose delete.
  const withDelete = options.withDelete ?? true;
  return {
    open: async () => ({
      async store(req) {
        calls.push({
          collection: req.collection,
          ids: req.documents.map((d) => d.id),
          count: req.documents.length,
        });
        return { ids: req.documents.map((d) => d.id), collection: req.collection ?? 'docs' };
      },
      ...(withDelete
        ? {
            async delete(req: DeleteRequest): Promise<DeleteResponse> {
              deletes.push({ collection: req.collection, ids: [...req.ids] });
              return { deleted: req.ids.length, collection: req.collection ?? 'docs' };
            },
          }
        : {}),
      async close() {
        closed++;
      },
    }),
    calls,
    deletes,
    get closed() {
      return closed;
    },
  };
}

function readJournalLines(path: string): Array<Record<string, unknown>> {
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
}

function baseManifest(overrides: Partial<RagPipelineManifest['spec']> = {}): RagPipelineManifest {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'RagPipeline',
    metadata: { name: 'test' },
    spec: {
      destination: { ragNode: 'kb-pg', collection: 'docs' },
      sources: [{ kind: 'filesystem', root: '/tmp', glob: '**/*' }],
      transforms: [],
      concurrency: 2,
      on_duplicate: 'skip',
      ...overrides,
    },
  } as RagPipelineManifest;
}

describe('runPipeline', () => {
  test('frames a successful run with run-started + run-complete', async () => {
    const restore = installStubFetcher({
      docs: [
        { id: 'a', content: 'alpha', metadata: {} },
        { id: 'b', content: 'beta', metadata: {} },
      ],
    });
    try {
      const mock = makeMockAdapter();
      const journalPath = join(tmp, 'journal.jsonl');
      const summary = await runPipeline({
        manifest: baseManifest(),
        journalPath,
        openAdapter: mock.open,
      });
      expect(summary.total_docs).toBe(2);
      expect(summary.total_chunks).toBe(2);
      expect(summary.skipped_docs).toBe(0);
      expect(summary.errors).toBe(0);
      expect(summary.per_source).toHaveLength(1);
      expect(summary.per_source[0]!.docs).toBe(2);
      expect(summary.per_source[0]!.chunks).toBe(2);

      const lines = readJournalLines(journalPath);
      expect(lines[0]!.kind).toBe('run-started');
      expect(lines[lines.length - 1]!.kind).toBe('run-complete');
      expect(lines.some((l) => l.kind === 'doc-ingested')).toBe(true);
      expect(lines.some((l) => l.kind === 'source-complete')).toBe(true);
      expect(mock.calls.length).toBe(2);
      expect(mock.closed).toBe(1);
    } finally {
      restore();
    }
  });

  test('skipped duplicates land as doc-skipped', async () => {
    const docs: RawDoc[] = [
      { id: 'a', content: 'alpha', metadata: {} },
      { id: 'b', content: 'beta', metadata: {} },
    ];
    const journalPath = join(tmp, 'journal.jsonl');
    const mock = makeMockAdapter();
    {
      const restore = installStubFetcher({ docs });
      try {
        await runPipeline({
          manifest: baseManifest(),
          journalPath,
          openAdapter: mock.open,
        });
      } finally {
        restore();
      }
    }
    // Second run: same content → should all be skipped.
    {
      const restore = installStubFetcher({ docs });
      try {
        const summary = await runPipeline({
          manifest: baseManifest(),
          journalPath,
          openAdapter: mock.open,
        });
        expect(summary.total_docs).toBe(0);
        expect(summary.skipped_docs).toBe(2);
      } finally {
        restore();
      }
    }
    const lines = readJournalLines(journalPath);
    const skipped = lines.filter((l) => l.kind === 'doc-skipped');
    expect(skipped).toHaveLength(2);
    // No extra store calls on the second run.
    expect(mock.calls.length).toBe(2);
  });

  test('transform fan-out surfaces in doc-ingested.chunks', async () => {
    const longMarkdown = [
      '# Heading One',
      '',
      'Paragraph one content with enough text to help chunking.',
      '',
      'Paragraph two content with another batch of prose.',
      '',
      '## Heading Two',
      '',
      'Paragraph three content under the second heading.',
      '',
      'Paragraph four content wrapping up the document.',
    ].join('\n');
    const restore = installStubFetcher({
      docs: [{ id: 'long.md', content: longMarkdown, metadata: {} }],
    });
    try {
      const mock = makeMockAdapter();
      const journalPath = join(tmp, 'journal.jsonl');
      const summary = await runPipeline({
        manifest: baseManifest({
          transforms: [
            {
              kind: 'markdown-chunk',
              chunk_size: 80,
              overlap: 20,
              preserve_headings: true,
            },
          ],
        }),
        journalPath,
        openAdapter: mock.open,
      });
      expect(summary.total_docs).toBe(1);
      expect(summary.total_chunks).toBeGreaterThan(1);

      const ingested = readJournalLines(journalPath).find(
        (l) => l.kind === 'doc-ingested',
      ) as Record<string, unknown> | undefined;
      expect(ingested).toBeDefined();
      expect(typeof ingested!.chunks).toBe('number');
      expect((ingested!.chunks as number) > 1).toBe(true);
    } finally {
      restore();
    }
  });

  test('store batching caps at 20 docs per call', async () => {
    // Generate 25 chunks via many small docs (no transforms needed).
    const docs: RawDoc[] = Array.from({ length: 25 }, (_, i) => ({
      id: `d-${i}`,
      content: `content-${i}`,
      metadata: {},
    }));
    const restore = installStubFetcher({ docs });
    try {
      // Sequentialize via concurrency=1 so batch sizes are deterministic.
      const manifest = baseManifest();
      manifest.spec.concurrency = 1;
      const mock = makeMockAdapter();
      await runPipeline({
        manifest,
        journalPath: join(tmp, 'journal.jsonl'),
        openAdapter: mock.open,
      });
      expect(mock.calls.length).toBe(25);
      // Each call is a single doc (1 chunk each, 1 batch each).
      for (const call of mock.calls) {
        expect(call.count).toBeLessThanOrEqual(20);
      }
    } finally {
      restore();
    }
  });

  test('returned summary tallies match the journal', async () => {
    const docs: RawDoc[] = [
      { id: 'a', content: 'alpha', metadata: {} },
      { id: 'b', content: 'beta', metadata: {} },
      { id: 'c', content: 'gamma', metadata: {} },
    ];
    const restore = installStubFetcher({ docs });
    try {
      const journalPath = join(tmp, 'journal.jsonl');
      const mock = makeMockAdapter();
      const summary = await runPipeline({
        manifest: baseManifest(),
        journalPath,
        openAdapter: mock.open,
      });
      const lines = readJournalLines(journalPath);
      const ingested = lines.filter((l) => l.kind === 'doc-ingested').length;
      const sourceComplete = lines.find((l) => l.kind === 'source-complete')!;
      expect(ingested).toBe(summary.total_docs);
      expect(sourceComplete.docs).toBe(summary.per_source[0]!.docs);
      expect(sourceComplete.chunks).toBe(summary.per_source[0]!.chunks);
    } finally {
      restore();
    }
  });

  test('dryRun skips adapter.store and journals doc-would-ingest', async () => {
    const docs: RawDoc[] = [
      { id: 'a', content: 'alpha', metadata: {} },
      { id: 'b', content: 'beta', metadata: {} },
    ];
    const restore = installStubFetcher({ docs });
    try {
      const mock = makeMockAdapter();
      const journalPath = join(tmp, 'journal.jsonl');
      const summary = await runPipeline({
        manifest: baseManifest(),
        journalPath,
        openAdapter: mock.open,
        dryRun: true,
      });
      expect(summary.total_docs).toBe(2);
      expect(summary.total_chunks).toBe(2);
      // The adapter is opened + closed, but never written to.
      expect(mock.calls).toHaveLength(0);
      expect(mock.closed).toBe(1);
      const lines = readJournalLines(journalPath);
      const would = lines.filter((l) => l.kind === 'doc-would-ingest');
      const ingested = lines.filter((l) => l.kind === 'doc-ingested');
      expect(would).toHaveLength(2);
      expect(ingested).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test('dryRun then wet run: dry does not poison dedupe, wet still stores', async () => {
    const docs: RawDoc[] = [{ id: 'a', content: 'alpha', metadata: {} }];
    const journalPath = join(tmp, 'journal.jsonl');
    const mock = makeMockAdapter();
    // Dry run first.
    {
      const restore = installStubFetcher({ docs });
      try {
        await runPipeline({
          manifest: baseManifest(),
          journalPath,
          openAdapter: mock.open,
          dryRun: true,
        });
      } finally {
        restore();
      }
    }
    expect(mock.calls).toHaveLength(0);
    // Wet run next — must still store (would-ingest doesn't count as dedupe).
    {
      const restore = installStubFetcher({ docs });
      try {
        const summary = await runPipeline({
          manifest: baseManifest(),
          journalPath,
          openAdapter: mock.open,
        });
        expect(summary.total_docs).toBe(1);
        expect(summary.skipped_docs).toBe(0);
      } finally {
        restore();
      }
    }
    expect(mock.calls).toHaveLength(1);
  });

  test('on_duplicate=replace deletes prior chunks before storing new ones', async () => {
    const journalPath = join(tmp, 'journal.jsonl');
    const mock = makeMockAdapter();
    // First run — two docs, both stored.
    {
      const restore = installStubFetcher({
        docs: [
          { id: 'a.md', content: 'alpha v1', metadata: {} },
          { id: 'b.md', content: 'beta v1', metadata: {} },
        ],
      });
      try {
        await runPipeline({
          manifest: baseManifest({ on_duplicate: 'replace' }),
          journalPath,
          openAdapter: mock.open,
        });
      } finally {
        restore();
      }
    }
    expect(mock.calls).toHaveLength(2);
    expect(mock.deletes).toHaveLength(0);

    // Second run — `a.md` content changed, `b.md` unchanged. Only
    // `a.md` should trigger a delete-then-store; `b.md` is a no-op.
    {
      const restore = installStubFetcher({
        docs: [
          { id: 'a.md', content: 'alpha v2', metadata: {} },
          { id: 'b.md', content: 'beta v1', metadata: {} },
        ],
      });
      try {
        const summary = await runPipeline({
          manifest: baseManifest({ on_duplicate: 'replace' }),
          journalPath,
          openAdapter: mock.open,
        });
        expect(summary.total_docs).toBe(1);
        expect(summary.skipped_docs).toBe(1);
      } finally {
        restore();
      }
    }
    expect(mock.deletes).toHaveLength(1);
    expect(mock.deletes[0]!.ids).toEqual(['a.md']);
    // Total store calls: 2 from run 1 + 1 from run 2 (only a.md).
    expect(mock.calls).toHaveLength(3);
  });

  test('on_duplicate=replace with no delete binding journals an error + still stores', async () => {
    const journalPath = join(tmp, 'journal.jsonl');
    const mock = makeMockAdapter({ withDelete: false });
    // Seed an initial ingestion so the second run has priors.
    {
      const restore = installStubFetcher({
        docs: [{ id: 'a.md', content: 'alpha v1', metadata: {} }],
      });
      try {
        await runPipeline({
          manifest: baseManifest({ on_duplicate: 'replace' }),
          journalPath,
          openAdapter: mock.open,
        });
      } finally {
        restore();
      }
    }
    expect(mock.calls).toHaveLength(1);

    const restore = installStubFetcher({
      docs: [{ id: 'a.md', content: 'alpha v2', metadata: {} }],
    });
    try {
      const summary = await runPipeline({
        manifest: baseManifest({ on_duplicate: 'replace' }),
        journalPath,
        openAdapter: mock.open,
      });
      expect(summary.total_docs).toBe(1);
      expect(summary.errors).toBe(0); // Delete-binding-missing is logged but not counted as a run error.
    } finally {
      restore();
    }
    const lines = readJournalLines(journalPath);
    const errs = lines.filter((l) => l.kind === 'error');
    expect(errs.some((e) => (e.message as string).includes('no delete binding'))).toBe(true);
    // Store still proceeded (no orphan-cleanup is worse than no ingest).
    expect(mock.calls).toHaveLength(2);
  });

  test('on_duplicate=version suffixes chunk IDs so old + new coexist', async () => {
    const journalPath = join(tmp, 'journal.jsonl');
    const mock = makeMockAdapter();
    // Long markdown so the chunker emits multiple chunks.
    const v1 = [
      '# Title',
      '',
      'Paragraph one. '.repeat(20),
      '',
      '## Section',
      '',
      'Paragraph two. '.repeat(20),
    ].join('\n');
    const v2 = `${v1}\n\nExtra paragraph.`;
    const manifest = (): RagPipelineManifest => ({
      ...baseManifest({ on_duplicate: 'version' }),
      spec: {
        ...baseManifest({ on_duplicate: 'version' }).spec,
        transforms: [
          {
            kind: 'markdown-chunk',
            chunk_size: 100,
            overlap: 20,
            preserve_headings: true,
          },
        ],
      },
    });
    // First run — default chunk IDs.
    {
      const restore = installStubFetcher({ docs: [{ id: 'd.md', content: v1, metadata: {} }] });
      try {
        await runPipeline({ manifest: manifest(), journalPath, openAdapter: mock.open });
      } finally {
        restore();
      }
    }
    const v1Ids = mock.calls.flatMap((c) => c.ids);
    expect(v1Ids.every((id) => id.startsWith('d.md#'))).toBe(true);
    expect(v1Ids.every((id) => !id.includes('@'))).toBe(true);

    // Second run — content changed. IDs should include the sha suffix.
    {
      const restore = installStubFetcher({ docs: [{ id: 'd.md', content: v2, metadata: {} }] });
      try {
        await runPipeline({ manifest: manifest(), journalPath, openAdapter: mock.open });
      } finally {
        restore();
      }
    }
    // No deletes — version mode is additive.
    expect(mock.deletes).toHaveLength(0);
    const allIds = mock.calls.flatMap((c) => c.ids);
    const v2Ids = allIds.filter((id) => id.includes('@'));
    expect(v2Ids.length).toBeGreaterThan(0);
    // Versioned id shape: `d.md@<12-hex>#<n>`.
    for (const id of v2Ids) {
      expect(id).toMatch(/^d\.md@[0-9a-f]{12}#\d+$/);
    }
    // v1 IDs are still in the store (not deleted), coexisting.
    for (const id of v1Ids) {
      expect(allIds).toContain(id);
    }
  });

  test('spec.cost.per_chunk_usd surfaces an estimated_cost on the summary', async () => {
    const docs: RawDoc[] = [
      { id: 'a', content: 'alpha', metadata: {} },
      { id: 'b', content: 'beta', metadata: {} },
      { id: 'c', content: 'gamma', metadata: {} },
    ];
    const restore = installStubFetcher({ docs });
    try {
      const mock = makeMockAdapter();
      const manifest = baseManifest();
      // Wire a per-chunk rate — 3 chunks × $0.001 = $0.003
      manifest.spec.cost = { per_chunk_usd: 0.001, currency: 'USD' };
      const summary = await runPipeline({
        manifest,
        journalPath: join(tmp, 'journal.jsonl'),
        openAdapter: mock.open,
      });
      expect(summary.estimated_cost).toBeDefined();
      expect(summary.estimated_cost!.usd).toBeCloseTo(0.003, 6);
      expect(summary.estimated_cost!.source).toBe('per_chunk');
      expect(summary.estimated_cost!.currency).toBe('USD');
    } finally {
      restore();
    }
  });

  test('combined per_chunk_usd + per_doc_usd sums both', async () => {
    const docs: RawDoc[] = [
      { id: 'a', content: 'alpha', metadata: {} },
      { id: 'b', content: 'beta', metadata: {} },
    ];
    const restore = installStubFetcher({ docs });
    try {
      const mock = makeMockAdapter();
      const manifest = baseManifest();
      // 2 chunks × 0.01 + 2 docs × 0.05 = 0.02 + 0.10 = 0.12
      manifest.spec.cost = {
        per_chunk_usd: 0.01,
        per_doc_usd: 0.05,
        currency: 'USD',
      };
      const summary = await runPipeline({
        manifest,
        journalPath: join(tmp, 'journal.jsonl'),
        openAdapter: mock.open,
      });
      expect(summary.estimated_cost?.usd).toBeCloseTo(0.12, 6);
      expect(summary.estimated_cost?.source).toBe('combined');
    } finally {
      restore();
    }
  });

  test('no cost rates configured → estimated_cost is undefined', async () => {
    const restore = installStubFetcher({
      docs: [{ id: 'a', content: 'x', metadata: {} }],
    });
    try {
      const mock = makeMockAdapter();
      const summary = await runPipeline({
        manifest: baseManifest(),
        journalPath: join(tmp, 'journal.jsonl'),
        openAdapter: mock.open,
      });
      expect(summary.estimated_cost).toBeUndefined();
    } finally {
      restore();
    }
  });

  test('missing fetcher for a kind journals an error and continues', async () => {
    // Temporarily delete the registered filesystem fetcher to prove
    // the runtime doesn't crash when the registry lookup misses.
    const original = FETCHERS.filesystem;
    delete (FETCHERS as Record<string, Fetcher>).filesystem;
    try {
      const journalPath = join(tmp, 'journal.jsonl');
      const mock = makeMockAdapter();
      const summary = await runPipeline({
        manifest: baseManifest(),
        journalPath,
        openAdapter: mock.open,
      });
      expect(summary.errors).toBe(1);
      const lines = readJournalLines(journalPath);
      expect(lines.some((l) => l.kind === 'error')).toBe(true);
    } finally {
      if (original) {
        (FETCHERS as Record<string, Fetcher>).filesystem = original;
      }
    }
  });
});
