/**
 * RAG adapter factory. Nodes with `kind: 'rag'` carry a `rag` binding
 * that picks the backend; this module materializes the right
 * `RetrievalProvider` for a given node. Keeps the switch off the
 * router so new backends plug in without touching tRPC.
 *
 * v1 providers: `chroma` (MCP-proxied), `pgvector` (native SQL).
 */
import type { RetrievalProvider } from '@nova/contracts';
import type { ClusterNode } from '../config/schema.js';
import { createChromaAdapter } from './chroma/index.js';
import { createPgvectorAdapter } from './pgvector/index.js';

export { RagError, type RagErrorCode } from './errors.js';
export { ChromaRagAdapter, createChromaAdapter } from './chroma/index.js';
export { PgvectorRagAdapter, createPgvectorAdapter } from './pgvector/index.js';

export async function createRagAdapter(
  node: ClusterNode,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RetrievalProvider> {
  if (!node.rag) {
    throw new Error(
      `node '${node.name}' is not a RAG node — missing 'rag' binding`,
    );
  }
  switch (node.rag.provider) {
    case 'chroma':
      return createChromaAdapter(node.rag, env);
    case 'pgvector':
      return createPgvectorAdapter(node.rag, env);
    default: {
      // The schema keeps `provider` narrowed to the known enum, so
      // this is unreachable unless the enum is expanded without
      // updating the factory.
      const exhaustive: never = node.rag.provider;
      throw new Error(`unknown RAG provider: ${String(exhaustive)}`);
    }
  }
}
