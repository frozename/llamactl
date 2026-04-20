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
import { RagError } from '../errors.js';
import type { ChromaMcpClient, ChromaToolResult } from './client.js';

/**
 * Proxies the `RetrievalProvider` surface onto chroma-mcp tool calls.
 *
 * Tool names and parameter shapes verified against
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
 * Score normalization: chroma returns cosine *distance* in
 * `distances[][]`. We surface `distance` verbatim and compute
 * `score = clamp(1 - distance, 0, 1)` so callers get the cosine
 * similarity documented on `SearchResultSchema`. The clamp guards
 * against the rare case where chroma reports a distance >1 (e.g.
 * for L2 collections that got mis-indexed).
 *
 * `embed()` is intentionally omitted. Chroma embeds internally during
 * `chroma_add_documents`; there's no separate embedding surface
 * exposed to MCP callers. `RetrievalProvider.embed` is optional, so
 * leaving it off is the contract-honest signal that this adapter
 * doesn't stand up an embedding endpoint.
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

export class ChromaRagAdapter implements RetrievalProvider {
  readonly kind = 'chroma';

  private readonly client: ChromaMcpClient;
  private readonly defaultCollection: string;
  private readonly teardown: () => Promise<void>;

  constructor(
    client: ChromaMcpClient,
    binding: Pick<RagBinding, 'collection'>,
    teardown: () => Promise<void> = () => client.close(),
  ) {
    this.client = client;
    this.defaultCollection = binding.collection ?? DEFAULT_COLLECTION;
    this.teardown = teardown;
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const collection = request.collection ?? this.defaultCollection;
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

    const results: SearchResult[] = ids.map((id, i) => {
      const distance = typeof distances[i] === 'number' ? distances[i]! : Number.NaN;
      const score = Number.isFinite(distance)
        ? clamp01(1 - distance)
        : 0;
      const doc: Document = {
        id,
        content: typeof documents[i] === 'string' ? (documents[i] as string) : '',
      };
      const meta = metadatas[i];
      if (meta && typeof meta === 'object') doc.metadata = meta;
      const result: SearchResult = { document: doc, score };
      if (Number.isFinite(distance)) result.distance = distance;
      return result;
    });

    return { results, collection };
  }

  async store(request: StoreRequest): Promise<StoreResponse> {
    const collection = request.collection ?? this.defaultCollection;
    const ids = request.documents.map((d) => d.id);
    const contents = request.documents.map((d) => d.content);
    const metadatas = request.documents.map((d) => d.metadata ?? {});

    await this.callTool<unknown>(TOOL_ADD, {
      collection_name: collection,
      documents: contents,
      ids,
      metadatas,
    });
    // chroma_add_documents returns a human-readable confirmation;
    // caller-supplied IDs are the source of truth so we echo them.
    return { ids, collection };
  }

  async delete(request: DeleteRequest): Promise<DeleteResponse> {
    const collection = request.collection ?? this.defaultCollection;
    await this.callTool<unknown>(TOOL_DELETE, {
      collection_name: collection,
      ids: request.ids,
    });
    // chroma's delete response doesn't carry a count; trust the
    // request-side cardinality. Partial failures surface as tool-error
    // through `callTool` above.
    return { deleted: request.ids.length, collection };
  }

  async listCollections(): Promise<ListCollectionsResponse> {
    const payload = await this.callTool<unknown>(TOOL_LIST, {});
    const collections = normalizeListCollections(payload);
    return { collections };
  }

  async close(): Promise<void> {
    await this.teardown();
  }

  private async callTool<T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    let raw: ChromaToolResult;
    try {
      raw = await this.client.callTool({ name, arguments: args });
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
    // Some tools return plain confirmation strings rather than JSON
    // (e.g. add / delete). Return the raw text as-is when parsing
    // fails — callers that asked for a payload (`search`, `list`)
    // downcast and will tolerate the shape.
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
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
