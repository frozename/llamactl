import { describe, expect, test } from 'bun:test';
import type postgres from 'postgres';
import {
  PgvectorRagAdapter,
  extractQueryVector,
} from '../src/rag/pgvector/adapter.js';
import {
  connectPgvector,
  redactPostgresUrl,
} from '../src/rag/pgvector/client.js';
import { createPgvectorAdapter } from '../src/rag/pgvector/index.js';
import { RagError } from '../src/rag/errors.js';

/**
 * Unit tests for the pgvector adapter. We can't stand up a real
 * Postgres here, so we substitute the adapter's `sql` instance with a
 * mock tagged-template function. Each call captures the query
 * fragments + interpolated values and returns the next canned row set
 * queued by the test. This lets us assert:
 *
 *   - the right SQL shape is generated (vector cast + cosine operator
 *     for search, INSERT ... ON CONFLICT for store, information_schema
 *     lookup for listCollections);
 *   - error mapping surfaces the right `RagError` code;
 *   - `close()` drains the pool via `sql.end`.
 */

interface MockCall {
  strings: readonly string[];
  values: readonly unknown[];
  /** Marker for helper invocations like `sql(identifier)` or `sql(rows, ...cols)`. */
  helper?: { first: unknown; rest: unknown[] };
  /** Marker for `sql.unsafe(raw)` fragment calls — only records the payload; postgres.js treats the return as a fragment that composes inside tagged templates. */
  unsafe?: { raw: string };
}

type QueueEntry =
  | { kind: 'rows'; rows: unknown[]; count?: number }
  | { kind: 'error'; error: unknown };

interface MockSql {
  /** The callable — passed where `postgres.Sql` is expected. */
  fn: postgres.Sql;
  /** Calls captured (helper + tagged-template, in order). */
  calls: MockCall[];
  /** Queue of canned responses for tagged-template calls. */
  queue: QueueEntry[];
  /** Whether `end()` was called. */
  endCalled: boolean;
  endOptions: { timeout?: number } | undefined;
}

function createMockSql(): MockSql {
  const mock: MockSql = {
    // Filled in below.
    fn: undefined as unknown as postgres.Sql,
    calls: [],
    queue: [],
    endCalled: false,
    endOptions: undefined,
  };

  const callable = (first: unknown, ...rest: unknown[]): unknown => {
    // Tagged template calls pass a TemplateStringsArray; helper calls
    // don't (they pass an identifier string, or a value array + column
    // names).
    if (
      Array.isArray(first) &&
      Object.prototype.hasOwnProperty.call(first, 'raw')
    ) {
      mock.calls.push({
        strings: first as unknown as readonly string[],
        values: rest,
      });
      const next = mock.queue.shift();
      if (!next) {
        // Default: empty row set, count 0.
        return Promise.resolve(Object.assign([] as unknown[], { count: 0 }));
      }
      if (next.kind === 'error') return Promise.reject(next.error);
      const arr = Object.assign([...next.rows], {
        count: next.count ?? next.rows.length,
      });
      return Promise.resolve(arr);
    }
    // Helper form: record it and return a sentinel that's accepted as
    // a template value by the real postgres.js at runtime. Inside the
    // test this sentinel flows through to the next tagged-template
    // call's `values` array, which we don't structurally assert on
    // beyond length.
    mock.calls.push({
      strings: [],
      values: [],
      helper: { first, rest },
    });
    return { __helper: true, first, rest };
  };

  // Attach `end()`.
  (callable as unknown as { end: (opts?: { timeout?: number }) => Promise<void> }).end = (opts) => {
    mock.endCalled = true;
    mock.endOptions = opts;
    return Promise.resolve();
  };

  // Attach `unsafe()`. Records the raw SQL and returns a sentinel the
  // tagged-template path will carry along without parametrization —
  // we don't need to reconstruct the composition here because the
  // bootstrap SQL we care about is asserted on the `raw` payload.
  (callable as unknown as {
    unsafe: (raw: string) => { __unsafe: true; raw: string };
  }).unsafe = (raw) => {
    mock.calls.push({ strings: [], values: [], unsafe: { raw } });
    return { __unsafe: true, raw };
  };

  mock.fn = callable as unknown as postgres.Sql;
  return mock;
}

function queueRows(mock: MockSql, rows: unknown[], count?: number): void {
  mock.queue.push({ kind: 'rows', rows, count });
}

function queueError(mock: MockSql, error: unknown): void {
  mock.queue.push({ kind: 'error', error });
}

