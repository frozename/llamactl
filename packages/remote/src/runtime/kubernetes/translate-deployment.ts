/**
 * Pure translation: `ServiceDeployment` → k8s Deployment + optional
 * Service + optional PVC + optional Secret. No I/O, no side effects —
 * the backend calls this and then drives the resulting resources
 * through the cluster API.
 *
 * Resource model (v1 Deployment path):
 *   - One Deployment per service (single replica, `strategy: Recreate`
 *     so RWO PVCs don't double-mount during a rollout).
 *   - One ClusterIP Service when the spec declares ports; selector
 *     targets the pod template's `app` label.
 *   - One PVC when the spec declares ANY volume — multi-PVC-per-service
 *     is a follow-up. The PVC binds host-path / named volumes in v1.
 *   - One Secret when the spec declares secrets — backend resolves
 *     each `DeploymentSecret.ref` to a value, we base64-encode and
 *     stamp it into `data`.
 *
 * Labels: every resource carries the `K8S_LABEL_KEYS` taxonomy so a
 * namespace-scoped `DELETE` (destroy-composite in Phase 5) cascades
 * cleanly. The `app: <spec.name>` label is the selector key — keep it
 * stable across renames (the spec's name IS the stable identifier).
 *
 * Drift detection: the `llamactl.io/spec-hash` annotation on the
 * Deployment carries `spec.specHash`. The backend compares on the
 * next apply and leaves the resource alone when hashes match.
 */
import type {
  V1Deployment,
  V1Service,
  V1PersistentVolumeClaim,
  V1Secret,
  V1EnvVar,
  V1VolumeMount,
  V1Volume,
  V1Container,
  V1ContainerPort,
  V1ServicePort,
  V1Probe,
} from '@kubernetes/client-node';
import type { ServiceDeployment } from '../backend.js';
import {
  K8S_ANNOTATION_KEYS,
  K8S_LABEL_KEYS,
  MANAGED_BY_VALUE,
} from './labels.js';

export interface TranslateDeploymentOptions {
  namespace: string;
  compositeName: string;
  /**
   * Override the PVC's storageClassName. Omit to inherit the cluster
   * default (k3s → `local-path`, Docker Desktop → `hostpath`). We
   * deliberately never emit an empty-string value — the API treats
   * `""` as "force no class", which breaks clusters whose default
   * StorageClass is their only provisioner.
   */
  storageClassName?: string;
  /**
   * Pre-resolved secret values keyed by container env-var name. The
   * backend runs `spec.secrets[*].ref` through the unified resolver
   * at apply time and hands us the plain values; we base64-encode
   * them into the Secret's `data`. Missing keys (when `spec.secrets`
   * is set) are a translator bug — the backend validates before
   * calling us.
   */
  resolvedSecrets: Record<string, string>;
}

export interface TranslatedDeployment {
  deployment: V1Deployment;
  /** null when `spec.ports` is empty — no Service is necessary. */
  service: V1Service | null;
  /** null when `spec.volumes` is empty — no PVC is emitted. */
  pvc: V1PersistentVolumeClaim | null;
  /** null when `spec.secrets` is empty — no Secret is emitted. */
  secret: V1Secret | null;
}

const PVC_DEFAULT_STORAGE = '10Gi';
const CONTAINER_NAME = 'container';

export function translateToDeployment(
  spec: ServiceDeployment,
  opts: TranslateDeploymentOptions,
): TranslatedDeployment {
  const labels = buildLabels(spec, opts);
  const podLabels = { ...labels, app: spec.name };
  const annotations: Record<string, string> = {
    [K8S_ANNOTATION_KEYS.specHash]: spec.specHash,
  };

  const secret = buildSecret(spec, opts, labels);
  const pvc = buildPvc(spec, opts, labels);
  const service = buildService(spec, opts, labels, podLabels);
  const container = buildContainer(spec);
  const podVolumes = buildPodVolumes(spec);

  const deployment: V1Deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: spec.name,
      namespace: opts.namespace,
      labels,
      annotations,
    },
    spec: {
      replicas: 1,
      // Recreate is mandatory when the pod mounts a RWO PVC — the
      // default RollingUpdate strategy would bring up a second pod
      // that can't mount the same volume. For stateless services we
      // still use Recreate (a stop-the-world blip) because the
      // downtime trade-off is trivial vs. the cost of getting the
      // two-modes-branch wrong per service.
      strategy: { type: 'Recreate' },
      selector: { matchLabels: { app: spec.name } },
      template: {
        metadata: {
          labels: podLabels,
          annotations,
        },
        spec: {
          containers: [container],
          ...(podVolumes.length > 0 && { volumes: podVolumes }),
        },
      },
    },
  };

  return { deployment, service, pvc, secret };
}

