import type {
  ModelHostHostedModel,
  ModelHostReadiness,
  ModelHostSpecForEngine,
} from "@llamactl/core/engines/types";

import { omitUndefined } from "@llamactl/core/object";
import { z } from "zod";

export const LOCAL_NODE_ID = "local" as const;

export const ModelHostHostedModelSchema = z
  .object({
    rel: z.string().min(1),
    // Optional LoRA adapter to serve alongside the base model. Resolved against
    // the same models dir as `rel` (training in packages/train emits adapters
    // there), so the engine can `--lora` an adapter without a second resolver.
    lora_path: z.string().min(1).optional(),
    dflash: z
      .object({
        enabled: z.boolean(),
        dflash_enabled: z.boolean().optional(),
        dflash_draft_model: z.string().min(1).nullable().optional(),
        dflash_draft_quant_enabled: z.boolean().optional(),
        dflash_draft_quant_weight_bits: z.number().int().optional(),
        dflash_draft_quant_activation_bits: z.number().int().optional(),
        dflash_draft_quant_group_size: z.number().int().optional(),
        dflash_max_ctx: z.number().int().optional(),
        dflash_in_memory_cache: z.boolean().optional(),
        dflash_in_memory_cache_max_entries: z.number().int().optional(),
        dflash_in_memory_cache_max_bytes: z.number().int().optional(),
        dflash_ssd_cache: z.boolean().optional(),
        dflash_draft_window_size: z.number().int().optional(),
        dflash_draft_sink_size: z.number().int().optional(),
        dflash_verify_mode: z.string().min(1).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ModelHostEndpointSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
  })
  .strict();

export const ModelHostReadinessSchema = z
  .object({
    path: z.string().startsWith("/"),
    expectStatus: z.number().int().default(200),
    expectJson: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .strict();

export const ModelHostSpecSchema = z
  .object({
    // Engine selection. The registry in packages/core/src/engines/ holds
    // the canonical list; this enum mirrors it. New engines land here when
    // their adapter is wired into ENGINES.
    engine: z.enum(["llamacpp", "omlx", "strata"]),
    node: z.string().min(1),
    enabled: z.boolean().default(true),
    binary: z.string().min(1),
    resources: z
      .object({
        expectedMemoryGiB: z.number().positive().optional(),
      })
      .optional(),
    endpoint: ModelHostEndpointSchema,
    hostedModels: z.array(ModelHostHostedModelSchema).min(1).max(1),
    extraArgs: z.array(z.string()).default([]),
    useProxy: z.boolean().optional(),
    restartPolicy: z.enum(["Always", "OnFailure", "Never"]).default("Always"),
    timeoutSeconds: z.number().int().positive().max(600).default(60),
    env: z.record(z.string(), z.string()).optional(),
    priority: z.number().int().min(0).max(100).optional(),
    // Opt-in for binding the engine to a non-loopback host. Deliberately NOT
    // .default(false): a defaulted key would be serialized into every manifest
    // the controller sends, and older remote agents reject unknown keys on
    // this strict schema. Absent means false.
    allowExternalBind: z.boolean().optional(),
    // Opt-in readiness probe (issue #220): engines that list their id on
    // /v1/models before they can serve (Gufo) declare a probe endpoint that
    // actually means "can serve". Absent means today's /v1/models behaviour.
    readiness: ModelHostReadinessSchema.optional(),
  })
  .strict();

export const ModelHostManifestSchema = z
  .object({
    apiVersion: z.literal("llamactl/v1"),
    kind: z.literal("ModelHost"),
    metadata: z
      .object({
        name: z
          .string()
          .regex(
            /^[a-z0-9][-a-z0-9]{0,62}$/,
            "name must be lowercase alphanumeric with dashes, max 63 chars",
          ),
        labels: z.record(z.string(), z.string()).optional(),
      })
      .strict(),
    spec: ModelHostSpecSchema,
  })
  .strict();

export type ModelHostManifest = z.infer<typeof ModelHostManifestSchema>;
export type ModelHostSpec = z.infer<typeof ModelHostSpecSchema>;

// Mirrors LOOPBACK_HOSTS in packages/core/src/server.ts: hosts in this set
// are unreachable from outside the machine, so they need no opt-in.
const LOCAL_BIND_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * The first bind host on the ModelHost launch path that is not loopback:
 * `spec.endpoint.host` first, then every `--host <v>` / `--host=<v>` value in
 * `spec.extraArgs` (the engines append extraArgs after their own `--host`, so
 * a later occurrence wins on the command line too). Null when every candidate
 * is local.
 */
export function modelHostExternalBindHost(
  spec: Pick<ModelHostSpec, "endpoint" | "extraArgs">,
): string | null {
  const candidates: string[] = [spec.endpoint.host];
  for (let i = 0; i < spec.extraArgs.length; i += 1) {
    const token = spec.extraArgs[i];
    if (token === "--host") {
      const value = spec.extraArgs[i + 1];
      if (value !== undefined) candidates.push(value);
    } else if (token?.startsWith("--host=")) {
      candidates.push(token.slice("--host=".length));
    }
  }
  return candidates.find((host) => !LOCAL_BIND_HOSTS.has(host)) ?? null;
}

/**
 * Refusal message when the manifest would bind an unauthenticated engine to a
 * non-loopback host without `allowExternalBind: true`, else null.
 */
export function modelHostBindRefusal(manifest: ModelHostManifest): string | null {
  const host = modelHostExternalBindHost(manifest.spec);
  if (host === null) return null;
  if (manifest.spec.allowExternalBind === true) return null;
  return `refusing to bind ModelHost ${manifest.metadata.name} to ${host} without \`allowExternalBind: true\` in the workload spec`;
}

/**
 * Normalize a parsed `ModelHostSpec` so its optional `resources.expectedMemoryGiB`
 * is ABSENT rather than `undefined`. Zod's `.optional()` infers `number | undefined`,
 * but `computeModelHostSpecHash` (and other consumers) declare the field under
 * `exactOptionalPropertyTypes` as `{ expectedMemoryGiB?: number }`. Reconstructing
 * the object with a conditional-spread keeps the value JSON-identical (an undefined
 * property is dropped by `JSON.stringify` either way) while satisfying the type.
 */
export function specForHash(
  spec: ModelHostSpec,
): Omit<ModelHostSpec, "resources"> & { resources?: { expectedMemoryGiB?: number } } {
  const { resources, ...rest } = spec;
  return {
    ...rest,
    ...(resources !== undefined
      ? {
          resources: {
            ...(resources.expectedMemoryGiB !== undefined
              ? { expectedMemoryGiB: resources.expectedMemoryGiB }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * Normalize a single parsed hosted-model entry into the engine-layer
 * `ModelHostHostedModel` shape. Zod's `.optional()` infers each optional as
 * `T | undefined`, but the engine interface (under exactOptionalPropertyTypes)
 * declares them as absent-or-present. Reconstructing with conditional-spreads
 * keeps the value runtime-identical (an undefined optional is equivalent to an
 * absent one for the engine boot path) while satisfying the stricter type.
 */
function normalizeHostedModel(m: ModelHostSpec["hostedModels"][number]): ModelHostHostedModel {
  const { dflash } = m;
  return {
    rel: m.rel,
    ...omitUndefined({ lora_path: m.lora_path }),
    ...(dflash !== undefined
      ? {
          dflash: {
            enabled: dflash.enabled,
            ...omitUndefined({
              dflash_enabled: dflash.dflash_enabled,
              dflash_draft_model: dflash.dflash_draft_model,
              dflash_draft_quant_enabled: dflash.dflash_draft_quant_enabled,
              dflash_draft_quant_weight_bits: dflash.dflash_draft_quant_weight_bits,
              dflash_draft_quant_activation_bits: dflash.dflash_draft_quant_activation_bits,
              dflash_draft_quant_group_size: dflash.dflash_draft_quant_group_size,
              dflash_max_ctx: dflash.dflash_max_ctx,
              dflash_in_memory_cache: dflash.dflash_in_memory_cache,
              dflash_in_memory_cache_max_entries: dflash.dflash_in_memory_cache_max_entries,
              dflash_in_memory_cache_max_bytes: dflash.dflash_in_memory_cache_max_bytes,
              dflash_ssd_cache: dflash.dflash_ssd_cache,
              dflash_draft_window_size: dflash.dflash_draft_window_size,
              dflash_draft_sink_size: dflash.dflash_draft_sink_size,
              dflash_verify_mode: dflash.dflash_verify_mode,
            }),
          },
        }
      : {}),
  };
}

/**
 * Normalize a parsed readiness probe into the engine-layer `ModelHostReadiness`
 * shape. Zod infers `expectJson` as `T | undefined`, but the engine interface
 * (under exactOptionalPropertyTypes) declares it absent-or-present.
 */
export function normalizeReadiness(
  readiness: ModelHostSpec["readiness"],
): ModelHostReadiness | undefined {
  if (readiness === undefined) return undefined;
  return {
    path: readiness.path,
    expectStatus: readiness.expectStatus,
    ...omitUndefined({ expectJson: readiness.expectJson }),
  };
}

/**
 * Normalize a parsed `ModelHostSpec` into the engine-layer `ModelHostSpecForEngine`
 * shape. Bridges the zod-inferred `T | undefined` optionals (hosted-model and
 * resources fields) to the engine interface's absent-or-present optionals.
 */
export function specForEngine(spec: ModelHostSpec): ModelHostSpecForEngine {
  const readiness = normalizeReadiness(spec.readiness);
  return {
    engine: spec.engine,
    binary: spec.binary,
    endpoint: spec.endpoint,
    hostedModels: spec.hostedModels.map(normalizeHostedModel),
    extraArgs: spec.extraArgs,
    timeoutSeconds: spec.timeoutSeconds,
    ...(readiness !== undefined ? { readiness } : {}),
    ...(spec.resources !== undefined
      ? {
          resources: {
            ...(spec.resources.expectedMemoryGiB !== undefined
              ? { expectedMemoryGiB: spec.resources.expectedMemoryGiB }
              : {}),
          },
        }
      : {}),
  };
}
