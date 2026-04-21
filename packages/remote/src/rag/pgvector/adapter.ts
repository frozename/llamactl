import type postgres from 'postgres';
import type {
  DeleteRequest,
  DeleteResponse,
  Document,
  ListCollectionsResponse,
  RetrievalProvider,
  SearchRequest,
  SearchResponse,
  StoreRequest,
  StoreResponse,
} from '@nova/contracts';
import { RagError } from '../errors.js';
import type { Embedder } from '../embedding.js';

/**
 * Native pgvector adapter. Talks directly to Postgres over SQL via the
 * `postgres` (postgres.js) tagged-template API — table/column names go
 * through `sql(identifier)` so they can't be injected, and values
 * interpolate as bound parameters. Unlike Chroma, pgvector doesn't
 * embed: callers must supply vectors (`req.filter.vector` on search,
 * `doc.vector` on store). The `embed()` method is deliberately omitted
 * from this implementation.
 */

const DEFAULT_TABLE = 'documents';

/**
 * Shape of a row the adapter returns from a search query. Kept as a
 * type so the test harness's canned rows are type-checked against it.
 */
interface SearchRow {
  id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  score: number;
  distance: number;
}

/** Row for `listCollections()` — information_schema lookup. */
interface CollectionRow {
  name: string;
}

interface PgvectorAdapterOptions {
  sql: postgres.Sql;
  defaultCollection?: string;
  /** Safe label (host:port/db) used in error messages; never the raw URL. */
  safeLabel?: string;
  /**
   * Optional delegated embedder. When set, the adapter auto-embeds:
   *   - `store` docs that arrive without a pre-computed `vector`.
   *   - `search` queries that arrive without `filter.vector`.
   * When unset, the adapter falls back to its v1 strict behavior —
   * caller-supplied vectors only, missing vector → invalid-request.
   */
  embedder?: Embedder;
  /**
   * Human-readable label for the embedder — used only in error
   * messages (e.g. dimension-mismatch) to point operators at the
   * binding responsible. The factory populates this from
   * `binding.embedder.node` when a binding was threaded through.
   */
  embedderLabel?: string;
}

/**
 * Format a numeric array as a pgvector literal so it can interpolate
 * into `::vector` casts. Explicit because postgres.js doesn't know
 * about pgvector's on-the-wire format and would otherwise pass the
 * array as a Postgres `float[]`, which doesn't cast implicitly.
 */
function vectorLiteral(v: readonly number[]): string {
  // pgvector accepts `'[0.1,0.2,…]'` — spaces are tolerated; leave them
  // out to keep the payload compact.
  return `[${v.join(',')}]`;
}

/**
 * Map postgres.js / node errors into `RagError`. Connection failures
 * (ECONNREFUSED, ENOTFOUND, auth) surface as `connect-failed`; the
 * well-known pgvector/missing-table codes become `tool-missing`; any
 * other SQL error is a generic `tool-error`.
 */
function wrapDbError(err: unknown, safeLabel: string | undefined): RagError {
  if (err instanceof RagError) return err;
  // postgres.js throws its own PostgresError; node networking errors
  // surface as Error with `.code`.
  const e = err as { code?: string; errno?: string; name?: string } | undefined;
  const code = e?.code;
  const label = safeLabel ?? 'pgvector';
  if (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === '28P01' /* invalid_password */ ||
    code === '28000' /* invalid_authorization_specification */ ||
    code === '3D000' /* invalid_catalog_name (db missing) */
  ) {
    return new RagError(
      'connect-failed',
      `pgvector: could not connect to ${label}`,
      err,
    );
  }
  if (
    code === '42P01' /* undefined_table */ ||
    code === '42703' /* undefined_column */ ||
    code === '42704' /* undefined_object — vector type missing */
  ) {
    return new RagError(
      'tool-missing',
      `pgvector: table or column missing at ${label}`,
      err,
    );
  }
  return new RagError(
    'tool-error',
    `pgvector: SQL error at ${label}`,
    err,
  );
}

