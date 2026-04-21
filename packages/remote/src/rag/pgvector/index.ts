import type { RetrievalProvider } from '@nova/contracts';
import type { Config, RagBinding } from '../../config/schema.js';
import { RagError } from '../errors.js';
import type { Embedder } from '../embedding.js';
import { PgvectorRagAdapter } from './adapter.js';
import { connectPgvector, redactPostgresUrl } from './client.js';

export { PgvectorRagAdapter, extractQueryVector } from './adapter.js';
export { connectPgvector, redactPostgresUrl } from './client.js';
export type { PgvectorClient } from './client.js';

export interface CreatePgvectorAdapterOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Kubeconfig used to resolve the embedder node (when the binding
   * carries `embedder`). Omit in isolated unit tests; pass the live
   * config when calling from the router / applier.
   */
  config?: Config;
  /**
   * Inject a pre-built embedder. Takes precedence over `binding.embedder`.
   * Lets callers (composite applier, tests) supply a stub embedder
   * without going through node resolution.
   */
  embedder?: Embedder;
}

/**
 * Factory — resolves the binding's endpoint + auth, opens a pgvector
 * connection, and wraps it in a `RetrievalProvider`. Caller owns the
 * returned adapter and must call `close()` when done.
 *
 * Accepts either a plain `NodeJS.ProcessEnv` (the original v1
 * signature) or an options bag carrying `env` + `config` +
 * `embedder`. The bag form is how the router wires delegated
 * embedding through `binding.embedder` at apply time.
 */
export async function createPgvectorAdapter(
  binding: RagBinding,
  envOrOpts: NodeJS.ProcessEnv | CreatePgvectorAdapterOptions = process.env,
): Promise<RetrievalProvider> {
  if (binding.provider !== 'pgvector') {
    throw new RagError(
      'invalid-request',
      `createPgvectorAdapter called with binding.provider=${binding.provider}`,
    );
  }

  // Backward-compat: the v1 signature passes a raw ProcessEnv. We
  // detect that by the absence of the options-bag sentinel keys.
  const asOpts: CreatePgvectorAdapterOptions =
    isOptionsBag(envOrOpts)
      ? envOrOpts
      : { env: envOrOpts };
  const env = asOpts.env ?? process.env;

  const client = connectPgvector(binding, env);
  let embedder = asOpts.embedder;
  if (!embedder && binding.embedder && asOpts.config) {
    const { createEmbedderFromBinding } = await import('../embedding.js');
    embedder = createEmbedderFromBinding({
      binding: binding.embedder,
      config: asOpts.config,
      env,
    });
  }

  return new PgvectorRagAdapter({
    sql: client.sql,
    defaultCollection: binding.collection,
    safeLabel: client.safeLabel ?? redactPostgresUrl(binding.endpoint),
    ...(embedder && { embedder }),
  });
}

function isOptionsBag(
  v: NodeJS.ProcessEnv | CreatePgvectorAdapterOptions,
): v is CreatePgvectorAdapterOptions {
  // ProcessEnv is a string-valued record; our options-bag has these
  // specific non-string fields. A process.env that someone literally
  // set with a `config: Config` key would confuse this, but that's
  // pathological and the compat shim errs on new-signature inputs.
  if (typeof v !== 'object' || v === null) return false;
  const maybe = v as Partial<CreatePgvectorAdapterOptions>;
  return (
    typeof maybe.embedder === 'function' ||
    (maybe.config !== undefined && typeof maybe.config === 'object') ||
    (maybe.env !== undefined && typeof maybe.env === 'object')
  );
}
