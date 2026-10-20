import type { ResolvedEnv } from "@llamactl/core/types";

/**
 * InferenceRpcV1 worker procedures (P4.1, design §6.1). The worker owns
 * every accepted attempt: `submit` runs acceptance fencing — claims,
 * ownership at the expected epoch and incarnation, deadline, hops,
 * backend kind — before anything executes, and records the attempt
 * without starting it. `stream` attaches its single consumer and starts
 * the fixed deployment directly (no public routing, no exact or semantic
 * cache). A disconnected or cancelled stream aborts the engine request;
 * nothing is ever replayed.
 *
 * Only `local-model` deployments execute. The backend-kind registry is
 * closed by default: `cli`/`acp` stay `target-unavailable` until their
 * lifecycle packages register a backend, and `cloud-api` is never a
 * worker-RPC target. Until a worker publishes a host that lists versions,
 * the RPC is not advertised. A draining host stops advertising for new
 * requests while its attempts run to their terminal.
 */
import { type inferenceContracts, inferenceRpc, routingCatalog } from "@llamactl/core";
import { LOCAL_NODE_NAME } from "@llamactl/core/config/schema";
import { resolveEnv } from "@llamactl/core/env";
import { listLocalRoutes } from "@llamactl/core/workloadRuntime";
import {
  createOpenAICompatProvider,
  type ExecutionContentPayload,
  type ExecutionErrorCode,
  type ExecutionEventV1,
  type ExecutionFinishReason,
  type ExecutionTerminal,
  type UnifiedAiRequest,
  type UnifiedStreamEvent,
  type UsageObservationV1,
} from "@novaproto/contracts";
import { initTRPC } from "@trpc/server";
import { createHash, randomUUID } from "node:crypto";

type Claims = inferenceRpc.InferenceServiceClaimsV1;
type Deployment = routingCatalog.RouteAdvertisementV1;
type Envelope = inferenceContracts.InferenceEnvelopeV1;
type Rejection = inferenceRpc.InferenceRpcRejectionV1;
type StreamFrame = inferenceRpc.InferenceRpcStreamFrameV1;
type SubmitRequest = inferenceRpc.InferenceRpcSubmitRequestV1;
type SubmitResult = inferenceRpc.InferenceRpcSubmitResultV1;
type AttemptStatus = inferenceRpc.InferenceRpcAttemptStatusV1;

export interface InferenceRpcContext {
  /** Verified service claims; set server-side, never from client headers. */
  inferenceClaims?: Claims | undefined;
}

export type WorkerRpcBackendKind = Exclude<routingCatalog.BackendKind, "cloud-api">;

type BackendResult =
  | { ok: true; finishReason: ExecutionFinishReason }
  | { ok: false; code: ExecutionErrorCode; message: string };

export type WorkerRpcBackendEvent =
  | { type: "content"; payload: ExecutionContentPayload }
  | { type: "end"; result: BackendResult; usage: UsageObservationV1 };

/** Executes one fixed deployment. Registered per backend kind on the host. */
export interface WorkerRpcBackend {
  execute(
    deployment: Deployment,
    envelope: Envelope,
    signal: AbortSignal,
  ): AsyncIterable<WorkerRpcBackendEvent>;
}

export interface WorkerRpcHostOptions {
  workerId: string;
  /**
   * Versions this worker advertises; empty (the default) means not
   * advertised. A function is read on every call, so the advertisement
   * can stop for new requests while active attempts continue.
   */
  versions?:
    | readonly inferenceRpc.InferenceRpcVersion[]
    | (() => readonly inferenceRpc.InferenceRpcVersion[]);
  resolved?: ResolvedEnv | (() => ResolvedEnv);
  /** Extra catalog input (the P0.2 advertisement seam). Foreign-owned entries never run. */
  advertisements?: () => readonly Deployment[];
  /** The backend-kind registration point. Defaults to `local-model` only. */
  backends?: ReadonlyMap<WorkerRpcBackendKind, WorkerRpcBackend>;
  /** Defaults to the claims the server put on the request context. */
  resolveClaims?: (ctx: InferenceRpcContext) => Claims | undefined;
  maxActiveAttempts?: number;
  /**
   * Attempt records kept, unsettled and settled. A settled record is kept
   * until its deadline plus a grace period, so a resubmit before then gets
   * the existing record; at the cap, new submits are refused `overloaded`
   * rather than any record being forgotten early.
   */
  maxAttemptRecords?: number;
  /** An accepted attempt whose stream never attaches is cancelled unstarted. */
  streamAttachTimeoutMs?: number;
  incarnation?: string;
  now?: () => number;
}

