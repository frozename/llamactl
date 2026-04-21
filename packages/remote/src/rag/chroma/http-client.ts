import type { RagBinding } from '../../config/schema.js';
import { resolveSecret } from '../../config/secret.js';
import { RagError } from '../errors.js';

/**
 * HTTP client for Chroma's REST v2 surface. Paired with
 * `HttpChromaRagBackend`; the adapter never talks to this module
 * directly. Keeps raw `fetch` wrangling + chroma's tenant/database
 * path layout out of the adapter so error translation lives in one
 * place.
 *
 * Targets the v2 surface shipped with `chromadb/chroma:1.5.8`. The
 * routes verified against a running image on 2026-04-21:
 *
 *   GET    /api/v2/heartbeat
 *   GET    /api/v2/tenants/{tenant}/databases/{db}/collections
 *   POST   /api/v2/tenants/{tenant}/databases/{db}/collections          (create w/ get_or_create)
 *   POST   /api/v2/tenants/{tenant}/databases/{db}/collections/{id}/upsert
 *   POST   /api/v2/tenants/{tenant}/databases/{db}/collections/{id}/query
 *   POST   /api/v2/tenants/{tenant}/databases/{db}/collections/{id}/delete
 *
 * The sub-routes (`upsert`, `query`, `delete`) require a UUID — they
 * reject a name with 400 `InvalidArgumentError`. We resolve a name →
 * UUID via `create_collection` with `get_or_create: true` and cache
 * the result for the lifetime of the client.
 */

export const CHROMA_DEFAULT_TENANT = 'default_tenant';
export const CHROMA_DEFAULT_DATABASE = 'default_database';

/**
 * Shape of the `POST /collections` response. Only `id` + `name` are
 * load-bearing for the adapter; the rest passes through and is
 * exposed on `listCollections()` when operators want more detail.
 */
export interface ChromaCollection {
  id: string;
  name: string;
  dimension?: number | null;
  metadata?: Record<string, unknown> | null;
  tenant?: string;
  database?: string;
}

export interface ChromaQueryPayload {
  query_embeddings: number[][];
  n_results?: number;
  where?: Record<string, unknown>;
  where_document?: Record<string, unknown>;
  include?: Array<'distances' | 'documents' | 'embeddings' | 'metadatas' | 'uris'>;
}

/**
 * Response shape from `POST /query`. All outer arrays are indexed by
 * query number — we only ever send one query, so the adapter reads
 * `[0]`.
 */
export interface ChromaQueryResponse {
  ids: string[][];
  distances?: Array<Array<number | null>> | null;
  documents?: Array<Array<string | null>> | null;
  metadatas?: Array<Array<Record<string, unknown> | null>> | null;
  include?: string[];
}

export interface ChromaUpsertPayload {
  ids: string[];
  embeddings: number[][];
  documents?: Array<string | null>;
  metadatas?: Array<Record<string, unknown> | null>;
}

export interface ChromaDeletePayload {
  ids?: string[];
  where?: Record<string, unknown>;
  where_document?: Record<string, unknown>;
}

export interface HttpChromaClientOptions {
  baseUrl: string;
  tenant?: string;
  database?: string;
  /**
   * Optional bearer token injected into every request as
   * `Authorization: Bearer <token>`. Chroma 1.5 supports token-based
   * auth behind an nginx/envoy proxy; setting `auth.token{Env,Ref}`
   * on the binding flows through here.
   */
  token?: string;
  /** Injected for tests — defaults to the global fetch. */
  fetch?: typeof fetch;
}

/**
 * Parse the binding endpoint into a normalized HTTP base URL. Accepts
 * `http://host:8000`, `http://host:8000/`, `http://host:8000/api/v2`
 * — anything with an `/api/v2` suffix has it stripped so callers can
 * paste either shape without the client tacking on a duplicate prefix.
 */
