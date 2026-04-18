import { z } from 'zod';

/**
 * ModelRun — declarative request for "this model should run on this
 * node with these args". Analogous to a Kubernetes Pod spec scoped to
 * llama.cpp: the user writes one, `llamactl apply -f` reconciles
 * against the live node, and the optional controller daemon keeps
 * re-reconciling on a timer.
 *
 * Phase D scope uses a single-node workload (spec.node: string).
 * Phase E will widen this to spec.nodes: string[] for tensor-parallel
 * RPC coordinators without breaking v1 manifests (the reconciler
 * will accept either shape).
 */

export const ModelRunTargetSchema = z.object({
  /**
   * `rel` — a repo/file.gguf path resolved against the target node's
   * LLAMA_CPP_MODELS directory. `alias` — a preset name that the node
   * resolves via its own resolveTarget (e.g. "best", "fast").
   */
  kind: z.enum(['rel', 'alias']).default('rel'),
  value: z.string().min(1),
});

export const ModelRunEndpointSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8080),
});

export const ModelRunSpecSchema = z.object({
  node: z.string().min(1),
  target: ModelRunTargetSchema,
  extraArgs: z.array(z.string()).default([]),
  /**
   * Restart semantics for the optional controller daemon. `Always`
   * restarts the server whenever /health drops. `OnFailure` restarts
   * only when the exit code was non-zero. `Never` leaves a crashed
   * server alone. The imperative `apply` command always starts the
   * server once regardless of this value.
   */
  restartPolicy: z.enum(['Always', 'OnFailure', 'Never']).default('Always'),
  /** Optional — informational only in Phase D; carry-through for the
   *  Phase-D-and-beyond controller to prefer a specific endpoint. */
  endpoint: ModelRunEndpointSchema.optional(),
  timeoutSeconds: z.number().int().positive().max(600).default(60),
});

export const ModelRunConditionSchema = z.object({
  type: z.string(),
  status: z.enum(['True', 'False', 'Unknown']),
  reason: z.string().optional(),
  message: z.string().optional(),
  lastTransitionTime: z.string(),
});

export const ModelRunStatusSchema = z.object({
  phase: z.enum(['Pending', 'Running', 'Failed', 'Stopped']),
  serverPid: z.number().nullable().default(null),
  endpoint: z.string().nullable().default(null),
  lastTransitionTime: z.string(),
  conditions: z.array(ModelRunConditionSchema).default([]),
});

export const ModelRunMetadataSchema = z.object({
  name: z.string().regex(/^[a-z0-9][-a-z0-9]{0,62}$/,
    'name must be lowercase alphanumeric with dashes, max 63 chars'),
  labels: z.record(z.string(), z.string()).default({}),
});

export const ModelRunSchema = z.object({
  apiVersion: z.literal('llamactl/v1'),
  kind: z.literal('ModelRun'),
  metadata: ModelRunMetadataSchema,
  spec: ModelRunSpecSchema,
  status: ModelRunStatusSchema.optional(),
});

export type ModelRunTarget = z.infer<typeof ModelRunTargetSchema>;
export type ModelRunEndpoint = z.infer<typeof ModelRunEndpointSchema>;
export type ModelRunSpec = z.infer<typeof ModelRunSpecSchema>;
export type ModelRunCondition = z.infer<typeof ModelRunConditionSchema>;
export type ModelRunStatus = z.infer<typeof ModelRunStatusSchema>;
export type ModelRunMetadata = z.infer<typeof ModelRunMetadataSchema>;
export type ModelRun = z.infer<typeof ModelRunSchema>;
