import type {
  CollectionInfo,
  DeleteRequest,
  DeleteResponse,
  Document,
  ListCollectionsResponse,
  RetrievalProvider,
  SearchRequest,
  SearchResponse,
  SearchResult,
  StoreRequest,
  StoreResponse,
} from '@nova/contracts';
import type { RagBinding } from '../../config/schema.js';
import type { Embedder } from '../embedding.js';
import { RagError } from '../errors.js';
import type { ChromaMcpClient, ChromaToolResult } from './client.js';
import type { HttpChromaClient } from './http-client.js';

/**
 * Proxies the `RetrievalProvider` surface onto a chroma backend —
 * either the stdio chroma-mcp subprocess (legacy / local-dev) or
 * chroma's native HTTP REST v2 API (the containerized path).
 * Backend selection happens at construction time; callers never mix
 * modes on the same adapter instance.
 *
 * MCP tool shapes verified against
 * https://github.com/chroma-core/chroma-mcp (src/chroma_mcp/server.py
 * on 2026-04-20):
 *   - chroma_query_documents(collection_name, query_texts, n_results,
 *     where, where_document, include) → {ids, distances, documents,
 *     metadatas} nested one level per query text.
 *   - chroma_add_documents(collection_name, documents, ids, metadatas)
 *     → confirmation string.
 *   - chroma_delete_documents(collection_name, ids) → confirmation.
 *   - chroma_list_collections(limit, offset) → array of names, or a
 *     single-element sentinel `["__NO_COLLECTIONS_FOUND__"]` when
 *     empty.
 *
 * HTTP routes verified against `chromadb/chroma:1.5.8` on 2026-04-21;
 * see `http-client.ts` for the exact paths.
 *
 * Score normalization: chroma returns raw distance in `distances[][]`
 * (cosine or L2 depending on collection config; default is L2). We
 * surface `distance` verbatim and compute `score = clamp(1 - distance,
 * 0, 1)` so callers get a comparable similarity score regardless of
 * the collection's index metric. The clamp guards against L2
 * distances >1 and numeric noise.
 *
 * `embed()` is intentionally omitted. Chroma embeds internally during
 * MCP `chroma_add_documents` (when a collection has an embedding
 * function) and can delegate to the caller-provided embedder on the
 * HTTP path. `RetrievalProvider.embed` is optional, so leaving it off
 * is the contract-honest signal that this adapter doesn't stand up a
 * dedicated embedding endpoint.
 */

const TOOL_QUERY = 'chroma_query_documents';
const TOOL_ADD = 'chroma_add_documents';
const TOOL_DELETE = 'chroma_delete_documents';
const TOOL_LIST = 'chroma_list_collections';
const CHROMA_EMPTY_SENTINEL = '__NO_COLLECTIONS_FOUND__';
const DEFAULT_COLLECTION = 'default_collection';

interface ChromaQueryResponse {
  // All fields are [nQueries][nResults]. We only ever send one query,
  // so the adapter reads index [0]. `ids` is always present; the rest
  // follow what the caller passed in `include`.
  ids?: string[][];
  distances?: number[][];
  documents?: Array<Array<string | null>>;
  metadatas?: Array<Array<Record<string, unknown> | null>>;
}

/**
 * Backend abstraction used by `ChromaRagAdapter`. The adapter holds
 * exactly one of these at a time; the factory picks the right one
 * based on the binding's endpoint shape.
 */
export type ChromaBackend =
  | { kind: 'mcp'; client: ChromaMcpClient; teardown: () => Promise<void> }
  | {
      kind: 'http';
      client: HttpChromaClient;
      /** Optional delegated embedder — mirrors pgvector. */
      embedder?: Embedder;
      teardown: () => Promise<void>;
    };

export class ChromaRagAdapter implements RetrievalProvider {
  readonly kind = 'chroma';

  private readonly backend: ChromaBackend;
  private readonly defaultCollection: string;