export function parseHttpChromaEndpoint(binding: Pick<RagBinding, 'endpoint'>): string {
  const trimmed = binding.endpoint.trim();
  if (trimmed.length === 0) {
    throw new RagError(
      'connect-failed',
      'chroma RAG binding has an empty endpoint; expected http(s)://host:port',
    );
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (cause) {
    throw new RagError(
      'connect-failed',
      `chroma RAG binding endpoint is not a valid URL: ${trimmed}`,
      cause,
    );
  }
  // Strip any trailing `/` and `/api/v2` suffix so we can splice
  // `/api/v2/tenants/...` cleanly in each request builder.
  let pathname = url.pathname.replace(/\/+$/, '');
  if (pathname === '/api/v2') pathname = '';
  url.pathname = pathname;
  return url.toString().replace(/\/+$/, '');
}

/**
 * Resolve the HTTP auth token from a RAG binding, mirroring the
 * pgvector client. `tokenEnv` wins over `tokenRef` when both are set
 * (legacy shape first). Returns `undefined` when neither is provided
 * — anonymous access stays the default because chroma 1.5.8 ships
 * without auth by default.
 */
export function resolveChromaHttpToken(
  binding: Pick<RagBinding, 'auth'>,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const auth = binding.auth;
  if (!auth) return undefined;
  if (auth.tokenEnv) {
    const v = env[auth.tokenEnv];
    if (v && v.length > 0) return v;
  }
  if (auth.tokenRef) {
    try {
      return resolveSecret(auth.tokenRef, env);
    } catch (cause) {
      throw new RagError(
        'connect-failed',
        `chroma: unable to resolve auth.tokenRef (${auth.tokenRef})`,
        cause,
      );
    }
  }
  return undefined;
}

/**
 * Map a fetch / HTTP response status into a `RagError` code. 4xx
 * surfaces as `tool-error` (caller did something wrong — bad
 * collection, bad payload); 5xx surfaces as `connect-failed` (the
 * backend itself is sick). `404` on the collection-id routes is the
 * classic "renamed collection underneath us" case; we lift it to
 * `tool-missing` so callers can differentiate.
 */
function statusToCode(status: number): 'tool-missing' | 'tool-error' | 'connect-failed' {
  if (status === 404) return 'tool-missing';
  if (status >= 400 && status < 500) return 'tool-error';
  return 'connect-failed';
}

/**
 * Thin HTTP client over chroma v2. Stateful only in that it caches
 * `collection_name → collection_id` after the first create-or-get —
 * chroma's data routes require a UUID, so resolving the id on every
 * call would double the request count for a typical `store` / `search`.
 */
export class HttpChromaClient {
  readonly baseUrl: string;
  readonly tenant: string;
  readonly database: string;
  private readonly token?: string;
  private readonly fetcher: typeof fetch;
  private readonly collectionIds = new Map<string, string>();

  constructor(opts: HttpChromaClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.tenant = opts.tenant ?? CHROMA_DEFAULT_TENANT;
    this.database = opts.database ?? CHROMA_DEFAULT_DATABASE;
    if (opts.token !== undefined) this.token = opts.token;
    this.fetcher = opts.fetch ?? fetch;
  }

  /**
   * Sanity-ping the backend. `createChromaAdapter` calls this before
   * handing the adapter to the caller so operator-facing errors
   * (wrong URL, container not listening) surface at connection time
   * rather than on the first `store()` call.
   */
  async heartbeat(): Promise<void> {
    const url = `${this.baseUrl}/api/v2/heartbeat`;
    let res: Response;
    try {
      res = await this.fetcher(url, { headers: this.headers() });
    } catch (cause) {
      throw new RagError(
        'connect-failed',
        `chroma http: heartbeat against ${this.baseUrl} failed: ${toMessage(cause)}`,
        cause,
      );
    }
    if (!res.ok) {
      throw new RagError(
        statusToCode(res.status),
        `chroma http: heartbeat returned ${res.status} at ${this.baseUrl}`,
      );
    }
  }

  /**
   * Resolve a collection *name* to its UUID `id`, creating the
   * collection if it doesn't exist (`get_or_create: true`). Chroma's
   * data routes (`/upsert`, `/query`, `/delete`) require a UUID —
   * using a name yields 400 `InvalidArgumentError`. We cache so
   * subsequent calls for the same name hit chroma only once per
   * client lifetime.
   *
   * `metadata` is only honored on *creation*. If the collection
   * already exists, the metadata returned by chroma wins (chroma's
   * `get_or_create` semantics — it ignores the provided metadata
   * when the name is already taken).
   */
  async resolveCollectionId(
    name: string,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    const cached = this.collectionIds.get(name);
    if (cached) return cached;
    const collection = await this.createCollection(name, { getOrCreate: true, ...(metadata && { metadata }) });
    this.collectionIds.set(name, collection.id);
    return collection.id;
  }

  /**
   * `POST /collections` — creates a collection or returns the
   * existing one when `getOrCreate` is `true`. Returned `id` is a
   * UUID the adapter uses for data routes.
   */
  async createCollection(
    name: string,
    opts: {
      getOrCreate?: boolean;
      metadata?: Record<string, unknown>;
      configuration?: Record<string, unknown>;
    } = {},
  ): Promise<ChromaCollection> {
    const path = `/api/v2/tenants/${encodeURIComponent(this.tenant)}/databases/${encodeURIComponent(this.database)}/collections`;
    const body: Record<string, unknown> = { name };
    if (opts.getOrCreate) body.get_or_create = true;
    if (opts.metadata) body.metadata = opts.metadata;
    if (opts.configuration) body.configuration = opts.configuration;
    return (await this.json<ChromaCollection>('POST', path, body)) as ChromaCollection;
  }

  /** `GET /collections` — list collection names in the current
   *  tenant/database. Returns the raw `ChromaCollection[]`; the
   *  adapter normalizes to `CollectionInfo[]`. */
  async listCollections(
    opts: { limit?: number; offset?: number } = {},
  ): Promise<ChromaCollection[]> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.offset !== undefined) params.set('offset', String(opts.offset));
    const qs = params.toString() ? `?${params.toString()}` : '';
    const path = `/api/v2/tenants/${encodeURIComponent(this.tenant)}/databases/${encodeURIComponent(this.database)}/collections${qs}`;
    const payload = await this.json<ChromaCollection[]>('GET', path);
    if (!Array.isArray(payload)) {
      throw new RagError(
        'invalid-response',
        `chroma http: listCollections returned non-array payload (got ${typeof payload})`,
      );
    }
    return payload;
  }

  async upsert(collectionId: string, payload: ChromaUpsertPayload): Promise<void> {
    const path = `/api/v2/tenants/${encodeURIComponent(this.tenant)}/databases/${encodeURIComponent(this.database)}/collections/${encodeURIComponent(collectionId)}/upsert`;
    await this.json<unknown>('POST', path, payload);
  }

  async query(collectionId: string, payload: ChromaQueryPayload): Promise<ChromaQueryResponse> {
    const path = `/api/v2/tenants/${encodeURIComponent(this.tenant)}/databases/${encodeURIComponent(this.database)}/collections/${encodeURIComponent(collectionId)}/query`;
    return (await this.json<ChromaQueryResponse>('POST', path, payload)) as ChromaQueryResponse;
  }

  async deleteRecords(collectionId: string, payload: ChromaDeletePayload): Promise<number> {
    const path = `/api/v2/tenants/${encodeURIComponent(this.tenant)}/databases/${encodeURIComponent(this.database)}/collections/${encodeURIComponent(collectionId)}/delete`;
    const res = await this.json<{ deleted?: number } | Record<string, unknown>>('POST', path, payload);
    // Chroma returns `{deleted: N}` on success, but older 1.x builds
    // returned `{}` — tolerate both. The adapter falls back to the
    // request-side `ids.length` when `deleted` is absent.
    const d = (res as { deleted?: unknown }).deleted;
    return typeof d === 'number' ? d : -1;
  }

  /** No-op close — fetch doesn't hold a connection we own. Exposed
   *  so the adapter can treat stdio / HTTP backends uniformly. */
  async close(): Promise<void> {
    this.collectionIds.clear();
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers['authorization'] = `Bearer ${this.token}`;
    return headers;
  }

  /**
   * One-line request helper. Translates non-OK responses into
   * typed `RagError`s; parses the error envelope when chroma
   * returns one (`{error, message}`) so operators see the real
   * failure text rather than a generic status line.
   */
  private async json<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    const init: RequestInit = {
      method,
      headers: this.headers(),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    try {
      res = await this.fetcher(url, init);
    } catch (cause) {
      throw new RagError(
        'connect-failed',
        `chroma http: ${method} ${path} failed before response: ${toMessage(cause)}`,
        cause,
      );
    }
    if (!res.ok) {
      const snippet = await safeErrorSnippet(res);
      throw new RagError(
        statusToCode(res.status),
        `chroma http: ${method} ${path} → ${res.status}${snippet ? `: ${snippet}` : ''}`,
      );
    }
    // Empty 2xx (some chroma responses are `{}` — upsert, delete) are
    // valid. Parse leniently.
    const text = await res.text();
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new RagError(
        'invalid-response',
        `chroma http: ${method} ${path} returned non-JSON body (${text.slice(0, 80)})`,
        cause,
      );
    }
  }
}

async function safeErrorSnippet(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return '';
    // Chroma's error envelope: `{"error":"ChromaError","message":"..."}`.
    try {
      const obj = JSON.parse(text) as { error?: string; message?: string };
      if (obj.message) return obj.error ? `${obj.error}: ${obj.message}` : obj.message;
    } catch {
      // fallthrough — use the raw text
    }
    return text.slice(0, 200);
  } catch {
    return '';
  }
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
