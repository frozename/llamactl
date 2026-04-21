/**
 * Chroma vector store handler. Pure translation from
 * `ChromaServiceSpec` to `ServiceDeployment`. No I/O.
 *
 * Image: chromadb/chroma:1.5.8 by default (pin your own tag in the
 * spec if reproducibility across hosts matters). Chroma exposes
 * port 8000 and persists under `/data`; healthcheck hits the
 * `/api/v1/heartbeat` endpoint the image also wires into its own
 * HEALTHCHECK directive.
 */
import type {
  ServiceDeployment,
  ServiceInstance,
} from '../../runtime/backend.js';
import { LABEL_KEYS, MANAGED_BY_VALUE } from '../../runtime/labels.js';
import { ServiceError } from '../errors.js';
import type { ChromaServiceSpec } from '../schema.js';
import { sha256Hex } from './hash.js';
import type {
  ResolvedServiceEndpoint,
  ServiceHandler,
  HandlerTranslateOptions,
} from './types.js';

const DEFAULT_IMAGE_REPOSITORY = 'chromadb/chroma';
const DEFAULT_IMAGE_TAG = '1.5.8';
const DEFAULT_MOUNT_PATH = '/data';
const CONTAINER_PORT = 8000;

function resolveImage(spec: ChromaServiceSpec): {
  repository: string;
  tag: string;
} {
  return {
    repository: spec.image?.repository ?? DEFAULT_IMAGE_REPOSITORY,
    tag: spec.image?.tag ?? DEFAULT_IMAGE_TAG,
  };
}

function resolveMountPath(spec: ChromaServiceSpec): string {
  return spec.persistence?.mountPath ?? DEFAULT_MOUNT_PATH;
}

function hashMaterial(spec: ChromaServiceSpec): Record<string, unknown> {
  const image = resolveImage(spec);
  const persistence = spec.persistence
    ? { volume: spec.persistence.volume, mountPath: resolveMountPath(spec) }
    : undefined;
  return {
    kind: spec.kind,
    runtime: spec.runtime,
    image,
    port: spec.port,
    persistence,
    externalEndpoint: spec.externalEndpoint,
    // Hash the secret refs, not their resolved values — rotating a
    // keychain secret behind the ref shouldn't recreate the pod,
    // but changing which ref is bound is a material change.
    secrets: spec.secrets,
  };
}

export const chromaHandler: ServiceHandler<ChromaServiceSpec> = {
  kind: 'chroma',

  validate(spec) {
    if (spec.runtime === 'external') {
      if (!spec.externalEndpoint || spec.externalEndpoint.length === 0) {
        throw new ServiceError(
          'spec-invalid',
          `chroma service '${spec.name}': runtime='external' requires externalEndpoint`,
        );
      }
      if (spec.image) {
        throw new ServiceError(
          'spec-invalid',
          `chroma service '${spec.name}': runtime='external' cannot set image — remove it or switch runtime to 'docker'`,
        );
      }
      return;
    }
    // runtime === 'docker'
    if (spec.externalEndpoint && spec.externalEndpoint.length > 0) {
      throw new ServiceError(
        'spec-invalid',
        `chroma service '${spec.name}': runtime='docker' cannot set externalEndpoint — remove it or switch runtime to 'external'`,
      );
    }
  },

  computeSpecHash(spec) {
    return sha256Hex(hashMaterial(spec));
  },

  toDeployment(
    spec,
    opts: HandlerTranslateOptions,
  ): ServiceDeployment | null {
    if (spec.runtime === 'external') return null;

    const image = resolveImage(spec);
    const hash = chromaHandler.computeSpecHash(spec);
    const name = `llamactl-chroma-${opts.compositeName}-${spec.name}`;
    const mountPath = resolveMountPath(spec);

    const deployment: ServiceDeployment = {
      name,
      image,
      ports: [
        { containerPort: CONTAINER_PORT, hostPort: spec.port, protocol: 'tcp' },
      ],
      labels: {
        [LABEL_KEYS.managedBy]: MANAGED_BY_VALUE,
        [LABEL_KEYS.composite]: opts.compositeName,
        [LABEL_KEYS.service]: spec.name,
        [LABEL_KEYS.specHash]: hash,
      },
      healthcheck: {
        test: [
          'CMD',
          'curl',
          '-f',
          `http://localhost:${CONTAINER_PORT}/api/v1/heartbeat`,
        ],
        intervalMs: 10_000,
        timeoutMs: 3_000,
        retries: 5,
      },
      restartPolicy: 'unless-stopped',
      specHash: hash,
    };

    if (spec.persistence?.volume) {
      const v = spec.persistence.volume;
      deployment.volumes = [
        v.startsWith('/')
          ? { hostPath: v, containerPath: mountPath }
          : { name: v, containerPath: mountPath },
      ];
    }

    if (spec.secrets && Object.keys(spec.secrets).length > 0) {
      deployment.secrets = spec.secrets;
    }

    return deployment;
  },

  resolvedEndpoint(
    spec,
    instance: ServiceInstance | null,
  ): ResolvedServiceEndpoint {
    if (spec.runtime === 'external') {
      const raw = spec.externalEndpoint;
      if (!raw) {
        throw new ServiceError(
          'spec-invalid',
          `chroma service '${spec.name}': externalEndpoint is missing`,
        );
      }
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch (err) {
        throw new ServiceError(
          'spec-invalid',
          `chroma service '${spec.name}': externalEndpoint '${raw}' is not a valid URL`,
          err,
        );
      }
      const port = parsed.port
        ? Number(parsed.port)
        : parsed.protocol === 'https:'
          ? 443
          : CONTAINER_PORT;
      return { host: parsed.hostname, port, url: raw };
    }

    // runtime === 'docker'
    if (!instance || !instance.endpoint) {
      throw new ServiceError(
        'endpoint-unresolvable',
        `chroma service '${spec.name}': docker runtime has no reachable endpoint yet (instance=${instance ? 'present-no-endpoint' : 'null'})`,
      );
    }
    const { host, port } = instance.endpoint;
    return { host, port, url: `http://${host}:${port}` };
  },
};
