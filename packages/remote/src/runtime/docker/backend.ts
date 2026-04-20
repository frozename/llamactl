/**
 * Docker Engine backend. Implements `RuntimeBackend` against the
 * Docker Engine API v1.54 over a unix socket.
 *
 * Every call cites its swagger operationId (see
 * `moby/moby/api/swagger.yaml` on the upstream moby repo). Keep the
 * citations when refactoring — they're the contract the next
 * reader uses to verify what shape the daemon expects.
 *
 * Idempotency model:
 *   1. `inspectService` — 404 means "doesn't exist, create fresh".
 *   2. Present + `specHash` label matches → leave alone.
 *   3. Present + label mismatch → stop + remove + recreate.
 *   4. Present but stopped → remove + recreate (simpler than
 *      deciding whether restart is safe).
 *
 * Platform handling:
 *   - Apple Silicon (`arm64`) vs Intel (`amd64`) is the common trap.
 *   - Before create we `GET /images/{ref}/json` and compare
 *     `Architecture`/`Os` to the host. Mismatch → `platform-mismatch`
 *     with a clear error; the daemon would otherwise surface a
 *     less-friendly "no matching manifest" near the start stage.
 */
import { arch as nodeArch, platform as nodePlatform } from 'node:os';

import type {
  ImageRef,
  RuntimeBackend,
  ServiceDeployment,
  ServiceFilter,
  ServiceInstance,
  ServiceRef,
} from '../backend.js';
import { RuntimeError } from '../errors.js';
import { LABEL_KEYS, MANAGED_BY_VALUE } from '../labels.js';
import {
  createDockerClient,
  drainNdjson,
  failWith,
  parseJsonOrThrow,
  type DockerClient,
  type DockerClientOptions,
} from './client.js';

const STOP_TIMEOUT_SECONDS = 10;

export interface DockerBackendOptions extends DockerClientOptions {
  /**
   * Override the host arch / OS we compare image manifests against.
   * Tests inject to exercise `platform-mismatch` deterministically;
   * production callers should leave these unset.
   */
  hostArch?: string;
  hostOs?: string;
}

export function createDockerBackend(
  opts: DockerBackendOptions = {},
): RuntimeBackend {
  return new DockerBackend(opts);
}

export class DockerBackend implements RuntimeBackend {
  readonly kind = 'docker';
  private readonly client: DockerClient;
  private readonly hostArch: string;
  private readonly hostOs: string;

  constructor(opts: DockerBackendOptions = {}) {
    this.client = createDockerClient(opts);
    this.hostArch = opts.hostArch ?? normalizeArch(nodeArch());
    this.hostOs = opts.hostOs ?? normalizeOs(nodePlatform());
  }

  // swagger: operationId=SystemPing (GET /_ping)
  async ping(): Promise<void> {
    const res = await this.client.request('/_ping');
    if (!res.ok) {
      throw await failWith('backend-unreachable', res, 'docker ping');
    }
    // Body is the literal string "OK" — drain so the connection is
    // released.
    await res.text().catch(() => '');
  }

  async ensureService(spec: ServiceDeployment): Promise<ServiceInstance> {
    if (!spec.image.tag || spec.image.tag.length === 0) {
      throw new RuntimeError(
        'spec-invalid',
        `image.tag is required (got empty for ${spec.image.repository})`,
      );
    }

    const existing = await this.inspectService({ name: spec.name });
    if (existing && existing.specHash === spec.specHash && existing.running) {
      return existing;
    }
    if (existing) {
      // Drift or stopped — recreate. Simpler + more predictable than
      // trying to patch in-place.
      await this.removeService({ name: spec.name });
    }

    await this.ensureImageCompatible(spec.image);
    const id = await this.createContainer(spec);
    await this.startContainer(id);
    const inspected = await this.inspectService({ name: spec.name });
    if (!inspected) {
      throw new RuntimeError(
        'start-failed',
        `container '${spec.name}' disappeared immediately after start`,
      );
    }
    return inspected;
  }

  // swagger: operationId=ContainerDelete (DELETE /containers/{id})
  // Stops first via operationId=ContainerStop when the container is
  // running; DELETE on an already-stopped container works without it.
  async removeService(ref: ServiceRef): Promise<void> {
    // swagger: operationId=ContainerStop (POST /containers/{id}/stop)
    const stopRes = await this.client.request(
      `/containers/${encodeURIComponent(ref.name)}/stop`,
      { method: 'POST', query: { t: STOP_TIMEOUT_SECONDS } },
    );
    // 204 stopped, 304 already stopped, 404 doesn't exist — all fine
    if (!stopRes.ok && stopRes.status !== 304 && stopRes.status !== 404) {
      throw await failWith('backend-unreachable', stopRes, `stop ${ref.name}`);
    }

    const delRes = await this.client.request(
      `/containers/${encodeURIComponent(ref.name)}`,
      { method: 'DELETE', query: { force: true, v: false } },
    );
    if (!delRes.ok && delRes.status !== 404) {
      throw await failWith('backend-unreachable', delRes, `remove ${ref.name}`);
    }
  }

