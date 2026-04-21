/**
 * pgvector Postgres handler. Pure translation.
 *
 * Image: pgvector/pgvector:0.8.2-pg18-trixie by default. The image
 * ships the extension but does **not** auto-run
 * `CREATE EXTENSION vector;` on a fresh database — the operator
 * must run it, or a later phase's post-start hook will. This
 * handler deliberately does NOT mount an init-script (no pure-
 * translation way to emit arbitrary SQL payloads without drifting
 * into I/O). Flagged as a deferred item for Phase 4+ to revisit.
 *
 * Password handling: `passwordEnv` names a process env var that
 * holds the password at translate time. We resolve it here (pure
 * read of `process.env`) and embed the value in `POSTGRES_PASSWORD`
 * on the deployment. Operators who don't want the password in their
 * composite manifest can export the env var before running apply.
 *
 * The `resolvedEndpoint.url` redacts the password (`:REDACTED@`) —
 * the URL is for logs / UI only. Consumers that need the actual
 * connection string should resolve the env var themselves at
 * connect time.
 */
import type {
  ServiceDeployment,
  ServiceInstance,
} from '../../runtime/backend.js';
import { LABEL_KEYS, MANAGED_BY_VALUE } from '../../runtime/labels.js';
import { ServiceError } from '../errors.js';
import type { PgvectorServiceSpec } from '../schema.js';
import { sha256Hex } from './hash.js';
import type {
  ResolvedServiceEndpoint,
  ServiceHandler,
  HandlerTranslateOptions,
} from './types.js';

const DEFAULT_IMAGE_REPOSITORY = 'pgvector/pgvector';
const DEFAULT_IMAGE_TAG = '0.8.2-pg18-trixie';
// pg18+ expects the volume rooted at /var/lib/postgresql with `data/`
// as an image-managed subpath. Mounting directly at
// /var/lib/postgresql/data triggers a crashloop on pg18. Callers
// pinning pg16/pg17 must pass an explicit
// `persistence.mountPath: /var/lib/postgresql/data` override.
const DEFAULT_MOUNT_PATH = '/var/lib/postgresql';
const CONTAINER_PORT = 5432;

function resolveImage(spec: PgvectorServiceSpec): {
  repository: string;
  tag: string;
} {
  return {
    repository: spec.image?.repository ?? DEFAULT_IMAGE_REPOSITORY,
    tag: spec.image?.tag ?? DEFAULT_IMAGE_TAG,
  };
}

function resolveMountPath(spec: PgvectorServiceSpec): string {
  return spec.persistence?.mountPath ?? DEFAULT_MOUNT_PATH;
}

/**
 * Format the password env var as a unified secret ref. The
 * translate-time value goes through the backend's secret resolver at
 * apply time — Docker materializes an env entry; k8s will emit a
 * Secret + secretKeyRef.
 */
function passwordSecretRef(spec: PgvectorServiceSpec): string | undefined {
  if (!spec.passwordEnv) return undefined;
  return `env:${spec.passwordEnv}`;
}

function hashMaterial(spec: PgvectorServiceSpec): Record<string, unknown> {
  const image = resolveImage(spec);
  const persistence = spec.persistence
    ? { volume: spec.persistence.volume, mountPath: resolveMountPath(spec) }
    : undefined;
  // Hash the **env var name**, not its value: rotating the actual
  // password shouldn't force a container recreate; changing which
  // env var holds it is a material change.
  return {
    kind: spec.kind,
    runtime: spec.runtime,
    image,
    port: spec.port,
    database: spec.database,
    user: spec.user,
    passwordEnv: spec.passwordEnv,
    persistence,
    externalEndpoint: spec.externalEndpoint,
    secrets: spec.secrets,
  };
}

