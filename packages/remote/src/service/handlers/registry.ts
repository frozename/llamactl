import type { ServiceSpec } from "../schema.js";
import type { ServiceHandler } from "./types.js";

/**
 * Default handler set + dispatch. Mirrors
 * `workload/gateway-handlers/registry.ts`: a static array, first-match
 * iteration by `kind`, and a `ServiceError` thrown when no handler
 * matches (rather than a generic Error so callers can branch on
 * `e.code === 'unknown-kind'`).
 *
 * Register new kinds by adding them to `DEFAULT_SERVICE_HANDLERS`
 * below and to the discriminated union in `../schema.ts`. Tests
 * under `packages/remote/test/service-handlers-*.test.ts` are the
 * contract each new handler must satisfy.
 */
import { ServiceError } from "../errors.js";
import { chromaHandler } from "./chroma-handler.js";
import { genericContainerHandler } from "./generic-handler.js";
import { pgvectorHandler } from "./pgvector-handler.js";

export const DEFAULT_SERVICE_HANDLERS: readonly ServiceHandler[] = [
  chromaHandler,
  pgvectorHandler,
  genericContainerHandler,
];

/**
 * Pick the handler that owns `spec.kind`. Throws `ServiceError`
 * with code `'unknown-kind'` when the discriminator names a kind no
 * handler is registered for — shouldn't happen if the spec went
 * through `ServiceSpecSchema.parse` but we keep the runtime check
 * because the registry is public API and callers may construct
 * specs manually.
 */
export function findServiceHandler(spec: ServiceSpec): ServiceHandler {
  const handler = DEFAULT_SERVICE_HANDLERS.find((h) => h.kind === spec.kind);
  if (!handler) {
    throw new ServiceError(
      "unknown-kind",
      `no handler for service kind '${(spec as { kind: string }).kind}'`,
    );
  }
  return handler;
}
