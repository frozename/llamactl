import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  DeleteRequest,
  DeleteResponse,
  ListCollectionsResponse,
  RetrievalProvider,
  SearchRequest,
  SearchResponse,
  StoreRequest,
  StoreResponse,
} from '@nova/contracts';

import { router } from '../src/router.js';
import { saveConfig, upsertNode } from '../src/config/kubeconfig.js';
import { freshConfig } from '../src/config/schema.js';

/**
 * Phase 4 — RAG router procedures. Mocks `./rag/index.js` so the test
 * drives the factory contract without spawning chroma-mcp / Postgres.
 * Covers:
 *  - rag-kind dispatch into the right provider + request passthrough.
 *  - Adapter `close()` runs in `finally` (even on throw).
 *  - Non-rag node rejected with BAD_REQUEST.
 *  - Missing node rejected.
 */

type CalledOp = keyof RetrievalProvider;

interface FakeProviderOptions {
  search?: (req: SearchRequest) => Promise<SearchResponse>;
  store?: (req: StoreRequest) => Promise<StoreResponse>;
  delete?: (req: DeleteRequest) => Promise<DeleteResponse>;
  listCollections?: () => Promise<ListCollectionsResponse>;
}

let tmp = '';
const originalEnv = { ...process.env };

let closeCount = 0;
let lastNodeName: string | null = null;
let lastProviderOptions: FakeProviderOptions = {};
const calls: Array<{ op: CalledOp; input: unknown }> = [];

function makeFakeProvider(options: FakeProviderOptions): RetrievalProvider {
  return {
    kind: 'fake',
    async search(req) {
      calls.push({ op: 'search', input: req });
      if (options.search) return options.search(req);
      return { collection: req.collection ?? 'default', results: [] };
    },
    async store(req) {
      calls.push({ op: 'store', input: req });
      if (options.store) return options.store(req);
      return {
        collection: req.collection ?? 'default',
        ids: req.documents.map((d) => d.id),
      };
    },
    async delete(req) {
      calls.push({ op: 'delete', input: req });
      if (options.delete) return options.delete(req);
      return { collection: req.collection ?? 'default', deleted: req.ids.length };
    },
    async listCollections() {
      calls.push({ op: 'listCollections', input: null });
      if (options.listCollections) return options.listCollections();
      return { collections: [{ name: 'default' }] };
    },
    async close() {
      closeCount++;
    },
  };
}

mock.module('../src/rag/index.js', () => ({
  createRagAdapter: async (node: { name: string }) => {
    lastNodeName = node.name;
    return makeFakeProvider(lastProviderOptions);
  },
}));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-router-rag-'));
  Object.assign(process.env, {
    LLAMACTL_CONFIG: join(tmp, 'config'),
  });
  closeCount = 0;
  lastNodeName = null;
  lastProviderOptions = {};
  calls.length = 0;

  let cfg = freshConfig();
  cfg = upsertNode(cfg, 'home', {
    name: 'kb-chroma',
    endpoint: '',
    kind: 'rag',
    rag: {
      provider: 'chroma',
      endpoint: 'chroma-mcp run --persist-directory /tmp/chroma-test',
      extraArgs: [],
    },
  });
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
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

describe('router RAG procedures', () => {
  test('ragSearch dispatches to adapter and forwards input', async () => {
    lastProviderOptions = {
      search: async (req) => ({
        collection: req.collection ?? 'default',
        results: [
          {
            document: { id: 'doc-1', content: 'hello world', metadata: { src: 'test' } },
            score: 0.92,
            distance: 0.08,
          },
        ],
      }),
    };

    const caller = router.createCaller({});
    const res = await caller.ragSearch({
      node: 'kb-chroma',
      query: 'greeting',
      topK: 5,
      filter: { src: 'test' },
      collection: 'default',
    });

    expect(res.results).toHaveLength(1);
    expect(res.results[0]?.document.id).toBe('doc-1');
    expect(res.results[0]?.score).toBeCloseTo(0.92);
    expect(lastNodeName).toBe('kb-chroma');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.op).toBe('search');
    expect((calls[0]?.input as SearchRequest).query).toBe('greeting');
    expect((calls[0]?.input as SearchRequest).topK).toBe(5);
    expect(closeCount).toBe(1);
  });

  test('ragSearch applies default topK', async () => {
    const caller = router.createCaller({});
    await caller.ragSearch({ node: 'kb-chroma', query: 'hi' });
    expect((calls[0]?.input as SearchRequest).topK).toBe(10);
  });

  test('ragStore dispatches to adapter and forwards docs', async () => {
    const caller = router.createCaller({});
    const res = await caller.ragStore({
      node: 'kb-chroma',
      documents: [
        { id: 'a', content: 'alpha' },
        { id: 'b', content: 'beta', metadata: { k: 'v' } },
      ],
    });

    expect(res.ids).toEqual(['a', 'b']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.op).toBe('store');
    expect((calls[0]?.input as StoreRequest).documents).toHaveLength(2);
    expect(closeCount).toBe(1);
  });

  test('ragDelete dispatches to adapter and forwards ids', async () => {
    const caller = router.createCaller({});
    const res = await caller.ragDelete({
      node: 'kb-pg',
      ids: ['a', 'b', 'c'],
      collection: 'docs',
    });

    expect(res.deleted).toBe(3);
    expect(calls[0]?.op).toBe('delete');
    expect((calls[0]?.input as DeleteRequest).ids).toEqual(['a', 'b', 'c']);
    expect(closeCount).toBe(1);
  });

  test('ragListCollections dispatches to adapter', async () => {
    lastProviderOptions = {
      listCollections: async () => ({
        collections: [
          { name: 'docs', count: 42 },
          { name: 'logs', count: 7 },
        ],
      }),
    };

    const caller = router.createCaller({});
    const res = await caller.ragListCollections({ node: 'kb-pg' });

    expect(res.collections).toHaveLength(2);
    expect(res.collections[0]?.name).toBe('docs');
    expect(calls[0]?.op).toBe('listCollections');
    expect(closeCount).toBe(1);
  });

  test('adapter.close() runs even when the adapter method throws', async () => {
    lastProviderOptions = {
      search: async () => {
        throw new Error('adapter-layer failure');
      },
    };

    const caller = router.createCaller({});
    await expect(
      caller.ragSearch({ node: 'kb-chroma', query: 'boom' }),
    ).rejects.toThrow(/adapter-layer failure/);
    expect(closeCount).toBe(1);
  });

  test('non-RAG node rejected with BAD_REQUEST', async () => {
    // The `local` node from freshConfig() is an inproc agent — not a
    // RAG node — so every ragX procedure must refuse it.
    const caller = router.createCaller({});
    await expect(
      caller.ragSearch({ node: 'local', query: 'x' }),
    ).rejects.toThrow(/not a RAG node/);
    expect(closeCount).toBe(0);
  });

  test('missing node rejected', async () => {
    const caller = router.createCaller({});
    await expect(
      caller.ragSearch({ node: 'nope', query: 'x' }),
    ).rejects.toThrow(/not found/);
    expect(closeCount).toBe(0);
  });
});