describe('PgvectorRagAdapter.search', () => {
  test('returns rows with score = 1 - distance from the mocked SQL', async () => {
    const mock = createMockSql();
    queueRows(mock, [
      {
        id: 'doc-1',
        content: 'hello world',
        metadata: { src: 'unit' },
        score: 0.92,
        distance: 0.08,
      },
      {
        id: 'doc-2',
        content: 'another doc',
        metadata: null,
        score: 0.71,
        distance: 0.29,
      },
    ]);

    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'knowledge',
    });
    const res = await adapter.search({
      query: 'anything',
      topK: 5,
      filter: { vector: [0.1, 0.2, 0.3] },
    });
    expect(res.collection).toBe('knowledge');
    expect(res.results).toHaveLength(2);
    expect(res.results[0]!.document.id).toBe('doc-1');
    expect(res.results[0]!.document.content).toBe('hello world');
    expect(res.results[0]!.document.metadata).toEqual({ src: 'unit' });
    expect(res.results[0]!.score).toBeCloseTo(0.92);
    expect(res.results[0]!.distance).toBeCloseTo(0.08);
    // Document without metadata returns undefined, not null.
    expect(res.results[1]!.document.metadata).toBeUndefined();
  });

  test('throws invalid-request when filter.vector is absent', async () => {
    const mock = createMockSql();
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'knowledge',
    });
    try {
      await adapter.search({ query: 'no vector', topK: 5 });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('invalid-request');
    }
    // No SQL was issued; only the caller's validation fired.
    expect(mock.calls.filter((c) => c.strings.length > 0)).toHaveLength(0);
  });

  test('throws invalid-request when filter.vector is not a number[]', async () => {
    const mock = createMockSql();
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'knowledge',
    });
    try {
      await adapter.search({
        query: 'bad vector',
        topK: 5,
        filter: { vector: ['nope', 'nope'] as unknown as number[] },
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('invalid-request');
    }
  });

  test('missing-table (42P01) returns empty results (operator-friendly)', async () => {
    // The adapter's store() path bootstraps the table on first write.
    // A search() that arrives before any store() hits an empty
    // collection — surface an empty result rather than the raw SQL
    // error so callers don't have to handle a distinct "not
    // bootstrapped yet" code.
    const mock = createMockSql();
    queueError(mock, Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'knowledge',
    });
    const res = await adapter.search({
      query: 'whatever',
      topK: 5,
      filter: { vector: [0.1, 0.2] },
    });
    expect(res.collection).toBe('knowledge');
    expect(res.results).toEqual([]);
  });

  test('non-42P01 Postgres errors still surface through wrapDbError', async () => {
    const mock = createMockSql();
    queueError(mock, Object.assign(new Error('syntax error'), { code: '42601' }));
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'knowledge',
    });
    try {
      await adapter.search({
        query: 'x',
        topK: 5,
        filter: { vector: [0.1, 0.2] },
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('tool-error');
    }
  });

  test('uses request collection override when provided', async () => {
    const mock = createMockSql();
    queueRows(mock, []);
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'default-table',
    });
    const res = await adapter.search({
      query: 'x',
      topK: 5,
      collection: 'custom-table',
      filter: { vector: [1, 2] },
    });
    expect(res.collection).toBe('custom-table');
    // Helper call captures the identifier the adapter hands to
    // postgres.js for table-name interpolation.
    const helper = mock.calls.find((c) => c.helper)?.helper;
    expect(helper?.first).toBe('custom-table');
  });

  test('embedder computes query vector when filter.vector absent', async () => {
    const mock = createMockSql();
    queueRows(mock, [
      { id: 'h', content: 'hit', metadata: null, score: 0.9, distance: 0.1 },
    ]);
    const embedCalls: string[][] = [];
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'docs',
      embedder: async (texts) => {
        embedCalls.push(texts);
        return [[0.5, 0.5]];
      },
    });
    const res = await adapter.search({ query: 'look for me', topK: 1 });
    expect(res.results).toHaveLength(1);
    expect(embedCalls).toEqual([['look for me']]);
  });

  test('caller-supplied filter.vector wins over the embedder', async () => {
    const mock = createMockSql();
    queueRows(mock, []);
    let embedderCalled = false;
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'docs',
      embedder: async () => {
        embedderCalled = true;
        return [[0.5, 0.5]];
      },
    });
    await adapter.search({
      query: 'x',
      topK: 1,
      filter: { vector: [0.1, 0.9] },
    });
    expect(embedderCalled).toBe(false);
  });
});

