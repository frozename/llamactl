import { describe, expect, test } from 'bun:test';
import { ChromaRagAdapter } from '../src/rag/chroma/adapter.js';
import type { ChromaMcpClient, ChromaToolResult } from '../src/rag/chroma/client.js';
import { connectChromaMcp } from '../src/rag/chroma/client.js';
import { RagError } from '../src/rag/errors.js';
import type { RagBinding } from '../src/config/schema.js';

/**
 * Unit-level coverage of the Chroma adapter. A lightweight mock
 * `ChromaMcpClient` stands in for the real MCP `Client` — the SDK
 * transport / subprocess story is exercised end-to-end by manual
 * smoke, not here, so these tests stay fast and deterministic.
 */

interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

function wrap(payload: unknown): ChromaToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

function wrapText(text: string): ChromaToolResult {
  return { content: [{ type: 'text', text }] };
}

function makeClient(
  handler: (call: ToolCall) => ChromaToolResult | Promise<ChromaToolResult>,
): { client: ChromaMcpClient; calls: ToolCall[]; closed: { value: boolean } } {
  const calls: ToolCall[] = [];
  const closed = { value: false };
  const client: ChromaMcpClient = {
    async callTool(params) {
      calls.push({ name: params.name, arguments: params.arguments });
      return handler({ name: params.name, arguments: params.arguments });
    },
    async close() {
      closed.value = true;
    },
  };
  return { client, calls, closed };
}

function makeAdapter(
  client: ChromaMcpClient,
  binding: Partial<RagBinding> = {},
): ChromaRagAdapter {
  return new ChromaRagAdapter(client, { collection: binding.collection });
}

describe('ChromaRagAdapter.search', () => {
  test('normalizes chroma distance to cosine similarity in 0..1', async () => {
    const { client, calls } = makeClient(() =>
      wrap({
        ids: [['doc-a', 'doc-b', 'doc-c']],
        distances: [[0.1, 0.7, 1.5]],
        documents: [['alpha', 'bravo', 'charlie']],
        metadatas: [[{ topic: 'x' }, { topic: 'y' }, null]],
      }),
    );
    const adapter = makeAdapter(client, { collection: 'kb' });

    const res = await adapter.search({ query: 'anything', topK: 3 });

    expect(res.collection).toBe('kb');
    expect(res.results).toHaveLength(3);
    expect(res.results[0]!.score).toBeCloseTo(0.9, 5);
    expect(res.results[0]!.distance).toBe(0.1);
    expect(res.results[0]!.document).toEqual({
      id: 'doc-a',
      content: 'alpha',
      metadata: { topic: 'x' },
    });
    // distance 1.5 → raw score -0.5 → clamped to 0.
    expect(res.results[2]!.score).toBe(0);
    expect(res.results[2]!.distance).toBe(1.5);
    // Null metadata drops from document shape (stays undefined).
    expect(res.results[2]!.document.metadata).toBeUndefined();

    // Tool call shape matches chroma-mcp contract.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('chroma_query_documents');
    expect(calls[0]!.arguments).toEqual({
      collection_name: 'kb',
      query_texts: ['anything'],
      n_results: 3,
      include: ['documents', 'metadatas', 'distances'],
    });
  });

  test('threads filter through as `where`', async () => {
    const { client, calls } = makeClient(() =>
      wrap({ ids: [[]], distances: [[]], documents: [[]], metadatas: [[]] }),
    );
    const adapter = makeAdapter(client, { collection: 'kb' });

    await adapter.search({ query: 'q', topK: 5, filter: { topic: 'x' } });
    expect(calls[0]!.arguments.where).toEqual({ topic: 'x' });
  });

  test('uses binding default collection when caller omits one', async () => {
    const { client, calls } = makeClient(() =>
      wrap({ ids: [[]], distances: [[]], documents: [[]], metadatas: [[]] }),
    );
    const adapter = makeAdapter(client, { collection: 'fallback-coll' });
    const res = await adapter.search({ query: 'q', topK: 2 });
    expect(res.collection).toBe('fallback-coll');
    expect(calls[0]!.arguments.collection_name).toBe('fallback-coll');
  });
});

describe('ChromaRagAdapter.store', () => {
  test('forwards documents + ids + metadatas + echoes caller ids', async () => {
    const { client, calls } = makeClient(() =>
      wrapText('Successfully added 2 documents to collection'),
    );
    const adapter = makeAdapter(client, { collection: 'kb' });

    const res = await adapter.store({
      documents: [
        { id: 'a', content: 'one', metadata: { tag: 't' } },
        { id: 'b', content: 'two' },
      ],
    });

    expect(res).toEqual({ ids: ['a', 'b'], collection: 'kb' });
    expect(calls[0]!.name).toBe('chroma_add_documents');
    expect(calls[0]!.arguments).toEqual({
      collection_name: 'kb',
      documents: ['one', 'two'],
      ids: ['a', 'b'],
      metadatas: [{ tag: 't' }, {}],
    });
  });

  test('handles a single-doc call', async () => {
    const { client, calls } = makeClient(() => wrapText('ok'));
    const adapter = makeAdapter(client);
    const res = await adapter.store({ documents: [{ id: 'only', content: 'c' }] });
    expect(res.ids).toEqual(['only']);
    expect((calls[0]!.arguments.documents as string[]).length).toBe(1);
  });
});

