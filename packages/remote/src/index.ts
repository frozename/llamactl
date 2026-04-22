export { router, type AppRouter } from './router.js';
export * as config from './config/kubeconfig.js';
export * as configSchema from './config/schema.js';
export * as agentConfig from './config/agent-config.js';
export * as bootstrapTokens from './config/bootstrap-tokens.js';
export * as siriusProviders from './config/sirius-providers.js';
export * as embersynth from './config/embersynth.js';
export * as providerNodes from './config/provider-nodes.js';
export * as auth from './server/auth.js';
export * as tls from './server/tls.js';
export { startAgentServer, type RunningAgent, type StartAgentOptions } from './server/serve.js';
export {
  createNodeClient,
  createRemoteNodeClient,
  type NodeClient,
  type TunnelSendFn,
  type TunnelSubscribeFn,
} from './client/node-client.js';
export {
  assertFingerprintMatch,
  buildPinnedLinks,
  makePinnedFetch,
  type PinnedFetch,
  type PinnedFetchFactory,
} from './client/links.js';
export type { ClusterNode, Config, NodeKind } from './config/schema.js';
export {
  LOCAL_NODE_NAME,
  LOCAL_NODE_ENDPOINT,
  resolveNodeKind,
} from './config/schema.js';
export * as workloadSchema from './workload/schema.js';
export * as workloadStore from './workload/store.js';
export * as workloadApply from './workload/apply.js';
export * as workloadGatewayHandlers from './workload/gateway-handlers/index.js';
export * as tunnel from './tunnel/index.js';
export * as workloadLock from './workload/lock.js';
export * as workloadReconciler from './workload/reconciler.js';
export * as noderunSchema from './workload/noderun-schema.js';
export * as noderunStore from './workload/noderun-store.js';
export * as noderunApply from './workload/noderun-apply.js';
export * as noderunReconciler from './workload/noderun-reconciler.js';
export * as infraLayout from './infra/layout.js';
export * as infraInstall from './infra/install.js';
export * as infraSpec from './infra/spec.js';
export * as infraServices from './infra/services.js';
export * as infraArtifactsFetch from './infra/artifacts-fetch.js';
export {
  KNOWN_OPS_CHAT_TOOLS,
  toolTier as opsChatToolTier,
  dispatchOpsChatTool,
  type OpsChatToolName,
  type ToolTier as OpsChatTier,
} from './ops-chat/dispatch.js';
export {
  appendOpsChatAudit,
  readOpsChatAudit,
  type OpsChatAuditEntry,
} from './ops-chat/audit.js';
export {
  runLoopExecutor,
  submitOutcome as submitOpsChatStepOutcome,
  sessionCount as opsChatSessionCount,
  resetSessions as resetOpsChatSessions,
  type LoopExecutorOptions,
} from './ops-chat/loop-executor.js';
export {
  OpsChatStreamEventSchema,
  OpsChatPlanProposedSchema,
  OpsChatRefusalSchema,
  OpsChatDoneSchema,
  OpsChatStepOutcomeSchema,
  type OpsChatStreamEvent,
  type OpsChatPlanProposed,
  type OpsChatRefusal,
  type OpsChatDone,
  type OpsChatStepOutcome,
} from './ops-chat/loop-schema.js';
export {
  createDockerBackend,
  DockerBackend,
  type DockerBackendOptions,
} from './runtime/docker/backend.js';
export {
  createKubernetesBackend,
  KubernetesBackend,
  type KubernetesBackendOptions,
} from './runtime/kubernetes/backend.js';
export {
  createKubernetesClient,
  type KubernetesClient,
  type KubernetesClientOptions,
} from './runtime/kubernetes/client.js';
export type {
  RuntimeBackend,
  ServiceDeployment,
  ServiceInstance,
  ServiceRef,
  ServiceFilter,
  RemoveServiceOptions,
} from './runtime/backend.js';
export {
  RuntimeError,
  type RuntimeErrorCode,
} from './runtime/errors.js';

// ---- RAG ingestion pipelines (R1.a + R1.b) ----
export {
  runPipeline,
  type RunPipelineOptions,
  type RunSummary,
  RagPipelineManifestSchema,
  RagPipelineSpecSchema,
  type RagPipelineManifest,
  type RagPipelineSpec,
  type SourceSpec,
  type TransformSpec,
  openJournal,
  type Journal,
  type JournalEntry,
  type PriorIngestion,
  startPipelineScheduler,
  nextRunAt,
  type PipelineSchedulerHandle,
  type PipelineSchedulerOptions,
  type TickReport,
  type SchedulerJournalEntry,
  draftPipeline,
  type DraftContext,
  type DraftResult,
} from './rag/pipeline/index.js';
export {
  applyPipeline,
  loadPipeline,
  listPipelines,
  removePipeline,
  writeLastRun,
  defaultPipelinesDir,
  pipelineDir,
  journalPathFor,
  type PipelineRecord,
} from './rag/pipeline/store.js';
export {
  runRagBench,
  RagBenchManifestSchema,
  RagBenchQuerySchema,
  type RagBenchManifest,
  type RagBenchQuery,
  type BenchReport,
  type PerQueryResult,
  type RagSearchCaller,
} from './rag/bench.js';

// ---- CLI subscription backends (Phase 1 of trifold-orchestrating-engelbart) ----
export {
  createCliSubprocessProvider,
  messagesToPrompt,
  CLI_PRESETS,
  resolvePreset,
  expandArgs,
  appendCliJournal,
  cliJournalPathFor,
  defaultCliJournalDir,
  type CliProviderOptions,
  type SpawnFn,
  type SpawnResult,
  type SpawnStreamFn,
  type SpawnStreamResult,
  type ResolvedCliInvocation,
  type CliJournalEntry,
} from './cli/index.js';
export {
  synthesizeProviderNodes,
  parseProviderNodeName,
  findCliBindingForNode,
} from './config/provider-nodes.js';
export {
  CliBindingSchema,
  CliPresetSchema,
  type CliBinding,
  type CliPreset,
} from './config/schema.js';
