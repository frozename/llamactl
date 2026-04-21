/**
 * Generic container handler — the escape hatch for "run any image
 * under the composite applier". No image defaults; callers supply
 * everything explicitly.
 *
 * Security posture: the spec schema deliberately does NOT expose
 * host-network, privileged, cgroup overrides, or capability adds.
 * Raising the ceiling requires a schema change in a later phase.
 *
 * `resolvedEndpoint` picks the **first** declared port. Callers
 * with multiple ports should either declare the "primary" one first
 * or resolve via `listServices` / inspect directly.
 */
import type {
  ServiceDeployment,
  ServiceInstance,
  VolumeMount,
} from '../../runtime/backend.js';
import { LABEL_KEYS, MANAGED_BY_VALUE } from '../../runtime/labels.js';
import { ServiceError } from '../errors.js';
import type { GenericContainerServiceSpec } from '../schema.js';
import { sha256Hex } from './hash.js';
import type {
  ResolvedServiceEndpoint,
  ServiceHandler,
  HandlerTranslateOptions,
} from './types.js';

function hashMaterial(
  spec: GenericContainerServiceSpec,
): Record<string, unknown> {
  return {
    kind: spec.kind,
    image: spec.image,
    env: spec.env,
    ports: spec.ports,
    volumes: spec.volumes,
    healthcheck: spec.healthcheck,
    secrets: spec.secrets,
  };
}

export const genericContainerHandler: ServiceHandler<GenericContainerServiceSpec> =
  {
    kind: 'container',

    validate(spec) {
      if (!spec.image.repository || spec.image.repository.length === 0) {
        throw new ServiceError(
          'spec-invalid',
          `container service '${spec.name}': image.repository is required`,
        );
      }
      if (!spec.image.tag || spec.image.tag.length === 0) {
        throw new ServiceError(
          'spec-invalid',
          `container service '${spec.name}': image.tag is required (no implicit 'latest')`,
        );
      }
      for (const v of spec.volumes) {
        const hasHostPath = typeof v.hostPath === 'string' && v.hostPath.length > 0;
        const hasName = typeof v.name === 'string' && v.name.length > 0;
        if (hasHostPath && hasName) {
          throw new ServiceError(
            'spec-invalid',
            `container service '${spec.name}': volume at '${v.containerPath}' has both hostPath and name — pick one`,
          );
        }
      }
    },

    computeSpecHash(spec) {
      return sha256Hex(hashMaterial(spec));
    },

    toDeployment(
      spec,
      opts: HandlerTranslateOptions,
    ): ServiceDeployment | null {
      const hash = genericContainerHandler.computeSpecHash(spec);
      const name = `llamactl-container-${opts.compositeName}-${spec.name}`;

      const volumes: VolumeMount[] = spec.volumes.map((v) => {
        const mount: VolumeMount = {
          containerPath: v.containerPath,
          readOnly: v.readOnly,
        };
        if (v.hostPath !== undefined) mount.hostPath = v.hostPath;
        if (v.name !== undefined) mount.name = v.name;
        return mount;
      });

      const deployment: ServiceDeployment = {
        name,
        image: { repository: spec.image.repository, tag: spec.image.tag },
        env: spec.env,
        ports: spec.ports.map((p) => {
          const port: {
            containerPort: number;
            hostPort?: number;
            protocol: 'tcp' | 'udp';
          } = {
            containerPort: p.containerPort,
            protocol: p.protocol,
          };
          if (p.hostPort !== undefined) port.hostPort = p.hostPort;
          return port;
        }),
        labels: {
          [LABEL_KEYS.managedBy]: MANAGED_BY_VALUE,
          [LABEL_KEYS.composite]: opts.compositeName,
          [LABEL_KEYS.service]: spec.name,
          [LABEL_KEYS.specHash]: hash,
        },
        restartPolicy: 'unless-stopped',
        specHash: hash,
      };

      if (volumes.length > 0) deployment.volumes = volumes;
      if (spec.healthcheck) {
        deployment.healthcheck = {
          test: spec.healthcheck.test,
          ...(spec.healthcheck.intervalMs !== undefined
            ? { intervalMs: spec.healthcheck.intervalMs }
            : {}),
          ...(spec.healthcheck.timeoutMs !== undefined
            ? { timeoutMs: spec.healthcheck.timeoutMs }
            : {}),
          ...(spec.healthcheck.retries !== undefined
            ? { retries: spec.healthcheck.retries }
            : {}),
        };
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
      if (spec.ports.length === 0) {
        throw new ServiceError(
          'endpoint-unresolvable',
          `container service '${spec.name}': spec declares no ports — nothing to resolve`,
        );
      }
      if (!instance || !instance.endpoint) {
        // Fall back to the first declared port's `hostPort` (or
        // container port if no hostPort was pinned) so callers that
        // resolve pre-apply in a dryRun still get something usable.
        const first = spec.ports[0];
        if (!first) {
          throw new ServiceError(
            'endpoint-unresolvable',
            `container service '${spec.name}': no ports available`,
          );
        }
        const port = first.hostPort ?? first.containerPort;
        return {
          host: '127.0.0.1',
          port,
          url: `http://127.0.0.1:${port}`,
        };
      }
      const { host, port } = instance.endpoint;
      return { host, port, url: `http://${host}:${port}` };
    },
  };
