/**
 * Pure translator: `ServiceDeployment` (with `controllerKind:
 * 'statefulset'`) → k8s manifests.
 *
 * Emits four resources (one optional):
 *   1. `V1StatefulSet` — pod controller with sticky per-pod storage
 *      via `volumeClaimTemplates`. Replicas locked to 1 for v1 (the
 *      composite model is single-pod per service; multi-replica
 *      needs RWX or per-pod config and is a deferred slice).
 *   2. Headless `V1Service` — **mandatory companion**. k8s rejects
 *      StatefulSets whose `spec.serviceName` resolves to a
 *      non-headless Service at apply time. Name matches
 *      `statefulSet.spec.serviceName` so the controller can stamp
 *      stable DNS records (`<pod>.<service>.<ns>.svc.cluster.local`).
 *      See https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/
 *      and https://kubernetes.io/docs/concepts/services-networking/service/#headless-services
 *   3. Regular ClusterIP `V1Service` — what operator-side clients
 *      dial. Named `<spec.name>-client` so the headless Service can
 *      keep the canonical `<spec.name>` (required by `serviceName`
 *      pattern above). Alternatives considered:
 *        - `<spec.name>-clusterip`: literal but reads awkwardly at
 *          call sites (`pgvector-main-clusterip:5432` is noisy).
 *        - `<spec.name>` with headless at `<spec.name>-headless`:
 *          rejected because StatefulSet.serviceName expects the
 *          companion Service's literal name, and swapping breaks
 *          the convention readers coming from Helm charts expect.
 *      `-client` is the shortest that (a) reads as "the endpoint
 *      clients use" and (b) doesn't clash with the headless name.
 *   4. `V1Secret` — only when `spec.secrets` is non-empty. Carries
 *      the resolved values base64-encoded. Pod env references each
 *      key via `secretKeyRef` so the plain-text never appears on
 *      the pod spec / audit log.
 *
 * This module is PURE — no network, no filesystem, no
 * `process.env` reads. The backend resolves secret refs before
 * calling us and hands the materialized values in
 * `opts.resolvedSecrets`.
 */
import type {
  V1Container,
  V1ContainerPort,
  V1EnvVar,
  V1PersistentVolumeClaim,
  V1Probe,
  V1Secret,
  V1Service,
  V1ServicePort,
  V1StatefulSet,
  V1VolumeMount,
} from '@kubernetes/client-node';

import type { ServiceDeployment } from '../backend.js';
import {
  K8S_ANNOTATION_KEYS,
  K8S_LABEL_KEYS,
  MANAGED_BY_VALUE,
} from './labels.js';

export interface TranslateStatefulSetOptions {
  /** Composite-scoped namespace. Applier creates it before calling us. */
  namespace: string;
  /** Composite name — flows into the Helm-style `part-of` / `instance` / `llamactl.io/composite` labels. */
  compositeName: string;
  /**
   * Override storageClassName on every `volumeClaimTemplates[*]`.
   * When undefined we OMIT the field so the cluster's default
   * StorageClass is used (k3s → `local-path`; Docker Desktop →
   * `hostpath`). Setting `''` would be rejected by k8s validation
   * on some clusters and pins the StorageClass to "no class"
   * on others — we deliberately never emit an empty string.
   */
  storageClassName?: string;
  /**
   * Resolved secret values keyed by container env-var name. Same
   * contract the Deployment translator uses: backend resolves each
   * `spec.secrets[K].ref` (env:/keychain:/file:) into a plain
   * string and passes the map in here. We base64-encode into the
   * Secret's `data` field.
   */
  resolvedSecrets: Record<string, string>;
}

export interface TranslatedStatefulSet {
  statefulSet: V1StatefulSet;
  /**
   * Headless Service (`clusterIP: 'None'`). Mandatory per
   * StatefulSet.serviceName contract. Named the same as the
   * StatefulSet so DNS records follow the
   * `<pod>.<statefulSet.spec.serviceName>.<ns>.svc.cluster.local` pattern.
   */
  headlessService: V1Service;
  /**
   * Regular ClusterIP Service — named `<spec.name>-client` so
   * consumers dial a stable endpoint. See module header for the
   * naming-convention rationale.
   */
  service: V1Service;
  /** `null` when `spec.secrets` is empty. */
  secret: V1Secret | null;
}

/** Name of the single container in every emitted pod template. */
const CONTAINER_NAME = 'container';
/** Default storage request when `spec.volumes[]` doesn't carry one. */
const DEFAULT_STORAGE_REQUEST = '20Gi';
/** Suffix on the regular (non-headless) Service. See module header. */
const CLIENT_SERVICE_SUFFIX = '-client';
/** Suffix on the Secret emitted alongside the StatefulSet. */
const SECRET_SUFFIX = '-secrets';