export interface WorkerRpcHost {
  readonly workerId: string;
  readonly incarnation: string;
  resolveClaims(ctx: InferenceRpcContext): Claims | undefined;
  negotiate(
    claims: Claims | undefined,
    input: inferenceRpc.InferenceRpcNegotiateRequestV1,
  ): inferenceRpc.InferenceRpcNegotiateResultV1;
  catalog(claims: Claims | undefined): inferenceRpc.InferenceRpcCatalogResultV1;
  submit(claims: Claims | undefined, input: SubmitRequest): SubmitResult;
  stream(
    claims: Claims | undefined,
    input: inferenceRpc.InferenceRpcStreamRequestV1,
    signal: AbortSignal,
  ): AsyncIterable<StreamFrame>;
  status(
    claims: Claims | undefined,
    input: inferenceRpc.InferenceRpcStatusRequestV1,
  ): inferenceRpc.InferenceRpcStatusResultV1;
  cancel(
    claims: Claims | undefined,
    input: inferenceRpc.InferenceRpcCancelRequestV1,
  ): inferenceRpc.InferenceRpcCancelResultV1;
  /**
   * Stops advertising for new requests and resolves once every
   * unsettled attempt has settled and every open stream has delivered
   * its terminal. Attempts already accepted keep running.
   */
  drain(): Promise<void>;
  /** Cancels every unsettled attempt. */
  close(): void;
}

type StopReason = "cancel" | "deadline" | "disconnect" | "attach-timeout" | "close";

/** Whose an attempt is: the service, the credential scope and the tenant it ran under. */
interface AttemptOwner {
  serviceId: string;
  credentialScopeId: string;
  tenantId: string;
}

/** What an unsettled attempt needs to run; dropped when it settles. */
interface AttemptRun {
  deployment: Deployment;
  envelope: Envelope;
  backend: WorkerRpcBackend;
  controller: AbortController;
  timers: ReturnType<typeof setTimeout>[];
}

interface AttemptRecord {
  attemptId: string;
  requestId: string;
  cancelId: string;
  owner: AttemptOwner;
  deploymentId: string;
  /** The upstream model the deployment executes. */
  model: string;
  acceptedAt: string;
  /** The record is kept until then: its deadline plus RETENTION_GRACE_MS. */
  retainUntil: number;
  state: Exclude<inferenceRpc.InferenceRpcAttemptState, "unknown">;
  streamed: boolean;
  terminal: ExecutionTerminal | undefined;
  terminalSequence: number | undefined;
  /** Until the attempt settles. A settled record keeps only its status. */
  run: AttemptRun | undefined;
}

interface HostState {
  workerId: string;
  incarnation: string;
  versions: () => readonly inferenceRpc.InferenceRpcVersion[];
  draining: boolean;
  resolve: () => ResolvedEnv;
  advertisements: () => readonly Deployment[];
  backends: ReadonlyMap<WorkerRpcBackendKind, WorkerRpcBackend>;
  maxActive: number;
  maxRecords: number;
  attachTimeoutMs: number;
  now: () => number;
  records: Map<string, AttemptRecord>;
  cancelIds: Map<string, string>;
  lastSweep: number;
  active: number;
  /** Streams attached and not yet ended. */
  streams: number;
  idle: (() => void)[];
}

interface WorkerCatalog {
  generation: string;
  all: Deployment[];
  owned: Map<string, Deployment>;
}

const UNKNOWN_USAGE: UsageObservationV1 = Object.freeze({ source: "unknown" });
const DEFAULT_MAX_ACTIVE = 64;
const DEFAULT_MAX_RECORDS = 16_384;
const DEFAULT_ATTACH_TIMEOUT_MS = 30_000;
/** How long past its deadline a settled record still answers status and resubmits. */
const RETENTION_GRACE_MS = 60_000;
const SWEEP_INTERVAL_MS = 1_000;
const NO_SCOPE: Rejection = Object.freeze({
  code: "unauthorized-scope",
  message: "the service claims do not allow this operation",
});

// ---- local-model backend --------------------------------------------------

function engineBaseUrl(endpoint: string): string {
  const trimmed = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

// Local engines take no credential and must never receive one; the Nova
// provider always sets Authorization, so it is dropped before the dial.
const engineFetch = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const headers = new Headers(init?.headers);
  headers.delete("authorization");
  return fetch(input, { ...init, headers });
}) as typeof globalThis.fetch;

function resultFromDone(event: Extract<UnifiedStreamEvent, { type: "done" }>): BackendResult {
  if (event.completion !== "upstream") {
    return { ok: false, code: "incomplete", message: "the engine stream ended without completing" };
  }
  if (event.finish_reason === "error") {
    return { ok: false, code: "upstream-error", message: "the engine finished with an error" };
  }
  return { ok: true, finishReason: event.finish_reason ?? "stop" };
}

