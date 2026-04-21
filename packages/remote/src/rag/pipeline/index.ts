/**
 * Public surface for the RAG ingestion pipeline. Library-only — the
 * CLI / MCP / tRPC wrappers land in R1.b.
 */
export {
  runPipeline,
  type RunPipelineOptions,
  type RunSummary,
  type OpenAdapterResult,
} from './runtime.js';
export {
  openJournal,
  type Journal,
  type JournalEntry,
  type PriorIngestion,
} from './journal.js';
export {
  startPipelineScheduler,
  nextRunAt,
  type PipelineSchedulerHandle,
  type PipelineSchedulerOptions,
  type TickReport,
  type SchedulerJournalEntry,
} from './scheduler.js';
export {
  RagPipelineSpecSchema,
  RagPipelineManifestSchema,
  SourceSpecSchema,
  TransformSpecSchema,
  FilesystemSourceSpecSchema,
  HttpSourceSpecSchema,
  MarkdownChunkTransformSchema,
  type RagPipelineSpec,
  type RagPipelineManifest,
  type SourceSpec,
  type TransformSpec,
} from './schema.js';
export type { RawDoc, Fetcher, Transform, FetcherContext, LogEvent } from './types.js';
export { FETCHERS } from './fetchers/registry.js';
export { TRANSFORMS } from './transforms/registry.js';
