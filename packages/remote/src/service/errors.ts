/**
 * Typed errors for the service-handler layer. Separate from
 * `RuntimeError` (which belongs to backends): handlers are pure
 * translation — their failures are about **spec shape**, not about
 * I/O against a daemon.
 *
 *   - `unknown-kind`            — no handler registered for the
 *     service kind in the spec.
 *   - `spec-invalid`            — handler's `validate()` rejected
 *     the spec (e.g., `runtime: 'external'` with no
 *     `externalEndpoint`, or pgvector with `passwordEnv` pointing
 *     at an unset env var).
 *   - `endpoint-unresolvable`   — `resolvedEndpoint` was called on
 *     a docker-runtime service whose instance has no reachable
 *     endpoint (no ports mapped, inspect returned null, …).
 */
export type ServiceErrorCode =
  | 'unknown-kind'
  | 'spec-invalid'
  | 'endpoint-unresolvable';

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  override readonly cause?: unknown;
  constructor(code: ServiceErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.cause = cause;
  }
}