export const pgvectorHandler: ServiceHandler<PgvectorServiceSpec> = {
  kind: 'pgvector',

  validate(spec) {
    if (spec.runtime === 'external') {
      if (!spec.externalEndpoint || spec.externalEndpoint.length === 0) {
        throw new ServiceError(
          'spec-invalid',
          `pgvector service '${spec.name}': runtime='external' requires externalEndpoint`,
        );
      }
      if (spec.image) {
        throw new ServiceError(
          'spec-invalid',
          `pgvector service '${spec.name}': runtime='external' cannot set image — remove it or switch runtime to 'docker'`,
        );
      }
      return;
    }
    if (spec.externalEndpoint && spec.externalEndpoint.length > 0) {
      throw new ServiceError(
        'spec-invalid',
        `pgvector service '${spec.name}': runtime='docker' cannot set externalEndpoint — remove it or switch runtime to 'external'`,
      );
    }
    // Password resolution is deferred to backend apply time — the
    // unified resolver handles env / keychain / file uniformly and
    // surfaces the missing-ref error there. We validate only the
    // spec shape here; keeping handlers pure.
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
    const passwordRef = passwordSecretRef(spec);
    const hash = pgvectorHandler.computeSpecHash(spec);
    const name = `llamactl-pgvector-${opts.compositeName}-${spec.name}`;
    const mountPath = resolveMountPath(spec);

    const env: Record<string, string> = {
      POSTGRES_DB: spec.database,
      POSTGRES_USER: spec.user,
    };

    const deployment: ServiceDeployment = {
      name,
      image,
      env,
      ports: [
        { containerPort: CONTAINER_PORT, hostPort: spec.port, protocol: 'tcp' },
      ],
      labels: {
        [LABEL_KEYS.managedBy]: MANAGED_BY_VALUE,
        [LABEL_KEYS.composite]: opts.compositeName,
        [LABEL_KEYS.service]: spec.name,
        [LABEL_KEYS.specHash]: hash,
      },
      // Exec form (no shell) — substitute the user at translate
      // time. A shell form with `$POSTGRES_USER` would rely on the
      // container env being set; exec form keeps us robust.
      healthcheck: {
        test: ['CMD', 'pg_isready', '-U', spec.user],
        intervalMs: 10_000,
        timeoutMs: 3_000,
        retries: 10,
      },
      restartPolicy: 'unless-stopped',
      // pgvector is stateful — the k8s backend translates to a
      // StatefulSet + headless Service + volumeClaimTemplates so
      // each pod gets sticky storage. Docker ignores the field.
      controllerKind: 'statefulset',
      specHash: hash,
    };

    // Merge domain-specific password ref with operator-supplied
    // secrets so callers can add extras (SSL cert passwords, replica
    // tokens) alongside POSTGRES_PASSWORD. Explicit spec.secrets keys
    // override the domain default so an operator can route
    // POSTGRES_PASSWORD through a different ref without losing the
    // other entries.
    const secrets: Record<string, { ref: string }> = {};
    if (passwordRef) {
      secrets.POSTGRES_PASSWORD = { ref: passwordRef };
    }
    if (spec.secrets) {
      for (const [k, v] of Object.entries(spec.secrets)) {
        secrets[k] = v;
      }
    }
    if (Object.keys(secrets).length > 0) {
      deployment.secrets = secrets;
    }

    if (spec.persistence?.volume) {
      const v = spec.persistence.volume;
      deployment.volumes = [
        v.startsWith('/')
          ? { hostPath: v, containerPath: mountPath }
          : { name: v, containerPath: mountPath },
      ];
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
          `pgvector service '${spec.name}': externalEndpoint is missing`,
        );
      }
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch (err) {
        throw new ServiceError(
          'spec-invalid',
          `pgvector service '${spec.name}': externalEndpoint '${raw}' is not a valid URL`,
          err,
        );
      }
      const port = parsed.port ? Number(parsed.port) : CONTAINER_PORT;
      return { host: parsed.hostname, port, url: raw };
    }

    if (!instance || !instance.endpoint) {
      throw new ServiceError(
        'endpoint-unresolvable',
        `pgvector service '${spec.name}': docker runtime has no reachable endpoint yet (instance=${instance ? 'present-no-endpoint' : 'null'})`,
      );
    }
    const { host, port } = instance.endpoint;
    const url = `postgres://${spec.user}:REDACTED@${host}:${port}/${spec.database}`;
    return { host, port, url };
  },
};
