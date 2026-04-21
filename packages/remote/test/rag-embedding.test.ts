import { describe, expect, test } from 'bun:test';
import type {
  AiProvider,
  UnifiedEmbeddingRequest,
  UnifiedEmbeddingResponse,
} from '@nova/contracts';

import { createEmbedderFromBinding } from '../src/rag/embedding.js';
import { RagError } from '../src/rag/errors.js';
import { freshConfig } from '../src/config/schema.js';

/**
 * Strategic 1 — delegated embedding tests for createEmbedderFromBinding.
 * Stubs the AiProvider via buildProvider so we don't resolve kubeconfig
 * nodes / stand up an OpenAI-compat client.
 */

function stubProvider(overrides: Partial<AiProvider> = {}): AiProvider {
  const base: AiProvider = {
    name: 'stub',
    createResponse: async () => ({
      id: 'x',
      object: 'chat.completion' as const,
      created: 0,
      model: 'stub',
      choices: [],
    }),
  };
  return { ...base, ...overrides };
}

function makeResponse(vectors: number[][]): UnifiedEmbeddingResponse {
  return {
    object: 'list',
    model: 'test-embedding',
    data: vectors.map((embedding, index) => ({
      object: 'embedding' as const,
      index,
      embedding,
    })),
  };
}

describe('createEmbedderFromBinding', () => {
  test('embeds a batch via the resolved provider', async () => {
    const received: UnifiedEmbeddingRequest[] = [];
    const provider = stubProvider({
      createEmbeddings: async (req) => {
        received.push(req);
        const texts = Array.isArray(req.input) ? (req.input as string[]) : [req.input as string];
        return makeResponse(texts.map((_, i) => [i + 1, i + 2]));
      },
    });
    const embedder = createEmbedderFromBinding({
      binding: { node: 'sirius', model: 'test-embedding' },
      config: freshConfig(),
      buildProvider: async () => provider,
    });
    const out = await embedder(['one', 'two']);
    expect(out).toEqual([
      [1, 2],
      [2, 3],
    ]);
    expect(received).toHaveLength(1);
    expect(received[0]?.input).toEqual(['one', 'two']);
    expect(received[0]?.model).toBe('test-embedding');
  });

  test('empty input short-circuits without provider build', async () => {
    let built = 0;
    const embedder = createEmbedderFromBinding({
      binding: { node: 'x', model: 'y' },
      config: freshConfig(),
      buildProvider: async () => {
        built++;
        return stubProvider();
      },
    });
    expect(await embedder([])).toEqual([]);
    expect(built).toBe(0);
  });

  test('provider without createEmbeddings → tool-missing', async () => {
    const embedder = createEmbedderFromBinding({
      binding: { node: 'n', model: 'm' },
      config: freshConfig(),
      buildProvider: async () => stubProvider(), // no createEmbeddings
    });
    await expect(embedder(['x'])).rejects.toThrow(RagError);
  });

  test('provider error → tool-error', async () => {
    const embedder = createEmbedderFromBinding({
      binding: { node: 'n', model: 'm' },
      config: freshConfig(),
      buildProvider: async () =>
        stubProvider({
          createEmbeddings: async () => {
            throw new Error('upstream boom');
          },
        }),
    });
    try {
      await embedder(['x']);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('tool-error');
      expect((err as RagError).message).toContain('upstream boom');
    }
  });

  test('count mismatch → invalid-response', async () => {
    const embedder = createEmbedderFromBinding({
      binding: { node: 'n', model: 'm' },
      config: freshConfig(),
      buildProvider: async () =>
        stubProvider({
          createEmbeddings: async () => makeResponse([[1, 2]]), // one vector for two inputs
        }),
    });
    try {
      await embedder(['a', 'b']);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('invalid-response');
    }
  });

  test('base64 embedding format → invalid-response (we require float arrays)', async () => {
    const embedder = createEmbedderFromBinding({
      binding: { node: 'n', model: 'm' },
      config: freshConfig(),
      buildProvider: async () =>
        stubProvider({
          createEmbeddings: async () => ({
            object: 'list',
            model: 'm',
            data: [
              { object: 'embedding' as const, index: 0, embedding: 'base64-encoded-garbage' },
            ],
          }),
        }),
    });
    try {
      await embedder(['x']);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('invalid-response');
      expect((err as RagError).message).toContain('non-array embedding');
    }
  });

  test('provider is cached across calls', async () => {
    let builds = 0;
    const embedder = createEmbedderFromBinding({
      binding: { node: 'n', model: 'm' },
      config: freshConfig(),
      buildProvider: async () => {
        builds++;
        return stubProvider({
          createEmbeddings: async (req) => {
            const texts = Array.isArray(req.input)
              ? (req.input as string[])
              : [req.input as string];
            return makeResponse(texts.map(() => [0.1]));
          },
        });
      },
    });
    await embedder(['a']);
    await embedder(['b']);
    await embedder(['c']);
    expect(builds).toBe(1);
  });
});

