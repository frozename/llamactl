import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { router } from '../src/router.js';
import { saveConfig, upsertNode } from '../src/config/kubeconfig.js';
import { freshConfig } from '../src/config/schema.js';

/**
 * Phase 7 — RAG end-to-end smoke. Opt-in; default CI skips every block.
 *
 * Two independent skip guards, one per provider, so an operator can
 * exercise just the backend they have running locally:
 *
 *   - `LLAMACTL_RAG_E2E_CHROMA=<command>`
 *     e.g. `LLAMACTL_RAG_E2E_CHROMA='chroma-mcp run --persist-directory /tmp/chroma-e2e'`
 *     The full command string is spawned as the chroma-mcp subprocess.
 *
 *   - `LLAMACTL_RAG_E2E_PG=<postgres-url>;<collection>;<dim>`
 *     e.g. `LLAMACTL_RAG_E2E_PG='postgres://kb_test@localhost:5432/kb_test;docs;1536'`
 *     The collection table must already exist; the test stores two
 *     docs with randomly-generated unit vectors of the configured
 *     dimension, runs a search, deletes them, and asserts counts.
 *
 * Nothing here spins up infra — every block skips cleanly if its env
 * var is unset. See docs/rag-nodes.md for provider prereqs.
 */

const CHROMA_CMD = process.env.LLAMACTL_RAG_E2E_CHROMA?.trim();
const PG_CONFIG = process.env.LLAMACTL_RAG_E2E_PG?.trim();

let tmp = '';
const originalEnv = { ...process.env };

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-rag-e2e-'));
  process.env.LLAMACTL_CONFIG = join(tmp, 'config');
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

function unitVector(dim: number): number[] {
  const v = Array.from({ length: dim }, () => Math.random() - 0.5);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

describe.skipIf(!CHROMA_CMD)('RAG E2E — chroma-mcp round-trip', () => {
  test('store → search → delete → listCollections', async () => {
    let cfg = freshConfig();
    cfg = upsertNode(cfg, 'home', {
      name: 'kb-e2e-chroma',
      endpoint: '',
      kind: 'rag',
      rag: {
        provider: 'chroma',
        endpoint: CHROMA_CMD!,
        collection: 'rag-e2e',
        extraArgs: [],
      },
    });
    saveConfig(cfg, join(tmp, 'config'));

    const caller = router.createCaller({});
    const docs = [
      {
        id: 'e2e-greet-1',
        content: 'a friendly greeting from the operator',
        metadata: { tag: 'greet' },
      },
      {
        id: 'e2e-err-1',
        content: 'authentication failed: invalid token',
        metadata: { tag: 'error' },
      },
    ];

    const stored = await caller.ragStore({
      node: 'kb-e2e-chroma',
      documents: docs,
      collection: 'rag-e2e',
    });
    expect(stored.ids.length).toBeGreaterThan(0);

    const found = await caller.ragSearch({
      node: 'kb-e2e-chroma',
      query: 'greeting from the operator',
      topK: 2,
      collection: 'rag-e2e',
    });
    expect(found.results.length).toBeGreaterThan(0);
    for (const r of found.results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }

    const cleaned = await caller.ragDelete({
      node: 'kb-e2e-chroma',
      ids: stored.ids,
      collection: 'rag-e2e',
    });
    expect(cleaned.deleted).toBeGreaterThan(0);

    const listed = await caller.ragListCollections({ node: 'kb-e2e-chroma' });
    expect(Array.isArray(listed.collections)).toBe(true);
  });
});

describe.skipIf(!PG_CONFIG)('RAG E2E — pgvector round-trip', () => {
  test('store → search → delete against a live pgvector collection', async () => {
    const parts = PG_CONFIG!.split(';');
    const [url, collection, dimStr] = parts;
    const dim = Number.parseInt(dimStr ?? '0', 10);
    expect(url, 'LLAMACTL_RAG_E2E_PG needs url;collection;dim').toBeTruthy();
    expect(collection, 'collection segment missing').toBeTruthy();
    expect(dim > 0, 'dim must be > 0').toBe(true);

    let cfg = freshConfig();
    cfg = upsertNode(cfg, 'home', {
      name: 'kb-e2e-pg',
      endpoint: '',
      kind: 'rag',
      rag: {
        provider: 'pgvector',
        endpoint: url!,
        collection: collection!,
        extraArgs: [],
      },
    });
    saveConfig(cfg, join(tmp, 'config'));

    const caller = router.createCaller({});
    const docs = [
      {
        id: 'e2e-pg-1',
        content: 'first pgvector smoke doc',
        metadata: { kind: 'smoke' },
        vector: unitVector(dim),
      },
      {
        id: 'e2e-pg-2',
        content: 'second pgvector smoke doc',
        metadata: { kind: 'smoke' },
        vector: unitVector(dim),
      },
    ];

    const stored = await caller.ragStore({
      node: 'kb-e2e-pg',
      documents: docs,
      collection,
    });
    expect(stored.ids).toEqual(['e2e-pg-1', 'e2e-pg-2']);

    const queryVector = unitVector(dim);
    const found = await caller.ragSearch({
      node: 'kb-e2e-pg',
      query: 'any — pgvector search uses filter.vector, not the text',
      topK: 2,
      filter: { vector: queryVector },
      collection,
    });
    expect(found.collection).toBe(collection!);
    for (const r of found.results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }

    const cleaned = await caller.ragDelete({
      node: 'kb-e2e-pg',
      ids: ['e2e-pg-1', 'e2e-pg-2'],
      collection,
    });
    expect(cleaned.deleted).toBeGreaterThanOrEqual(0);
  });
});