/**
 * Streams the fixed deployment through Nova's OpenAI-compatible provider:
 * the exact upstream model, never the public alias, with usage requested
 * so the terminal can report it as observed.
 */
export const localModelBackend: WorkerRpcBackend = {
  async *execute(deployment, envelope, signal): AsyncGenerator<WorkerRpcBackendEvent> {
    let usage: UsageObservationV1 = UNKNOWN_USAGE;
    const provider = createOpenAICompatProvider({
      name: deployment.providerKind ?? "local-model",
      baseUrl: engineBaseUrl(deployment.endpoint),
      apiKey: "",
      fetch: engineFetch,
      onUsageObservation: (snapshot) => {
        usage = snapshot.observation;
      },
    });
    const request = {
      ...envelope.nativeBody,
      model: deployment.upstreamModelId,
      stream_options: { include_usage: true },
    } as unknown as UnifiedAiRequest;
    let result: BackendResult = {
      ok: false,
      code: "incomplete",
      message: "the engine stream ended without a terminal event",
    };
    for await (const event of provider.streamResponse?.(request, signal) ?? []) {
      if (event.type === "chunk" || event.type === "tool_call") {
        yield { type: "content", payload: event };
        continue;
      }
      result =
        event.type === "done"
          ? resultFromDone(event)
          : { ok: false, code: "upstream-error", message: event.error.message };
    }
    yield { type: "end", result, usage };
  },
};

const DEFAULT_BACKENDS: ReadonlyMap<WorkerRpcBackendKind, WorkerRpcBackend> = new Map([
  ["local-model", localModelBackend],
]);

// ---- catalog and claims ---------------------------------------------------

function epochOf(deployment: Deployment): string | null {
  return deployment.deploymentEpoch.status === "known" ? deployment.deploymentEpoch.value : null;
}

function buildWorkerCatalog(state: HostState): WorkerCatalog {
  const catalog = routingCatalog.buildRouteCatalog({
    routes: listLocalRoutes(state.resolve()),
    nodeId: state.workerId,
    now: state.now(),
    advertisements: state.advertisements(),
  });
  const owned = catalog.deployments
    .filter((d) => d.ownerNodeId === state.workerId)
    .sort((a, b) => (a.deploymentId < b.deploymentId ? -1 : 1));
  const hash = createHash("sha256");
  for (const d of owned) {
    const identity = [
      d.deploymentId,
      d.upstreamModelId,
      d.publicModelIds,
      d.backendKind,
      epochOf(d),
      d.draining,
    ];
    hash.update(`${JSON.stringify(identity)}\n`);
  }
  return {
    generation: `gen-${hash.digest("hex").slice(0, 16)}`,
    all: catalog.deployments,
    owned: new Map(owned.map((d) => [d.deploymentId, d])),
  };
}

function backendFor(state: HostState, deployment: Deployment): WorkerRpcBackend | undefined {
  if (deployment.backendKind === "cloud-api") return undefined;
  return state.backends.get(deployment.backendKind);
}

function isAvailable(state: HostState, deployment: Deployment): boolean {
  return (
    backendFor(state, deployment) !== undefined &&
    epochOf(deployment) !== null &&
    !deployment.draining
  );
}

function authorized(
  claims: Claims | undefined,
  operation: inferenceRpc.InferenceRpcOperation,
): Claims | null {
  return claims?.operations.includes(operation) === true ? claims : null;
}

function inScope(claims: Claims, deployment: Deployment): boolean {
  return (
    claims.deployments.includes(deployment.deploymentId) ||
    claims.models.includes(deployment.upstreamModelId) ||
    deployment.publicModelIds.some((id) => claims.models.includes(id))
  );
}

/** What the worker advertises now: nothing while draining. */
function advertised(state: HostState): readonly inferenceRpc.InferenceRpcVersion[] {
  return state.draining ? [] : state.versions();
}

function versionRejection(state: HostState, message: string): Rejection {
  return { code: "unsupported-version", message, supportedVersions: [...advertised(state)] };
}

function notifyIdle(state: HostState): void {
  if (state.active > 0 || state.streams > 0) return;
  for (const resolve of state.idle.splice(0)) resolve();
}

function rejectedWith(rejection: Rejection): { outcome: "rejected"; rejection: Rejection } {
  return { outcome: "rejected", rejection };
}

// ---- negotiate / catalog --------------------------------------------------