/**
 * Build the shared label taxonomy. Stamped on the StatefulSet,
 * pod template metadata, both Services, and the Secret so
 * label-selector based list/destroy operations reach every child.
 */
function commonLabels(
  spec: ServiceDeployment,
  compositeName: string,
): Record<string, string> {
  const labels: Record<string, string> = {
    [K8S_LABEL_KEYS.managedBy]: MANAGED_BY_VALUE,
    [K8S_LABEL_KEYS.instance]: `${compositeName}-${spec.name}`,
    [K8S_LABEL_KEYS.partOf]: compositeName,
    [K8S_LABEL_KEYS.composite]: compositeName,
    [K8S_LABEL_KEYS.component]: 'service',
    // `app` is the StatefulSet + Services selector key. Keeping it
    // short + conventional matches the examples in the upstream
    // StatefulSet docs.
    app: spec.name,
  };
  if (spec.labels) {
    for (const [k, v] of Object.entries(spec.labels)) {
      // K8s label values are capped at 63 chars; handler-emitted
      // spec-hash is 64. Truncate so the PVC + StatefulSet apply
      // doesn't 422 on metadata.labels. Same rationale as in
      // translate-deployment.buildLabels.
      labels[k] = v.length > 63 ? v.slice(0, 63) : v;
    }
  }
  return labels;
}

/** Drift-detection annotation. Value can exceed 63 chars → annotation, not label. */
function commonAnnotations(spec: ServiceDeployment): Record<string, string> {
  return {
    [K8S_ANNOTATION_KEYS.specHash]: spec.specHash,
  };
}

function containerPorts(
  spec: ServiceDeployment,
): V1ContainerPort[] | undefined {
  if (!spec.ports || spec.ports.length === 0) return undefined;
  return spec.ports.map((p) => ({
    containerPort: p.containerPort,
    protocol: (p.protocol ?? 'tcp').toUpperCase(),
  }));
}

function containerEnv(
  spec: ServiceDeployment,
  secretName: string,
): V1EnvVar[] | undefined {
  const staticEntries: V1EnvVar[] = Object.entries(spec.env ?? {}).map(
    ([name, value]) => ({ name, value }),
  );
  const secretEntries: V1EnvVar[] = Object.keys(spec.secrets ?? {}).map(
    (name) => ({
      name,
      valueFrom: {
        secretKeyRef: { name: secretName, key: name },
      },
    }),
  );
  const all = [...staticEntries, ...secretEntries];
  return all.length > 0 ? all : undefined;
}

function livenessProbe(spec: ServiceDeployment): V1Probe | undefined {
  if (!spec.healthcheck) return undefined;
  // Docker's `test[0]` is the dispatcher (`CMD` / `CMD-SHELL`) —
  // k8s' exec action only accepts the argv, so we skip it.
  const command = spec.healthcheck.test.slice(1);
  const probe: V1Probe = { exec: { command } };
  if (spec.healthcheck.intervalMs !== undefined) {
    probe.periodSeconds = Math.max(
      1,
      Math.round(spec.healthcheck.intervalMs / 1000),
    );
  }
  if (spec.healthcheck.timeoutMs !== undefined) {
    probe.timeoutSeconds = Math.max(
      1,
      Math.round(spec.healthcheck.timeoutMs / 1000),
    );
  }
  if (spec.healthcheck.retries !== undefined) {
    probe.failureThreshold = spec.healthcheck.retries;
  }
  if (spec.healthcheck.startPeriodMs !== undefined) {
    probe.initialDelaySeconds = Math.max(
      0,
      Math.round(spec.healthcheck.startPeriodMs / 1000),
    );
  }
  return probe;
}

/**
 * Build the list of `volumeClaimTemplates` + the container-side
 * `volumeMounts` that reference them 1:1. We default each template
 * to 20Gi RWO. `storageClassName` is added ONLY when
 * `opts.storageClassName` is set — emitting `''` would either be
 * rejected or pin the PVC to "no class" depending on the cluster.
 */
function buildVolumeClaimTemplates(
  spec: ServiceDeployment,
  storageClassName: string | undefined,
): {
  templates: V1PersistentVolumeClaim[];
  mounts: V1VolumeMount[];
} {
  const volumes = spec.volumes ?? [];
  const templates: V1PersistentVolumeClaim[] = [];
  const mounts: V1VolumeMount[] = [];
  volumes.forEach((v, i) => {
    const name = v.name ?? `data-${i}`;
    const pvcSpec: V1PersistentVolumeClaim['spec'] = {
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: DEFAULT_STORAGE_REQUEST } },
    };
    // Omit the field entirely when the operator didn't set it.
    // Passing `undefined` on an object literal still survives JSON
    // serialisation as "absent", but we're explicit for readers.
    if (storageClassName !== undefined) {
      pvcSpec.storageClassName = storageClassName;
    }
    templates.push({
      metadata: { name },
      spec: pvcSpec,
    });
    mounts.push({
      name,
      mountPath: v.containerPath,
      ...(v.readOnly !== undefined && { readOnly: v.readOnly }),
    });
  });
  return { templates, mounts };
}