  /**
   * Bind an adapter to a pre-constructed `ChromaBackend`. The factory
   * (`createChromaAdapter`) uses this overload after selecting the
   * right backend based on the binding endpoint.
   */
  constructor(backend: ChromaBackend, binding: Pick<RagBinding, 'collection'>);
  /**
   * Legacy 3-arg overload — keeps pre-G1 call sites (and unit tests
   * that stand up a mock `ChromaMcpClient` directly) working. When
   * the first argument is a `ChromaMcpClient`, the adapter wraps it
   * in an `mcp`-kind backend with the supplied teardown (defaulting
   * to `client.close()`).
   */
  constructor(
    client: ChromaMcpClient,
    binding: Pick<RagBinding, 'collection'>,
    teardown?: () => Promise<void>,
  );
  constructor(
    backendOrClient: ChromaBackend | ChromaMcpClient,
    binding: Pick<RagBinding, 'collection'>,
    teardown?: () => Promise<void>,
  ) {
    if (isChromaBackend(backendOrClient)) {
      this.backend = backendOrClient;
    } else {
      const client = backendOrClient as ChromaMcpClient;
      this.backend = {
        kind: 'mcp',
        client,
        teardown: teardown ?? (() => client.close()),
      };
    }
    this.defaultCollection = binding.collection ?? DEFAULT_COLLECTION;
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const collection = request.collection ?? this.defaultCollection;
    if (this.backend.kind === 'mcp') {
      return this.searchMcp(collection, request);
    }
    return this.searchHttp(collection, request);
  }

  async store(request: StoreRequest): Promise<StoreResponse> {
    const collection = request.collection ?? this.defaultCollection;
    if (this.backend.kind === 'mcp') {
      return this.storeMcp(collection, request);
    }
    return this.storeHttp(collection, request);
  }

  async delete(request: DeleteRequest): Promise<DeleteResponse> {
    const collection = request.collection ?? this.defaultCollection;
    if (this.backend.kind === 'mcp') {
      return this.deleteMcp(collection, request);
    }
    return this.deleteHttp(collection, request);
  }

  async listCollections(): Promise<ListCollectionsResponse> {
    if (this.backend.kind === 'mcp') {
      const payload = await this.callTool<unknown>(TOOL_LIST, {});
      return { collections: normalizeListCollections(payload) };
    }
    const rows = await this.backend.client.listCollections();
    const collections: CollectionInfo[] = rows.map((r) => {
      const info: CollectionInfo = { name: r.name };
      if (typeof r.dimension === 'number' && r.dimension > 0) info.dimensions = r.dimension;
      if (r.metadata && typeof r.metadata === 'object') {
        info.metadata = r.metadata;
      }
      return info;
    });
    return { collections };
  }

  async close(): Promise<void> {
    await this.backend.teardown();
  }

  // ---- MCP path --------------------------------------------------------

  private async searchMcp(
    collection: string,
    request: SearchRequest,
  ): Promise<SearchResponse> {
    const args: Record<string, unknown> = {
      collection_name: collection,
      query_texts: [request.query],
      n_results: request.topK,
      include: ['documents', 'metadatas', 'distances'],
    };
    if (request.filter) args.where = request.filter;

    const payload = await this.callTool<ChromaQueryResponse>(TOOL_QUERY, args);
    const ids = payload.ids?.[0] ?? [];
    const distances = payload.distances?.[0] ?? [];
    const documents = payload.documents?.[0] ?? [];
    const metadatas = payload.metadatas?.[0] ?? [];

    const results: SearchResult[] = ids.map((id, i) =>
      buildResult(id, documents[i], metadatas[i], distances[i]),
    );
    return { results, collection };
  }

  private async storeMcp(
    collection: string,
    request: StoreRequest,
  ): Promise<StoreResponse> {
    const ids = request.documents.map((d) => d.id);
    const contents = request.documents.map((d) => d.content);
    const metadatas = request.documents.map((d) => d.metadata ?? {});
    await this.callTool<unknown>(TOOL_ADD, {
      collection_name: collection,
      documents: contents,
      ids,
      metadatas,
    });
    return { ids, collection };
  }

  private async deleteMcp(
    collection: string,
    request: DeleteRequest,
  ): Promise<DeleteResponse> {
    await this.callTool<unknown>(TOOL_DELETE, {
      collection_name: collection,
      ids: request.ids,
    });
    return { deleted: request.ids.length, collection };
  }

  // ---- HTTP path -------------------------------------------------------