function negotiate(
  state: HostState,
  claimsIn: Claims | undefined,
  input: inferenceRpc.InferenceRpcNegotiateRequestV1,
): inferenceRpc.InferenceRpcNegotiateResultV1 {
  const versions = advertised(state);
  if (versions.length === 0) return { outcome: "not-advertised", workerId: state.workerId };
  if (authorized(claimsIn, "negotiate") === null) return rejectedWith(NO_SCOPE);
  const version = inferenceRpc.selectInferenceRpcVersion(input.versions, versions);
  if (version === null) {
    return rejectedWith(versionRejection(state, "no common InferenceRpc version"));
  }
  const known = new Set(inferenceRpc.INFERENCE_RPC_FEATURES);
  const unknownRequired = input.requiredFeatures.filter((f) => !known.has(f));
  if (unknownRequired.length > 0) {
    return rejectedWith({
      code: "unsupported-feature",
      message: `unsupported required features: ${unknownRequired.join(", ")}`,
      unsupportedFeatures: unknownRequired,
    });
  }
  const features = [...new Set([...input.requiredFeatures, ...input.optionalFeatures])]
    .filter((f) => known.has(f))
    .sort();
  return {
    outcome: "negotiated",
    version,
    workerId: state.workerId,
    workerIncarnation: state.incarnation,
    features,
  };
}

function listCatalog(
  state: HostState,
  claimsIn: Claims | undefined,
): inferenceRpc.InferenceRpcCatalogResultV1 {
  const claims = authorized(claimsIn, "catalog");
  if (claims === null) return rejectedWith(NO_SCOPE);
  const catalog = buildWorkerCatalog(state);
  const deployments = [...catalog.owned.values()]
    .filter((d) => inScope(claims, d))
    .map((d) => ({
      deploymentId: d.deploymentId,
      model: d.upstreamModelId,
      publicModelIds: [...d.publicModelIds],
      backendKind: d.backendKind,
      deploymentEpoch: epochOf(d),
      availability: isAvailable(state, d) ? ("available" as const) : ("unavailable" as const),
    }));
  return {
    outcome: "catalog",
    workerId: state.workerId,
    workerIncarnation: state.incarnation,
    catalogGeneration: catalog.generation,
    deployments,
  };
}

// ---- submit: acceptance fencing -------------------------------------------

function fenceClaims(
  claims: Claims,
  input: SubmitRequest,
  target: Deployment | undefined,
): Rejection | null {
  const { envelope } = input;
  if (!claims.tenants.includes(envelope.tenantId)) {
    return {
      code: "unauthorized-scope",
      message: `tenant '${envelope.tenantId}' is outside the service claims`,
    };
  }
  if (envelope.credentialScopeId !== claims.credentialScopeId) {
    return {
      code: "unauthorized-scope",
      message: "credential scope is outside the service claims",
    };
  }
  const allowed =
    target === undefined
      ? claims.deployments.includes(input.target.deploymentId)
      : inScope(claims, target);
  return allowed
    ? null
    : {
        code: "unauthorized-scope",
        message: `deployment '${input.target.deploymentId}' is outside the service claims`,
      };
}

function stale(message: string, catalog: WorkerCatalog): Rejection {
  return { code: "stale-generation", message, catalogGeneration: catalog.generation };
}

/** X2: the worker owns the deployment at the expected epoch, incarnation and generation. */
function fenceOwnership(
  state: HostState,
  catalog: WorkerCatalog,
  target: inferenceRpc.InferenceRpcTargetV1,
): { deployment: Deployment } | { rejection: Rejection } {
  const deployment = catalog.owned.get(target.deploymentId);
  if (deployment === undefined) {
    return {
      rejection: {
        code: "not-owner",
        message: `worker '${state.workerId}' does not own deployment '${target.deploymentId}'`,
      },
    };
  }
  if (target.workerIncarnation !== state.incarnation) {
    return { rejection: stale("the worker restarted since the caller's catalog", catalog) };
  }
  const epoch = epochOf(deployment);
  if (epoch === null) {
    return {
      rejection: { code: "target-unavailable", message: "the deployment epoch is unknown" },
    };
  }
  if (epoch !== target.expectedDeploymentEpoch) {
    return { rejection: stale(`deployment epoch is now '${epoch}'`, catalog) };
  }
  if (target.catalogGeneration !== catalog.generation) {
    return { rejection: stale("the catalog generation changed", catalog) };
  }
  return { deployment };
}

function fenceHops(envelope: Envelope): Rejection | null {
  const hops = envelope.internal?.hopCount ?? 0;
  const visited = envelope.internal?.visitedNodes ?? [];
  if (hops > inferenceRpc.INFERENCE_RPC_MAX_HOPS) {
    return { code: "hop-limit", message: `hop limit reached (${String(hops)} hops)` };
  }
  if (visited.length > inferenceRpc.INFERENCE_RPC_MAX_VISITED_NODES) {
    return { code: "hop-limit", message: "the visited-node chain is too long" };
  }
  return new Set(visited).size === visited.length
    ? null
    : { code: "hop-limit", message: "the request already visited a node on its path" };
}

