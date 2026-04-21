/**
 * Kubernetes backend. Implements `RuntimeBackend` against a real
 * cluster via `@kubernetes/client-node`. Phase 3 wires the Deployment
 * path; Phase 4 (parallel) adds StatefulSet; Phase 5 fills remove /
 * inspect / list.
 *
 * Composite-lifecycle model (Helm pattern, no CRD):
 *   - One Namespace per composite (`<prefix>-<composite-name>`).
 *   - Every emitted child stamps `app.kubernetes.io/managed-by`,
 *     `llamactl.io/composite`, + the rest of the K8S_LABEL_KEYS
 *     taxonomy.
 *   - Drift detection via `llamactl.io/spec-hash` annotation on the
 *     Deployment (and Service / PVC / Secret for symmetry).
 *   - Destroy = DELETE Namespace, which cascades through k8s's
 *     built-in garbage collection.
 *
 * Idempotency model for `ensureService` mirrors docker: inspect
 * first, hash-compare, leave / replace. Creation order for a brand-
 * new service is Secret → PVC → Service → Deployment so the
 * Deployment never references a not-yet-existent Secret. The PVC is
 * never replaced after creation — storage migrations are dangerous
 * and out of scope for v1.
 *
 * The interface stays identical to DockerBackend so composite/apply.ts
 * doesn't care which backend it's driving.
 */
import type {
  V1Deployment,
  V1PersistentVolumeClaim,
  V1Secret,
  V1Service,
  V1StatefulSet,
} from '@kubernetes/client-node';

import type {
  ImageRef,
  RuntimeBackend,
  ServiceDeployment,
  ServiceFilter,
  ServiceInstance,
  ServiceRef,
} from '../backend.js';
import { RuntimeError } from '../errors.js';
import { resolveSecret } from '../../config/secret.js';
import {
  createKubernetesClient,
  type KubernetesClient,
  type KubernetesClientOptions,
} from './client.js';
import { K8S_ANNOTATION_KEYS, K8S_LABEL_KEYS, MANAGED_BY_VALUE } from './labels.js';
import {
  translateToDeployment,
} from './translate-deployment.js';
import { translateToStatefulSet } from './translate-statefulset.js';

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
  /**
   * How often to poll the Deployment's `readyReplicas` while
   * waiting for startup. Lowered by tests to keep them fast.
   */
  readinessPollMs?: number;
  /**
   * Total wall-clock budget for readiness. `RuntimeError('start-failed')`
   * after this elapses. Lowered by tests.
   */
  readinessTimeoutMs?: number;
}

