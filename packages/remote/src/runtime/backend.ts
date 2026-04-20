/**
 * Runtime-backend contract. Every backend (DockerBackend today, a
 * future KubernetesBackend) implements this interface; the composite
 * applier drives the whole surface through it so the spec stays
 * runtime-agnostic.
 *
 * Lifecycle is desired-state: callers hand us a `ServiceDeployment`,
 * we converge the world. `ensureService` is idempotent — a second
 * call with an unchanged spec is a cheap no-op (the applier hashes
 * the spec and compares against `llamactl.spec.hash` on the running
 * container).
 *
 * Platform handling: Docker containers are tied to an `{os,
 * architecture}` pair. Backends must translate platform mismatches
 * (arm64 host, amd64-only image manifest) into a `RuntimeError` with
 * code `'platform-mismatch'` instead of letting the underlying
 * daemon error leak.
 */
import type { RuntimeError } from './errors.js';

export interface ImageRef {
  repository: string; // e.g. 'chromadb/chroma', 'pgvector/pgvector'
  tag: string; // pinned; callers must supply — no implicit 'latest'
}

export interface PortMapping {
  containerPort: number;
  hostPort?: number; // when omitted, backend may pick (docker ephemeral port)
  protocol?: 'tcp' | 'udp';
}

export interface VolumeMount {
  /** Host path (bind mount). Mutually exclusive with `name`. */
  hostPath?: string;
  /** Named docker volume. Mutually exclusive with `hostPath`. */
  name?: string;
  containerPath: string;
  readOnly?: boolean;
}

export interface Healthcheck {
  /** Docker healthcheck `Test` array — ['CMD', ...] or ['CMD-SHELL', ...]. */
  test: string[];
  intervalMs?: number;
  timeoutMs?: number;
  retries?: number;
  startPeriodMs?: number;
}

export type RestartPolicy = 'no' | 'on-failure' | 'unless-stopped' | 'always';

export interface ServiceDeployment {
  /** Deterministic name. Handlers pick it so drift detection works. */
  name: string;
  image: ImageRef;
  env?: Record<string, string>;
  ports?: PortMapping[];
  volumes?: VolumeMount[];
  labels?: Record<string, string>;
  /** Override image `CMD` entirely. */
  command?: string[];
  healthcheck?: Healthcheck;
  restartPolicy?: RestartPolicy;
  /**
   * Opaque caller-computed hash of the deployment's material fields.
   * Stored as the `llamactl.spec.hash` label; compared on the next
   * `ensureService` call for drift detection. Callers — not
   * backends — own the hashing function so the scheme stays
   * consistent across hosts running different backend versions.
   */
  specHash: string;
}

export interface ServiceRef {
  name: string;
}

export interface ServiceInstance {
  ref: ServiceRef;
  running: boolean;
  health?: 'healthy' | 'unhealthy' | 'starting' | 'unknown';
  /**
   * Hash that was on the running container at inspect time. `null`
   * when the container predates the label convention or the label
   * was stripped.
   */
  specHash: string | null;
  /** ISO8601 — when the container was created. */
  createdAt: string;
  /**
   * Resolved host+port for the first declared port mapping. Null
   * when the container has no ports or the backend can't resolve
   * the host binding (e.g., host-network mode).
   */
  endpoint: { host: string; port: number } | null;
}

export interface ServiceFilter {
  /** Filter by our own label key — e.g. `{ composite: 'kb' }`. */
  composite?: string;
  service?: string;
  /** Include stopped containers too. Default false (running only). */
  includeStopped?: boolean;
}

export interface RuntimeBackend {
  readonly kind: string; // 'docker' for v1, 'kubernetes' later

  /** Healthcheck against the backend itself. Throws `RuntimeError`
   *  with code `'backend-unreachable'` when it can't talk to the
   *  control plane. Cheap — meant for pre-flight. */
  ping(): Promise<void>;

  /**
   * Idempotent converge. If a container with `spec.name` exists and
   * its `specHash` label matches, returns the existing instance. If
   * it exists but the hash differs, the backend stops + removes +
   * recreates. If it does not exist, creates + starts.
   */
  ensureService(spec: ServiceDeployment): Promise<ServiceInstance>;

  removeService(ref: ServiceRef): Promise<void>;

  /** Returns null when the service does not exist. Not an error. */
  inspectService(ref: ServiceRef): Promise<ServiceInstance | null>;

  listServices(filter?: ServiceFilter): Promise<ServiceInstance[]>;

  /** Docker-specific today. Optional so KubernetesBackend can omit
   *  it (image pulls there are node-level + implicit). */
  pullImage?(ref: ImageRef): Promise<void>;
}

export type { RuntimeError };