function fenceFeatures(envelope: Envelope): Rejection | null {
  if (envelope.session !== undefined) {
    return { code: "unsupported-feature", message: "the worker RPC is sessionless" };
  }
  if (envelope.cachePolicy.semantic !== "off") {
    return { code: "unsupported-feature", message: "the worker RPC carries no cache semantics" };
  }
  if (envelope.operation !== "generate" || envelope.ingressProtocol !== "openai-chat") {
    return {
      code: "unsupported-feature",
      message: `${envelope.operation} over ${envelope.ingressProtocol} is not served by this worker`,
    };
  }
  return null;
}

function fenceDeadline(state: HostState, envelope: Envelope): Rejection | null {
  const ahead = envelope.deadline - state.now();
  if (ahead <= 0) {
    return { code: "deadline-exceeded", message: "the deadline passed before acceptance" };
  }
  if (ahead > inferenceRpc.INFERENCE_RPC_MAX_DEADLINE_MS) {
    const horizon = String(inferenceRpc.INFERENCE_RPC_MAX_DEADLINE_MS);
    return { code: "deadline-exceeded", message: `the deadline is more than ${horizon} ms ahead` };
  }
  return null;
}

function fenceExecution(
  state: HostState,
  deployment: Deployment,
  envelope: Envelope,
): { backend: WorkerRpcBackend } | { rejection: Rejection } {
  const deadline = fenceDeadline(state, envelope);
  if (deadline !== null) return { rejection: deadline };
  const hops = fenceHops(envelope);
  if (hops !== null) return { rejection: hops };
  const backend = isAvailable(state, deployment) ? backendFor(state, deployment) : undefined;
  if (backend === undefined) {
    return {
      rejection: {
        code: "target-unavailable",
        message: `no executable ${deployment.backendKind} backend for '${deployment.deploymentId}'`,
      },
    };
  }
  const features = fenceFeatures(envelope);
  if (features !== null) return { rejection: features };
  if (state.active >= state.maxActive) {
    return { rejection: { code: "overloaded", message: "the worker is at its attempt limit" } };
  }
  if (state.records.size >= state.maxRecords) {
    return { rejection: { code: "overloaded", message: "the worker is at its record limit" } };
  }
  return { backend };
}

function statusOf(record: AttemptRecord): AttemptStatus {
  return {
    attemptId: record.attemptId,
    state: record.state,
    requestId: record.requestId,
    deploymentId: record.deploymentId,
    ...(record.terminal !== undefined ? { terminal: record.terminal } : {}),
    ...(record.terminalSequence !== undefined ? { terminalSequence: record.terminalSequence } : {}),
  };
}

/**
 * Settles once. The record then keeps only what its status needs: the
 * envelope, the backend and the deployment go, so a settled attempt holds
 * no request body however large it was.
 */
function settle(
  state: HostState,
  record: AttemptRecord,
  terminal: ExecutionTerminal,
): ExecutionTerminal {
  if (record.terminal !== undefined) return record.terminal;
  record.terminal = terminal;
  record.state = "terminal";
  for (const timer of record.run?.timers ?? []) clearTimeout(timer);
  record.run = undefined;
  state.active -= 1;
  notifyIdle(state);
  return terminal;
}

/**
 * Forgets settled records past their deadline plus the grace period, never
 * earlier: until then a resubmit of the attempt gets the existing record.
 * A record past its deadline can no longer be resubmitted anyway; its
 * deadline fence refuses it.
 */
function sweep(state: HostState): void {
  const now = state.now();
  if (now - state.lastSweep < SWEEP_INTERVAL_MS && state.records.size < state.maxRecords) return;
  state.lastSweep = now;
  for (const record of state.records.values()) {
    if (record.terminal === undefined || record.retainUntil > now) continue;
    state.records.delete(record.attemptId);
    if (state.cancelIds.get(record.cancelId) === record.attemptId) {
      state.cancelIds.delete(record.cancelId);
    }
  }
}

function executedBy(record: AttemptRecord): { model: string; deployment: string } {
  return { model: record.model, deployment: record.deploymentId };
}

function stopTerminal(record: AttemptRecord, reason: StopReason): ExecutionTerminal {
  const started = record.state !== "accepted";
  const executed = started ? executedBy(record) : {};
  if (reason === "deadline") {
    const error = {
      code: "timeout" as const,
      message: "the attempt deadline passed",
      retryable: false,
    };
    return { outcome: "failed", started, error, ...executed, usage: UNKNOWN_USAGE };
  }
  return { outcome: "cancelled", started, ...executed, usage: UNKNOWN_USAGE };
}

