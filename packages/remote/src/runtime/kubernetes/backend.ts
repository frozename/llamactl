/**
 * Kubernetes backend. Implements `RuntimeBackend` against a real
 * cluster via `@kubernetes/client-node`. Phase 2 ships only the
 * skeleton + `ping()`; Phases 3-5 fill in ensureService /
 * removeService / inspectService / listServices.
 *
 * Composite-lifecycle model (Helm pattern, no CRD):
 *   - One Namespace per composite (`<prefix>-<composite-name>`).
 *   - Every emitted child stamps `app.kubernetes.io/managed-by`,
 *     `llamactl.io/composite`, + the rest of the K8S_LABEL_KEYS
 *     taxonomy.
 *   - Drift detection via `llamactl.io/spec-hash` annotation.
 *   - Destroy = DELETE Namespace, which cascades through k8s's
 *     built-in garbage collection.
 *
 * The interface stays identical to DockerBackend so composite/apply.ts
 * doesn't care which backend it's driving.
 */
import type {
  ImageRef,
  RuntimeBackend,
  ServiceDeployment,
  ServiceFilter,
  ServiceInstance,
  ServiceRef,
} from '../backend.js';
import { RuntimeError } from '../errors.js';
import {
  createKubernetesClient,
  type KubernetesClient,
  type KubernetesClientOptions,
} from './client.js';

export interface KubernetesBackendOptions extends KubernetesClientOptions {
  /**
   * Namespace prefix for composite-scoped namespaces. Default
   * `'llamactl'` so a composite named 'kb-stack' lands in
   * `llamactl-kb-stack`.
   */
  namespacePrefix?: string;
  /**
   * Override the storageClassName on emitted PVCs. Default: omit
   * the field so the cluster's default StorageClass is used (k3s
   * ships `local-path`; Docker Desktop ships `hostpath`). Set
   * explicitly when operators want to target a specific class.
   */
  storageClassName?: string;
}

const DEFAULT_NAMESPACE_PREFIX = 'llamactl';

export function createKubernetesBackend(
  opts: KubernetesBackendOptions = {},
): RuntimeBackend {
  return new KubernetesBackend(opts);
}

export class KubernetesBackend implements RuntimeBackend {
  readonly kind = 'kubernetes';
  private readonly client: KubernetesClient;
  readonly namespacePrefix: string;
  readonly storageClassName: string | undefined;

  constructor(opts: KubernetesBackendOptions = {}) {
    this.client = createKubernetesClient(opts);
    this.namespacePrefix = opts.namespacePrefix ?? DEFAULT_NAMESPACE_PREFIX;
    this.storageClassName = opts.storageClassName;
  }

  /**
   * Healthcheck against the cluster. Uses `GET /api/v1` — a discovery
   * endpoint the core API always exposes; requires no RBAC beyond
   * what the bound credential has for discovery.
   */
  async ping(): Promise<void> {
    try {
      await this.client.core.getAPIResources();
    } catch (err) {
      throw new RuntimeError(
        'backend-unreachable',
        `kubernetes unreachable: ${(err as Error)?.message ?? String(err)}`,
        err,
      );
    }
  }

  async ensureService(_spec: ServiceDeployment): Promise<ServiceInstance> {
    throw new RuntimeError(
      'backend-unreachable',
      'KubernetesBackend.ensureService is not implemented yet (Phases 3 + 4)',
    );
  }

  async removeService(_ref: ServiceRef): Promise<void> {
    throw new RuntimeError(
      'backend-unreachable',
      'KubernetesBackend.removeService is not implemented yet (Phase 5)',
    );
  }

  async inspectService(_ref: ServiceRef): Promise<ServiceInstance | null> {
    throw new RuntimeError(
      'backend-unreachable',
      'KubernetesBackend.inspectService is not implemented yet (Phase 5)',
    );
  }

  async listServices(_filter?: ServiceFilter): Promise<ServiceInstance[]> {
    throw new RuntimeError(
      'backend-unreachable',
      'KubernetesBackend.listServices is not implemented yet (Phase 5)',
    );
  }

  // pullImage is not exposed — k8s nodes pull on behalf of the pod.
  // Keeping the method off the class cleanly documents the contract:
  // `RuntimeBackend.pullImage?` is optional and omitted here.
  pullImage?: undefined = undefined;

  // Consumed by Phase 3+ translators; exposed here so tests can
  // spell the resolved namespace without reaching into `client`.
  namespaceFor(compositeName: string): string {
    return `${this.namespacePrefix}-${compositeName}`;
  }

  // Exposed for Phase 3+ so translators can read the context-scoped
  // namespace fallback when a composite doesn't name its own.
  get currentContext(): string {
    return this.client.currentContext;
  }

  /** Purely informational — lets tests assert image refs don't leak. */
  describeImage(image: ImageRef): string {
    return `${image.repository}:${image.tag}`;
  }
}
