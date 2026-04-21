/**
 * Zod schemas for the `RagPipeline` manifest shape. The manifest is
 * the declarative description of a single ingestion run: where to
 * pull documents from, how to transform them, and which rag node to
 * land them in. Schemas apply defaults, so callers can parse the
 * trimmed YAML shape and get back fully-populated objects.
 */
import { z } from 'zod';

export const FilesystemSourceSpecSchema = z.object({
  kind: z.literal('filesystem'),
  root: z.string().min(1),
  glob: z.string().default('**/*'),
  tag: z.record(z.string(), z.unknown()).optional(),
});

export const HttpSourceSpecSchema = z.object({
  kind: z.literal('http'),
  url: z.url(),
  max_depth: z.number().int().min(0).max(5).default(1),
  same_origin: z.boolean().default(true),
  ignore_robots: z.boolean().default(false),
  rate_limit_per_sec: z.number().positive().default(2),
  timeout_ms: z.number().int().positive().default(10_000),
  auth: z.object({ tokenRef: z.string().min(1) }).optional(),
  tag: z.record(z.string(), z.unknown()).optional(),
});

export const SourceSpecSchema = z.discriminatedUnion('kind', [
  FilesystemSourceSpecSchema,
  HttpSourceSpecSchema,
]);

export const MarkdownChunkTransformSchema = z.object({
  kind: z.literal('markdown-chunk'),
  chunk_size: z.number().int().positive().default(800),
  overlap: z.number().int().min(0).default(150),
  preserve_headings: z.boolean().default(true),
});

export const TransformSpecSchema = z.discriminatedUnion('kind', [
  MarkdownChunkTransformSchema,
]);

export const RagPipelineSpecSchema = z.object({
  destination: z.object({
    ragNode: z.string().min(1),
    collection: z.string().min(1),
  }),
  sources: z.array(SourceSpecSchema).min(1),
  transforms: z.array(TransformSpecSchema).default([]),
  concurrency: z.number().int().min(1).max(32).default(4),
  on_duplicate: z.enum(['skip']).default('skip'),
});

export const RagPipelineManifestSchema = z.object({
  apiVersion: z.literal('llamactl/v1'),
  kind: z.literal('RagPipeline'),
  metadata: z.object({ name: z.string().min(1) }),
  spec: RagPipelineSpecSchema,
});

export type FilesystemSourceSpec = z.infer<typeof FilesystemSourceSpecSchema>;
export type HttpSourceSpec = z.infer<typeof HttpSourceSpecSchema>;
export type MarkdownChunkTransform = z.infer<typeof MarkdownChunkTransformSchema>;
export type SourceSpec = z.infer<typeof SourceSpecSchema>;
export type TransformSpec = z.infer<typeof TransformSpecSchema>;
export type RagPipelineSpec = z.infer<typeof RagPipelineSpecSchema>;
export type RagPipelineManifest = z.infer<typeof RagPipelineManifestSchema>;
