import { z } from 'zod';

/**
 * Marker on YAML entries that llamactl writes on behalf of a composite.
 * Operator-authored entries omit this object entirely. Reference-counted
 * across composites — the same entry can be co-owned by multiple
 * composites, the union of which lives in `compositeNames`.
 */
export const CompositeOwnershipSchema = z.object({
  source: z.literal('composite'),
  compositeNames: z.array(z.string().min(1)).min(1),
  specHash: z.string().min(1),
});
export type CompositeOwnership = z.infer<typeof CompositeOwnershipSchema>;

/**
 * Common per-handler config carried on a composite gateway entry.
 * Strict on cross-handler fields (tags, displayName, priority) so
 * typos surface at apply time; `extra` is the escape hatch for
 * handler-specific opaque overrides.
 */
export const ProviderConfigCommonSchema = z
  .object({
    tags: z.array(z.string()).optional(),
    displayName: z.string().optional(),
    priority: z.number().int().min(1).max(10).optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ProviderConfigCommon = z.infer<typeof ProviderConfigCommonSchema>;

export interface ApplyConflict {
  kind: 'name' | 'shape';
  name: string;
  /** When kind=='name': 'operator'. When kind=='shape': describes the differing field. */
  detail: string;
}