/** Settle first, then abort: the running stream sees the recorded terminal. */
function stopAttempt(state: HostState, record: AttemptRecord, reason: StopReason): void {
  const controller = record.run?.controller;
  settle(state, record, stopTerminal(record, reason));
  controller?.abort(reason);
}

function admit(
  state: HostState,
  claims: Claims,
  input: SubmitRequest,
  deployment: Deployment,
  backend: WorkerRpcBackend,
): AttemptRecord {
  const { envelope } = input;
  const run: AttemptRun = {
    deployment,
    envelope,
    backend,
    controller: new AbortController(),
    timers: [],
  };
  const record: AttemptRecord = {
    attemptId: envelope.attemptId,
    requestId: envelope.requestId,
    cancelId: input.cancelId,
    owner: {
      serviceId: claims.serviceId,
      credentialScopeId: claims.credentialScopeId,
      tenantId: envelope.tenantId,
    },
    deploymentId: deployment.deploymentId,
    model: deployment.upstreamModelId,
    acceptedAt: new Date(state.now()).toISOString(),
    retainUntil: envelope.deadline + RETENTION_GRACE_MS,
    state: "accepted",
    streamed: false,
    terminal: undefined,
    terminalSequence: undefined,
    run,
  };
  state.records.set(record.attemptId, record);
  state.cancelIds.set(record.cancelId, record.attemptId);
  state.active += 1;
  const untilDeadline = Math.max(0, envelope.deadline - state.now());
  const deadline = setTimeout(() => {
    stopAttempt(state, record, "deadline");
  }, untilDeadline);
  const attach = setTimeout(
    () => {
      if (!record.streamed) stopAttempt(state, record, "attach-timeout");
    },
    Math.min(state.attachTimeoutMs, untilDeadline),
  );
  deadline.unref();
  attach.unref();
  run.timers.push(deadline, attach);
  return record;
}

function submit(
  state: HostState,
  claimsIn: Claims | undefined,
  input: SubmitRequest,
): SubmitResult {
  const version = input.version;
  const versions = advertised(state);
  if (!versions.some((v) => inferenceRpc.compareInferenceRpcVersions(v, version) === 0)) {
    return rejectedWith(versionRejection(state, "the submit version was not negotiated here"));
  }
  const claims = authorized(claimsIn, "submit");
  if (claims === null) return rejectedWith(NO_SCOPE);
  const catalog = buildWorkerCatalog(state);
  const target = catalog.all.find((d) => d.deploymentId === input.target.deploymentId);
  const scope = fenceClaims(claims, input, target);
  if (scope !== null) return rejectedWith(scope);
  sweep(state);
  const existing = state.records.get(input.envelope.attemptId);
  if (existing !== undefined) {
    return ownedBy(existing, claims)
      ? { outcome: "existing", status: statusOf(existing) }
      : rejectedWith(NO_SCOPE);
  }
  const owned = fenceOwnership(state, catalog, input.target);
  if ("rejection" in owned) return rejectedWith(owned.rejection);
  const execution = fenceExecution(state, owned.deployment, input.envelope);
  if ("rejection" in execution) return rejectedWith(execution.rejection);
  const record = admit(state, claims, input, owned.deployment, execution.backend);
  return {
    outcome: "accepted",
    requestId: record.requestId,
    attemptId: record.attemptId,
    workerId: state.workerId,
    workerIncarnation: state.incarnation,
    deploymentId: owned.deployment.deploymentId,
    deploymentEpoch: input.target.expectedDeploymentEpoch,
    acceptedAt: record.acceptedAt,
  };
}

// ---- stream: the single consumer of an accepted attempt --------------------

function endTerminal(
  record: AttemptRecord,
  end: Extract<WorkerRpcBackendEvent, { type: "end" }>,
): ExecutionTerminal {
  if (end.result.ok) {
    return {
      outcome: "completed",
      completion: "upstream",
      finishReason: end.result.finishReason,
      ...executedBy(record),
      usage: end.usage,
    };
  }
  const error = { code: end.result.code, message: end.result.message, retryable: false };
  return { outcome: "failed", started: true, error, ...executedBy(record), usage: end.usage };
}

function failureTerminal(
  record: AttemptRecord,
  err: unknown,
  code: ExecutionErrorCode,
): ExecutionTerminal {
  const started = record.state !== "accepted";
  const message = err instanceof Error ? err.message : String(err);
  return {
    outcome: "failed",
    started,
    error: { code, message, retryable: false },
    ...(started ? executedBy(record) : {}),
    usage: UNKNOWN_USAGE,
  };
}

function startBackend(
  record: AttemptRecord,
): AsyncIterable<WorkerRpcBackendEvent> | readonly WorkerRpcBackendEvent[] {
  const run = record.run;
  // Stopped between acceptance and the first pull: nothing starts.
  if (run === undefined || run.controller.signal.aborted) return [];
  record.state = "started";
  return run.backend.execute(run.deployment, run.envelope, run.controller.signal);
}