export class PgvectorRagAdapter implements RetrievalProvider {
  readonly kind = 'pgvector';
  private readonly sql: postgres.Sql;
  private readonly defaultCollection: string;
  private readonly safeLabel: string | undefined;
  private readonly embedder: Embedder | undefined;
  private readonly embedderLabel: string | undefined;
  /**
   * Memoized `CREATE EXTENSION IF NOT EXISTS vector` — we only want
   * to issue it once per adapter lifetime even when N concurrent
   * stores race to be the first writer. Storing the promise (not a
   * bool) lets concurrent callers await the same in-flight statement.
   */
  private extensionEnsured: Promise<void> | null = null;
  /**
   * Collection → established embedding dimension. Populated the first
   * time a store() succeeds (or a CREATE TABLE IF NOT EXISTS runs)
   * for each table. Subsequent stores check incoming vector length
   * against this map and surface `dimension-mismatch` if the caller
   * swapped embedders.
   */
  private readonly schemaReady = new Map<string, number>();

  constructor(opts: PgvectorAdapterOptions) {
    this.sql = opts.sql;
    this.defaultCollection = opts.defaultCollection ?? DEFAULT_TABLE;
    this.safeLabel = opts.safeLabel;
    this.embedder = opts.embedder;
    this.embedderLabel = opts.embedderLabel;
  }

  async search(req: SearchRequest): Promise<SearchResponse> {
    const collection = req.collection ?? this.defaultCollection;
    let vector = extractQueryVector(req);
    if (!vector && this.embedder) {
      // Delegated embedding: embed the free-text `query` so operators
      // don't have to pre-compute vectors for search either.
      const [embedded] = await this.embedder([req.query]);
      if (!embedded) {
        throw new RagError(
          'invalid-response',
          'pgvector search: embedder returned no vector for the query',
        );
      }
      vector = embedded;
    }
    if (!vector) {
      throw new RagError(
        'invalid-request',
        'pgvector search requires a pre-computed query vector via filter.vector (number[]) or an embedder on the rag binding',
      );
    }
    const literal = vectorLiteral(vector);
    const topK = req.topK ?? 10;

    let rows: readonly SearchRow[];
    try {
      rows = await this.sql<SearchRow[]>`
        SELECT id, content, metadata,
               1 - (embedding <=> ${literal}::vector) AS score,
               (embedding <=> ${literal}::vector) AS distance
        FROM ${this.sql(collection)}
        ORDER BY embedding <=> ${literal}::vector
        LIMIT ${topK}
      `;
    } catch (err) {
      // Operator-friendly: a search against a collection nothing has
      // stored into yet returns an empty result instead of the raw
      // Postgres 42P01. The bootstrap path (CREATE TABLE on first
      // write) means there's a legitimate window where the caller
      // probes before any store() has run; don't make them handle
      // a distinct error code for that. Any other SQL error (bad
      // vector dim, connection loss, missing `vector` extension on
      // the column cast) still surfaces through wrapDbError.
      if (isUndefinedTable(err)) {
        return { collection, results: [] };
      }
      throw wrapDbError(err, this.safeLabel);
    }

    return {
      collection,
      results: rows.map((r) => ({
        document: {
          id: r.id,
          content: r.content,
          ...(r.metadata ? { metadata: r.metadata } : {}),
        },
        score: r.score,
        distance: r.distance,
      })),
    };
  }

  async store(req: StoreRequest): Promise<StoreResponse> {
    const collection = req.collection ?? this.defaultCollection;

    // Empty docs: short-circuit to a no-op response. Skipping the
    // bootstrap for a zero-doc call means we don't probe a dimension
    // we don't have, and callers that conditionally batch can pass
    // through an empty array without tripping a DB round-trip.
    if (req.documents.length === 0) {
      return { ids: [], collection };
    }

    // Delegated embedding: for docs arriving without a vector, ask
    // the configured embedder to compute one. We batch all missing
    // ones into a single embed call so the provider only eats one
    // round-trip per store() regardless of how many docs are missing.
    const docsWithVectors = await this.ensureDocumentVectors(req.documents);

    // Probe the embedding dimension from the first resolved vector.
    // All docs in a single store() are assumed to share a dim (they
    // come from one embedder batch or one caller's vectorization);
    // the ensureSchemaForStore cache below guarantees cross-call
    // consistency per collection.
    const firstVector = docsWithVectors[0]?.vector;
    if (!firstVector || firstVector.length === 0) {
      throw new RagError(
        'invalid-request',
        `pgvector store: resolved vector has zero length for collection '${collection}'`,
      );
    }
    await this.ensureSchemaForStore(collection, firstVector.length);

    // JSON-encode metadata so postgres.js routes it into the `jsonb`
    // column as a string literal the server casts. Sidesteps the
    // library's `ParameterOrJSON` typing (which rejects arbitrary
    // `Record<string, unknown>`) while staying safe against injection
    // — values go through `${…}` placeholders either way.
    const values = docsWithVectors.map((d) => ({
      id: d.id,
      content: d.content,
      metadata: d.metadata ? JSON.stringify(d.metadata) : null,
      embedding: vectorLiteral(d.vector),
    }));

    try {
      // Parametrized upsert — postgres.js's helper expands the array
      // into a VALUES clause with typed placeholders.
      await this.sql`
        INSERT INTO ${this.sql(collection)} ${this.sql(values, 'id', 'content', 'metadata', 'embedding')}
        ON CONFLICT (id) DO UPDATE
        SET content = EXCLUDED.content,
            metadata = EXCLUDED.metadata,
            embedding = EXCLUDED.embedding
      `;
    } catch (err) {
      throw wrapDbError(err, this.safeLabel);
    }

    return {
      ids: req.documents.map((d) => d.id),
      collection,
    };
  }