describe('PgvectorRagAdapter.store', () => {
  test('upserts when all docs carry vectors', async () => {
    const mock = createMockSql();
    queueRows(mock, []);
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'knowledge',
    });
    const res = await adapter.store({
      documents: [
        { id: 'a', content: 'aaa', vector: [0.1, 0.2], metadata: { k: 1 } },
        { id: 'b', content: 'bbb', vector: [0.3, 0.4] },
      ],
    });
    expect(res.ids).toEqual(['a', 'b']);
    expect(res.collection).toBe('knowledge');
    // Post-bootstrap: the helper call whose `rest` is the column list
    // is the VALUES helper for the INSERT. Everything before it is
    // the CREATE EXTENSION + CREATE TABLE bootstrap.
    const valuesHelper = mock.calls
      .map((c) => c.helper)
      .find((h): h is NonNullable<typeof h> =>
        !!h &&
        Array.isArray((h as { rest: unknown[] }).rest) &&
        (h as { rest: unknown[] }).rest.length > 0,
      );
    expect(valuesHelper).toBeDefined();
    expect(Array.isArray(valuesHelper!.first)).toBe(true);
    expect(valuesHelper!.rest).toEqual(['id', 'content', 'metadata', 'embedding']);
    const rows = valuesHelper!.first as Array<{ id: string; embedding: string }>;
    expect(rows[0]!.id).toBe('a');
    // Embedding is formatted as the pgvector literal string.
    expect(rows[0]!.embedding).toBe('[0.1,0.2]');
  });

  test('throws invalid-request when any doc is missing a vector', async () => {
    const mock = createMockSql();
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'knowledge',
    });
    try {
      await adapter.store({
        documents: [
          { id: 'a', content: 'aaa', vector: [0.1, 0.2] },
          { id: 'b', content: 'no vector here' },
        ],
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('invalid-request');
      expect((err as RagError).message).toContain('id=b');
    }
  });

  test('throws invalid-request for an empty vector', async () => {
    const mock = createMockSql();
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'knowledge',
    });
    try {
      await adapter.store({
        documents: [{ id: 'a', content: 'zero-len', vector: [] }],
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('invalid-request');
    }
  });

  test('delegated embedder fills missing vectors in one batch', async () => {
    const mock = createMockSql();
    queueRows(mock, []);
    const embedCalls: string[][] = [];
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'knowledge',
      embedder: async (texts) => {
        embedCalls.push(texts);
        return texts.map((_, i) => [i + 0.1, i + 0.2]);
      },
    });
    const res = await adapter.store({
      documents: [
        { id: 'a', content: 'aaa', vector: [0.7, 0.8] }, // supplied
        { id: 'b', content: 'bbb' },                      // auto
        { id: 'c', content: 'ccc' },                      // auto
      ],
    });
    expect(res.ids).toEqual(['a', 'b', 'c']);
    // Embedder called once with the two missing texts in order.
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]).toEqual(['bbb', 'ccc']);
    // Rows landed with supplied-then-computed vectors.
    const valuesHelper = mock.calls
      .map((c) => c.helper)
      .find((h): h is NonNullable<typeof h> =>
        !!h &&
        Array.isArray((h as { rest: unknown[] }).rest) &&
        (h as { rest: unknown[] }).rest.length > 0,
      )!;
    const rows = valuesHelper.first as Array<{ id: string; embedding: string }>;
    expect(rows[0]!.embedding).toBe('[0.7,0.8]');
    expect(rows[1]!.embedding).toBe('[0.1,0.2]');
    expect(rows[2]!.embedding).toBe('[1.1,1.2]');
  });

  test('no embedder + missing vector → invalid-request (back-compat)', async () => {
    const mock = createMockSql();
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'knowledge',
    });
    await expect(
      adapter.store({
        documents: [{ id: 'a', content: 'aaa' }],
      }),
    ).rejects.toThrow(/configure a rag\.embedder/);
  });

  test('embedder mismatch (wrong count) surfaces invalid-response', async () => {
    const mock = createMockSql();
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'knowledge',
      embedder: async () => [[0.1, 0.2]], // only one vector for two missing
    });
    try {
      await adapter.store({
        documents: [
          { id: 'a', content: 'aaa' },
          { id: 'b', content: 'bbb' },
        ],
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('invalid-response');
    }
  });
});