function buildLabels(
  spec: ServiceDeployment,
  opts: TranslateDeploymentOptions,
): Record<string, string> {
  const base: Record<string, string> = {
    [K8S_LABEL_KEYS.managedBy]: MANAGED_BY_VALUE,
    [K8S_LABEL_KEYS.instance]: `${opts.compositeName}-${spec.name}`,
    [K8S_LABEL_KEYS.partOf]: opts.compositeName,
    [K8S_LABEL_KEYS.composite]: opts.compositeName,
    [K8S_LABEL_KEYS.component]: 'service',
  };
  if (spec.labels) {
    for (const [k, v] of Object.entries(spec.labels)) {
      base[k] = v;
    }
  }
  return base;
}

function buildContainer(spec: ServiceDeployment): V1Container {
  const container: V1Container = {
    name: CONTAINER_NAME,
    image: `${spec.image.repository}:${spec.image.tag}`,
  };

  if (spec.command && spec.command.length > 0) {
    container.command = spec.command;
  }

  if (spec.ports && spec.ports.length > 0) {
    const ports: V1ContainerPort[] = spec.ports.map((p) => {
      const port: V1ContainerPort = { containerPort: p.containerPort };
      if (p.protocol) port.protocol = p.protocol.toUpperCase();
      return port;
    });
    container.ports = ports;
  }

  const env = buildContainerEnv(spec);
  if (env.length > 0) container.env = env;

  const mounts = buildVolumeMounts(spec);
  if (mounts.length > 0) container.volumeMounts = mounts;

  const probe = buildLivenessProbe(spec);
  if (probe) container.livenessProbe = probe;

  return container;
}

function buildContainerEnv(spec: ServiceDeployment): V1EnvVar[] {
  const env: V1EnvVar[] = [];
  if (spec.env) {
    for (const [name, value] of Object.entries(spec.env)) {
      env.push({ name, value });
    }
  }
  if (spec.secrets) {
    const secretName = secretNameFor(spec);
    for (const envName of Object.keys(spec.secrets)) {
      env.push({
        name: envName,
        valueFrom: {
          secretKeyRef: { name: secretName, key: envName },
        },
      });
    }
  }
  return env;
}

function buildVolumeMounts(spec: ServiceDeployment): V1VolumeMount[] {
  if (!spec.volumes || spec.volumes.length === 0) return [];
  return spec.volumes.map((v, i) => {
    const mount: V1VolumeMount = {
      name: v.name ?? `data-${i}`,
      mountPath: v.containerPath,
    };
    if (v.readOnly !== undefined) mount.readOnly = v.readOnly;
    return mount;
  });
}

function buildPodVolumes(spec: ServiceDeployment): V1Volume[] {
  if (!spec.volumes || spec.volumes.length === 0) return [];
  const pvcName = pvcNameFor(spec);
  return spec.volumes.map((v, i): V1Volume => {
    const name = v.name ?? `data-${i}`;
    if (v.hostPath) {
      // Bind-style volumes. `DirectoryOrCreate` mirrors the docker
      // bind-mount behaviour — create the host directory when it's
      // missing so fresh nodes don't fail the first apply.
      return {
        name,
        hostPath: { path: v.hostPath, type: 'DirectoryOrCreate' },
      };
    }
    // Named volume → back with the PVC. Multi-PVC-per-service is
    // deferred (documented below at buildPvc).
    return {
      name,
      persistentVolumeClaim: { claimName: pvcName },
    };
  });
}

