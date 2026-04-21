import postgres from 'postgres';
import type { RagBinding } from '../../config/schema.js';
import { resolveSecret } from '../../config/secret.js';
import { RagError } from '../errors.js';

/**
 * Resolves the caller-declared Postgres credentials into a ready-to-
 * query `postgres.Sql` instance. Keeps secret lookup at the edge so
 * the adapter never sees raw tokens: the env var / file reference is
 * read here, injected into connection options as `password`, and the
 * adapter just uses the resulting tagged-template function.
 */

export interface PgvectorClient {
  sql: postgres.Sql;
  /** host+port+db redacted label — safe to surface in error messages. */
  safeLabel: string;
  close: () => Promise<void>;
}

/**
 * Redact the connection string for diagnostics. Extracts `host:port/db`
 * without password or query params; falls back to a generic label if
 * parsing fails so we still never echo raw credentials.
 */
export function redactPostgresUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname || 'unknown-host';
    const port = u.port || '5432';
    const db = u.pathname.replace(/^\//, '') || 'postgres';
    return `${host}:${port}/${db}`;
  } catch {
    return 'postgres://[redacted]';
  }
}

/**
 * Resolve the pgvector password. `tokenEnv` is the legacy env-only
 * shape (it names the env var directly — no scheme prefix). `tokenRef`
 * rides the unified secret resolver so `keychain:`, `env:`, `file:`,
 * and legacy bare paths all work. We prefer `tokenEnv` when set so
 * that legacy configs continue resolving identically.
 */
function resolveToken(
  binding: RagBinding,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const auth = binding.auth;
  if (!auth) return undefined;
  if (auth.tokenEnv) {
    const v = env[auth.tokenEnv];
    if (v && v.length > 0) return v;
  }
  if (auth.tokenRef) {
    try {
      return resolveSecret(auth.tokenRef, env);
    } catch (cause) {
      throw new RagError(
        'connect-failed',
        `pgvector: unable to resolve auth.tokenRef (${auth.tokenRef})`,
        cause,
      );
    }
  }
  return undefined;
}

export function connectPgvector(
  binding: RagBinding,
  env: NodeJS.ProcessEnv = process.env,
): PgvectorClient {
  const safeLabel = redactPostgresUrl(binding.endpoint);
  const password = resolveToken(binding, env);

  let sql: postgres.Sql;
  try {
    // postgres.js parses the full URL; we layer an explicit `password`
    // override only when the binding carries one, otherwise the
    // URL-embedded password (if any) is used verbatim.
    const options: postgres.Options<Record<string, postgres.PostgresType>> = {
      // Keep pool small — tRPC calls open-and-close per request in v1.
      max: 4,
      // postgres.js defaults its notice handler to stdout logging;
      // silence it so Postgres NOTICEs don't leak into llamactl logs.
      onnotice: () => {},
    };
    if (password) options.password = password;
    sql = postgres(binding.endpoint, options);
  } catch (cause) {
    throw new RagError(
      'connect-failed',
      `pgvector: failed to initialize connection to ${safeLabel}`,
      cause,
    );
  }

  return {
    sql,
    safeLabel,
    close: () => sql.end({ timeout: 5 }),
  };
}
