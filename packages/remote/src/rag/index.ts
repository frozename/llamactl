/**
 * RAG adapter factory. Nodes with `kind: 'rag'` carry a `rag` binding
 * that picks the backend; this module materializes the right
 * `RetrievalProvider` for a given node. Keeps the switch off the
 * router so new backends plug in without touching tRPC.
 *
 * v1 providers: `chroma` (MCP-proxied), `pgvector` (native SQL).
 */
import type { RetrievalProvider } from '@nova/contracts';
import type { ClusterNode, Config } from '../config/schema.js';
import { createChromaAdapter } from './chroma/index.js';
import { createPgvectorAdapter } from './pgvector/index.js';
import type { Embedder } from './embedding.js';

export { RagError, type RagErrorCode } from './errors.js';
export { ChromaRagAdapter, createChromaAdapter } from './chroma/index.js';
export { PgvectorRagAdapter, createPgvectorAdapter } from './pgvector/index.js';
export { createEmbedderFromBinding, type Embedder } from './embedding.js';

export interface CreateRagAdapterOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Kubeconfig used by the pgvector factory to resolve a delegated
   * embedder's target node. Omit for adapters that don't need
   * delegated embedding.
   */
  config?: Config;
  /**
   * Pre-built embedder. Overrides `binding.embedder` when supplied;
   * tests inject here.
   */
  embedder?: Embedder;
}

export async function createRagAdapter(
  node: ClusterNode,
  envOrOpts: NodeJS.ProcessEnv | CreateRagAdapterOptions = process.env,
): Promise<RetrievalProvider> {
  if (!node.rag) {
    throw new Error(
      `node '${node.name}' is not a RAG node — missing 'rag' binding`,
    );
  }
  const opts: CreateRagAdapterOptions = isOptionsBag(envOrOpts)
    ? envOrOpts
    : { env: envOrOpts };
  const env = opts.env ?? process.env;
  switch (node.rag.provider) {
    case 'chroma':
      // HTTP-mode chroma honors a delegated embedder the same way
      // pgvector does; MCP-mode ignores it (chroma-mcp embeds via
      // the collection's embedding function).
      return createChromaAdapter(node.rag, {
        env,
        ...(opts.config && { config: opts.config }),
        ...(opts.embedder && { embedder: opts.embedder }),
      });
    case 'pgvector':
      return createPgvectorAdapter(node.rag, {
        env,
        ...(opts.config && { config: opts.config }),
        ...(opts.embedder && { embedder: opts.embedder }),
      });
    default: {
      // The schema keeps `provider` narrowed to the known enum, so
      // this is unreachable unless the enum is expanded without
      // updating the factory.
      const exhaustive: never = node.rag.provider;
      throw new Error(`unknown RAG provider: ${String(exhaustive)}`);
    }
  }
}

function isOptionsBag(
  v: NodeJS.ProcessEnv | CreateRagAdapterOptions,
): v is CreateRagAdapterOptions {
  if (typeof v !== 'object' || v === null) return false;
  const maybe = v as Partial<CreateRagAdapterOptions>;
  return (
    typeof maybe.embedder === 'function' ||
    (maybe.config !== undefined && typeof maybe.config === 'object') ||
    (maybe.env !== undefined && typeof maybe.env === 'object' && !isProcessEnvShape(v))
  );
}

function isProcessEnvShape(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  // ProcessEnv has all-string values. Options-bag has function / object
  // fields. Sample a few keys to distinguish.
  for (const val of Object.values(v as Record<string, unknown>)) {
    if (typeof val !== 'string' && val !== undefined) return false;
  }
  return true;
}