describe('PgvectorRagAdapter.store — auto-schema bootstrap', () => {
  /**
   * Scan the ordered call log for the CREATE EXTENSION + CREATE TABLE
   * tagged-templates the adapter emits before the INSERT. We match on
   * literal SQL fragments in `strings[0]` because the tagged-template
   * first string carries the statement's leading text verbatim.
   */
  function countBootstrapCalls(mock: ReturnType<typeof createMockSql>): {
    extension: number;
    createTable: number;
  } {
    let extension = 0;
    let createTable = 0;
    for (const c of mock.calls) {
      const head = c.strings[0] ?? '';
      if (head.includes('CREATE EXTENSION')) extension++;
      if (head.includes('CREATE TABLE IF NOT EXISTS')) createTable++;
    }
    return { extension, createTable };
  }

  test('first store() issues CREATE EXTENSION + CREATE TABLE before INSERT', async () => {
    const mock = createMockSql();
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'kb',
    });
    await adapter.store({
      documents: [{ id: 'a', content: 'hello', vector: [0.1, 0.2, 0.3] }],
    });
    const counts = countBootstrapCalls(mock);
    expect(counts.extension).toBe(1);
    expect(counts.createTable).toBe(1);
    // The CREATE TABLE landed the probed dim (3) as an unsafe fragment.
    const unsafeCalls = mock.calls
      .map((c) => c.unsafe)
      .filter((u): u is NonNullable<typeof u> => !!u);
    expect(unsafeCalls).toHaveLength(1);
    expect(unsafeCalls[0]!.raw).toBe('3');
    // Relative ordering: extension → table → insert.
    const indices = mock.calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => {
        const head = c.strings[0] ?? '';
        return (
          head.includes('CREATE EXTENSION') ||
          head.includes('CREATE TABLE') ||
          head.includes('INSERT INTO')
        );
      })
      .map(({ c, i }) => ({
        i,
        kind:
          (c.strings[0] ?? '').match(/CREATE EXTENSION|CREATE TABLE|INSERT INTO/)?.[0] ?? '',
      }));
    expect(indices.map((x) => x.kind)).toEqual([
      'CREATE EXTENSION',
      'CREATE TABLE',
      'INSERT INTO',
    ]);
  });

  test('second store() to the same collection skips both bootstrap statements', async () => {
    const mock = createMockSql();
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'kb',
    });
    await adapter.store({
      documents: [{ id: 'a', content: 'x', vector: [0.1, 0.2, 0.3] }],
    });
    await adapter.store({
      documents: [{ id: 'b', content: 'y', vector: [0.4, 0.5, 0.6] }],
    });
    const counts = countBootstrapCalls(mock);
    expect(counts.extension).toBe(1);
    expect(counts.createTable).toBe(1);
  });

  test('different collections each trigger CREATE TABLE once, CREATE EXTENSION still once', async () => {
    const mock = createMockSql();
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'kb',
    });
    await adapter.store({
      collection: 'kb',
      documents: [{ id: 'a', content: 'x', vector: [0.1, 0.2, 0.3] }],
    });
    await adapter.store({
      collection: 'notes',
      documents: [{ id: 'b', content: 'y', vector: [0.1, 0.2, 0.3] }],
    });
    const counts = countBootstrapCalls(mock);
    // CREATE EXTENSION is cached across collections.
    expect(counts.extension).toBe(1);
    // CREATE TABLE fires once per collection.
    expect(counts.createTable).toBe(2);
  });

  test('dimension mismatch on second store surfaces dimension-mismatch with embedder label', async () => {
    const mock = createMockSql();
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'kb',
      embedderLabel: 'nomic-embed',
    });
    // First store establishes vector(3).
    await adapter.store({
      documents: [{ id: 'a', content: 'x', vector: [0.1, 0.2, 0.3] }],
    });
    // Second store arrives with a 4-dim vector.
    try {
      await adapter.store({
        documents: [{ id: 'b', content: 'y', vector: [0.1, 0.2, 0.3, 0.4] }],
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('dimension-mismatch');
      expect((err as RagError).message).toContain("collection 'kb'");
      expect((err as RagError).message).toContain('vector(3)');
      expect((err as RagError).message).toContain('4-dim');
      expect((err as RagError).message).toContain("embedder 'nomic-embed'");
    }
  });

  test('dimension mismatch without an embedderLabel still throws the typed error', async () => {
    const mock = createMockSql();
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'kb',
    });
    await adapter.store({
      documents: [{ id: 'a', content: 'x', vector: [0.1, 0.2] }],
    });
    try {
      await adapter.store({
        documents: [{ id: 'b', content: 'y', vector: [0.1, 0.2, 0.3] }],
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('dimension-mismatch');
      expect((err as RagError).message).toContain('the configured embedder');
    }
  });

  test('bootstrap failure lets a later store() retry', async () => {
    const mock = createMockSql();
    // Queue an error on the first call (CREATE EXTENSION), then
    // rows for everything else.
    queueError(
      mock,
      Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' }),
    );
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'kb',
    });
    await expect(
      adapter.store({
        documents: [{ id: 'a', content: 'x', vector: [0.1, 0.2] }],
      }),
    ).rejects.toBeInstanceOf(RagError);
    // Retry — no queued error this time; bootstrap runs fresh.
    await adapter.store({
      documents: [{ id: 'a', content: 'x', vector: [0.1, 0.2] }],
    });
    const counts = countBootstrapCalls(mock);
    // CREATE EXTENSION ran twice (initial fail + retry); CREATE TABLE
    // only runs on the successful path (after extension succeeds).
    expect(counts.extension).toBe(2);
    expect(counts.createTable).toBe(1);
  });
});

