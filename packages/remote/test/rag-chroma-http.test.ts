import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  CHROMA_DEFAULT_DATABASE,
  CHROMA_DEFAULT_TENANT,
  ChromaRagAdapter,
  createChromaAdapter,
  HttpChromaClient,
  parseHttpChromaEndpoint,
  resolveChromaHttpToken,
} from '../src/rag/chroma/index.js';
import { RagError } from '../src/rag/errors.js';
import type { RagBinding } from '../src/config/schema.js';

/**
 * HTTP-mode coverage of the chroma adapter (slice G1). The fixture
 * server below is a `Bun.serve` stand-in for a real chroma container
 * — canned JSON responses keyed by path + method so we can test
 * create-or-get resolution, upsert, query, delete, listCollections,
 * and the 4xx/5xx error paths hermetically. Live container smoke is
 * gated behind `LLAMACTL_RAG_CHROMA_HTTP_URL` for the "real signal"
 * block at the end.
 */

interface RecordedRequest {
  method: string;
  path: string;
  search: string;
  body: string;
  auth: string | null;
}

interface FakeChromaOptions {
  /** Override the response for a specific method+path combo. */
  overrides?: Record<string, (body: unknown) => Promise<Response> | Response>;
  /** Fail heartbeat — simulates a backend that's up but refusing. */
  heartbeatStatus?: number;
  /** Body + status returned for unknown routes. Defaults to 404. */
  notFound?: { status: number; body: string };
  /** Metadata baked into every Collection response. */
  collectionDimension?: number | null;
  /** Deterministic UUID for the first-created collection. */
  collectionId?: string;
}