async function* runAttempt(
  state: HostState,
  record: AttemptRecord,
  signal: AbortSignal,
): AsyncGenerator<StreamFrame> {
  let sequence = 0;
  const identity = (): Pick<ExecutionEventV1, "v" | "requestId" | "attemptId" | "sequence"> => ({
    v: 1,
    requestId: record.requestId,
    attemptId: record.attemptId,
    sequence: sequence++,
  });
  const onDisconnect = (): void => {
    stopAttempt(state, record, "disconnect");
  };
  signal.addEventListener("abort", onDisconnect, { once: true });
  if (signal.aborted) onDisconnect();
  let terminal: ExecutionTerminal;
  try {
    yield {
      frame: "event",
      event: { ...identity(), type: "accepted", acceptedAt: record.acceptedAt },
    };
    for await (const out of startBackend(record)) {
      if (record.terminal !== undefined) break;
      if (out.type === "end") {
        settle(state, record, endTerminal(record, out));
        continue;
      }
      record.state = "emitting";
      yield { frame: "event", event: { ...identity(), type: "content", payload: out.payload } };
    }
    terminal = settle(
      state,
      record,
      failureTerminal(record, "no backend result", "internal-error"),
    );
  } catch (err) {
    terminal = settle(state, record, failureTerminal(record, err, "upstream-error"));
  } finally {
    signal.removeEventListener("abort", onDisconnect);
    // The consumer left mid-stream: that is a disconnect, never an orphan.
    if (record.terminal === undefined) stopAttempt(state, record, "disconnect");
  }
  const last = identity();
  record.terminalSequence = last.sequence;
  yield { frame: "event", event: { ...last, type: "terminal", terminal } };
}

/**
 * An attempt belongs to the service and credential scope that submitted
 * it, and only while its tenant is still inside the presented claims.
 */
function ownedBy(record: AttemptRecord, claims: Claims): boolean {
  return (
    record.owner.serviceId === claims.serviceId &&
    record.owner.credentialScopeId === claims.credentialScopeId &&
    claims.tenants.includes(record.owner.tenantId)
  );
}

function ownedRecord(
  state: HostState,
  claims: Claims,
  attemptId: string,
): AttemptRecord | undefined {
  const record = state.records.get(attemptId);
  return record !== undefined && ownedBy(record, claims) ? record : undefined;
}

async function* streamAttempt(
  state: HostState,
  claimsIn: Claims | undefined,
  input: inferenceRpc.InferenceRpcStreamRequestV1,
  signal: AbortSignal,
): AsyncGenerator<StreamFrame> {
  const claims = authorized(claimsIn, "stream");
  if (claims === null) {
    yield { frame: "rejected", rejection: NO_SCOPE };
    return;
  }
  const record = ownedRecord(state, claims, input.attemptId);
  if (record === undefined || record.streamed || record.terminal !== undefined) {
    const status =
      record === undefined
        ? { attemptId: input.attemptId, state: "unknown" as const }
        : statusOf(record);
    yield { frame: "unavailable", status };
    return;
  }
  record.streamed = true;
  state.streams += 1;
  try {
    yield* runAttempt(state, record, signal);
  } finally {
    state.streams -= 1;
    notifyIdle(state);
  }
}

// ---- status / cancel ------------------------------------------------------

function attemptStatus(
  state: HostState,
  claimsIn: Claims | undefined,
  input: inferenceRpc.InferenceRpcStatusRequestV1,
): inferenceRpc.InferenceRpcStatusResultV1 {
  const claims = authorized(claimsIn, "status");
  if (claims === null) return rejectedWith(NO_SCOPE);
  const record = ownedRecord(state, claims, input.attemptId);
  const status =
    record === undefined
      ? { attemptId: input.attemptId, state: "unknown" as const }
      : statusOf(record);
  return { outcome: "status", ...status };
}

function cancelAttempt(
  state: HostState,
  claimsIn: Claims | undefined,
  input: inferenceRpc.InferenceRpcCancelRequestV1,
): inferenceRpc.InferenceRpcCancelResultV1 {
  const claims = authorized(claimsIn, "cancel");
  if (claims === null) return rejectedWith(NO_SCOPE);
  const attemptId = "attemptId" in input ? input.attemptId : state.cancelIds.get(input.cancelId);
  const record = attemptId === undefined ? undefined : ownedRecord(state, claims, attemptId);
  if (record === undefined) return { outcome: "unknown" };
  if (record.terminal !== undefined) {
    return { outcome: "already-terminal", attemptId: record.attemptId };
  }
  stopAttempt(state, record, "cancel");
  return { outcome: "cancelled", attemptId: record.attemptId };
}