  // swagger: operationId=ContainerInspect (GET /containers/{id}/json)
  async inspectService(ref: ServiceRef): Promise<ServiceInstance | null> {
    const res = await this.client.request(
      `/containers/${encodeURIComponent(ref.name)}/json`,
    );
    if (res.status === 404) return null;
    const body = await parseJsonOrThrow<ContainerInspectResponse>(
      res,
      'backend-unreachable',
      `inspect ${ref.name}`,
    );
    return toServiceInstance(body);
  }

  // swagger: operationId=ContainerList (GET /containers/json)
  async listServices(filter: ServiceFilter = {}): Promise<ServiceInstance[]> {
    const labels: string[] = [`${LABEL_KEYS.managedBy}=${MANAGED_BY_VALUE}`];
    if (filter.composite) labels.push(`${LABEL_KEYS.composite}=${filter.composite}`);
    if (filter.service) labels.push(`${LABEL_KEYS.service}=${filter.service}`);
    const filters = JSON.stringify({ label: labels });

    const res = await this.client.request('/containers/json', {
      query: { all: filter.includeStopped ?? false, filters },
    });
    const list = await parseJsonOrThrow<ContainerListItem[]>(
      res,
      'backend-unreachable',
      'list containers',
    );
    // /containers/json returns a trimmer shape than /json; for the
    // full ServiceInstance we'd have to inspect each. v1 does that
    // — the list sizes we expect are small (composite-scoped) and
    // the inspect calls are cheap (unix socket, no TLS).
    const out: ServiceInstance[] = [];
    for (const item of list) {
      const ref: ServiceRef = { name: trimContainerName(item.Names[0] ?? '') };
      const full = await this.inspectService(ref);
      if (full) out.push(full);
    }
    return out;
  }

  // swagger: operationId=ImageCreate (POST /images/create)
  async pullImage(ref: ImageRef): Promise<void> {
    const res = await this.client.request('/images/create', {
      method: 'POST',
      query: { fromImage: ref.repository, tag: ref.tag },
    });
    await drainNdjson(res, 'image-pull-failed', `pull ${ref.repository}:${ref.tag}`);
  }

  // -----

  /**
   * Confirm the image is available locally OR pull it, then verify
   * the local manifest has a variant for this host. Single combined
   * step so the rarest operation (pull) gets logged once.
   */
  private async ensureImageCompatible(ref: ImageRef): Promise<void> {
    const inspected = await this.inspectImage(ref);
    if (!inspected) {
      await this.pullImage(ref);
      const afterPull = await this.inspectImage(ref);
      if (!afterPull) {
        throw new RuntimeError(
          'image-pull-failed',
          `pull of ${ref.repository}:${ref.tag} succeeded but image not found post-pull`,
        );
      }
      this.checkPlatform(ref, afterPull);
      return;
    }
    this.checkPlatform(ref, inspected);
  }

  // swagger: operationId=ImageInspect (GET /images/{name}/json)
  private async inspectImage(ref: ImageRef): Promise<ImageInspectResponse | null> {
    const name = `${ref.repository}:${ref.tag}`;
    const res = await this.client.request(
      `/images/${encodeURIComponent(name)}/json`,
    );
    if (res.status === 404) return null;
    return parseJsonOrThrow<ImageInspectResponse>(
      res,
      'backend-unreachable',
      `inspect image ${name}`,
    );
  }

  private checkPlatform(ref: ImageRef, image: ImageInspectResponse): void {
    if (!image.Architecture || !image.Os) return; // older daemons omit
    const imageArch = normalizeArch(image.Architecture);
    const imageOs = normalizeOs(image.Os);
    if (imageArch !== this.hostArch || imageOs !== this.hostOs) {
      throw new RuntimeError(
        'platform-mismatch',
        `image ${ref.repository}:${ref.tag} is ${imageOs}/${imageArch}, host is ${this.hostOs}/${this.hostArch}`,
      );
    }
  }

  // swagger: operationId=ContainerCreate (POST /containers/create)
  private async createContainer(spec: ServiceDeployment): Promise<string> {
    const body = translateDeployment(spec);
    const res = await this.client.request('/containers/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      query: { name: spec.name },
    });
    const parsed = await parseJsonOrThrow<{ Id: string }>(
      res,
      'create-failed',
      `create ${spec.name}`,
    );
    return parsed.Id;
  }

  // swagger: operationId=ContainerStart (POST /containers/{id}/start)
  private async startContainer(id: string): Promise<void> {
    const res = await this.client.request(`/containers/${id}/start`, {
      method: 'POST',
    });
    // 204 started, 304 already running — both ok
    if (!res.ok && res.status !== 304) {
      throw await failWith('start-failed', res, `start ${id}`);
    }
  }
}

// ---- translation helpers ---------------------------------------------