// ---- baseUrl override --------------------------------------------------
//
// Covers slice G4: `EmbedderBinding.baseUrl` routes the embedder at a
// free-form OpenAI-compatible URL instead of going through kubeconfig
// node resolution. The fixture below is a `Bun.serve` stand-in for a
// llama-server `/v1/embeddings` endpoint — lets us exercise the real
// `createOpenAICompatProvider` code path + assert the bearer header is
// attached when `apiKeyRef` resolves.

interface EmbedRecord {
  path: string;
  auth: string | null;
  body: string;
}

async function startFakeEmbedder(opts: {
  response?: (input: string[]) => number[][];
  status?: number;
} = {}): Promise<{ url: string; calls: EmbedRecord[]; stop: () => Promise<void> }> {
  const calls: EmbedRecord[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === 'POST' ? await req.text() : '';
      calls.push({
        path: url.pathname,
        auth: req.headers.get('authorization'),
        body,
      });
      if (opts.status && opts.status !== 200) {
        return new Response(`{"error":"nope"}`, {
          status: opts.status,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname.endsWith('/embeddings') && req.method === 'POST') {
        const parsed = body ? JSON.parse(body) : {};
        const inputs = Array.isArray(parsed.input)
          ? (parsed.input as string[])
          : [String(parsed.input ?? '')];
        const vectors = opts.response
          ? opts.response(inputs)
          : inputs.map((_, i) => [i + 0.1, i + 0.2]);
        return new Response(
          JSON.stringify({
            object: 'list',
            model: parsed.model ?? 'stub-embed',
            data: vectors.map((embedding, index) => ({
              object: 'embedding',
              index,
              embedding,
            })),
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    stop: async () => {
      server.stop(true);
    },
  };
}

describe('createEmbedderFromBinding — baseUrl override', () => {
  test('baseUrl routes requests to the override URL, bypassing kubeconfig', async () => {
    const fake = await startFakeEmbedder();
    try {
      const embedder = createEmbedderFromBinding({
        // `freshConfig()` has no such node; binding.node would fail
        // through the resolver. Proves the override bypasses it.
        binding: {
          node: 'external-embedder',
          model: 'nomic-embed-text-v1.5',
          baseUrl: `${fake.url}/v1`,
        },
        config: freshConfig(),
      });
      const vectors = await embedder(['alpha', 'beta']);
      expect(vectors).toEqual([
        [0.1, 0.2],
        [1.1, 1.2],
      ]);
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]!.path).toBe('/v1/embeddings');
      // No apiKeyRef → empty-string bearer (OpenAI-compat adapter
      // always sets the header; unauthenticated upstreams ignore it).
      // HTTP stacks trim trailing whitespace, so the wire value is
      // the bare "Bearer" token.
      expect(fake.calls[0]!.auth?.startsWith('Bearer')).toBe(true);
      expect(fake.calls[0]!.auth).not.toContain('sk-');
      const sent = JSON.parse(fake.calls[0]!.body) as { model: string; input: string[] };
      expect(sent.model).toBe('nomic-embed-text-v1.5');
      expect(sent.input).toEqual(['alpha', 'beta']);
    } finally {
      await fake.stop();
    }
  });

  test('apiKeyRef resolves via the unified secret resolver → Bearer header', async () => {
    const fake = await startFakeEmbedder();
    try {
      const embedder = createEmbedderFromBinding({
        binding: {
          node: 'external-embedder',
          model: 'nomic-embed-text-v1.5',
          baseUrl: `${fake.url}/v1`,
          apiKeyRef: 'env:NOMIC_TOKEN_TEST',
        },
        config: freshConfig(),
        env: { NOMIC_TOKEN_TEST: 'sk-test-abc123' } as NodeJS.ProcessEnv,
      });
      await embedder(['hello']);
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]!.auth).toBe('Bearer sk-test-abc123');
    } finally {
      await fake.stop();
    }
  });

  test('unresolvable apiKeyRef surfaces connect-failed with audit label', async () => {
    const embedder = createEmbedderFromBinding({
      binding: {
        node: 'external-embedder',
        model: 'm',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKeyRef: 'env:DEFINITELY_NOT_SET_ANYWHERE',
      },
      config: freshConfig(),
      env: {} as NodeJS.ProcessEnv,
    });
    try {
      await embedder(['x']);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('connect-failed');
      expect((err as RagError).message).toContain("'external-embedder'");
      expect((err as RagError).message).toContain('apiKeyRef');
    }
  });

  test('baseUrl absent → existing node-resolution path still runs (regression)', async () => {
    // Regression guard: without `baseUrl`, we must still reach the
    // kubeconfig resolver. `freshConfig()` has no 'ghost' node, so the
    // resolver throws `connect-failed` with the familiar message —
    // proves we haven't silently hijacked the default path.
    const embedder = createEmbedderFromBinding({
      binding: { node: 'ghost', model: 'm' },
      config: freshConfig(),
    });
    try {
      await embedder(['x']);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RagError);
      expect((err as RagError).code).toBe('connect-failed');
      expect((err as RagError).message).toContain("'ghost'");
      expect((err as RagError).message).toContain('kubeconfig');
    }
  });
});