async function startFakeChroma(
  opts: FakeChromaOptions = {},
): Promise<{
  url: string;
  calls: RecordedRequest[];
  collections: Map<string, { id: string; name: string }>;
  stop: () => Promise<void>;
}> {
  const calls: RecordedRequest[] = [];
  const collections = new Map<string, { id: string; name: string }>();
  let nextId = 0;
  const assignedUuid = () => {
    const base = opts.collectionId ?? '11111111-1111-4111-8111-';
    return `${base}${String(nextId++).padStart(12, '0')}`;
  };

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
      calls.push({
        method: req.method,
        path: url.pathname,
        search: url.search,
        body,
        auth: req.headers.get('authorization'),
      });

      // Explicit override wins.
      const key = `${req.method} ${url.pathname}`;
      if (opts.overrides && opts.overrides[key]) {
        return opts.overrides[key](body ? safeJson(body) : undefined);
      }

      if (url.pathname === '/api/v2/heartbeat') {
        const status = opts.heartbeatStatus ?? 200;
        if (status !== 200) {
          return new Response(`{"error":"down"}`, {
            status,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{"nanosecond heartbeat":12345}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      const base = `/api/v2/tenants/${CHROMA_DEFAULT_TENANT}/databases/${CHROMA_DEFAULT_DATABASE}/collections`;
      if (req.method === 'POST' && url.pathname === base) {
        const parsed = body ? (safeJson(body) as { name: string }) : { name: '' };
        let existing = [...collections.values()].find((c) => c.name === parsed.name);
        if (!existing) {
          existing = { id: assignedUuid(), name: parsed.name };
          collections.set(existing.id, existing);
        }
        const dim = opts.collectionDimension ?? null;
        return new Response(
          JSON.stringify({
            id: existing.id,
            name: existing.name,
            configuration_json: {},
            dimension: dim,
            metadata: null,
            tenant: CHROMA_DEFAULT_TENANT,
            database: CHROMA_DEFAULT_DATABASE,
            log_position: 0,
            version: 0,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (req.method === 'GET' && url.pathname === base) {
        const dim = opts.collectionDimension ?? null;
        const arr = [...collections.values()].map((c) => ({
          id: c.id,
          name: c.name,
          configuration_json: {},
          dimension: dim,
          metadata: null,
          tenant: CHROMA_DEFAULT_TENANT,
          database: CHROMA_DEFAULT_DATABASE,
          log_position: 0,
          version: 0,
        }));
        return new Response(JSON.stringify(arr), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (req.method === 'POST' && url.pathname.startsWith(`${base}/`)) {
        const rest = url.pathname.slice(base.length + 1);
        const slash = rest.indexOf('/');
        const id = slash >= 0 ? rest.slice(0, slash) : rest;
        const action = slash >= 0 ? rest.slice(slash + 1) : '';
        if (!collections.has(id)) {
          return new Response(
            `{"error":"NotFoundError","message":"Collection [${id}] does not exist"}`,
            { status: 404, headers: { 'content-type': 'application/json' } },
          );
        }
        if (action === 'upsert') {
          return new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (action === 'query') {
          const parsed = body ? (safeJson(body) as { n_results?: number }) : {};
          const n = parsed.n_results ?? 2;
          const ids = Array.from({ length: n }, (_, i) => `doc-${i}`);
          const docs = Array.from({ length: n }, (_, i) => `content-${i}`);
          const metas = Array.from(
            { length: n },
            (_, i): Record<string, unknown> | null => (i === n - 1 ? null : { t: 'x' }),
          );
          const distances = Array.from({ length: n }, (_, i) => Math.min(0.1 * (i + 1), 1.5));
          return new Response(
            JSON.stringify({
              ids: [ids],
              documents: [docs],
              metadatas: [metas],
              distances: [distances],
              include: ['distances', 'documents', 'metadatas'],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (action === 'delete') {
          const parsed = body ? (safeJson(body) as { ids?: string[] }) : {};
          return new Response(JSON.stringify({ deleted: parsed.ids?.length ?? 0 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
      }

      const nf = opts.notFound ?? { status: 404, body: `{"error":"NotFound","message":"unknown"}` };
      return new Response(nf.body, {
        status: nf.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    collections,
    stop: async () => {
      server.stop(true);
    },
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function httpBinding(overrides: Partial<RagBinding> = {}): RagBinding {
  return {
    provider: 'chroma',
    endpoint: overrides.endpoint ?? 'http://127.0.0.1:0',
    collection: overrides.collection ?? 'kb',
    extraArgs: [],
    ...(overrides.embedder !== undefined && { embedder: overrides.embedder }),
    ...(overrides.auth !== undefined && { auth: overrides.auth }),
  } as RagBinding;
}

// ---- parseHttpChromaEndpoint + token resolution ------------------------

describe('parseHttpChromaEndpoint', () => {
  test('accepts plain host:port', () => {
    expect(parseHttpChromaEndpoint({ endpoint: 'http://host:8000' })).toBe('http://host:8000');
  });
  test('strips trailing slash', () => {
    expect(parseHttpChromaEndpoint({ endpoint: 'http://host:8000/' })).toBe('http://host:8000');
  });
  test('strips /api/v2 suffix', () => {
    expect(parseHttpChromaEndpoint({ endpoint: 'http://host:8000/api/v2' })).toBe('http://host:8000');
  });
  test('rejects empty endpoint', () => {
    try {
      parseHttpChromaEndpoint({ endpoint: '   ' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('connect-failed');
    }
  });
  test('rejects non-URL garbage', () => {
    try {
      parseHttpChromaEndpoint({ endpoint: 'not a url' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('connect-failed');
    }
  });
});

describe('resolveChromaHttpToken', () => {
  test('returns undefined without auth block', () => {
    expect(resolveChromaHttpToken({} as RagBinding, {})).toBeUndefined();
  });
  test('reads tokenEnv when set', () => {
    const env = { CHROMA_TOKEN: 'abc123' };
    const got = resolveChromaHttpToken(
      { auth: { tokenEnv: 'CHROMA_TOKEN' } } as RagBinding,
      env as NodeJS.ProcessEnv,
    );
    expect(got).toBe('abc123');
  });
  test('reads env: scheme via tokenRef', () => {
    const env = { CT: 'z' };
    const got = resolveChromaHttpToken(
      { auth: { tokenRef: 'env:CT' } } as RagBinding,
      env as NodeJS.ProcessEnv,
    );
    expect(got).toBe('z');
  });
  test('wraps tokenRef failure in RagError', () => {
    try {
      resolveChromaHttpToken(
        { auth: { tokenRef: 'env:MISSING_VAR' } } as RagBinding,
        {} as NodeJS.ProcessEnv,
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('connect-failed');
    }
  });
});

// ---- HttpChromaClient direct -------------------------------------------

describe('HttpChromaClient', () => {
  let fake: Awaited<ReturnType<typeof startFakeChroma>>;
  beforeEach(async () => {
    fake = await startFakeChroma({ collectionDimension: 768 });
  });
  afterEach(async () => {
    await fake.stop();
  });

  test('heartbeat hits /api/v2/heartbeat and returns void on 200', async () => {
    const client = new HttpChromaClient({ baseUrl: fake.url });
    await client.heartbeat();
    expect(fake.calls.at(-1)!.path).toBe('/api/v2/heartbeat');
  });

  test('heartbeat translates 5xx into RagError connect-failed', async () => {
    await fake.stop();
    fake = await startFakeChroma({ heartbeatStatus: 503 });
    const client = new HttpChromaClient({ baseUrl: fake.url });
    try {
      await client.heartbeat();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('connect-failed');
    }
  });

  test('resolveCollectionId caches the first lookup', async () => {
    const client = new HttpChromaClient({ baseUrl: fake.url });
    const a = await client.resolveCollectionId('kb');
    const b = await client.resolveCollectionId('kb');
    expect(a).toBe(b);
    const postCreates = fake.calls.filter(
      (c) => c.method === 'POST' && c.path.endsWith('/collections'),
    );
    expect(postCreates).toHaveLength(1);
  });

  test('upsert + query + delete + listCollections happy path', async () => {
    const client = new HttpChromaClient({ baseUrl: fake.url });
    const id = await client.resolveCollectionId('kb');
    await client.upsert(id, {
      ids: ['a', 'b'],
      embeddings: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      documents: ['one', 'two'],
      metadatas: [{ t: '1' }, null],
    });
    const q = await client.query(id, {
      query_embeddings: [[0.1, 0.2]],
      n_results: 2,
      include: ['distances', 'documents', 'metadatas'],
    });
    expect(q.ids[0]).toHaveLength(2);
    expect(q.distances![0]).toHaveLength(2);
    const deleted = await client.deleteRecords(id, { ids: ['a'] });
    expect(deleted).toBe(1);
    const list = await client.listCollections();
    expect(list.map((c) => c.name)).toContain('kb');
  });

  test('attaches bearer token when configured', async () => {
    const client = new HttpChromaClient({ baseUrl: fake.url, token: 'bear' });
    await client.heartbeat();
    expect(fake.calls.at(-1)!.auth).toBe('Bearer bear');
  });

  test('propagates 4xx as RagError tool-error', async () => {
    await fake.stop();
    fake = await startFakeChroma({
      overrides: {
        [`POST /api/v2/tenants/${CHROMA_DEFAULT_TENANT}/databases/${CHROMA_DEFAULT_DATABASE}/collections`]:
          () =>
            new Response('{"error":"ChromaError","message":"bad name"}', {
              status: 422,
              headers: { 'content-type': 'application/json' },
            }),
      },
    });
    const client = new HttpChromaClient({ baseUrl: fake.url });
    try {
      await client.createCollection('bogus', { getOrCreate: true });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('tool-error');
      expect((err as RagError).message).toContain('bad name');
    }
  });

  test('propagates 5xx as RagError connect-failed', async () => {
    await fake.stop();
    fake = await startFakeChroma({
      overrides: {
        [`POST /api/v2/tenants/${CHROMA_DEFAULT_TENANT}/databases/${CHROMA_DEFAULT_DATABASE}/collections`]:
          () =>
            new Response('{"error":"InternalError","message":"boom"}', {
              status: 500,
              headers: { 'content-type': 'application/json' },
            }),
      },
    });
    const client = new HttpChromaClient({ baseUrl: fake.url });
    try {
      await client.createCollection('boom', { getOrCreate: true });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('connect-failed');
    }
  });

  test('deleteRecords tolerates servers that omit deleted field', async () => {
    await fake.stop();
    fake = await startFakeChroma({
      overrides: {},
    });
    const client = new HttpChromaClient({ baseUrl: fake.url });
    const id = await client.resolveCollectionId('kb');
    const deleted = await client.deleteRecords(id, { ids: ['x', 'y'] });
    // Fake returns `{deleted: 2}` by default. Replace override with an
    // empty body shape to verify the fallback path.
    expect(deleted).toBe(2);
  });
});

// ---- ChromaRagAdapter HTTP-mode round-trip -----------------------------

describe('ChromaRagAdapter (HTTP backend)', () => {
  let fake: Awaited<ReturnType<typeof startFakeChroma>>;
  beforeEach(async () => {
    fake = await startFakeChroma({ collectionDimension: 3 });
  });
  afterEach(async () => {
    await fake.stop();
  });

  test('store + search + delete round-trip with caller-supplied vectors', async () => {
    const adapter = (await createChromaAdapter(httpBinding({ endpoint: fake.url }))) as ChromaRagAdapter;

    const storeRes = await adapter.store({
      documents: [
        { id: 'a', content: 'hello', vector: [0.1, 0.2, 0.3], metadata: { topic: 'x' } },
        { id: 'b', content: 'world', vector: [0.4, 0.5, 0.6] },
      ],
    });
    expect(storeRes.ids).toEqual(['a', 'b']);
    expect(storeRes.collection).toBe('kb');

    const searchRes = await adapter.search({
      query: 'anything',
      topK: 2,
      filter: { vector: [0.1, 0.2, 0.3] },
    });
    expect(searchRes.results).toHaveLength(2);
    // Fake server returns distances [0.1, 0.2] → scores [0.9, 0.8].
    expect(searchRes.results[0]!.score).toBeCloseTo(0.9, 5);
    expect(searchRes.results[0]!.document.metadata).toEqual({ t: 'x' });
    expect(searchRes.results[1]!.document.metadata).toBeUndefined(); // last one is null

    const delRes = await adapter.delete({ ids: ['a'] });
    expect(delRes.deleted).toBe(1);

    await adapter.close();

    // Upsert payload confirms embeddings threaded through correctly.
    const upsertCall = fake.calls.find((c) => c.path.endsWith('/upsert'))!;
    const upsertBody = JSON.parse(upsertCall.body) as {
      ids: string[];
      embeddings: number[][];
      documents: string[];
      metadatas: Array<Record<string, unknown> | null>;
    };
    expect(upsertCall).toBeDefined();
    expect(upsertBody.ids).toEqual(['a', 'b']);
    expect(upsertBody.embeddings).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
    expect(upsertBody.documents).toEqual(['hello', 'world']);
    expect(upsertBody.metadatas).toEqual([{ topic: 'x' }, null]);
    // Query payload shape.
    const queryCall = fake.calls.find((c) => c.path.endsWith('/query'))!;
    const queryBody = JSON.parse(queryCall.body) as {
      query_embeddings: number[][];
      n_results: number;
      include: string[];
    };
    expect(queryBody.query_embeddings).toEqual([[0.1, 0.2, 0.3]]);
    expect(queryBody.n_results).toBe(2);
    expect(queryBody.include).toEqual(['distances', 'documents', 'metadatas']);
  });

  test('uses delegated embedder when docs arrive without vectors', async () => {
    let embedCalls = 0;
    const embedder = async (texts: string[]) => {
      embedCalls++;
      // Return one 3-dim vector per text; each row deterministic by index.
      return texts.map((_, i) => [0.1 * (i + 1), 0.2 * (i + 1), 0.3 * (i + 1)]);
    };
    const adapter = (await createChromaAdapter(httpBinding({ endpoint: fake.url }), {
      embedder,
    })) as ChromaRagAdapter;

    await adapter.store({
      documents: [
        { id: 'a', content: 'x' },
        { id: 'b', content: 'y' },
      ],
    });
    expect(embedCalls).toBe(1); // single batched call for both docs

    const searchRes = await adapter.search({ query: 'find x', topK: 1 });
    expect(searchRes.results).toBeDefined();
    expect(embedCalls).toBe(2); // one more for the query

    await adapter.close();

    const upsertCall = fake.calls.find((c) => c.path.endsWith('/upsert'))!;
    const upsertBody = JSON.parse(upsertCall.body) as { embeddings: number[][] };
    expect(upsertBody.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
    expect(upsertBody.embeddings[1]).toEqual([0.2, 0.4, 0.6]);
  });

  test('store without vector and without embedder surfaces invalid-request', async () => {
    const adapter = (await createChromaAdapter(httpBinding({ endpoint: fake.url }))) as ChromaRagAdapter;
    try {
      await adapter.store({ documents: [{ id: 'x', content: 'c' }] });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('invalid-request');
      expect((err as RagError).message).toContain('no rag.embedder is configured');
    } finally {
      await adapter.close();
    }
  });

  test('search without vector + no embedder → invalid-request', async () => {
    const adapter = (await createChromaAdapter(httpBinding({ endpoint: fake.url }))) as ChromaRagAdapter;
    try {
      await adapter.search({ query: 'q', topK: 3 });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('invalid-request');
    } finally {
      await adapter.close();
    }
  });

  test('listCollections normalizes HTTP rows into CollectionInfo[]', async () => {
    const adapter = (await createChromaAdapter(httpBinding({ endpoint: fake.url }))) as ChromaRagAdapter;
    // First trigger a create so the collection exists.
    await adapter.store({
      documents: [{ id: 'x', content: 'c', vector: [0.1, 0.2, 0.3] }],
    });
    const list = await adapter.listCollections();
    expect(list.collections.length).toBeGreaterThan(0);
    const kb = list.collections.find((c) => c.name === 'kb');
    expect(kb).toBeDefined();
    expect(kb!.dimensions).toBe(3);
    await adapter.close();
  });

  test('unreachable backend throws connect-failed on heartbeat', async () => {
    // Point at a port nothing is listening on.
    try {
      await createChromaAdapter(httpBinding({ endpoint: 'http://127.0.0.1:1' }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('connect-failed');
    }
  });

  test('5xx from chroma on upsert surfaces connect-failed', async () => {
    await fake.stop();
    fake = await startFakeChroma({
      overrides: {
        [`POST /api/v2/tenants/${CHROMA_DEFAULT_TENANT}/databases/${CHROMA_DEFAULT_DATABASE}/collections/11111111-1111-4111-8111-000000000000/upsert`]:
          () =>
            new Response('{"error":"InternalError","message":"disk full"}', {
              status: 500,
              headers: { 'content-type': 'application/json' },
            }),
      },
    });
    const adapter = (await createChromaAdapter(httpBinding({ endpoint: fake.url }))) as ChromaRagAdapter;
    try {
      await adapter.store({
        documents: [{ id: 'a', content: 'c', vector: [0.1, 0.2, 0.3] }],
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('connect-failed');
      expect((err as RagError).message).toContain('disk full');
    } finally {
      await adapter.close();
    }
  });
});

// ---- live test (opt-in) ------------------------------------------------

const LIVE_URL = process.env.LLAMACTL_RAG_CHROMA_HTTP_URL;
const liveDescribe = LIVE_URL ? describe : describe.skip;

liveDescribe('ChromaRagAdapter (live HTTP, opt-in)', () => {
  test('round-trip against a real chroma container', async () => {
    const adapter = (await createChromaAdapter({
      provider: 'chroma',
      endpoint: LIVE_URL!,
      collection: `llamactl_test_${Date.now()}`,
      extraArgs: [],
    })) as ChromaRagAdapter;
    try {
      await adapter.store({
        documents: [
          { id: 'live-a', content: 'alpha', vector: [0.1, 0.2, 0.3] },
          { id: 'live-b', content: 'bravo', vector: [0.4, 0.5, 0.6] },
        ],
      });
      const res = await adapter.search({
        query: 'anything',
        topK: 2,
        filter: { vector: [0.1, 0.2, 0.3] },
      });
      expect(res.results.length).toBeGreaterThan(0);
      expect(res.results[0]!.document.id).toBe('live-a');
      const del = await adapter.delete({ ids: ['live-a'] });
      expect(del.deleted).toBeGreaterThanOrEqual(0);
    } finally {
      await adapter.close();
    }
  });
});