const DEFAULT_NAMESPACE_PREFIX = 'llamactl';
const DEFAULT_READINESS_POLL_MS = 2_000;
const DEFAULT_READINESS_TIMEOUT_MS = 60_000;

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
  private readonly readinessPollMs: number;
  private readonly readinessTimeoutMs: number;
  /**
   * Secret resolver override — tests set this so secrets can be
   * resolved without mutating `process.env`. Production leaves it
   * unset to go through the default resolver.
   */
  private readonly secretResolver: (ref: string) => string;

  constructor(opts: KubernetesBackendOptions = {}) {
    this.client = createKubernetesClient(opts);
    this.namespacePrefix = opts.namespacePrefix ?? DEFAULT_NAMESPACE_PREFIX;
    this.storageClassName = opts.storageClassName;
    this.readinessPollMs = opts.readinessPollMs ?? DEFAULT_READINESS_POLL_MS;
    this.readinessTimeoutMs =
      opts.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.secretResolver = (ref: string): string => resolveSecret(ref);
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

  async ensureService(spec: ServiceDeployment): Promise<ServiceInstance> {
    if (!spec.image.tag || spec.image.tag.length === 0) {
      throw new RuntimeError(
        'spec-invalid',
        `image.tag is required (got empty for ${spec.image.repository})`,
      );
    }
    // Composite name comes in via labels so the applier's writer
    // can drive namespace routing without a second path. Tests +
    // standalone callers without a composite get a stable fallback.
    const compositeName = spec.labels?.[K8S_LABEL_KEYS.composite] ?? 'default';
    const namespace = this.namespaceFor(compositeName);
    await this.ensureNamespace(namespace, compositeName);

    const resolvedSecrets = this.resolveSecrets(spec);

    const kind = spec.controllerKind ?? 'deployment';
    if (kind === 'deployment') {
      return this.ensureDeployment(
        spec,
        namespace,
        compositeName,
        resolvedSecrets,
      );
    }
    if (kind === 'statefulset') {
      return this.ensureStatefulSet(spec);
    }
    throw new RuntimeError(
      'spec-invalid',
      `unknown controllerKind: ${kind satisfies never}`,
    );
  }

  /**
   * Locate + delete a managed service by name. Because the k8s
   * backend doesn't always know which namespace the service lives
   * in (composite-scoped namespaces are implicit), we search via
   * the managed-by label selector across all namespaces and pick
   * the first Deployment or StatefulSet whose `metadata.name`
   * matches.
   *
   * When found, the delete cascade is:
   *   Controller (Deployment / StatefulSet) → Services (by label)
   *   → Secret (by conventional name) → PVCs (label-scoped; gated
   *   behind `opts.purgeVolumes`). Missing resources at each step
   *   are 404-tolerant — treated as already-gone.
   *
   * A not-found service is a no-op (matches Docker backend's
   * 404-tolerant semantics).
   */
  async removeService(
    ref: ServiceRef,
    opts?: import('../backend.js').RemoveServiceOptions,
  ): Promise<void> {
    const located = await this.locateService(ref.name);
    if (!located) return;
    const { namespace, controllerKind } = located;
    const purgeVolumes = opts?.purgeVolumes ?? false;

    // 1. Controller first — removing it stops the pods before we
    //    drop the Service that points at them, so clients see a
    //    clean "gone" instead of a stale endpoint.
    try {
      if (controllerKind === 'deployment') {
        await this.client.apps.deleteNamespacedDeployment({
          name: ref.name,
          namespace,
        });
      } else {
        await this.client.apps.deleteNamespacedStatefulSet({
          name: ref.name,
          namespace,
        });
      }
    } catch (err) {
      if (!isNotFound(err)) {
        throw wrapBackend(err, `delete ${controllerKind} '${ref.name}'`);
      }
    }

    // 2. Services — both the ClusterIP service and, for StatefulSet,
    //    the headless companion + the `-client` ClusterIP. Look them
    //    up via label selector so we pick up every variant without
    //    hard-coding name suffixes.
    const serviceSelector = `${K8S_LABEL_KEYS.managedBy}=${MANAGED_BY_VALUE},${K8S_LABEL_KEYS.component}=service,app=${ref.name}`;
    try {
      const services = await this.client.core.listNamespacedService({
        namespace,
        labelSelector: serviceSelector,
      });
      for (const svc of services.items ?? []) {
        if (!svc.metadata?.name) continue;
        try {
          await this.client.core.deleteNamespacedService({
            name: svc.metadata.name,
            namespace,
          });
        } catch (err) {
          if (!isNotFound(err)) {
            throw wrapBackend(err, `delete service '${svc.metadata.name}'`);
          }
        }
      }
    } catch (err) {
      if (!isNotFound(err)) {
        throw wrapBackend(err, `list services for '${ref.name}'`);
      }
    }

    // 3. Secret (both translators use the same naming convention).
    try {
      await this.client.core.deleteNamespacedSecret({
        name: `${ref.name}-secrets`,
        namespace,
      });
    } catch (err) {
      if (!isNotFound(err)) {
        throw wrapBackend(err, `delete secret for '${ref.name}'`);
      }
    }

    // 4. PVCs — opt-in only. Deployment path emits a standalone PVC;
    //    StatefulSet's volumeClaimTemplates materialize as
    //    PVCs named `<template>-<statefulset>-<ordinal>` which carry
    //    no managed-by label (k8s generates them). Scope by name
    //    prefix when the controller is a StatefulSet; Deployment
    //    path deletes the named PVC directly.
    if (purgeVolumes) {
      try {
        const pvcs = await this.client.core.listNamespacedPersistentVolumeClaim({
          namespace,
        });
        for (const pvc of pvcs.items ?? []) {
          const n = pvc.metadata?.name;
          if (!n) continue;
          // Deployment case: exactly `${name}-data`.
          // StatefulSet case: `*-${name}-<ordinal>` (k8s convention).
          if (n === `${ref.name}-data` || n.endsWith(`-${ref.name}-0`) || n.includes(`-${ref.name}-`)) {
            try {
              await this.client.core.deleteNamespacedPersistentVolumeClaim({
                name: n,
                namespace,
              });
            } catch (err) {
              if (!isNotFound(err)) {
                throw wrapBackend(err, `delete pvc '${n}'`);
              }
            }
          }
        }
      } catch (err) {
        if (!isNotFound(err)) {
          throw wrapBackend(err, `list pvcs for '${ref.name}'`);
        }
      }
    }
  }

  /**
   * Lookup by name across all managed namespaces. Returns null when
   * nothing matches — same semantics as the docker backend so the
   * Composite applier can write uniform not-found handling.
   */
  async inspectService(ref: ServiceRef): Promise<ServiceInstance | null> {
    const located = await this.locateService(ref.name);
    if (!located) return null;
    const { namespace, controllerKind, controller } = located;

    // Pair the controller with its ClusterIP service so we can
    // surface the cluster-DNS endpoint. StatefulSet exposes both a
    // headless + a `-client` ClusterIP; prefer the ClusterIP for
    // the endpoint (external consumers can't use headless DNS
    // directly).
    let service: V1Service | null = null;
    try {
      const candidateName =
        controllerKind === 'statefulset' ? `${ref.name}-client` : ref.name;
      service = await this.client.core.readNamespacedService({
        name: candidateName,
        namespace,
      });
    } catch (err) {
      if (!isNotFound(err)) {
        throw wrapBackend(err, `read service '${ref.name}'`);
      }
    }

    return this.buildServiceInstance(
      {
        name: ref.name,
        image: { repository: '', tag: '' },
        specHash: annotationHash(controller) ?? '',
      },
      controller,
      service,
      namespace,
    );
  }

  /**
   * List every managed service across every composite-scoped
   * namespace, optionally narrowed to one composite. Fans out over
   * both Deployments and StatefulSets, then resolves each to its
   * ServiceInstance — the endpoint resolution runs the same cluster-
   * DNS lookup as `inspectService`.
   */
  async listServices(filter?: ServiceFilter): Promise<ServiceInstance[]> {
    const selectorParts = [
      `${K8S_LABEL_KEYS.managedBy}=${MANAGED_BY_VALUE}`,
      `${K8S_LABEL_KEYS.component}=service`,
    ];
    if (filter?.composite) {
      selectorParts.push(`${K8S_LABEL_KEYS.composite}=${filter.composite}`);
    }
    const labelSelector = selectorParts.join(',');

    const out: ServiceInstance[] = [];
    let deployments: V1Deployment[] = [];
    let statefulSets: V1StatefulSet[] = [];
    try {
      const res = await this.client.apps.listDeploymentForAllNamespaces({
        labelSelector,
      });
      deployments = res.items ?? [];
    } catch (err) {
      throw wrapBackend(err, 'list Deployments');
    }
    try {
      const res = await this.client.apps.listStatefulSetForAllNamespaces({
        labelSelector,
      });
      statefulSets = res.items ?? [];
    } catch (err) {
      throw wrapBackend(err, 'list StatefulSets');
    }

    for (const d of deployments) {
      const name = d.metadata?.name;
      const namespace = d.metadata?.namespace;
      if (!name || !namespace) continue;
      let service: V1Service | null = null;
      try {
        service = await this.client.core.readNamespacedService({
          name,
          namespace,
        });
      } catch (err) {
        if (!isNotFound(err)) {
          throw wrapBackend(err, `read service '${name}'`);
        }
      }
      out.push(
        this.buildServiceInstance(
          {
            name,
            image: { repository: '', tag: '' },
            specHash: annotationHash(d) ?? '',
          },
          d,
          service,
          namespace,
        ),
      );
    }

    for (const ss of statefulSets) {
      const name = ss.metadata?.name;
      const namespace = ss.metadata?.namespace;
      if (!name || !namespace) continue;
      let service: V1Service | null = null;
      try {
        service = await this.client.core.readNamespacedService({
          name: `${name}-client`,
          namespace,
        });
      } catch (err) {
        if (!isNotFound(err)) {
          throw wrapBackend(err, `read service '${name}-client'`);
        }
      }
      out.push(
        this.buildServiceInstance(
          {
            name,
            image: { repository: '', tag: '' },
            specHash: annotationHash(ss) ?? '',
          },
          ss,
          service,
          namespace,
        ),
      );
    }

    return out;
  }

  /**
   * Shared lookup for removeService / inspectService. Searches
   * managed Deployments first, then StatefulSets. Returns the first
   * name match across all namespaces.
   */
  private async locateService(name: string): Promise<{
    namespace: string;
    controllerKind: 'deployment' | 'statefulset';
    controller: V1Deployment | V1StatefulSet;
  } | null> {
    const labelSelector = `${K8S_LABEL_KEYS.managedBy}=${MANAGED_BY_VALUE},${K8S_LABEL_KEYS.component}=service`;
    try {
      const deployments = await this.client.apps.listDeploymentForAllNamespaces({
        labelSelector,
      });
      const match = (deployments.items ?? []).find(
        (d) => d.metadata?.name === name,
      );
      if (match?.metadata?.namespace) {
        return {
          namespace: match.metadata.namespace,
          controllerKind: 'deployment',
          controller: match,
        };
      }
    } catch (err) {
      throw wrapBackend(err, `locate '${name}' among Deployments`);
    }
    try {
      const statefulSets =
        await this.client.apps.listStatefulSetForAllNamespaces({
          labelSelector,
        });
      const match = (statefulSets.items ?? []).find(
        (s) => s.metadata?.name === name,
      );
      if (match?.metadata?.namespace) {
        return {
          namespace: match.metadata.namespace,
          controllerKind: 'statefulset',
          controller: match,
        };
      }
    } catch (err) {
      throw wrapBackend(err, `locate '${name}' among StatefulSets`);
    }
    return null;
  }

  /**
   * StatefulSet path for stateful services (pgvector and future
   * databases). Mirrors `ensureDeployment` but with a headless
   * Service companion (required by StatefulSet.serviceName) + a
   * second ClusterIP Service for clients + in-template PVCs via
   * `volumeClaimTemplates` so each pod gets sticky storage.
   *
   * Creation order: Secret → headless Service → ClusterIP Service
   * → StatefulSet. Services come first so the StatefulSet never
   * references a missing headless Service on its first scheduling
   * pass.
   */
  private async ensureStatefulSet(
    spec: ServiceDeployment,
  ): Promise<ServiceInstance> {
    const compositeName = spec.labels?.[K8S_LABEL_KEYS.composite] ?? 'default';
    const namespace = this.namespaceFor(compositeName);
    const resolvedSecrets = this.resolveSecrets(spec);

    const translated = translateToStatefulSet(spec, {
      namespace,
      compositeName,
      storageClassName: this.storageClassName,
      resolvedSecrets,
    });

    if (translated.secret) {
      await this.upsertSecret(translated.secret, namespace);
    }
    // Headless Service must exist before the StatefulSet — its
    // `serviceName` points at it; k8s rejects the apply otherwise.
    await this.upsertService(translated.headlessService, namespace, spec.specHash);
    await this.upsertService(translated.service, namespace, spec.specHash);

    const statefulSet = await this.upsertStatefulSet(
      translated.statefulSet,
      namespace,
      spec.specHash,
    );

    const ready = await this.waitForStatefulSetReady(
      spec.name,
      namespace,
      statefulSet,
    );

    return this.buildServiceInstance(spec, ready, translated.service, namespace);
  }

  // pullImage is not exposed — k8s nodes pull on behalf of the pod.
  // Keeping the method off the class cleanly documents the contract:
  // `RuntimeBackend.pullImage?` is optional and omitted here.
  pullImage?: undefined = undefined;

  /**
   * Composite-level teardown: deletes the composite's namespace and
   * lets k8s cascade GC wipe every child (Deployments, StatefulSets,
   * Services, Secrets, PVCs). Single-call destroy replaces the
   * per-component loop for the common case. 404 is a no-op — same
   * idempotent semantics as Docker's removeService.
   *
   * `opts.purgeVolumes` has no direct effect here (namespace delete
   * cascades to PVCs regardless). We accept the opt for API symmetry
   * with removeService.
   */
  async destroyCompositeBoundary(
    compositeName: string,
    _opts?: import('../backend.js').RemoveServiceOptions,
  ): Promise<void> {
    const namespace = this.namespaceFor(compositeName);
    try {
      await this.client.core.deleteNamespace({ name: namespace });
    } catch (err) {
      if (isNotFound(err)) return;
      throw wrapBackend(err, `delete namespace '${namespace}'`);
    }
  }

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

  // --- Phase 3 internals ------------------------------------------

  /**
   * Resolve every `spec.secrets[envName].ref` into a literal value
   * so the translator can base64-encode it for the `v1.Secret`.
   * Missing refs throw `spec-invalid` naming the env-var key — never
   * the value, never the resolver's detailed reason beyond the short
   * root-cause message. This matches the docker backend's contract.
   */
  private resolveSecrets(spec: ServiceDeployment): Record<string, string> {
    if (!spec.secrets) return {};
    const resolved: Record<string, string> = {};
    for (const [envName, secret] of Object.entries(spec.secrets)) {
      try {
        resolved[envName] = this.secretResolver(secret.ref);
      } catch (err) {
        throw new RuntimeError(
          'spec-invalid',
          `failed to resolve secret '${envName}' (ref='${secret.ref}'): ${(err as Error).message}`,
        );
      }
    }
    return resolved;
  }

  /**
   * Idempotent namespace upsert. Read first; on 404 create with the
   * composite labels stamped. Present → do nothing (we don't try to
   * patch labels of an existing namespace — it might be operator-
   * authored; Phase 5's destroy still scopes by the composite label
   * on the children, not the namespace).
   */
  private async ensureNamespace(
    namespace: string,
    compositeName: string,
  ): Promise<void> {
    try {
      await this.client.core.readNamespace({ name: namespace });
      return;
    } catch (err) {
      if (!isNotFound(err)) {
        throw wrapBackend(err, `read namespace '${namespace}'`);
      }
    }
    try {
      await this.client.core.createNamespace({
        body: {
          apiVersion: 'v1',
          kind: 'Namespace',
          metadata: {
            name: namespace,
            labels: {
              [K8S_LABEL_KEYS.managedBy]: MANAGED_BY_VALUE,
              [K8S_LABEL_KEYS.composite]: compositeName,
              [K8S_LABEL_KEYS.partOf]: compositeName,
              [K8S_LABEL_KEYS.instance]: compositeName,
            },
          },
        },
      });
    } catch (err) {
      // Race: another apply created it between our read + create.
      // 409 Conflict is benign here.
      if (!isConflict(err)) {
        throw wrapBackend(err, `create namespace '${namespace}'`);
      }
    }
  }

  private async ensureDeployment(
    spec: ServiceDeployment,
    namespace: string,
    compositeName: string,
    resolvedSecrets: Record<string, string>,
  ): Promise<ServiceInstance> {
    const translated = translateToDeployment(spec, {
      namespace,
      compositeName,
      storageClassName: this.storageClassName,
      resolvedSecrets,
    });

    // Creation order: Secret → PVC → Service → Deployment. The
    // Deployment's env references the Secret; the pod mounts the
    // PVC. Placing them last means the kubelet never fails to
    // resolve one of our dependencies on the first scheduling pass.
    if (translated.secret) {
      await this.upsertSecret(translated.secret, namespace);
    }
    if (translated.pvc) {
      await this.upsertPvc(translated.pvc, namespace);
    }
    if (translated.service) {
      await this.upsertService(translated.service, namespace, spec.specHash);
    }
    const deployment = await this.upsertDeployment(
      translated.deployment,
      namespace,
      spec.specHash,
    );

    const ready = await this.waitForDeploymentReady(
      spec.name,
      namespace,
      deployment,
    );

    return this.buildServiceInstance(spec, ready, translated.service, namespace);
  }

  private async upsertSecret(
    desired: V1Secret,
    namespace: string,
  ): Promise<void> {
    const name = desired.metadata?.name;
    if (!name) throw new RuntimeError('spec-invalid', 'secret missing name');
    let existing: V1Secret | null = null;
    try {
      existing = await this.client.core.readNamespacedSecret({
        name,
        namespace,
      });
    } catch (err) {
      if (!isNotFound(err)) {
        throw wrapBackend(err, `read secret '${name}'`);
      }
    }
    if (existing === null) {
      try {
        await this.client.core.createNamespacedSecret({
          namespace,
          body: desired,
        });
      } catch (err) {
        throw wrapBackend(err, `create secret '${name}'`);
      }
      return;
    }
    // Always replace — Secret payloads can rotate on every apply
    // and a base64 diff is cheap. Preserve `resourceVersion` on the
    // replace so the API server accepts the optimistic-lock.
    const body: V1Secret = {
      ...desired,
      metadata: {
        ...desired.metadata,
        resourceVersion: existing.metadata?.resourceVersion,
      },
    };
    try {
      await this.client.core.replaceNamespacedSecret({
        name,
        namespace,
        body,
      });
    } catch (err) {
      throw wrapBackend(err, `replace secret '${name}'`);
    }
  }

  private async upsertPvc(
    desired: V1PersistentVolumeClaim,
    namespace: string,
  ): Promise<void> {
    const name = desired.metadata?.name;
    if (!name) throw new RuntimeError('spec-invalid', 'pvc missing name');
    try {
      await this.client.core.readNamespacedPersistentVolumeClaim({
        name,
        namespace,
      });
      // PVC exists — DO NOT replace. Storage migrations are
      // dangerous (size reductions are rejected; class changes can
      // trigger a rebind that drops data on some provisioners).
      // Accepting drift here is the documented v1 behaviour; a
      // future slice gates storage migration behind an explicit
      // operator opt-in.
      return;
    } catch (err) {
      if (!isNotFound(err)) {
        throw wrapBackend(err, `read pvc '${name}'`);
      }
    }
    try {
      await this.client.core.createNamespacedPersistentVolumeClaim({
        namespace,
        body: desired,
      });
    } catch (err) {
      throw wrapBackend(err, `create pvc '${name}'`);
    }
  }

  private async upsertService(
    desired: V1Service,
    namespace: string,
    specHash: string,
  ): Promise<void> {
    const name = desired.metadata?.name;
    if (!name) throw new RuntimeError('spec-invalid', 'service missing name');
    let existing: V1Service | null = null;
    try {
      existing = await this.client.core.readNamespacedService({
        name,
        namespace,
      });
    } catch (err) {
      if (!isNotFound(err)) {
        throw wrapBackend(err, `read service '${name}'`);
      }
    }
    if (existing === null) {
      try {
        await this.client.core.createNamespacedService({
          namespace,
          body: desired,
        });
      } catch (err) {
        throw wrapBackend(err, `create service '${name}'`);
      }
      return;
    }
    if (annotationHash(existing) === specHash) {
      return;
    }
    const body: V1Service = {
      ...desired,
      metadata: {
        ...desired.metadata,
        resourceVersion: existing.metadata?.resourceVersion,
      },
      // ClusterIP is immutable after create; preserve it on replace
      // so the API server doesn't reject the PUT.
      spec: {
        ...desired.spec,
        ...(existing.spec?.clusterIP && { clusterIP: existing.spec.clusterIP }),
        ...(existing.spec?.clusterIPs && {
          clusterIPs: existing.spec.clusterIPs,
        }),
      },
    };
    try {
      await this.client.core.replaceNamespacedService({
        name,
        namespace,
        body,
      });
    } catch (err) {
      throw wrapBackend(err, `replace service '${name}'`);
    }
  }

  private async upsertDeployment(
    desired: V1Deployment,
    namespace: string,
    specHash: string,
  ): Promise<V1Deployment> {
    const name = desired.metadata?.name;
    if (!name) throw new RuntimeError('spec-invalid', 'deployment missing name');
    let existing: V1Deployment | null = null;
    try {
      existing = await this.client.apps.readNamespacedDeployment({
        name,
        namespace,
      });
    } catch (err) {
      if (!isNotFound(err)) {
        throw wrapBackend(err, `read deployment '${name}'`);
      }
    }
    if (existing === null) {
      try {
        return await this.client.apps.createNamespacedDeployment({
          namespace,
          body: desired,
        });
      } catch (err) {
        throw wrapBackend(err, `create deployment '${name}'`);
      }
    }
    if (annotationHash(existing) === specHash) {
      return existing;
    }
    const body: V1Deployment = {
      ...desired,
      metadata: {
        ...desired.metadata,
        resourceVersion: existing.metadata?.resourceVersion,
      },
    };
    try {
      return await this.client.apps.replaceNamespacedDeployment({
        name,
        namespace,
        body,
      });
    } catch (err) {
      throw wrapBackend(err, `replace deployment '${name}'`);
    }
  }

  private async upsertStatefulSet(
    desired: V1StatefulSet,
    namespace: string,
    specHash: string,
  ): Promise<V1StatefulSet> {
    const name = desired.metadata?.name;
    if (!name) throw new RuntimeError('spec-invalid', 'statefulset missing name');
    let existing: V1StatefulSet | null = null;
    try {
      existing = await this.client.apps.readNamespacedStatefulSet({
        name,
        namespace,
      });
    } catch (err) {
      if (!isNotFound(err)) {
        throw wrapBackend(err, `read statefulset '${name}'`);
      }
    }
    if (existing === null) {
      try {
        return await this.client.apps.createNamespacedStatefulSet({
          namespace,
          body: desired,
        });
      } catch (err) {
        throw wrapBackend(err, `create statefulset '${name}'`);
      }
    }
    if (annotationHash(existing) === specHash) {
      return existing;
    }
    // volumeClaimTemplates are immutable after create per the
    // StatefulSet API — preserving them on replace keeps the PUT
    // accepted. Size expansions happen through the PVC itself, not
    // the template; that's a v1 limitation and out of scope here.
    const body: V1StatefulSet = {
      ...desired,
      metadata: {
        ...desired.metadata,
        resourceVersion: existing.metadata?.resourceVersion,
      },
      spec: {
        ...desired.spec!,
        ...(existing.spec?.volumeClaimTemplates && {
          volumeClaimTemplates: existing.spec.volumeClaimTemplates,
        }),
      },
    };
    try {
      return await this.client.apps.replaceNamespacedStatefulSet({
        name,
        namespace,
        body,
      });
    } catch (err) {
      throw wrapBackend(err, `replace statefulset '${name}'`);
    }
  }

  /**
   * Poll `readNamespacedStatefulSet` until `status.readyReplicas >= 1`.
   * Same shape as the Deployment poll — both resources report
   * `readyReplicas` on `.status` with identical semantics for
   * single-replica workloads.
   */
  private async waitForStatefulSetReady(
    name: string,
    namespace: string,
    initial: V1StatefulSet,
  ): Promise<V1StatefulSet> {
    if (isReady(initial)) return initial;
    const deadline = Date.now() + this.readinessTimeoutMs;
    let latest = initial;
    while (Date.now() < deadline) {
      await delay(this.readinessPollMs);
      try {
        latest = await this.client.apps.readNamespacedStatefulSet({
          name,
          namespace,
        });
      } catch (err) {
        if (isNotFound(err)) {
          throw new RuntimeError(
            'start-failed',
            `statefulset '${name}' disappeared during startup poll`,
          );
        }
        throw wrapBackend(err, `poll statefulset '${name}'`);
      }
      if (isReady(latest)) return latest;
    }
    const ready = latest.status?.readyReplicas ?? 0;
    const replicas = latest.status?.replicas ?? 0;
    throw new RuntimeError(
      'start-failed',
      `statefulset '${name}' not ready after ${this.readinessTimeoutMs}ms (ready=${ready}, replicas=${replicas})`,
    );
  }

  /**
   * Poll `readNamespacedDeployment` until `status.readyReplicas >= 1`
   * or the timeout fires. `setTimeout`-based — never blocks the
   * event loop. Timeout → `start-failed` with the last observed
   * status snapshot in the message so operators see what's happening.
   */
  private async waitForDeploymentReady(
    name: string,
    namespace: string,
    initial: V1Deployment,
  ): Promise<V1Deployment> {
    if (isReady(initial)) return initial;
    const deadline = Date.now() + this.readinessTimeoutMs;
    let latest = initial;
    while (Date.now() < deadline) {
      await delay(this.readinessPollMs);
      try {
        latest = await this.client.apps.readNamespacedDeployment({
          name,
          namespace,
        });
      } catch (err) {
        if (isNotFound(err)) {
          throw new RuntimeError(
            'start-failed',
            `deployment '${name}' disappeared during startup poll`,
          );
        }
        throw wrapBackend(err, `poll deployment '${name}'`);
      }
      if (isReady(latest)) return latest;
    }
    const ready = latest.status?.readyReplicas ?? 0;
    const replicas = latest.status?.replicas ?? 0;
    throw new RuntimeError(
      'start-failed',
      `deployment '${name}' not ready after ${this.readinessTimeoutMs}ms (ready=${ready}, replicas=${replicas})`,
    );
  }

  private buildServiceInstance(
    spec: ServiceDeployment,
    controller: V1Deployment | V1StatefulSet,
    service: V1Service | null,
    namespace: string,
  ): ServiceInstance {
    const ready = controller.status?.readyReplicas ?? 0;
    const running = ready >= 1;
    const health: ServiceInstance['health'] =
      ready >= 1 ? 'healthy' : 'starting';
    const createdAtRaw = controller.metadata?.creationTimestamp;
    const createdAt =
      createdAtRaw instanceof Date
        ? createdAtRaw.toISOString()
        : typeof createdAtRaw === 'string'
          ? createdAtRaw
          : new Date(0).toISOString();
    let endpoint: ServiceInstance['endpoint'] = null;
    if (service && service.metadata?.name) {
      const port = service.spec?.ports?.[0]?.port;
      if (typeof port === 'number') {
        endpoint = {
          host: `${service.metadata.name}.${namespace}.svc.cluster.local`,
          port,
        };
      }
    }
    return {
      ref: { name: spec.name },
      running,
      health,
      specHash: spec.specHash,
      createdAt,
      endpoint,
    };
  }
}

