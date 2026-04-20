import type { RetrievalProvider } from '@nova/contracts';
import type { RagBinding } from '../../config/schema.js';
import { RagError } from '../errors.js';
import { PgvectorRagAdapter } from './adapter.js';
import { connectPgvector, redactPostgresUrl } from './client.js';

export { PgvectorRagAdapter, extractQueryVector } from './adapter.js';
export { connectPgvector, redactPostgresUrl } from './client.js';
export type { PgvectorClient } from './client.js';

/**
 * Factory — resolves the binding's endpoint + auth, opens a pgvector
 * connection, and wraps it in a `RetrievalProvider`. Caller owns the
 * returned adapter and must call `close()` when done. `env` is
 * overridable for tests.
 */
export async function createPgvectorAdapter(
  binding: RagBinding,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RetrievalProvider> {
  if (binding.provider !== 'pgvector') {
    throw new RagError(
      'invalid-request',
      `createPgvectorAdapter called with binding.provider=${binding.provider}`,
    );
  }
  const client = connectPgvector(binding, env);
  return new PgvectorRagAdapter({
    sql: client.sql,
    defaultCollection: binding.collection,
    safeLabel: client.safeLabel ?? redactPostgresUrl(binding.endpoint),
  });
}
