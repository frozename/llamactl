import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StoreRequest, StoreResponse } from '@nova/contracts';

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

function makeMockAdapter(): {
  open: () => Promise<{ store: (req: StoreRequest) => Promise<StoreResponse>; close: () => Promise<void> }>;
  calls: StoreCall[];
  closed: number;
} {
  const calls: StoreCall[] = [];
  let closed = 0;
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
      async close() {
        closed++;
      },
    }),
    calls,
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