function buildLivenessProbe(spec: ServiceDeployment): V1Probe | undefined {
  const hc = spec.healthcheck;
  if (!hc) return undefined;
  // Docker healthchecks carry the runner tag as test[0] — 'CMD' or
  // 'CMD-SHELL'. k8s exec probes take just the argv, no runner, so
  // drop the leading tag. Empty `test` after stripping → skip the
  // probe entirely (defensive; handlers always set at least one arg).
  const command = hc.test.slice(1);
  if (command.length === 0) return undefined;
  const probe: V1Probe = {
    exec: { command },
  };
  if (hc.intervalMs !== undefined) {
    probe.periodSeconds = Math.floor(hc.intervalMs / 1000);
  }
  if (hc.timeoutMs !== undefined) {
    probe.timeoutSeconds = Math.floor(hc.timeoutMs / 1000);
  }
  if (hc.retries !== undefined) {
    probe.failureThreshold = hc.retries;
  }
  return probe;
}

function buildService(
  spec: ServiceDeployment,
  opts: TranslateDeploymentOptions,
  labels: Record<string, string>,
  podLabels: Record<string, string>,
): V1Service | null {
  if (!spec.ports || spec.ports.length === 0) return null;
  const ports: V1ServicePort[] = spec.ports.map((p) => ({
    port: p.hostPort ?? p.containerPort,
    targetPort: p.containerPort,
    protocol: (p.protocol ?? 'tcp').toUpperCase(),
  }));
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: spec.name,
      namespace: opts.namespace,
      labels,
      annotations: { [K8S_ANNOTATION_KEYS.specHash]: spec.specHash },
    },
    spec: {
      type: 'ClusterIP',
      selector: { app: podLabels.app ?? spec.name },
      ports,
    },
  };
}

function buildPvc(
  spec: ServiceDeployment,
  opts: TranslateDeploymentOptions,
  labels: Record<string, string>,
): V1PersistentVolumeClaim | null {
  if (!spec.volumes || spec.volumes.length === 0) return null;
  // v1 simplification: ONE PVC per service regardless of how many
  // `spec.volumes[]` entries there are. Mixed bind + named volumes
  // bind to the same PVC's claim; follow-up slice will split per
  // distinct logical volume when a real use case hits.
  const pvcSpec: V1PersistentVolumeClaim['spec'] = {
    accessModes: ['ReadWriteOnce'],
    resources: { requests: { storage: PVC_DEFAULT_STORAGE } },
  };
  // NEVER emit `storageClassName: ''` — the empty string means
  // "force no StorageClass" (k8s semantics), which breaks clusters
  // that rely on a default class. Omit the field entirely instead.
  if (opts.storageClassName) {
    pvcSpec.storageClassName = opts.storageClassName;
  }
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: pvcNameFor(spec),
      namespace: opts.namespace,
      labels,
      annotations: { [K8S_ANNOTATION_KEYS.specHash]: spec.specHash },
    },
    spec: pvcSpec,
  };
}

function buildSecret(
  spec: ServiceDeployment,
  opts: TranslateDeploymentOptions,
  labels: Record<string, string>,
): V1Secret | null {
  if (!spec.secrets || Object.keys(spec.secrets).length === 0) return null;
  const data: Record<string, string> = {};
  for (const envName of Object.keys(spec.secrets)) {
    // The caller (`backend.resolveSecrets`) guarantees a value for
    // every declared key; a missing one is a caller bug.
    const value = opts.resolvedSecrets[envName] ?? '';
    data[envName] = Buffer.from(value, 'utf8').toString('base64');
  }
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: {
      name: secretNameFor(spec),
      namespace: opts.namespace,
      labels,
      annotations: { [K8S_ANNOTATION_KEYS.specHash]: spec.specHash },
    },
    data,
  };
}

export function pvcNameFor(spec: ServiceDeployment): string {
  return `${spec.name}-data`;
}

export function secretNameFor(spec: ServiceDeployment): string {
  return `${spec.name}-secrets`;
}
