/**
 * ServiceHandler contract. Each service kind (chroma, pgvector,
 * generic container) ships a handler implementing this interface.
 *
 * Separation of concerns:
 *   - Handlers are **pure translation**. No I/O, no file reads, no
 *     network. They validate the spec, compute a stable hash, and
 *     emit a `ServiceDeployment` for any `RuntimeBackend` to
 *     converge.
 *   - Backends are the **impure I/O**. They take the
 *     `ServiceDeployment`, hit the daemon, and return a
 *     `ServiceInstance`.
 *
 * This split mirrors the `GatewayHandler` pattern under
 * `workload/gateway-handlers/` — dispatch picks a handler by kind,
 * the handler owns domain knowledge (images, health checks, env
 * vars), and the core applier stays handler-free.
 */
import type {
  ServiceDeployment,
  ServiceInstance,
} from '../../runtime/backend.js';
import type { ServiceSpec } from '../schema.js';

export interface HandlerTranslateOptions {
  /** Composite the spec lives in — goes into labels + deterministic names. */
  compositeName: string;
}

export interface ResolvedServiceEndpoint {
  host: string;
  port: number;
  /** URL form consumers can paste into a client (http://, postgres://, …). */
  url: string;
}

/**
 * A ServiceHandler knows how to turn a domain-level service spec
 * (chroma, pgvector, …) into the runtime-agnostic deployment the
 * backend consumes. Handlers are pure — no I/O, no side-effects.
 *
 * `toDeployment` returns `null` when the spec opts into
 * `runtime: 'external'` — the applier short-circuits external
 * services (nothing to spawn) and uses `resolvedEndpoint` directly
 * to wire up dependents.
 */
export interface ServiceHandler<S extends ServiceSpec = ServiceSpec> {
  /** Short stable identifier matching the spec's `kind` literal. */
  readonly kind: S['kind'];

  /** Throws `ServiceError('spec-invalid', …)` on unacceptable shape. */
  validate(spec: S): void;

  /**
   * Stable sha256 of the **deployment-material** fields (image,
   * ports, env, volumes, healthcheck). Excludes identity fields
   * (`name`) so renaming doesn't force a recreate, and excludes
   * `node` so moving between nodes is handled at the applier level,
   * not by drift detection.
   */
  computeSpecHash(spec: S): string;

  /**
   * Translate to the runtime-agnostic deployment. Returns `null`
   * when `spec.runtime === 'external'` — there's nothing to spawn
   * and the applier uses `resolvedEndpoint` directly.
   */
  toDeployment(
    spec: S,
    opts: HandlerTranslateOptions,
  ): ServiceDeployment | null;

  /**
   * Resolve the endpoint consumers use to reach this service. For
   * docker-runtime, derive from the `ServiceInstance`'s endpoint
   * (127.0.0.1:hostPort). For external-runtime, parse
   * `spec.externalEndpoint`. Throws
   * `ServiceError('endpoint-unresolvable', …)` when docker-runtime
   * is asked to resolve before the instance is present.
   */
  resolvedEndpoint(
    spec: S,
    instance: ServiceInstance | null,
  ): ResolvedServiceEndpoint;
}
