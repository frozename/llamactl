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

  constructor(opts: PgvectorAdapterOptions) {
    this.sql = opts.sql;
    this.defaultCollection = opts.defaultCollection ?? DEFAULT_TABLE;
    this.safeLabel = opts.safeLabel;
    this.embedder = opts.embedder;
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

    // Delegated embedding: for docs arriving without a vector, ask
    // the configured embedder to compute one. We batch all missing
    // ones into a single embed call so the provider only eats one
    // round-trip per store() regardless of how many docs are missing.
    const docsWithVectors = await this.ensureDocumentVectors(req.documents);

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
