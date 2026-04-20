/**
 * Typed errors for RAG adapters. Each backend translates its own
 * failure modes (MCP tool-missing, Postgres connection refused, bad
 * response shape) into one of these codes so callers get a stable
 * surface regardless of which adapter is behind the node.
 *
 *   - `connect-failed`    — couldn't reach the backend (spawn failure,
 *     TCP refused, auth handshake died).
 *   - `tool-missing`      — the adapter expected a backend tool /
 *     endpoint / SQL feature that isn't available.
 *   - `tool-error`        — the backend returned an error response
 *     (MCP `isError: true`, SQL error, HTTP 5xx).
 *   - `invalid-response`  — response didn't parse against the expected
 *     schema.
 *   - `invalid-request`   — caller-supplied input is unusable for this
 *     backend (e.g. pgvector search without a vector).
 */
export type RagErrorCode =
  | 'connect-failed'
  | 'tool-missing'
  | 'tool-error'
  | 'invalid-response'
  | 'invalid-request';

export class RagError extends Error {
  readonly code: RagErrorCode;
  override readonly cause?: unknown;
  constructor(code: RagErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'RagError';
    this.code = code;
    this.cause = cause;
  }
}