/**
 * Map `spec.ports[]` → `V1ServicePort[]`. The Service's `port` is
 * the one clients dial; `targetPort` is the container port. We
 * prefer `hostPort` for the Service `port` when set because
 * composite specs use `hostPort` as "the visible port" across
 * runtimes; fall back to `containerPort` otherwise.
 */
function servicePorts(spec: ServiceDeployment): V1ServicePort[] | undefined {
  if (!spec.ports || spec.ports.length === 0) return undefined;
  return spec.ports.map((p) => ({
    port: p.hostPort ?? p.containerPort,
    targetPort: p.containerPort,
    protocol: (p.protocol ?? 'tcp').toUpperCase(),
  }));
}

/** Base64-encode the resolved secret values for the Secret's `data` map. */
function encodeSecretData(
  secretNames: string[],
  resolved: Record<string, string>,
): Record<string, string> {
  const data: Record<string, string> = {};
  for (const key of secretNames) {
    // Missing resolution is a backend bug (resolver must produce
    // every key the spec names). Fail loudly here rather than
    // silently emit base64 of 'undefined'.
    const value = resolved[key];
    if (value === undefined) {
      throw new Error(
        `translate-statefulset: missing resolved secret for key '${key}' (backend must resolve every spec.secrets entry before translate)`,
      );
    }
    data[key] = Buffer.from(value, 'utf8').toString('base64');
  }
  return data;
}

/**
 * Translate a `ServiceDeployment` into the four k8s manifests a
 * stateful service needs. Pure function.
 */
export function translateToStatefulSet(
  spec: ServiceDeployment,
  opts: TranslateStatefulSetOptions,
): TranslatedStatefulSet {
  const { namespace, compositeName, storageClassName, resolvedSecrets } = opts;
  const labels = commonLabels(spec, compositeName);
  const annotations = commonAnnotations(spec);

  const secretNames = Object.keys(spec.secrets ?? {});
  const hasSecrets = secretNames.length > 0;
  const secretObjectName = `${spec.name}${SECRET_SUFFIX}`;

  const { templates, mounts } = buildVolumeClaimTemplates(
    spec,
    storageClassName,
  );

  const container: V1Container = {
    name: CONTAINER_NAME,
    image: `${spec.image.repository}:${spec.image.tag}`,
    ...(spec.command && spec.command.length > 0 && { command: spec.command }),
  };
  const ports = containerPorts(spec);
  if (ports) container.ports = ports;
  const env = containerEnv(spec, secretObjectName);
  if (env) container.env = env;
  const probe = livenessProbe(spec);
  if (probe) container.livenessProbe = probe;
  if (mounts.length > 0) container.volumeMounts = mounts;

  const statefulSet: V1StatefulSet = {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: {
      name: spec.name,
      namespace,
      labels,
      annotations,
    },
    spec: {
      // Points at the headless Service we emit below. k8s
      // validates the Service exists + is headless at apply time.
      serviceName: spec.name,
      replicas: 1,
      selector: { matchLabels: { app: spec.name } },
      template: {
        metadata: { labels, annotations },
        spec: { containers: [container] },
      },
      ...(templates.length > 0 && { volumeClaimTemplates: templates }),
    },
  };

  const svcPorts = servicePorts(spec);

  const headlessService: V1Service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: spec.name,
      namespace,
      labels,
      annotations,
    },
    spec: {
      clusterIP: 'None',
      selector: { app: spec.name },
      ...(svcPorts && { ports: svcPorts }),
    },
  };

  const service: V1Service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: `${spec.name}${CLIENT_SERVICE_SUFFIX}`,
      namespace,
      labels,
      annotations,
    },
    spec: {
      // Omit `clusterIP` entirely → k8s auto-allocates a ClusterIP.
      // Do NOT set `'None'` here: that would make it headless too.
      selector: { app: spec.name },
      ...(svcPorts && { ports: svcPorts }),
    },
  };

  const secret: V1Secret | null = hasSecrets
    ? {
        apiVersion: 'v1',
        kind: 'Secret',
        type: 'Opaque',
        metadata: {
          name: secretObjectName,
          namespace,
          labels,
        },
        data: encodeSecretData(secretNames, resolvedSecrets),
      }
    : null;

  return { statefulSet, headlessService, service, secret };
}