function versionsOf(
  versions: WorkerRpcHostOptions["versions"],
): () => readonly inferenceRpc.InferenceRpcVersion[] {
  if (typeof versions === "function") return versions;
  const fixed = [...(versions ?? [])];
  return () => fixed;
}

export function createWorkerRpcHost(opts: WorkerRpcHostOptions): WorkerRpcHost {
  const resolvedOpt = opts.resolved;
  const state: HostState = {
    workerId: opts.workerId,
    incarnation: opts.incarnation ?? `inc-${randomUUID()}`,
    versions: versionsOf(opts.versions),
    draining: false,
    resolve:
      typeof resolvedOpt === "function"
        ? resolvedOpt
        : (): ResolvedEnv => resolvedOpt ?? resolveEnv(),
    advertisements: opts.advertisements ?? ((): readonly Deployment[] => []),
    backends: opts.backends ?? DEFAULT_BACKENDS,
    maxActive: opts.maxActiveAttempts ?? DEFAULT_MAX_ACTIVE,
    maxRecords: opts.maxAttemptRecords ?? DEFAULT_MAX_RECORDS,
    attachTimeoutMs: opts.streamAttachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS,
    now: opts.now ?? ((): number => Date.now()),
    records: new Map(),
    cancelIds: new Map(),
    lastSweep: 0,
    active: 0,
    streams: 0,
    idle: [],
  };
  return {
    workerId: state.workerId,
    incarnation: state.incarnation,
    resolveClaims: opts.resolveClaims ?? ((ctx): Claims | undefined => ctx.inferenceClaims),
    negotiate: (claims, input) => negotiate(state, claims, input),
    catalog: (claims) => listCatalog(state, claims),
    submit: (claims, input) => submit(state, claims, input),
    stream: (claims, input, signal) => streamAttempt(state, claims, input, signal),
    status: (claims, input) => attemptStatus(state, claims, input),
    cancel: (claims, input) => cancelAttempt(state, claims, input),
    drain: (): Promise<void> => {
      state.draining = true;
      const idle = new Promise<void>((resolve) => {
        state.idle.push(resolve);
      });
      notifyIdle(state);
      return idle;
    },
    close: (): void => {
      for (const record of state.records.values()) {
        if (record.terminal === undefined) stopAttempt(state, record, "close");
      }
    },
  };
}

let publishedHost: WorkerRpcHost | null = null;

/** The host the procedures serve. Until a worker publishes one, the RPC is not advertised. */
export function currentWorkerRpcHost(): WorkerRpcHost {
  publishedHost ??= createWorkerRpcHost({ workerId: LOCAL_NODE_NAME });
  return publishedHost;
}

/** Serve `host` from the procedures. Returns a restore for the previous host. */
export function publishWorkerRpcHost(host: WorkerRpcHost): () => void {
  const previous = publishedHost;
  publishedHost = host;
  return () => {
    publishedHost = previous;
  };
}

function served(ctx: InferenceRpcContext): { host: WorkerRpcHost; claims: Claims | undefined } {
  const host = currentWorkerRpcHost();
  return { host, claims: host.resolveClaims(ctx) };
}

const t = initTRPC.context<InferenceRpcContext>().create();

/** Mounted as `inferenceRpc` on the agent router. */
export const inferenceRpcRouter = t.router({
  negotiate: t.procedure
    .input(inferenceRpc.InferenceRpcNegotiateRequestV1Schema)
    .query(({ ctx, input }) => {
      const { host, claims } = served(ctx);
      return host.negotiate(claims, input);
    }),
  catalog: t.procedure.query(({ ctx }) => {
    const { host, claims } = served(ctx);
    return host.catalog(claims);
  }),
  submit: t.procedure
    .input(inferenceRpc.InferenceRpcSubmitRequestV1Schema)
    .mutation(({ ctx, input }) => {
      const { host, claims } = served(ctx);
      return host.submit(claims, input);
    }),
  stream: t.procedure
    .input(inferenceRpc.InferenceRpcStreamRequestV1Schema)
    .subscription(async function* ({ ctx, input, signal }) {
      const { host, claims } = served(ctx);
      yield* host.stream(claims, input, signal ?? new AbortController().signal);
    }),
  status: t.procedure
    .input(inferenceRpc.InferenceRpcStatusRequestV1Schema)
    .query(({ ctx, input }) => {
      const { host, claims } = served(ctx);
      return host.status(claims, input);
    }),
  cancel: t.procedure
    .input(inferenceRpc.InferenceRpcCancelRequestV1Schema)
    .mutation(({ ctx, input }) => {
      const { host, claims } = served(ctx);
      return host.cancel(claims, input);
    }),
});
