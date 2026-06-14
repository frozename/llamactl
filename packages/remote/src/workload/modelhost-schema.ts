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

export const ModelHostSpecSchema = z
  .object({
    // Engine selection. The registry in packages/core/src/engines/ holds
    // the canonical list; this enum mirrors it. New engines land here when
    // their adapter is wired into ENGINES.
    engine: z.enum(["llamacpp", "omlx"]),
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
