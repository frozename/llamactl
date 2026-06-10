export { type DraftContext, draftPipeline, type DraftResult } from "./draft.js";
export {
  createPipelineEventBus,
  PIPELINE_RETENTION_MS,
  type PipelineEventBus,
  pipelineEvents,
  type PipelineRun,
} from "./event-bus.js";
export { FETCHERS } from "./fetchers/registry.js";
export { type Journal, type JournalEntry, openJournal, type PriorIngestion } from "./journal.js";
export {
  DEFAULT_STALE_THRESHOLD_MS,
  detectOrphanedRuns,
  type DetectOrphansOptions,
  findTrailingOrphan,
  JOURNAL_TAIL_LINES,
  type OrphanedRun,
} from "./orphan.js";
/**
 * Public surface for the RAG ingestion pipeline. Library-only — the
 * CLI / MCP / tRPC wrappers land in R1.b.
 */
export {
  type OpenAdapterResult,
  runPipeline,
  type RunPipelineOptions,
  type RunSummary,
} from "./runtime.js";
export {
  nextRunAt,
  type PipelineSchedulerHandle,
  type PipelineSchedulerOptions,
  type SchedulerJournalEntry,
  startPipelineScheduler,
  type TickReport,
} from "./scheduler.js";
export {
  FilesystemSourceSpecSchema,
  HttpSourceSpecSchema,
  MarkdownChunkTransformSchema,
  type RagPipelineManifest,
  RagPipelineManifestSchema,
  type RagPipelineSpec,
  RagPipelineSpecSchema,
  type SourceSpec,
  SourceSpecSchema,
  type TransformSpec,
  TransformSpecSchema,
} from "./schema.js";
export { TRANSFORMS } from "./transforms/registry.js";
export type { Fetcher, FetcherContext, LogEvent, RawDoc, Transform } from "./types.js";