  async delete(req: DeleteRequest): Promise<DeleteResponse> {
    const collection = req.collection ?? this.defaultCollection;
    let result: { count: number };
    try {
      // postgres.js exposes `.count` on the result object for DELETE /
      // UPDATE statements — authoritative row count from the server.
      const res = await this.sql`
        DELETE FROM ${this.sql(collection)}
        WHERE id = ANY(${req.ids as string[]})
      `;
      result = { count: res.count };
    } catch (err) {
      throw wrapDbError(err, this.safeLabel);
    }
    return { deleted: result.count, collection };
  }

  async listCollections(): Promise<ListCollectionsResponse> {
    let rows: readonly CollectionRow[];
    try {
      rows = await this.sql<CollectionRow[]>`
        SELECT table_name AS name
        FROM information_schema.columns
        WHERE column_name = 'embedding'
          AND udt_name = 'vector'
          AND table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY table_name
      `;
    } catch (err) {
      throw wrapDbError(err, this.safeLabel);
    }
    // `count` + `dimensions` left unpopulated in v1 — pulling them
    // requires a per-table SELECT COUNT(*) + vector dim inspection that
    // wouldn't scale on large instances. Follow-up slice.
    return {
      collections: rows.map((r) => ({ name: r.name })),
    };
  }

  async close(): Promise<void> {
    try {
      await this.sql.end({ timeout: 5 });
    } catch {
      // end() always resolves; ignore teardown errors.
    }
  }

  /**
   * Idempotent schema bootstrap for a given collection. Runs
   * `CREATE EXTENSION IF NOT EXISTS vector;` (once per adapter
   * lifetime) plus `CREATE TABLE IF NOT EXISTS <collection> (...)` on
   * the caller's first write to that collection. Subsequent calls are
   * a single Map lookup + dim-equality check.
   *
   * Dimension mismatch semantics: if a caller stored 768-dim vectors
   * earlier and now arrives with 1536-dim vectors, we surface
   * `dimension-mismatch` before issuing the INSERT so the INSERT's
   * pgvector cast doesn't explode with a cryptic
   * `expected N dimensions, not M` from the server. We do NOT
   * auto-migrate — reshaping an existing column is a destructive op
   * that belongs in an explicit operator workflow.
   */
  private async ensureSchemaForStore(
    collection: string,
    dim: number,
  ): Promise<void> {
    const known = this.schemaReady.get(collection);
    if (known !== undefined) {
      if (known !== dim) {
        const label = this.embedderLabel
          ? `embedder '${this.embedderLabel}'`
          : 'the configured embedder';
        throw new RagError(
          'dimension-mismatch',
          `pgvector store: collection '${collection}' was created with vector(${known}) but received a ${dim}-dim vector from ${label}. ` +
            `Rebind the rag node to an embedder whose dimension matches, or drop and recreate the collection.`,
        );
      }
      return;
    }

    // First write against this collection: ensure the extension and
    // the table exist. Both are idempotent; concurrent adapters racing
    // the same CREATE TABLE IF NOT EXISTS is safe.
    if (!this.extensionEnsured) {
      this.extensionEnsured = this.runCreateExtension();
    }
    try {
      await this.extensionEnsured;
    } catch (err) {
      // Don't let a connection-time extension failure poison the
      // cache — null it so a later call can retry once the DB is
      // reachable.
      this.extensionEnsured = null;
      throw wrapDbError(err, this.safeLabel);
    }

    // Dim is probed from a Number[] length — must be a positive
    // integer. Defensive: reject anything else before baking it into
    // the SQL (we're about to cross the tagged-template boundary
    // where the value lands inside `vector(N)` as a raw fragment).
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new RagError(
        'invalid-request',
        `pgvector store: refusing to create collection '${collection}' with non-positive-integer dim ${dim}`,
      );
    }

