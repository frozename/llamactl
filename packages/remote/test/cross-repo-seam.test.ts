import { describe, expect, test } from 'bun:test';
import {
  CollectionInfoSchema,
  DeleteRequestSchema,
  DocumentSchema,
  ListCollectionsResponseSchema,
  SearchRequestSchema,
  SearchResponseSchema,
  StoreRequestSchema,
  StoreResponseSchema,
  UnifiedAiRequestSchema,
  createOpenAICompatProvider,
  type AiProvider,
  type DeleteRequest,
  type DeleteResponse,
  type ListCollectionsResponse,
  type RetrievalProvider,
  type SearchRequest,
  type SearchResponse,
  type StoreRequest,
  type StoreResponse,
} from '@nova/contracts';

/**
 * Cross-repo seam test — proves llamactl can resolve every
 * `@nova/contracts` symbol it actively uses and that the shapes
 * haven't drifted from what the router / adapters expect. Guards
 * against the class of regressions where a nova schema field gets
 * renamed / tightened and llamactl's compile-clean suite doesn't
 * notice because only the tests that hit that field would.
 *
 * Mirrors `embersynth/tests/nova-seam.test.ts` — same purpose, just
 * the llamactl-side surface:
 *   - RAG: RetrievalProvider + Store/Delete/Search/ListCollections
 *   - Chat: AiProvider + UnifiedAiRequest + createOpenAICompatProvider
 *
 * What this file does NOT test:
 *   - Runtime behavior of any adapter (see rag-*.test.ts).
 *   - Network round-trips (see cluster-*.test.ts, openai-proxy.test.ts).
 * If this file fails, treat it as a schema-drift alarm and align
 * llamactl against nova before trying to unbreak downstream tests.
 */

describe('cross-repo seam: @nova/contracts imports + schema shapes', () => {
  test('SearchRequestSchema parses a minimal search', () => {
    const req = SearchRequestSchema.parse({ query: 'hi' });
    // Defaulting behavior we rely on in router.ragSearch:
    expect(req.topK).toBe(10);
  });

  test('StoreRequestSchema rejects an empty documents array', () => {
    // The runtime.ts batcher assumes min(1) holds; if nova loosens
    // this to `.min(0)`, runtime behavior for empty-fetch pipelines
    // changes silently.
    expect(() => StoreRequestSchema.parse({ documents: [] })).toThrow();
  });

  test('DeleteRequestSchema rejects an empty ids array', () => {
    // Runtime.ts replace-mode passes prior chunk_ids through this
    // shape; a no-op delete should be guarded by the caller, not
    // silently accepted.
    expect(() => DeleteRequestSchema.parse({ ids: [] })).toThrow();
  });

  test('DocumentSchema accepts optional vector', () => {
    // pgvector adapters require `vector` on store; chroma ignores it.
    // Both paths depend on this field staying optional at the schema.
    const withVec = DocumentSchema.parse({
      id: 'a',
      content: 'hello',
      vector: [0.1, 0.2, 0.3],
    });
    expect(withVec.vector?.length).toBe(3);
    const noVec = DocumentSchema.parse({ id: 'b', content: 'world' });
    expect(noVec.vector).toBeUndefined();
  });

  test('CollectionInfoSchema exposes count + dimensions + metadata', () => {
    // The Knowledge module's Collections tab + the planned Query-tab
    // header consume these three optional fields. If nova removes
    // any, the UI silently stops surfacing them.
    const c = CollectionInfoSchema.parse({
      name: 'docs',
      count: 1234,
      dimensions: 1536,
      metadata: { source: 'runbook' },
    });
    expect(c.count).toBe(1234);
    expect(c.dimensions).toBe(1536);
    expect(c.metadata?.source).toBe('runbook');
  });

  test('ListCollectionsResponseSchema wraps CollectionInfo[]', () => {
    const r = ListCollectionsResponseSchema.parse({
      collections: [{ name: 'docs' }, { name: 'notes', count: 10 }],
    });
    expect(r.collections).toHaveLength(2);
  });

  test('SearchResponseSchema carries results + collection', () => {
    const r = SearchResponseSchema.parse({
      results: [
        {
          document: { id: 'a', content: 'alpha' },
          score: 0.95,
          distance: 0.05,
        },
      ],
      collection: 'docs',
    });
    expect(r.results[0]!.score).toBeCloseTo(0.95);
    expect(r.collection).toBe('docs');
  });

  test('UnifiedAiRequestSchema parses the chat completion body llamactl routes', () => {
    const req = UnifiedAiRequestSchema.parse({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(req.messages).toHaveLength(2);
  });

  test('createOpenAICompatProvider is callable and returns a named AiProvider', () => {
    // router.ts:29 imports this for the OpenAI-compatible gateway path.
    // If nova renames the factory or changes its call signature, the
    // router stops compiling — but this test fails first with a
    // clearer message.
    const p: AiProvider = createOpenAICompatProvider({
      name: 'seam-test',
      baseUrl: 'http://127.0.0.1:9999/v1',
      apiKey: 'none',
    });
    expect(p.name).toBe('seam-test');
    expect(typeof p.createResponse).toBe('function');
  });

  test('RetrievalProvider / AiProvider interfaces accept llamactl-shaped adapters', () => {
    // Compile-time check — a shape that satisfies every current
    // llamactl adapter (chroma/pgvector RAG; native chat). If any
    // interface grows a required method, this block stops compiling.
    const stubRag: RetrievalProvider = {
      kind: 'fake',
      async search(req: SearchRequest): Promise<SearchResponse> {
        return { results: [], collection: req.collection ?? 'docs' };
      },
      async store(req: StoreRequest): Promise<StoreResponse> {
        return {
          ids: req.documents.map((d) => d.id),
          collection: req.collection ?? 'docs',
        };
      },
      async delete(req: DeleteRequest): Promise<DeleteResponse> {
        return { deleted: req.ids.length, collection: req.collection ?? 'docs' };
      },
      async listCollections(): Promise<ListCollectionsResponse> {
        return { collections: [] };
      },
      async close() {
        /* no-op */
      },
    };
    expect(stubRag.kind).toBe('fake');

    const stubChat: AiProvider = {
      name: 'stub',
      async createResponse(req) {
        return {
          id: 'test',
          object: 'chat.completion',
          created: 0,
          model: req.model,
          choices: [],
        };
      },
    };
    expect(stubChat.name).toBe('stub');
  });
});