describe('ChromaRagAdapter.delete', () => {
  test('returns count based on input ids', async () => {
    const { client, calls } = makeClient(() => wrapText('Removed 3 documents'));
    const adapter = makeAdapter(client, { collection: 'kb' });

    const res = await adapter.delete({ ids: ['a', 'b', 'c'] });
    expect(res).toEqual({ deleted: 3, collection: 'kb' });
    expect(calls[0]!.name).toBe('chroma_delete_documents');
    expect(calls[0]!.arguments).toEqual({ collection_name: 'kb', ids: ['a', 'b', 'c'] });
  });
});

describe('ChromaRagAdapter.listCollections', () => {
  test('maps a plain string array into CollectionInfo[]', async () => {
    const { client } = makeClient(() => wrap(['kb', 'notes', 'runbooks']));
    const adapter = makeAdapter(client);
    const res = await adapter.listCollections();
    expect(res.collections).toEqual([
      { name: 'kb' },
      { name: 'notes' },
      { name: 'runbooks' },
    ]);
  });

  test('normalizes the empty sentinel to []', async () => {
    const { client } = makeClient(() => wrap(['__NO_COLLECTIONS_FOUND__']));
    const adapter = makeAdapter(client);
    const res = await adapter.listCollections();
    expect(res.collections).toEqual([]);
  });

  test('tolerates the detailed object form', async () => {
    const { client } = makeClient(() =>
      wrap([
        { name: 'kb', count: 42, metadata: { owner: 'ops' } },
        { name: 'notes' },
      ]),
    );
    const adapter = makeAdapter(client);
    const res = await adapter.listCollections();
    expect(res.collections[0]).toEqual({
      name: 'kb',
      count: 42,
      metadata: { owner: 'ops' },
    });
    expect(res.collections[1]).toEqual({ name: 'notes' });
  });
});

describe('ChromaRagAdapter error paths', () => {
  test('MCP isError:true surfaces as RagError with code tool-error', async () => {
    const { client } = makeClient(() => ({
      content: [{ type: 'text', text: 'collection does not exist' }],
      isError: true,
    }));
    const adapter = makeAdapter(client);

    try {
      await adapter.search({ query: 'q', topK: 1 });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('tool-error');
      expect((err as RagError).message).toContain('collection does not exist');
    }
  });

  test('SDK method-not-found maps to tool-missing', async () => {
    const client: ChromaMcpClient = {
      async callTool() {
        throw new Error('Method not found: -32601');
      },
      async close() {},
    };
    const adapter = makeAdapter(client);

    try {
      await adapter.listCollections();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('tool-missing');
    }
  });

  test('non-array listCollections payload → invalid-response', async () => {
    const { client } = makeClient(() => wrap({ not: 'an array' }));
    const adapter = makeAdapter(client);

    try {
      await adapter.listCollections();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('invalid-response');
    }
  });

  test('response with no text content → invalid-response', async () => {
    const client: ChromaMcpClient = {
      async callTool() {
        return { content: [] };
      },
      async close() {},
    };
    const adapter = makeAdapter(client);

    try {
      await adapter.search({ query: 'q', topK: 1 });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('invalid-response');
    }
  });
});

describe('ChromaRagAdapter lifecycle', () => {
  test('close() invokes the supplied teardown', async () => {
    const { client, closed } = makeClient(() => wrap([]));
    let teardownRan = false;
    const adapter = new ChromaRagAdapter(
      client,
      { collection: 'kb' },
      async () => {
        teardownRan = true;
        await client.close();
      },
    );
    await adapter.close();
    expect(teardownRan).toBe(true);
    expect(closed.value).toBe(true);
  });

  test('default teardown closes the MCP client', async () => {
    const { client, closed } = makeClient(() => wrap([]));
    const adapter = new ChromaRagAdapter(client, {});
    await adapter.close();
    expect(closed.value).toBe(true);
  });
});

describe('connectChromaMcp', () => {
  test('empty endpoint → RagError connect-failed before any spawn attempt', async () => {
    try {
      await connectChromaMcp({
        provider: 'chroma',
        endpoint: '   ',
        extraArgs: [],
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('connect-failed');
    }
  });

  test('unreachable command surfaces connect-failed rather than hanging', async () => {
    try {
      await connectChromaMcp({
        provider: 'chroma',
        endpoint: '/nonexistent/chroma-mcp-binary-for-test',
        extraArgs: [],
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('connect-failed');
    }
  });
});