    try {
      // Both pieces flow through postgres.js fragment interpolation
      // so neither is parametrized:
      //   - the collection name uses `sql(ident)` for quoted-ident
      //     escaping;
      //   - the vector dim uses `sql.unsafe(String(dim))` to land as
      //     a literal integer inside `vector(N)` — the type
      //     constructor needs a compile-time literal, not a `$1`
      //     bind parameter, so parametrization would be a syntax
      //     error here. The input is a validated positive integer,
      //     so the unsafe fragment is truly safe.
      await this.sql`
        CREATE TABLE IF NOT EXISTS ${this.sql(collection)} (
          id text PRIMARY KEY,
          content text,
          metadata jsonb,
          embedding vector(${this.sql.unsafe(String(dim))})
        )
      `;
    } catch (err) {
      throw wrapDbError(err, this.safeLabel);
    }

    this.schemaReady.set(collection, dim);
  }

  private async runCreateExtension(): Promise<void> {
    await this.sql`CREATE EXTENSION IF NOT EXISTS vector`;
  }

  /**
   * Fill missing `vector` fields on incoming documents by batching a
   * single embedder call. Caller-supplied vectors are passed through
   * unchanged. Without an embedder, missing vectors surface as
   * `invalid-request` same as the v1 strict behavior.
   */
  private async ensureDocumentVectors(
    documents: readonly Document[],
  ): Promise<Array<{ id: string; content: string; metadata?: Record<string, unknown>; vector: number[] }>> {
    const missingIdx: number[] = [];
    for (let i = 0; i < documents.length; i++) {
      const d = documents[i]!;
      if (!d.vector || d.vector.length === 0) missingIdx.push(i);
    }
    if (missingIdx.length > 0 && !this.embedder) {
      const firstMissing = documents[missingIdx[0]!]!;
      throw new RagError(
        'invalid-request',
        `pgvector store requires doc.vector on every document (missing on id=${firstMissing.id}) — configure a rag.embedder to auto-compute`,
      );
    }

    let computed: number[][] = [];
    if (missingIdx.length > 0 && this.embedder) {
      const texts = missingIdx.map((i) => documents[i]!.content);
      computed = await this.embedder(texts);
      if (computed.length !== missingIdx.length) {
        throw new RagError(
          'invalid-response',
          `embedder returned ${computed.length} vectors for ${missingIdx.length} docs`,
        );
      }
    }

    return documents.map((d, i) => {
      const supplied = d.vector && d.vector.length > 0 ? (d.vector as number[]) : null;
      const computedIdx = missingIdx.indexOf(i);
      const vector = supplied ?? (computedIdx >= 0 ? computed[computedIdx]! : null);
      if (!vector) {
        // Unreachable — if we reach here, the earlier check should
        // have thrown. Defensive.
        throw new RagError(
          'invalid-request',
          `pgvector store: no vector resolved for doc id=${d.id}`,
        );
      }
      return {
        id: d.id,
        content: d.content,
        ...(d.metadata !== undefined && { metadata: d.metadata }),
        vector,
      };
    });
  }
}

/**
 * Pulls the query vector out of `req.filter.vector`, validating its
 * shape. Exposed for reuse (and tested directly).
 */
export function extractQueryVector(req: SearchRequest): number[] | null {
  const f = req.filter;
  if (!f) return null;
  const v = (f as { vector?: unknown }).vector;
  if (!Array.isArray(v) || v.length === 0) return null;
  if (!v.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return v as number[];
}

/**
 * Narrow check for the Postgres "undefined_table" code used by the
 * search() path to turn a missing-table error into an empty-results
 * response. Kept local (rather than extending wrapDbError) because
 * the search path specifically wants to distinguish this one code
 * from the broader `tool-missing` bucket wrapDbError maps it into.
 */
function isUndefinedTable(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    return (err as { code?: string }).code === '42P01';
  }
  return false;
}