  private async searchHttp(
    collection: string,
    request: SearchRequest,
  ): Promise<SearchResponse> {
    if (this.backend.kind !== 'http') throw new Error('unreachable');
    const vector = await this.embedQuery(request);
    const id = await this.backend.client.resolveCollectionId(collection);
    const payload = await this.backend.client.query(id, {
      query_embeddings: [vector],
      n_results: request.topK,
      include: ['distances', 'documents', 'metadatas'],
      ...(request.filter && { where: request.filter }),
    });

    const ids = payload.ids?.[0] ?? [];
    const distances = payload.distances?.[0] ?? [];
    const documents = payload.documents?.[0] ?? [];
    const metadatas = payload.metadatas?.[0] ?? [];

    const results: SearchResult[] = ids.map((rid, i) =>
      buildResult(rid, documents[i] ?? undefined, metadatas[i] ?? undefined, distances[i] ?? undefined),
    );
    return { results, collection };
  }

  private async storeHttp(
    collection: string,
    request: StoreRequest,
  ): Promise<StoreResponse> {
    if (this.backend.kind !== 'http') throw new Error('unreachable');
    const ids = request.documents.map((d) => d.id);
    const contents = request.documents.map((d) => d.content);
    const metadatas = request.documents.map((d) => d.metadata ?? null);
    const embeddings = await this.embedDocuments(request.documents);

    const collectionId = await this.backend.client.resolveCollectionId(collection);
    await this.backend.client.upsert(collectionId, {
      ids,
      embeddings,
      documents: contents,
      metadatas,
    });
    return { ids, collection };
  }

  private async deleteHttp(
    collection: string,
    request: DeleteRequest,
  ): Promise<DeleteResponse> {
    if (this.backend.kind !== 'http') throw new Error('unreachable');
    const collectionId = await this.backend.client.resolveCollectionId(collection);
    const deleted = await this.backend.client.deleteRecords(collectionId, {
      ids: request.ids,
    });
    // Chroma returns `-1` from the client helper when the server omits
    // the `deleted` field (older 1.x responses). Fall back to the
    // request-side cardinality in that case.
    return {
      deleted: deleted >= 0 ? deleted : request.ids.length,
      collection,
    };
  }

  /**
   * Resolve the query vector for an HTTP search. Order of precedence:
   *   1. Caller-supplied vector on `filter.vector` — zero embedder
   *      round-trips, matches the pgvector adapter.
   *   2. Delegated embedder — uses the same `embedDocumentsViaBinding`
   *      style used by pgvector so operators swap embedders without
   *      swapping vector stores.
   *
   * Chroma can also embed server-side if the collection was created
   * with an `embedding_function`, but the v2 query endpoint on
   * `chromadb/chroma:1.5.8` still requires `query_embeddings` in the
   * payload — there is no `query_texts` alternative at the transport
   * level. If no embedder is configured and the caller didn't supply
   * `filter.vector`, we surface an `invalid-request` so operators
   * know to wire one up.
   */
  private async embedQuery(request: SearchRequest): Promise<number[]> {
    if (this.backend.kind !== 'http') throw new Error('unreachable');
    const supplied = extractQueryVector(request);
    if (supplied) return supplied;
    if (!this.backend.embedder) {
      throw new RagError(
        'invalid-request',
        'chroma http search needs a query vector — pass filter.vector or configure rag.embedder',
      );
    }
    const [vector] = await this.backend.embedder([request.query]);
    if (!vector) {
      throw new RagError(
        'invalid-response',
        'chroma http search: embedder returned no vector for the query',
      );
    }
    return vector;
  }

  /**
   * Gather embeddings for a `store` call. Same precedence as
   * `embedQuery` — caller-supplied `vector` wins, otherwise the
   * delegated embedder fills every missing slot in one batch.
   */
  private async embedDocuments(documents: readonly Document[]): Promise<number[][]> {
    if (this.backend.kind !== 'http') throw new Error('unreachable');
    const missingIdx: number[] = [];
    for (let i = 0; i < documents.length; i++) {
      const d = documents[i]!;
      if (!d.vector || d.vector.length === 0) missingIdx.push(i);
    }
    if (missingIdx.length > 0 && !this.backend.embedder) {
      const firstMissing = documents[missingIdx[0]!]!;
      throw new RagError(
        'invalid-request',
        `chroma http store: doc id=${firstMissing.id} has no .vector and no rag.embedder is configured`,
      );
    }

    let computed: number[][] = [];
    if (missingIdx.length > 0 && this.backend.embedder) {
      const texts = missingIdx.map((i) => documents[i]!.content);
      computed = await this.backend.embedder(texts);
      if (computed.length !== missingIdx.length) {
        throw new RagError(
          'invalid-response',
          `chroma http store: embedder returned ${computed.length} vectors for ${missingIdx.length} docs`,
        );
      }
    }

    return documents.map((d, i) => {
      if (d.vector && d.vector.length > 0) return d.vector as number[];
      const idx = missingIdx.indexOf(i);
      const v = idx >= 0 ? computed[idx] : null;
      if (!v) {
        throw new RagError(
          'invalid-request',
          `chroma http store: no vector resolved for doc id=${d.id}`,
        );
      }
      return v;
    });
  }

