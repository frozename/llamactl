/**
 * Delegated embedding helpers for RAG adapters that don't embed
 * internally (pgvector, future backends). An `Embedder` maps N texts
 * to N vectors in one batch — the adapter calls it during
 * `store({docs without vector})` and `search({query, filter.vector
 * absent})` to fill in the pre-computed vectors pgvector expects.
 *
 * `createEmbedderFromBinding` materializes an `Embedder` by
 * resolving the target cluster node + wrapping its AiProvider
 * surface. Lazy — the provider isn't built until the first embed
 * call, so pgvector nodes without docs that need embedding stay
 * cheap.
 */
import type {
  AiProvider,
  UnifiedEmbeddingRequest,
  UnifiedEmbeddingResponse,
} from '@nova/contracts';

import { RagError } from './errors.js';
import type { Config } from '../config/schema.js';
import type { EmbedderBinding } from '../config/schema.js';

export type Embedder = (texts: string[]) => Promise<number[][]>;

export interface EmbedderFactoryOptions {
  binding: EmbedderBinding;
  /** Kubeconfig used to resolve the target node. */
  config: Config;
  env?: NodeJS.ProcessEnv;
  /**
   * Override the provider build step. Tests inject a stub provider
   * so they don't need to stand up a live embedding server.
   */
  buildProvider?: (opts: EmbedderFactoryOptions) => Promise<AiProvider>;
}

/**
 * Build an `Embedder` from an `EmbedderBinding`. The returned
 * function lazily builds the AiProvider on first call; subsequent
 * calls reuse the cached provider.
 */
export function createEmbedderFromBinding(
  opts: EmbedderFactoryOptions,
): Embedder {
  let cached: AiProvider | null = null;
  const { binding } = opts;

  return async (texts) => {
    if (texts.length === 0) return [];
    if (!cached) {
      cached = await (opts.buildProvider ?? defaultBuildProvider)(opts);
    }
    if (typeof cached.createEmbeddings !== 'function') {
      throw new RagError(
        'tool-missing',
        `embedder node '${binding.node}' does not expose createEmbeddings`,
      );
    }
    const request: UnifiedEmbeddingRequest = {
      model: binding.model,
      input: texts,
    };
    let response: UnifiedEmbeddingResponse;
    try {
      response = await cached.createEmbeddings(request);
    } catch (err) {
      throw new RagError(
        'tool-error',
        `embedder '${binding.node}' call failed: ${toMessage(err)}`,
        err,
      );
    }
    if (!response.data || response.data.length !== texts.length) {
      throw new RagError(
        'invalid-response',
        `embedder '${binding.node}' returned ${response.data?.length ?? 0} vectors for ${texts.length} inputs`,
      );
    }
    return response.data.map((row, i) => {
      // Embedding can be number[] or base64 string. RAG path needs
      // number[] for pgvector's `::vector` cast; we refuse anything
      // else with a clear error.
      if (!Array.isArray(row.embedding)) {
        throw new RagError(
          'invalid-response',
          `embedder '${binding.node}' returned non-array embedding at index ${i} (encoding_format='base64'? request float)`,
        );
      }
      return row.embedding as number[];
    });
  };
}

async function defaultBuildProvider(
  opts: EmbedderFactoryOptions,
): Promise<AiProvider> {
  const { binding, config, env } = opts;

  // Explicit baseUrl override wins — skip kubeconfig resolution and
  // point an OpenAI-compat adapter directly at the supplied endpoint.
  // Useful when the embedder llama-server runs on a different
  // host:port than the agent's advertised URL, or when the embedder
  // lives on a separate host with no llamactl agent at all. `node`
  // still carries its audit-label role in error messages.
  if (binding.baseUrl) {
    const { createOpenAICompatProvider } = await import('@nova/contracts');
    let apiKey = '';
    if (binding.apiKeyRef) {
      const { resolveSecret } = await import('../config/secret.js');
      try {
        apiKey = resolveSecret(binding.apiKeyRef, env ?? process.env);
      } catch (err) {
        throw new RagError(
          'connect-failed',
          `embedder '${binding.node}': unable to resolve apiKeyRef (${binding.apiKeyRef})`,
          err,
        );
      }
    }
    return createOpenAICompatProvider({
      name: binding.node,
      displayName: binding.node,
      baseUrl: normalizeOpenAICompatBaseUrl(binding.baseUrl),
      apiKey,
    });
  }

  // Resolve the node via the kubeconfig helpers; use the provider
  // factory the router already uses for cloud/gateway/agent kinds.
  const { resolveNode, resolveToken } = await import('../config/kubeconfig.js');
  const { providerForNode } = await import('../providers/factory.js');
  let resolved;
  try {
    resolved = resolveNode(config, binding.node);
  } catch (err) {
    throw new RagError(
      'connect-failed',
      `embedder node '${binding.node}' not found in kubeconfig`,
      err,
    );
  }
  void resolveToken; // retained import — may be used by providerForNode
  const provider = providerForNode({
    node: resolved.node,
    user: resolved.user,
    cfg: config,
    env: env ?? process.env,
  });
  return provider;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Nova's OpenAI-compat provider calls `/embeddings` and
 * `/chat/completions` relative to `baseUrl` (no `/v1` prepended).
 * Operators naturally write `baseUrl: http://embedder:8081` (i.e.
 * the service root) — if we don't append `/v1`, the provider hits
 * llama-server's native `/embeddings` endpoint instead of
 * `/v1/embeddings` and receives a flat list (not the OpenAI
 * envelope), which then confuses the response parser.
 *
 * Append `/v1` when it's not already there. Preserve any
 * explicit suffix (`/v2`, a proxy prefix, etc.) untouched so the
 * escape hatch stays available.
 */
function normalizeOpenAICompatBaseUrl(url: string): string {
  const trimmed = url.endsWith('/') ? url.slice(0, -1) : url;
  if (/\/v\d+$/.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}