// --- helpers ------------------------------------------------------

function isNotFound(err: unknown): boolean {
  return readStatus(err) === 404;
}

function isConflict(err: unknown): boolean {
  return readStatus(err) === 409;
}

function readStatus(err: unknown): number | null {
  if (err && typeof err === 'object') {
    const rec = err as Record<string, unknown>;
    if (typeof rec.code === 'number') return rec.code;
    if (typeof rec.statusCode === 'number') return rec.statusCode;
    if (typeof rec.status === 'number') return rec.status;
  }
  return null;
}

function wrapBackend(err: unknown, context: string): RuntimeError {
  const status = readStatus(err);
  const message =
    err && typeof err === 'object' && 'message' in err
      ? String((err as { message?: unknown }).message ?? err)
      : String(err);
  return new RuntimeError(
    'backend-unreachable',
    `${context} failed${status !== null ? ` (${status})` : ''}: ${message}`,
    err,
  );
}

function annotationHash(resource: {
  metadata?: { annotations?: Record<string, string> };
}): string | undefined {
  return resource.metadata?.annotations?.[K8S_ANNOTATION_KEYS.specHash];
}

function isReady(controller: V1Deployment | V1StatefulSet): boolean {
  return (controller.status?.readyReplicas ?? 0) >= 1;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
