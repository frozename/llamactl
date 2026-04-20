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

  test('maps missing-table Postgres error to tool-missing', async () => {
    const mock = createMockSql();
    queueError(mock, Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    const adapter = new PgvectorRagAdapter({
      sql: mock.fn,
      defaultCollection: 'knowledge',
    });
    try {
      await adapter.search({
        query: 'whatever',
        topK: 5,
        filter: { vector: [0.1, 0.2] },
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('tool-missing');
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
    // Two helper calls (collection identifier + values helper) and one
    // tagged-template call for the INSERT.
    const helperCalls = mock.calls.filter((c) => c.helper);
    expect(helperCalls).toHaveLength(2);
    // values helper receives the prepared rows shape.
    const valuesHelper = helperCalls[1]!.helper!;
    expect(Array.isArray(valuesHelper.first)).toBe(true);
    expect(valuesHelper.rest).toEqual(['id', 'content', 'metadata', 'embedding']);
    const rows = valuesHelper.first as Array<{ id: string; embedding: string }>;
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
