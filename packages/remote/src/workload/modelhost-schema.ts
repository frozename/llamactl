import { z } from 'zod';

export const ModelHostHostedModelSchema = z.object({
  rel: z.string().min(1),
}).strict();

export const ModelHostEndpointSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
}).strict();

export const ModelHostSpecSchema = z.object({
  engine: z.enum(['omlx']),
  node: z.string().min(1),
  enabled: z.boolean().default(true),
  binary: z.string().min(1),
  resources: z.object({
    expectedMemoryGiB: z.number().positive().optional(),
  }).optional(),
  endpoint: ModelHostEndpointSchema,
  hostedModels: z.array(ModelHostHostedModelSchema).min(1).max(1),
  extraArgs: z.array(z.string()).default([]),
  restartPolicy: z.enum(['Always', 'OnFailure', 'Never']).default('Always'),
  timeoutSeconds: z.number().int().positive().max(600).default(60),
}).strict();

export const ModelHostManifestSchema = z.object({
  apiVersion: z.literal('llamactl/v1'),
  kind: z.literal('ModelHost'),
  metadata: z.object({
    name: z.string().min(1),
    labels: z.record(z.string(), z.string()).optional(),
  }).strict(),
  spec: ModelHostSpecSchema,
}).strict();

export type ModelHostManifest = z.infer<typeof ModelHostManifestSchema>;
export type ModelHostSpec = z.infer<typeof ModelHostSpecSchema>;
