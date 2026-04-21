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