interface DockerCreateBody {
  Image: string;
  Cmd?: string[];
  Env?: string[];
  Labels?: Record<string, string>;
  ExposedPorts?: Record<string, Record<string, never>>;
  Healthcheck?: DockerHealthcheck;
  HostConfig: {
    Binds?: string[];
    Mounts?: DockerMount[];
    PortBindings?: Record<string, Array<{ HostPort?: string }>>;
    RestartPolicy?: { Name: string };
  };
}

interface DockerHealthcheck {
  Test: string[];
  Interval?: number; // nanoseconds
  Timeout?: number;
  Retries?: number;
  StartPeriod?: number;
}

interface DockerMount {
  Type: 'bind' | 'volume';
  Source: string;
  Target: string;
  ReadOnly?: boolean;
}

function translateDeployment(spec: ServiceDeployment): DockerCreateBody {
  const body: DockerCreateBody = {
    Image: `${spec.image.repository}:${spec.image.tag}`,
    Labels: {
      [LABEL_KEYS.managedBy]: MANAGED_BY_VALUE,
      [LABEL_KEYS.specHash]: spec.specHash,
      ...(spec.labels ?? {}),
    },
    HostConfig: {},
  };
  if (spec.command) body.Cmd = spec.command;
  if (spec.env) body.Env = Object.entries(spec.env).map(([k, v]) => `${k}=${v}`);
  if (spec.ports && spec.ports.length > 0) {
    body.ExposedPorts = {};
    body.HostConfig.PortBindings = {};
    for (const p of spec.ports) {
      const key = `${p.containerPort}/${p.protocol ?? 'tcp'}`;
      body.ExposedPorts[key] = {};
      if (p.hostPort !== undefined) {
        body.HostConfig.PortBindings[key] = [{ HostPort: String(p.hostPort) }];
      } else {
        body.HostConfig.PortBindings[key] = [{}];
      }
    }
  }
  if (spec.volumes && spec.volumes.length > 0) {
    body.HostConfig.Mounts = spec.volumes.map((v) => ({
      Type: v.hostPath ? 'bind' : 'volume',
      Source: v.hostPath ?? v.name ?? '',
      Target: v.containerPath,
      ReadOnly: v.readOnly,
    }));
  }
  if (spec.healthcheck) {
    body.Healthcheck = {
      Test: spec.healthcheck.test,
      ...(spec.healthcheck.intervalMs !== undefined && {
        Interval: spec.healthcheck.intervalMs * 1_000_000,
      }),
      ...(spec.healthcheck.timeoutMs !== undefined && {
        Timeout: spec.healthcheck.timeoutMs * 1_000_000,
      }),
      ...(spec.healthcheck.retries !== undefined && { Retries: spec.healthcheck.retries }),
      ...(spec.healthcheck.startPeriodMs !== undefined && {
        StartPeriod: spec.healthcheck.startPeriodMs * 1_000_000,
      }),
    };
  }
  if (spec.restartPolicy) {
    body.HostConfig.RestartPolicy = { Name: spec.restartPolicy };
  }
  return body;
}

interface ContainerInspectResponse {
  Id: string;
  Name: string;
  Created: string;
  State: {
    Running: boolean;
    Health?: { Status: 'healthy' | 'unhealthy' | 'starting' | 'none' };
  };
  Config: {
    Labels: Record<string, string> | null;
  };
  NetworkSettings: {
    Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null> | null;
  };
}

interface ContainerListItem {
  Id: string;
  Names: string[];
  Labels: Record<string, string>;
}

interface ImageInspectResponse {
  Architecture?: string;
  Os?: string;
}

function toServiceInstance(body: ContainerInspectResponse): ServiceInstance {
  const labels = body.Config.Labels ?? {};
  const specHash = labels[LABEL_KEYS.specHash] ?? null;
  const health =
    body.State.Health?.Status === 'none' ? undefined : body.State.Health?.Status;

  let endpoint: { host: string; port: number } | null = null;
  const ports = body.NetworkSettings.Ports ?? {};
  for (const [, bindings] of Object.entries(ports)) {
    if (!bindings || bindings.length === 0) continue;
    const b = bindings[0];
    if (!b) continue;
    const port = Number.parseInt(b.HostPort, 10);
    if (!Number.isFinite(port)) continue;
    // 0.0.0.0 / :: bindings — route to 127.0.0.1 for local use.
    const host = b.HostIp === '0.0.0.0' || b.HostIp === '::' || !b.HostIp
      ? '127.0.0.1'
      : b.HostIp;
    endpoint = { host, port };
    break;
  }

  return {
    ref: { name: trimContainerName(body.Name) },
    running: body.State.Running,
    health,
    specHash,
    createdAt: body.Created,
    endpoint,
  };
}

function trimContainerName(name: string): string {
  // Docker inspect returns names with a leading '/' (legacy
  // convention from when containers were tree-addressed).
  return name.startsWith('/') ? name.slice(1) : name;
}

function normalizeArch(a: string): string {
  // node 'x64' ↔ docker 'amd64'; 'arm64' is identical.
  if (a === 'x64') return 'amd64';
  return a;
}

function normalizeOs(o: string): string {
  // node 'darwin' / 'linux' match docker's values.
  return o;
}
