import type { RetrievalProvider } from '@nova/contracts';
import type { Config, RagBinding } from '../../config/schema.js';
import { createEmbedderFromBinding, type Embedder } from '../embedding.js';
import { ChromaRagAdapter } from './adapter.js';
import { connectChromaMcp } from './client.js';
import {
  HttpChromaClient,
  parseHttpChromaEndpoint,
  resolveChromaHttpToken,
} from './http-client.js';

export { ChromaRagAdapter, extractQueryVector, type ChromaBackend } from './adapter.js';
export {
  connectChromaMcp,
  type ChromaMcpClient,
  type ChromaMcpConnection,
  type ChromaToolResult,
} from './client.js';
export {
  CHROMA_DEFAULT_DATABASE,
  CHROMA_DEFAULT_TENANT,
  HttpChromaClient,
  parseHttpChromaEndpoint,
  resolveChromaHttpToken,
  type ChromaCollection,
  type ChromaDeletePayload,
  type ChromaQueryPayload,
  type ChromaQueryResponse,
  type ChromaUpsertPayload,
  type HttpChromaClientOptions,
} from './http-client.js';

export interface CreateChromaAdapterOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Kubeconfig used to resolve a delegated embedder node when the
   * binding carries `embedder`. Ignored for MCP backends (chroma-mcp
   * embeds via its collection's embedding function). Ignored even on
   * the HTTP backend when `embedder` is pre-built.
   */
  config?: Config;
  /**
   * Pre-built embedder — wins over `binding.embedder`. Tests and the
   * composite applier both inject here. MCP backend ignores this.
   */
  embedder?: Embedder;
  /**
   * Override the global fetch on the HTTP backend — lets tests point
   * at a `Bun.serve` fixture without requiring a full URL round-trip.
   */
  fetch?: typeof fetch;
}

/**
 * Factory — picks the right backend based on the binding's endpoint
 * shape and returns a `RetrievalProvider` ready for the router. HTTP
 * URLs (`http://`, `https://`) route through chroma's REST v2 API;
 * everything else goes through the legacy stdio chroma-mcp subprocess.
 * Caller owns the returned adapter and calls `close()` when done.
 *
 * The endpoint branch is intentional — MCP mode is still useful for
 * local dev without a running container and for operators running a
 * persistent chroma-mcp outside a composite.
 */
export async function createChromaAdapter(
  binding: RagBinding,
  envOrOpts: NodeJS.ProcessEnv | CreateChromaAdapterOptions = process.env,
): Promise<RetrievalProvider> {
  const opts: CreateChromaAdapterOptions = isOptionsBag(envOrOpts)
    ? envOrOpts
    : { env: envOrOpts };
  const env = opts.env ?? process.env;

  if (isHttpEndpoint(binding.endpoint)) {
    const baseUrl = parseHttpChromaEndpoint(binding);
    const token = resolveChromaHttpToken(binding, env);
    const clientOpts: ConstructorParameters<typeof HttpChromaClient>[0] = { baseUrl };
    if (token) clientOpts.token = token;
    if (opts.fetch) clientOpts.fetch = opts.fetch;
    const client = new HttpChromaClient(clientOpts);
    // Ping before handing the adapter to the caller so a wrong URL
    // surfaces at apply-time rather than deep inside the first query.
    await client.heartbeat();

    let embedder = opts.embedder;
    if (!embedder && binding.embedder && opts.config) {
      embedder = createEmbedderFromBinding({
        binding: binding.embedder,
        config: opts.config,
        env,
      });
    }
    return new ChromaRagAdapter(
      {
        kind: 'http',
        client,
        ...(embedder && { embedder }),
        teardown: () => client.close(),
      },
      binding,
    );
  }

  const { client, close } = await connectChromaMcp(binding, env);
  return new ChromaRagAdapter(client, binding, close);
}

function isHttpEndpoint(endpoint: string): boolean {
  const trimmed = endpoint.trim().toLowerCase();
  return trimmed.startsWith('http://') || trimmed.startsWith('https://');
}

function isOptionsBag(
  v: NodeJS.ProcessEnv | CreateChromaAdapterOptions,
): v is CreateChromaAdapterOptions {
  if (typeof v !== 'object' || v === null) return false;
  const maybe = v as Partial<CreateChromaAdapterOptions>;
  return (
    typeof maybe.embedder === 'function' ||
    typeof maybe.fetch === 'function' ||
    (maybe.config !== undefined && typeof maybe.config === 'object')
  );
}