describe('PgvectorRagAdapter.delete', () => {
  test('returns the DB-reported row count', async () => {
    const mock = createMockSql();
    queueRows(mock, [], 3);
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'knowledge',
    });
    const res = await adapter.delete({ ids: ['a', 'b', 'c', 'd'] });
    expect(res.deleted).toBe(3);
    expect(res.collection).toBe('knowledge');
  });

  test('surfaces SQL errors as tool-error', async () => {
    const mock = createMockSql();
    queueError(
      mock,
      Object.assign(new Error('syntax error near ANY'), { code: '42601' }),
    );
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'knowledge',
    });
    try {
      await adapter.delete({ ids: ['a'] });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('tool-error');
    }
  });
});

describe('PgvectorRagAdapter.listCollections', () => {
  test('returns the table names information_schema reports', async () => {
    const mock = createMockSql();
    queueRows(mock, [{ name: 'docs' }, { name: 'notebooks' }]);
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'docs',
    });
    const res = await adapter.listCollections();
    expect(res.collections).toEqual([{ name: 'docs' }, { name: 'notebooks' }]);
  });

  test('returns empty list when no vector columns exist', async () => {
    const mock = createMockSql();
    queueRows(mock, []);
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'docs',
    });
    const res = await adapter.listCollections();
    expect(res.collections).toEqual([]);
  });
});

describe('PgvectorRagAdapter.close', () => {
  test('calls sql.end with a 5s timeout', async () => {
    const mock = createMockSql();
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'docs',
    });
    await adapter.close();
    expect(mock.endCalled).toBe(true);
    expect(mock.endOptions).toEqual({ timeout: 5 });
  });
});

describe('extractQueryVector', () => {
  test('pulls a number[] out of filter.vector', () => {
    expect(
      extractQueryVector({ query: 'q', topK: 5, filter: { vector: [1, 2, 3] } }),
    ).toEqual([1, 2, 3]);
  });
  test('rejects non-array values', () => {
    expect(
      extractQueryVector({
        query: 'q',
        topK: 5,
        filter: { vector: 'not-an-array' as unknown as number[] },
      }),
    ).toBeNull();
  });
  test('rejects arrays containing non-finite numbers', () => {
    expect(
      extractQueryVector({ query: 'q', topK: 5, filter: { vector: [1, Number.NaN, 3] } }),
    ).toBeNull();
  });
});

describe('redactPostgresUrl', () => {
  test('strips the password and keeps host:port/db', () => {
    const redacted = redactPostgresUrl('postgres://kb_user:hunter2@db.local:5432/kb_main');
    expect(redacted).toBe('db.local:5432/kb_main');
    expect(redacted).not.toContain('hunter2');
  });
  test('falls back to a generic label when the URL is unparseable', () => {
    expect(redactPostgresUrl('::not-a-url::')).toContain('redacted');
  });
});

describe('connectPgvector error surfaces', () => {
  test('surfaces connect-failed with redacted label when tokenRef is missing', () => {
    try {
      connectPgvector(
        {
          provider: 'pgvector',
          endpoint: 'postgres://u@db.local:5432/kb',
          auth: { tokenRef: '/nonexistent/path-we-hope-never-exists.txt' },
          extraArgs: [],
        },
        {},
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('connect-failed');
      // Message must not leak the absent password (there is none) but
      // also must not leak the whole URL with credentials.
      expect((err as RagError).message).not.toContain('u@db.local');
    }
  });
});

describe('createPgvectorAdapter', () => {
  test('rejects non-pgvector bindings', async () => {
    try {
      await createPgvectorAdapter(
        {
          provider: 'chroma',
          endpoint: 'chroma-mcp run',
          extraArgs: [],
        },
        {},
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('invalid-request');
    }
  });
});
