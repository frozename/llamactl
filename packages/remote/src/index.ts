// ---- CLI subscription backends (Phase 1 of trifold-orchestrating-engelbart) ----
export {
  appendCliJournal,
  CLI_PRESETS,
  type CliJournalEntry,
  cliJournalPathFor,
  type CliProviderOptions,
  createCliSubprocessProvider,
  defaultCliJournalDir,
  expandArgs,
  messagesToPrompt,
  type ResolvedCliInvocation,
  resolvePreset,
  type SpawnFn,
  type SpawnResult,
  type SpawnStreamFn,
  type SpawnStreamResult,
} from "./cli/index.js";
export * from "./client/infra-client.js";
export {
  assertFingerprintMatch,
  buildPinnedLinks,
  makePinnedFetch,
  type PinnedFetch,
  type PinnedFetchFactory,
} from "./client/links.js";
export {
  createNodeClient,
  createRemoteNodeClient,
  type NodeClient,
  type TunnelSendFn,
  type TunnelSubscribeFn,
} from "./client/node-client.js";
export * as agentConfig from "./config/agent-config.js";
export * as bootstrapTokens from "./config/bootstrap-tokens.js";
export * as embersynth from "./config/embersynth.js";
export * as config from "./config/kubeconfig.js";
export { listPeers, type PeerNode } from "./config/peers.js";
export * as providerNodes from "./config/provider-nodes.js";
export {
  findCliBindingForNode,
  parseProviderNodeName,
  synthesizeProviderNodes,
} from "./config/provider-nodes.js";
export * as configSchema from "./config/schema.js";
export type { ClusterNode, Config, NodeKind } from "./config/schema.js";
export { LOCAL_NODE_ENDPOINT, LOCAL_NODE_NAME, resolveNodeKind } from "./config/schema.js";
export {
  type CliBinding,
  CliBindingSchema,
  type CliPreset,
  CliPresetSchema,
} from "./config/schema.js";
export * as siriusProviders from "./config/sirius-providers.js";
export * as infraArtifactsFetch from "./infra/artifacts-fetch.js";
export * as infraInstall from "./infra/install.js";
export * as infraLayout from "./infra/layout.js";
export * as infraServices from "./infra/services.js";
export * as infraSpec from "./infra/spec.js";
export { appendOpsChatAudit, type OpsChatAuditEntry, readOpsChatAudit } from "./ops-chat/audit.js";
export {
  dispatchOpsChatTool,
  KNOWN_OPS_CHAT_TOOLS,
  type ToolTier as OpsChatTier,
  type OpsChatToolName,
  toolTier as opsChatToolTier,
} from "./ops-chat/dispatch.js";
export {
  type LoopExecutorOptions,
  sessionCount as opsChatSessionCount,
  resetSessions as resetOpsChatSessions,
  runLoopExecutor,
  submitOutcome as submitOpsChatStepOutcome,
} from "./ops-chat/loop-executor.js";
export {
  type OpsChatDone,
  OpsChatDoneSchema,
  type OpsChatPlanProposed,
  OpsChatPlanProposedSchema,
  type OpsChatRefusal,
  OpsChatRefusalSchema,
  type OpsChatStepOutcome,
  OpsChatStepOutcomeSchema,
  type OpsChatStreamEvent,
  OpsChatStreamEventSchema,
} from "./ops-chat/loop-schema.js";
export {
  checkRefusal,
  DEFAULT_REFUSAL_RULES,
  normalizeGoal,
  type RefusalMatch,
} from "./ops-chat/refusals.js";
export { providerForCloudNode, providerForNode } from "./providers/factory.js";
export {
  type BenchReport,
  type PerQueryResult,
  type RagBenchManifest,
  RagBenchManifestSchema,
  type RagBenchQuery,
  RagBenchQuerySchema,
  type RagSearchCaller,
  runRagBench,
} from "./rag/bench.js";
// ---- RAG ingestion pipelines (R1.a + R1.b) ----
export {
  type DraftContext,
  draftPipeline,
  type DraftResult,
  type Journal,
  type JournalEntry,
  nextRunAt,
  openJournal,
  type PipelineSchedulerHandle,
  type PipelineSchedulerOptions,
  type PriorIngestion,
  type RagPipelineManifest,
  RagPipelineManifestSchema,
  type RagPipelineSpec,
  RagPipelineSpecSchema,
  runPipeline,
  type RunPipelineOptions,
  type RunSummary,
  type SchedulerJournalEntry,
  type SourceSpec,
  startPipelineScheduler,
  type TickReport,
  type TransformSpec,
} from "./rag/pipeline/index.js";
export {
  applyPipeline,
  defaultPipelinesDir,
  journalPathFor,
  listPipelines,
  loadPipeline,
  pipelineDir,
  type PipelineRecord,
  removePipeline,
  writeLastRun,
} from "./rag/pipeline/store.js";
export { type AppRouter, router } from "./router.js";
export type {
  RemoveServiceOptions,
  RuntimeBackend,
  ServiceDeployment,
  ServiceFilter,
  ServiceInstance,
  ServiceRef,
} from "./runtime/backend.js";
export {
  createDockerBackend,
  DockerBackend,
  type DockerBackendOptions,
} from "./runtime/docker/backend.js";
export { RuntimeError, type RuntimeErrorCode } from "./runtime/errors.js";
export {
  createKubernetesBackend,
  KubernetesBackend,
  type KubernetesBackendOptions,
} from "./runtime/kubernetes/backend.js";
export {
  createKubernetesClient,
  type KubernetesClient,
  type KubernetesClientOptions,
} from "./runtime/kubernetes/client.js";
export * as auth from "./server/auth.js";
export { type RunningAgent, type StartAgentOptions, startAgentServer } from "./server/serve.js";
export * as tls from "./server/tls.js";
export * as tunnel from "./tunnel/index.js";
export * as workloadApply from "./workload/apply.js";
export * as workloadGatewayHandlers from "./workload/gateway-handlers/index.js";
export * as workloadLock from "./workload/lock.js";

export * as modelHostStore from "./workload/modelhost-store.js";
export * as noderunApply from "./workload/noderun-apply.js";
export * as noderunReconciler from "./workload/noderun-reconciler.js";

export * as noderunSchema from "./workload/noderun-schema.js";
export * as noderunStore from "./workload/noderun-store.js";
export * as workloadReconciler from "./workload/reconciler.js";

export * as workloadSchema from "./workload/schema.js";
export * as workloadStore from "./workload/store.js";