  // ---- shared helpers --------------------------------------------------

  private async callTool<T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    if (this.backend.kind !== 'mcp') {
      throw new Error(`callTool invoked on non-MCP backend (kind=${this.backend.kind})`);
    }
    let raw: ChromaToolResult;
    try {
      raw = await this.backend.client.callTool({ name, arguments: args });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      // MCP SDK throws `McpError` with code -32601 for unknown tools;
      // other failures (transport, timeout) surface as generic errors.
      if (/method not found|unknown tool|-32601/i.test(msg)) {
        throw new RagError('tool-missing', `chroma-mcp does not expose "${name}": ${msg}`, cause);
      }
      throw new RagError('tool-error', `chroma-mcp call "${name}" failed: ${msg}`, cause);
    }

    if (raw.isError === true) {
      throw new RagError('tool-error', `chroma-mcp returned isError for "${name}": ${extractText(raw)}`);
    }

    const text = extractText(raw);
    if (text === null) {
      throw new RagError('invalid-response', `chroma-mcp "${name}" response had no text content`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
}

function isChromaBackend(v: unknown): v is ChromaBackend {
  if (typeof v !== 'object' || v === null) return false;
  const kind = (v as { kind?: unknown }).kind;
  return kind === 'mcp' || kind === 'http';
}

function buildResult(
  id: string,
  content: string | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
  distance: number | null | undefined,
): SearchResult {
  const dist =
    typeof distance === 'number' && Number.isFinite(distance) ? distance : Number.NaN;
  const score = Number.isFinite(dist) ? clamp01(1 - dist) : 0;
  const doc: Document = {
    id,
    content: typeof content === 'string' ? content : '',
  };
  if (metadata && typeof metadata === 'object') doc.metadata = metadata;
  const result: SearchResult = { document: doc, score };
  if (Number.isFinite(dist)) result.distance = dist;
  return result;
}

function extractText(raw: ChromaToolResult): string | null {
  const first = raw.content?.[0];
  if (first && first.type === 'text' && typeof first.text === 'string') return first.text;
  return null;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Pull a query vector out of `SearchRequest.filter.vector`. Matches
 * the shape used by `pgvector/adapter.ts::extractQueryVector` so the
 * same call site works for both backends.
 */
export function extractQueryVector(req: SearchRequest): number[] | null {
  const f = req.filter;
  if (!f) return null;
  const v = (f as { vector?: unknown }).vector;
  if (!Array.isArray(v) || v.length === 0) return null;
  if (!v.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return v as number[];
}

function normalizeListCollections(payload: unknown): CollectionInfo[] {
  // chroma_list_collections returns an array of names. We tolerate
  // the more-detailed shape (array of {name, count?, metadata?}) some
  // chroma-mcp forks emit, so operators running a patched server
  // aren't punished.
  if (!Array.isArray(payload)) {
    throw new RagError(
      'invalid-response',
      `chroma_list_collections payload is not an array (got ${typeof payload})`,
    );
  }
  if (payload.length === 1 && payload[0] === CHROMA_EMPTY_SENTINEL) return [];
  return payload.map((entry, i): CollectionInfo => {
    if (typeof entry === 'string') return { name: entry };
    if (entry && typeof entry === 'object' && 'name' in entry) {
      const obj = entry as Record<string, unknown>;
      const info: CollectionInfo = { name: String(obj.name) };
      if (typeof obj.count === 'number') info.count = obj.count;
      if (typeof obj.dimensions === 'number') info.dimensions = obj.dimensions;
      if (obj.metadata && typeof obj.metadata === 'object') {
        info.metadata = obj.metadata as Record<string, unknown>;
      }
      return info;
    }
    throw new RagError(
      'invalid-response',
      `chroma_list_collections entry at index ${i} is neither a string nor a named object`,
    );
  });
}
