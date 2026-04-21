/**
 * Service specs — the high-level, runtime-agnostic description of a
 * supporting-infra container (chroma vector store, pgvector Postgres,
 * escape-hatch generic container). Composite manifests include one
 * or more of these under `spec.services`; the ServiceHandler
 * registry (`./handlers/registry.ts`) translates each into a
 * `ServiceDeployment` consumable by any `RuntimeBackend`.
 *
 * Design rules:
 *   - `runtime: 'external'` is opt-in — for operators whose Postgres
 *     / Chroma already runs elsewhere. The applier short-circuits
 *     external services (nothing to spawn) and uses the resolved
 *     endpoint directly to wire up dependents.
 *   - Image defaults are pinned (no implicit `latest`). Callers who
 *     want a newer pgvector supply the override in the spec.
 *   - Schemas stay runtime-agnostic. No Docker-specific fields
 *     (privileged, host-network, …) leak into v1.
 */
import { z } from 'zod';

/**
 * Spec-level secret declaration. Keys are container env-var names;
 * values carry a secret-ref string that flows through the unified
 * resolver at apply time. Supported ref syntax:
 *   - `env:VAR_NAME` / `$VAR_NAME`      (environment)
 *   - `keychain:service/account`         (macOS Keychain)
 *   - `file:/abs/path` / `file:~/path`  (filesystem)
 *   - legacy bare `/abs/path` / `~/...` (treated as file)
 *
 * Docker resolves each ref at translate time and merges into the
 * container env. k8s emits a `v1.Secret` + `secretKeyRef` so the
 * value never lands in the pod spec.
 */
export const ServiceSpecSecretsSchema = z.record(
  z.string().min(1),
  z.object({ ref: z.string().min(1) }),
);
export type ServiceSpecSecrets = z.infer<typeof ServiceSpecSecretsSchema>;

/**
 * Chroma vector store. Default image tag tracks the latest stable
 * as of the composite-infra plan; pin to an explicit tag in the
 * spec if reproducibility across hosts matters.
 */
export const ChromaServiceSpecSchema = z.object({
  kind: z.literal('chroma'),
  name: z.string().min(1),
  node: z.string().min(1),
  runtime: z.enum(['docker', 'external']).default('docker'),
  image: z
    .object({
      repository: z.string().default('chromadb/chroma'),
      tag: z.string().default('1.5.8'),
    })
    .optional(),
  persistence: z
    .object({
      volume: z.string().optional(),
      mountPath: z.string().default('/data'),
    })
    .optional(),
  port: z.number().int().positive().default(8000),
  externalEndpoint: z.string().optional(),
  secrets: ServiceSpecSecretsSchema.optional(),
});

/**
 * pgvector Postgres. The image ships the `vector` extension but does
 * not auto-run `CREATE EXTENSION vector;` — the operator (or a
 * later phase's post-start hook) must run it against each fresh
 * database. Documented as a deferred item on the pgvector handler.
 */
export const PgvectorServiceSpecSchema = z.object({
  kind: z.literal('pgvector'),
  name: z.string().min(1),
  node: z.string().min(1),
  runtime: z.enum(['docker', 'external']).default('docker'),
  image: z
    .object({
      repository: z.string().default('pgvector/pgvector'),
      tag: z.string().default('0.8.2-pg18-trixie'),
    })
    .optional(),
  database: z.string().default('postgres'),
  user: z.string().default('postgres'),
  passwordEnv: z.string().optional(),
  persistence: z
    .object({
      volume: z.string().optional(),
      mountPath: z.string().default('/var/lib/postgresql/data'),
    })
    .optional(),
  port: z.number().int().positive().default(5432),
  externalEndpoint: z.string().optional(),
  /**
   * Extra secret env vars beyond the domain-specific POSTGRES_PASSWORD
   * (which rides `passwordEnv`). Useful for operators who want to
   * inject, say, an SSL cert password or a pg_basebackup token via
   * Keychain / file refs without hand-editing the generated Secret.
   */
  secrets: ServiceSpecSecretsSchema.optional(),
});

/**
 * Escape-hatch generic container. No image defaults — callers must
 * supply repository + tag explicitly. Security ceiling stays
 * low-privilege (no `--privileged`, no host-network); raising it
 * requires an explicit field added to the schema in a later phase.
 */
export const GenericContainerServiceSpecSchema = z.object({
  kind: z.literal('container'),
  name: z.string().min(1),
  node: z.string().min(1),
  image: z.object({ repository: z.string().min(1), tag: z.string().min(1) }),
  env: z.record(z.string(), z.string()).default({}),
  ports: z
    .array(
      z.object({
        containerPort: z.number().int().positive(),
        hostPort: z.number().int().positive().optional(),
        protocol: z.enum(['tcp', 'udp']).default('tcp'),
      }),
    )
    .default([]),
  volumes: z
    .array(
      z.object({
        hostPath: z.string().optional(),
        name: z.string().optional(),
        containerPath: z.string().min(1),
        readOnly: z.boolean().default(false),
      }),
    )
    .default([]),
  healthcheck: z
    .object({
      test: z.array(z.string()).min(1),
      intervalMs: z.number().optional(),
      timeoutMs: z.number().optional(),
      retries: z.number().int().optional(),
    })
    .optional(),
  secrets: ServiceSpecSecretsSchema.optional(),
});

export const ServiceSpecSchema = z.discriminatedUnion('kind', [
  ChromaServiceSpecSchema,
  PgvectorServiceSpecSchema,
  GenericContainerServiceSpecSchema,
]);

export type ChromaServiceSpec = z.infer<typeof ChromaServiceSpecSchema>;
export type PgvectorServiceSpec = z.infer<typeof PgvectorServiceSpecSchema>;
export type GenericContainerServiceSpec = z.infer<
  typeof GenericContainerServiceSpecSchema
>;
export type ServiceSpec = z.infer<typeof ServiceSpecSchema>;
