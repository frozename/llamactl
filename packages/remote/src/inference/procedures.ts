import type { PidIdentityDeps } from "@llamactl/core/pidIdentity";
import type { Lease, ResidencyLeases } from "@llamactl/core/residency/leases";
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
 *
 * When `residencyLeases` is provided in `WorkerRpcHostOptions`, an
 * opt-in residency lease is acquired after all acceptance fences pass
 * (after `fenceExecution`, before `admit`), released in `settle`, and
 * revoked when the lease is force-unloaded. Without it, behaviour is
 * unchanged.
 *
 * When `admission` is provided, Worker RPC streams count against the shared
 * request-admission cap (the same instance as the HTTP chat/messages/responses
 * ingresses, #281 DF-08): the 'accepted' event is emitted before the queue
 * wait, and the execution slot is held for the stream's lifetime and released
 * once on every terminal path. Embedded (in-process unified-proxy) attempts
 * are exempt, so an admitted HTTP request is not counted a second time.
 * Unified-proxy callers that were never admitted (the router.ts chat mutation
 * and generic /v1/* proxying) stay uncounted until the create-proxy.ts slice.
 * Without `admission`, nothing is called and behaviour is unchanged.
 */
import { type inferenceContracts, inferenceRpc, openaiProxy, routingCatalog } from "@llamactl/core";
import { LOCAL_NODE_NAME } from "@llamactl/core/config/schema";
import { checkServingReadiness, formatHostForUrl } from "@llamactl/core/engines";
import { resolveEnv } from "@llamactl/core/env";
import {
  selectLocalEngineReadiness,
  withLocalEngineBody,
} from "@llamactl/core/residency/engine-forwarder";
import {
  listLocalRoutes,
  listWorkloadRoutes,
  type LocalRoute,
} from "@llamactl/core/workloadRuntime";
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

import type {
  OwnerAdmission,
  OwnerPermit,
  OwnerReservation,
} from "../residency/owner-admission.js";

import {
  type Release,
  type RequestAdmission,
  RequestAdmissionError,
} from "../residency/request-admission.js";
import { CHAT_INGRESS_MODEL } from "../server/chat-admission.js";

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
  /**
   * Set only in-process by `createEmbeddedInferenceRpcClient`, never from a
   * request. An embedded unified-proxy attempt is exempt from the shared
   * admission cap so an already-admitted HTTP request is not counted twice.
   */
  embeddedCaller?: boolean | undefined;
}

export type WorkerRpcBackendKind = Exclude<routingCatalog.BackendKind, "cloud-api">;

type BackendResult =
  | { ok: true; finishReason: ExecutionFinishReason }
  | { ok: false; code: ExecutionErrorCode; message: string };

export type WorkerRpcBackendEvent =
  | { type: "content"; payload: ExecutionContentPayload }
  | { type: "end"; result: BackendResult; usage: UsageObservationV1 };

/**
 * Executes one fixed deployment. Iterator completion, including return()
 * after cancellation, acknowledges adapter teardown. An adapter that cannot
 * confirm teardown must keep its iterator open.
 */
export interface WorkerRpcBackend {
  execute(
    deployment: Deployment,
    envelope: Envelope,
    signal: AbortSignal,
    managed?: { permit: OwnerPermit; onDial: () => void },
    beforeLocalDial?: () => void,
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
  /** Identity checks for the worker's own workload pids; `ps` by default. */
  pidIdentity?: PidIdentityDeps;
  /** The backend-kind registration point. Defaults to `local-model` only. */
  backends?: ReadonlyMap<WorkerRpcBackendKind, WorkerRpcBackend>;
  /** Defaults to the claims the server put on the request context. */
  resolveClaims?: (ctx: InferenceRpcContext) => Claims | undefined;
  maxActiveAttempts?: number;
  /**
   * Unsettled attempts one owner, a (serviceId, credentialScopeId), may
   * hold, checked before `maxActiveAttempts` so one owner cannot take
   * every slot from the others. A function is read on every submit, so a
   * changed share applies to the next one; unset, or a function returning
   * undefined, the share is the whole of `maxActiveAttempts`.
   */
  maxActiveAttemptsPerOwner?: number | (() => number | undefined);
  /**
   * Attempt records one owner, a (serviceId, credentialScopeId), may hold,
   * unsettled and settled. Every record is kept for the deadline horizon
   * plus a minute after acceptance, so a resubmit within the horizon gets
   * the existing record; an owner at its quota has its new submits refused
   * `overloaded`, and nobody else does.
   */
  maxAttemptRecordsPerOwner?: number;
  /**
   * Attempt records kept across every owner: the worker's memory
   * backstop. At it, new submits are refused `overloaded` rather than any
   * record being forgotten early.
   */
  maxAttemptRecords?: number;
  /** An accepted attempt whose stream never attaches is cancelled unstarted. */
  streamAttachTimeoutMs?: number;
  incarnation?: string;
  /** Wall-clock time: deadlines and acceptance times. */
  now?: () => number;
  /** Monotonic time: record retention, which a wall-clock step must not shorten. */
  monotonicNow?: () => number;
  /**
   * Opt-in residency leases: when set, a lease is acquired after all
   * acceptance fences pass (after `fenceExecution`, before `admit`) and
   * released when execution settles. Unset means no residency lease is taken.
   */
  residencyLeases?: ResidencyLeases;
  /**
   * Opt-in shared inference admission (#281 DF-08): the same
   * `RequestAdmission` instance as the HTTP chat/messages/responses
   * ingresses, so Worker RPC streams count against one cap. Unset means
   * unchanged and nothing is called.
   */
  admission?: RequestAdmission;
  ownerAdmission?: OwnerAdmission;
}

export interface WorkerRpcHost {
  readonly workerId: string;
  readonly incarnation: string;
  resolveClaims(ctx: InferenceRpcContext): Claims | undefined;
  negotiate(
    claims: Claims | undefined,
    input: inferenceRpc.InferenceRpcNegotiateRequestV1,
  ): inferenceRpc.InferenceRpcNegotiateResultV1;
  /** Synchronous catalog for hosts that provide their own serving contract. */
  catalog(claims: Claims | undefined): inferenceRpc.InferenceRpcCatalogResultV1;
  /** Network and embedded procedures prefer readiness-checked availability. */
  servingCatalog?(claims: Claims | undefined): Promise<inferenceRpc.InferenceRpcCatalogResultV1>;
  submit(claims: Claims | undefined, input: SubmitRequest): SubmitResult;
  stream(
    claims: Claims | undefined,
    input: inferenceRpc.InferenceRpcStreamRequestV1,
    signal: AbortSignal,
    options?: { embedded?: boolean },
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

type StopReason = "cancel" | "deadline" | "disconnect" | "attach-timeout" | "close" | "revoked";

/**
 * An owner, the service and credential scope its records belong to, how
 * many records or active backend executions it holds. Either keeps this
 * owner available for admission accounting.
 */
interface AttemptOwner {
  key: string;
  serviceId: string;
  credentialScopeId: string;
  held: number;
  active: number;
}

interface BackendExecution {
  iterator: AsyncIterator<WorkerRpcBackendEvent>;
  read: Promise<IteratorResult<WorkerRpcBackendEvent>> | undefined;
  closed: boolean;
}

/** Execution resources retained until backend teardown is acknowledged. */
interface AttemptRun {
  deployment: Deployment;
  envelope: Envelope;
  backend: WorkerRpcBackend;
  controller: AbortController;
  timers: ReturnType<typeof setTimeout>[];
  acceptedAt: string;
  state: "accepted" | "started" | "emitting";
  streamed: boolean;
  lease: Lease | undefined;
  onRevoke: (() => void) | undefined;
  /** The shared admission slot for this stream, held through backend teardown (#281 DF-08). */
  admissionRelease?: Release;
  execution?: BackendExecution;
  cleanup?: Promise<void>;
  ownerPermit?: OwnerPermit;
  dialRefusal?: string;
}

/**
 * An attempt from acceptance until it is swept. Settling drops `run`, so
 * a settled record is a tombstone: its ids, owner and tenant, deployment,
 * terminal and retention, which is all status, cancel and a resubmit read.
 */
interface AttemptRecord {
  attemptId: string;
  requestId: string;
  cancelId: string;
  owner: AttemptOwner;
  tenantId: string;
  /** Of the attempts one cancelId names under different tenants, a cancel takes the latest admitted. */
  admission: number;
  deploymentId: string;
  /** Monotonic: acceptance plus ATTEMPT_RECORD_RETENTION_MS. */
  retainUntil: number;
  /** Wall clock: the envelope's deadline; until it passes, a resubmit of that envelope passes the deadline fence. */
  deadline: number;
  terminal: ExecutionTerminal | undefined;
  terminalSequence: number | undefined;
  run: AttemptRun | undefined;
}

interface HostState {
  workerId: string;
  incarnation: string;
  versions: () => readonly inferenceRpc.InferenceRpcVersion[];
  draining: boolean;
  resolve: () => ResolvedEnv;
  advertisements: () => readonly Deployment[];
  pidIdentity: PidIdentityDeps | undefined;
  backends: ReadonlyMap<WorkerRpcBackendKind, WorkerRpcBackend>;
  maxActive: number;
  maxActivePerOwner: () => number;
  maxRecords: number;
  maxRecordsPerOwner: number;
  attachTimeoutMs: number;
  now: () => number;
  monotonicNow: () => number;
  records: Map<string, AttemptRecord>;
  owners: Map<string, AttemptOwner>;
  /** Records in acceptance order, which is retainUntil order; swept from `retainedHead`. */
  retained: (AttemptRecord | undefined)[];
  retainedHead: number;
  /**
   * Records past their retention whose envelope deadline is still ahead of
   * the wall clock, as a min-heap on deadline: each envelope has its own
   * deadline, so they become forgettable in no order a queue could keep.
   */
  awaitingDeadline: AttemptRecord[];
  /**
   * cancelKey(owner, tenant, cancelId) to attemptId. Keyed by tenant as
   * ownedBy is: bindings of one owner can present different tenants, and
   * one binding's attempt must not shadow another's under a shared cancelId.
   */
  cancelIds: Map<string, string>;
  admissions: number;
  active: number;
  /** Streams attached and not yet ended. */
  streams: number;
  idle: (() => void)[];
  leases: ResidencyLeases | undefined;
  admission: RequestAdmission | undefined;
  ownerAdmission: OwnerAdmission | undefined;
}

interface WorkerCatalog {
  generation: string;
  all: Deployment[];
  owned: Map<string, Deployment>;
  routes: readonly LocalRoute[];
}

const UNKNOWN_USAGE: UsageObservationV1 = Object.freeze({ source: "unknown" });
const DEFAULT_MAX_ACTIVE = 64;
/**
 * The default share once a worker binds two or more owners: 16 below the
 * cap, so no one owner can take every slot. With one owner there is
 * nobody to keep slots for, so it keeps the whole cap.
 */
export const DEFAULT_SHARED_MAX_ACTIVE_PER_OWNER = DEFAULT_MAX_ACTIVE - 16;
/**
 * A record is kept 16 min, so an owner's default quota sustains 136
 * attempts a second, twice what 64 concurrent one-second attempts need.
 * A tombstone with UUID ids takes about 440 bytes of heap; the backstop
 * lets four owners fill their quotas at once, in about 220 MiB.
 */
const DEFAULT_MAX_RECORDS_PER_OWNER = 131_072;
const DEFAULT_MAX_RECORDS = 4 * DEFAULT_MAX_RECORDS_PER_OWNER;
const DEFAULT_ATTACH_TIMEOUT_MS = 30_000;
/**
 * How long a record is kept after acceptance: max(deadline, acceptance +
 * the deadline horizon) plus a minute's grace. The deadline fence keeps
 * every deadline inside the horizon, so a resubmit before its deadline,
 * however short the first one was, gets the existing record; past the
 * horizon the same envelope is refused by its own deadline.
 */
const ATTEMPT_RECORD_RETENTION_MS = inferenceRpc.INFERENCE_RPC_MAX_DEADLINE_MS + 60_000;
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
function engineFetch(
  managed: Parameters<WorkerRpcBackend["execute"]>[3],
  beforeLocalDial: (() => void) | undefined,
): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    if (managed !== undefined) {
      return managed.permit.send(
        (signal, body, transport = fetch) => {
          beforeLocalDial?.();
          managed.onDial();
          const engine = {
            ...withLocalEngineBody({ ...init, headers }, body),
            signal,
            redirect: "error" as const,
            timeout: false,
          };
          return transport(input, engine);
        },
        typeof init?.body === "string" ? init.body : null,
      );
    }
    beforeLocalDial?.();
    return fetch(input, {
      ...init,
      headers,
      ...(beforeLocalDial === undefined ? {} : { redirect: "error" as const }),
    });
  }) as typeof fetch;
}

function resultFromDone(event: Extract<UnifiedStreamEvent, { type: "done" }>): BackendResult {
  if (event.completion !== "upstream") {
    return { ok: false, code: "incomplete", message: "the engine stream ended without completing" };
  }
  if (event.finish_reason === "error") {
    return { ok: false, code: "upstream-error", message: "the engine finished with an error" };
  }
  return { ok: true, finishReason: event.finish_reason ?? "stop" };
}

function localBackendRequest(deployment: Deployment, envelope: Envelope): UnifiedAiRequest {
  return {
    ...envelope.nativeBody,
    model: deployment.upstreamModelId,
    stream: true,
    stream_options: { include_usage: true },
  } as unknown as UnifiedAiRequest;
}

/**
 * Streams the fixed deployment through Nova's OpenAI-compatible provider:
 * the exact upstream model, never the public alias, with usage requested
 * so the terminal can report it as observed.
 */
export const localModelBackend: WorkerRpcBackend = {
  async *execute(
    deployment,
    envelope,
    signal,
    managed,
    beforeLocalDial,
  ): AsyncGenerator<WorkerRpcBackendEvent> {
    let usage: UsageObservationV1 = UNKNOWN_USAGE;
    const provider = createOpenAICompatProvider({
      name: deployment.providerKind ?? "local-model",
      baseUrl: engineBaseUrl(deployment.endpoint),
      apiKey: "",
      fetch: engineFetch(managed, beforeLocalDial),
      onUsageObservation: (snapshot) => {
        usage = snapshot.observation;
      },
    });
    const request = localBackendRequest(deployment, envelope);
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

/** The catalog over `routes` and the advertisements, and what this worker owns of it by id. */
function ownedDeployments(
  state: HostState,
  routes: readonly LocalRoute[],
): { all: Deployment[]; owned: Deployment[] } {
  const catalog = routingCatalog.buildRouteCatalog({
    routes,
    nodeId: state.workerId,
    now: state.now(),
    advertisements: state.advertisements(),
  });
  const owned = catalog.deployments
    .filter((d) => d.ownerNodeId === state.workerId)
    .sort((a, b) => (a.deploymentId < b.deploymentId ? -1 : 1));
  return { all: catalog.deployments, owned };
}

function buildWorkerCatalog(state: HostState): WorkerCatalog {
  const routes = listLocalRoutes(state.resolve(), state.pidIdentity);
  const { all, owned } = ownedDeployments(state, routes);
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
    all,
    owned: new Map(owned.map((d) => [d.deploymentId, d])),
    routes,
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

type LocalServingBinding =
  | { kind: "external" }
  | { kind: "refused" }
  | { kind: "local"; route: LocalRoute; guarded: boolean };

function modelDeclaration(
  state: HostState,
  model: string,
): routingCatalog.DeclaredModelEntryV1 | undefined {
  return openaiProxy.declaredModelBinding(model, state.resolve());
}

function declarationMatches(
  state: HostState,
  declaration: routingCatalog.DeclaredModelEntryV1,
  route: LocalRoute,
): boolean {
  return (
    (declaration.ownerNodeId === LOCAL_NODE_NAME || declaration.ownerNodeId === state.workerId) &&
    declaration.workload === route.workload &&
    declaration.kind === route.kind &&
    (declaration.state === "ready" ||
      (declaration.state === "loading" && route.readiness !== undefined)) &&
    !routingCatalog.isDeclaredStaleReason(declaration.reason)
  );
}

function findServingBinding(
  state: HostState,
  deployment: Deployment,
  model: string,
  routes: readonly LocalRoute[],
): LocalServingBinding {
  if (backendFor(state, deployment) !== localModelBackend) return { kind: "external" };
  const declaration = modelDeclaration(state, model);
  const canonicalDeclaration =
    model === deployment.upstreamModelId
      ? declaration
      : modelDeclaration(state, deployment.upstreamModelId);
  // An external advertisement with no local declaration keeps its own
  // readiness contract. Discovered local routes are always workload-bound.
  if (
    deployment.transport !== "local-http" &&
    declaration === undefined &&
    canonicalDeclaration === undefined
  )
    return { kind: "external" };
  const workload = routingCatalog.workloadOfDeployment(deployment.deploymentId, state.workerId);
  const route = routes.find(
    (candidate) =>
      candidate.workload === workload &&
      candidate.model === model &&
      engineBaseUrl(deployment.endpoint) ===
        `http://${formatHostForUrl(candidate.host)}:${String(candidate.port)}/v1`,
  );
  if (
    route === undefined ||
    openaiProxy.servingWithdrawnWorkloads().has(route.workload) ||
    (declaration !== undefined && !declarationMatches(state, declaration, route)) ||
    (canonicalDeclaration !== undefined && !declarationMatches(state, canonicalDeclaration, route))
  )
    return { kind: "refused" };
  return {
    kind: "local",
    route,
    guarded:
      route.readiness !== undefined ||
      declaration !== undefined ||
      canonicalDeclaration !== undefined,
  };
}

function currentRoutes(state: HostState, deployment: Deployment): LocalRoute[] {
  const workload = routingCatalog.workloadOfDeployment(deployment.deploymentId, state.workerId);
  return workload === null ? [] : listWorkloadRoutes(state.resolve(), workload, state.pidIdentity);
}

function bindingStillCurrent(state: HostState, deployment: Deployment, route: LocalRoute): boolean {
  const current = findServingBinding(
    state,
    deployment,
    route.model,
    currentRoutes(state, deployment),
  );
  return (
    current.kind === "local" &&
    current.route.pid === route.pid &&
    current.route.engine === route.engine &&
    current.route.kind === route.kind &&
    JSON.stringify(current.route.readiness) === JSON.stringify(route.readiness)
  );
}

const fetchAtServingEndpoint = ((input: string | URL | Request, init?: RequestInit) =>
  fetch(input, { ...init, redirect: "error" })) as typeof fetch;

async function verifiesServingReadiness(
  state: HostState,
  deployment: Deployment,
  binding: Extract<LocalServingBinding, { kind: "local" }>,
): Promise<boolean> {
  const { route } = binding;
  if (route.readiness !== undefined) {
    const transport = selectLocalEngineReadiness(route, route.readiness.path);
    if (
      transport === null ||
      !(await checkServingReadiness(route, route.readiness, {
        fetch: transport ?? fetchAtServingEndpoint,
      }))
    )
      return false;
  }
  return bindingStillCurrent(state, deployment, route);
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
  if (versions.length === 0) return { outcome: "not-advertised" };
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
  snapshot?: WorkerCatalog,
): inferenceRpc.InferenceRpcCatalogResultV1 {
  const claims = authorized(claimsIn, "catalog");
  if (claims === null) return rejectedWith(NO_SCOPE);
  const catalog = snapshot ?? buildWorkerCatalog(state);
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

async function listServingCatalog(
  state: HostState,
  claims: Claims | undefined,
): Promise<inferenceRpc.InferenceRpcCatalogResultV1> {
  if (authorized(claims, "catalog") === null) return rejectedWith(NO_SCOPE);
  const catalog = buildWorkerCatalog(state);
  const listing = listCatalog(state, claims, catalog);
  if (listing.outcome !== "catalog") return listing;
  const deployments = await Promise.all(
    listing.deployments.map(async (row) => {
      const deployment = catalog.owned.get(row.deploymentId);
      if (row.availability !== "available" || deployment === undefined) return row;
      const binding = findServingBinding(state, deployment, row.model, catalog.routes);
      if (
        binding.kind === "refused" ||
        (binding.kind === "local" &&
          binding.guarded &&
          !(await verifiesServingReadiness(state, deployment, binding)))
      )
        return { ...row, availability: "unavailable" as const };
      return {
        ...row,
        publicModelIds: row.publicModelIds.filter(
          (model) =>
            findServingBinding(state, deployment, model, catalog.routes).kind !== "refused",
        ),
      };
    }),
  );
  return { ...listing, deployments };
}

// ---- submit: acceptance fencing -------------------------------------------

/**
 * Acquire a residency lease after all acceptance fences pass. Returns
 * `{lease}` on success (including when no leases are configured or the
 * deployment has no workload), or `{rejection}` when the workload is
 * draining or unloaded.
 */
function acquireResidency(
  state: HostState,
  deployment: Deployment,
): { lease: Lease | undefined } | { rejection: Rejection } {
  if (state.leases === undefined) return { lease: undefined };
  const workload = routingCatalog.workloadOfDeployment(deployment.deploymentId, state.workerId);
  if (workload === null) return { lease: undefined };
  const r = state.leases.acquire(workload);
  if (r.ok) return { lease: r.lease };
  return {
    rejection: {
      code: "target-unavailable",
      message: `residency ${r.reason}`,
    },
  };
}

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

/** X1: the caller asked for a model this deployment serves, by its exact or a public id. */
function fenceModel(deployment: Deployment, envelope: Envelope): Rejection | null {
  const asked = envelope.publicModelId;
  if (asked === deployment.upstreamModelId || deployment.publicModelIds.includes(asked)) {
    return null;
  }
  return {
    code: "target-unavailable",
    message: `deployment '${deployment.deploymentId}' does not serve model '${asked}'`,
  };
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

function ownerKey(claims: Claims): string {
  return JSON.stringify([claims.serviceId, claims.credentialScopeId]);
}

/** cancelIds are chosen by callers, so each owner, and within it each tenant, has its own. */
function cancelKey(owner: string, tenantId: string, cancelId: string): string {
  return JSON.stringify([owner, tenantId, cancelId]);
}

/**
 * The owner's active share first, so an owner at it is told so even when
 * the worker is full too; then concurrency, the owner's record quota and
 * the worker-wide backstop.
 */
function fenceCapacity(state: HostState, claims: Claims): Rejection | null {
  const owner = state.owners.get(ownerKey(claims));
  if ((owner?.active ?? 0) >= state.maxActivePerOwner()) {
    return { code: "overloaded", message: "the service is at its active attempt share" };
  }
  if (state.active >= state.maxActive) {
    return { code: "overloaded", message: "the worker is at its attempt limit" };
  }
  const held = owner?.held ?? 0;
  if (held >= state.maxRecordsPerOwner) {
    return { code: "overloaded", message: "the service is at its attempt record quota" };
  }
  if (state.records.size >= state.maxRecords) {
    return { code: "overloaded", message: "the worker is at its record limit" };
  }
  return null;
}

function fenceExecution(
  state: HostState,
  claims: Claims,
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
  const model = fenceModel(deployment, envelope);
  if (model !== null) return { rejection: model };
  const features = fenceFeatures(envelope);
  if (features !== null) return { rejection: features };
  const capacity = fenceCapacity(state, claims);
  return capacity === null ? { backend } : { rejection: capacity };
}

function statusOf(record: AttemptRecord): AttemptStatus {
  return {
    attemptId: record.attemptId,
    state: record.run?.state ?? "terminal",
    requestId: record.requestId,
    deploymentId: record.deploymentId,
    ...(record.terminal !== undefined ? { terminal: record.terminal } : {}),
    ...(record.terminalSequence !== undefined ? { terminalSequence: record.terminalSequence } : {}),
  };
}

/**
 * Publishes one terminal result and drops the execution from the RPC record.
 * Only its unfinished backend cleanup may retain admission and residency.
 */
function settle(
  state: HostState,
  record: AttemptRecord,
  terminal: ExecutionTerminal,
): ExecutionTerminal {
  if (record.terminal !== undefined) return record.terminal;
  record.terminal = terminal;
  const run = record.run;
  record.run = undefined;
  if (run === undefined) return terminal;
  for (const timer of run.timers) clearTimeout(timer);
  const execution = run.execution;
  if (execution === undefined || execution.closed) {
    releaseSettledRun(state, record.owner, run);
  } else {
    run.cleanup = closeBackendExecution(execution).then((closed) => {
      if (closed) releaseSettledRun(state, record.owner, run);
    });
  }
  return terminal;
}

function releaseSettledRun(state: HostState, owner: AttemptOwner, run: AttemptRun): void {
  run.ownerPermit?.releaseUnused();
  const { lease, onRevoke, admissionRelease } = run;
  if (onRevoke !== undefined) lease?.signal.removeEventListener("abort", onRevoke);
  lease?.release();
  admissionRelease?.();
  state.active -= 1;
  owner.active -= 1;
  forgetEmptyOwner(state, owner);
  notifyIdle(state);
}

async function closeBackendExecution(execution: BackendExecution): Promise<boolean> {
  // A terminal must be visible before abort listeners run, but backend
  // teardown must begin after those listeners receive the stop signal.
  const close = Promise.resolve().then(() => execution.iterator.return?.());
  const [pending, returned] = await Promise.allSettled([execution.read, close]);
  return (
    (pending.status === "fulfilled" && pending.value?.done === true) ||
    (returned.status === "fulfilled" && returned.value?.done === true)
  );
}

function forget(state: HostState, record: AttemptRecord): void {
  state.records.delete(record.attemptId);
  const key = cancelKey(record.owner.key, record.tenantId, record.cancelId);
  if (state.cancelIds.get(key) === record.attemptId) {
    state.cancelIds.delete(key);
  }
  record.owner.held -= 1;
  forgetEmptyOwner(state, record.owner);
}

function forgetEmptyOwner(state: HostState, owner: AttemptOwner): void {
  if (owner.held === 0 && owner.active === 0) state.owners.delete(owner.key);
}

/** The sweep reads only the earliest deadline, so the records waiting are never scanned. */
function pushByDeadline(heap: AttemptRecord[], record: AttemptRecord): void {
  let at = heap.push(record) - 1;
  while (at > 0) {
    const parent = Math.floor((at - 1) / 2);
    const above = heap[parent];
    if (above === undefined || above.deadline <= record.deadline) break;
    heap[at] = above;
    at = parent;
  }
  heap[at] = record;
}

/** Removes the earliest deadline, at index 0, keeping the heap ordered. */
function popEarliestDeadline(heap: AttemptRecord[]): void {
  const last = heap.pop();
  if (last === undefined || heap.length === 0) return;
  let at = 0;
  for (;;) {
    let child = 2 * at + 1;
    let below = heap[child];
    if (below === undefined) break;
    const right = heap[child + 1];
    if (right !== undefined && right.deadline < below.deadline) {
      child += 1;
      below = right;
    }
    if (last.deadline <= below.deadline) break;
    heap[at] = below;
    at = child;
  }
  heap[at] = last;
}

/**
 * Forgets tombstones whose retention has passed and whose envelope deadline
 * is behind the wall clock, never earlier. Every record is kept the same span
 * from its acceptance, so the acceptance queue is in retainUntil order and the
 * sweep stops at the first record still in its retention. It also stops at an
 * unsettled one, which the deadline settles long before its retention ends.
 * The wall-clock condition matters only after a backward clock step: until the
 * deadline passes again, the same envelope would pass the deadline fence, so
 * its record stays. It waits in `awaitingDeadline`, not at the head of the
 * queue, where it would keep every owner's later records past their own
 * retention and fill their quotas; it counts against its own owner's quota
 * and the backstop until it is forgotten.
 */
function sweep(state: HostState): void {
  const now = state.monotonicNow();
  const wall = state.now();
  const queue = state.retained;
  for (
    let next = queue[state.retainedHead];
    next !== undefined && next.run === undefined && next.retainUntil <= now;
    next = queue[state.retainedHead]
  ) {
    queue[state.retainedHead] = undefined;
    state.retainedHead += 1;
    if (next.deadline <= wall) {
      forget(state, next);
    } else {
      pushByDeadline(state.awaitingDeadline, next);
    }
  }
  if (state.retainedHead > 1024 && state.retainedHead * 2 > queue.length) {
    queue.splice(0, state.retainedHead);
    state.retainedHead = 0;
  }
  const awaiting = state.awaitingDeadline;
  for (let next = awaiting[0]; next !== undefined && next.deadline <= wall; next = awaiting[0]) {
    popEarliestDeadline(awaiting);
    forget(state, next);
  }
}

function executedBy(run: AttemptRun): { model: string; deployment: string } {
  return { model: run.deployment.upstreamModelId, deployment: run.deployment.deploymentId };
}

function stopTerminal(run: AttemptRun, reason: StopReason): ExecutionTerminal {
  const started = run.state !== "accepted";
  const executed = started ? executedBy(run) : {};
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

/** Record cancellation before notifying the backend. Its cleanup owns capacity. */
function stopAttempt(state: HostState, record: AttemptRecord, reason: StopReason): void {
  const run = record.run;
  if (run === undefined) return;
  settle(state, record, stopTerminal(run, reason));
  run.controller.abort(reason);
}

function ownerOf(state: HostState, claims: Claims): AttemptOwner {
  const key = ownerKey(claims);
  let owner = state.owners.get(key);
  if (owner === undefined) {
    owner = {
      key,
      serviceId: claims.serviceId,
      credentialScopeId: claims.credentialScopeId,
      held: 0,
      active: 0,
    };
    state.owners.set(key, owner);
  }
  return owner;
}

function admit(
  state: HostState,
  claims: Claims,
  input: SubmitRequest,
  deployment: Deployment,
  backend: WorkerRpcBackend,
  lease: Lease | undefined,
): AttemptRun {
  const { envelope } = input;
  const run: AttemptRun = {
    deployment,
    envelope,
    backend,
    controller: new AbortController(),
    timers: [],
    acceptedAt: new Date(state.now()).toISOString(),
    state: "accepted",
    streamed: false,
    lease,
    onRevoke: undefined,
  };
  if (run.lease !== undefined) {
    run.onRevoke = (): void => {
      stopAttempt(state, record, "revoked");
    };
    run.lease.signal.addEventListener("abort", run.onRevoke, { once: true });
  }
  const owner = ownerOf(state, claims);
  state.admissions += 1;
  const record: AttemptRecord = {
    attemptId: envelope.attemptId,
    requestId: envelope.requestId,
    cancelId: input.cancelId,
    owner,
    tenantId: envelope.tenantId,
    admission: state.admissions,
    deploymentId: deployment.deploymentId,
    retainUntil: state.monotonicNow() + ATTEMPT_RECORD_RETENTION_MS,
    deadline: envelope.deadline,
    terminal: undefined,
    terminalSequence: undefined,
    run,
  };
  owner.held += 1;
  owner.active += 1;
  state.records.set(record.attemptId, record);
  state.retained.push(record);
  state.cancelIds.set(cancelKey(owner.key, record.tenantId, record.cancelId), record.attemptId);
  state.active += 1;
  const untilDeadline = Math.max(0, envelope.deadline - state.now());
  const deadline = setTimeout(() => {
    stopAttempt(state, record, "deadline");
  }, untilDeadline);
  const attach = setTimeout(
    () => {
      if (!run.streamed) stopAttempt(state, record, "attach-timeout");
    },
    Math.min(state.attachTimeoutMs, untilDeadline),
  );
  deadline.unref();
  attach.unref();
  run.timers.push(deadline, attach);
  return run;
}

function submit(
  state: HostState,
  claimsIn: Claims | undefined,
  input: SubmitRequest,
): SubmitResult {
  const claims = authorized(claimsIn, "submit");
  sweep(state);
  const existing = state.records.get(input.envelope.attemptId);
  // A duplicate is answered from its own record before any fence, so a
  // draining or re-scoped worker still reports the attempt it accepted.
  if (claims !== null && existing !== undefined && ownedBy(existing, claims)) {
    return { outcome: "existing", status: statusOf(existing) };
  }
  const version = input.version;
  const versions = advertised(state);
  if (!versions.some((v) => inferenceRpc.compareInferenceRpcVersions(v, version) === 0)) {
    return rejectedWith(versionRejection(state, "the submit version was not negotiated here"));
  }
  if (claims === null) return rejectedWith(NO_SCOPE);
  const catalog = buildWorkerCatalog(state);
  const target = catalog.all.find((d) => d.deploymentId === input.target.deploymentId);
  const scope = fenceClaims(claims, input, target);
  if (scope !== null) return rejectedWith(scope);
  if (existing !== undefined) return rejectedWith(NO_SCOPE);
  const owned = fenceOwnership(state, catalog, input.target);
  if ("rejection" in owned) return rejectedWith(owned.rejection);
  const execution = fenceExecution(state, claims, owned.deployment, input.envelope);
  if ("rejection" in execution) return rejectedWith(execution.rejection);
  if (
    findServingBinding(state, owned.deployment, input.envelope.publicModelId, catalog.routes)
      .kind === "refused"
  )
    return rejectedWith({
      code: "target-unavailable",
      message: "the declared model has no exact local serving route",
    });
  const residency = acquireResidency(state, owned.deployment);
  if ("rejection" in residency) return rejectedWith(residency.rejection);
  const run = admit(state, claims, input, owned.deployment, execution.backend, residency.lease);
  return {
    outcome: "accepted",
    requestId: input.envelope.requestId,
    attemptId: input.envelope.attemptId,
    workerId: state.workerId,
    workerIncarnation: state.incarnation,
    deploymentId: owned.deployment.deploymentId,
    deploymentEpoch: input.target.expectedDeploymentEpoch,
    acceptedAt: run.acceptedAt,
  };
}

// ---- stream: the single consumer of an accepted attempt --------------------

function endTerminal(
  run: AttemptRun,
  end: Extract<WorkerRpcBackendEvent, { type: "end" }>,
): ExecutionTerminal {
  if (end.result.ok) {
    return {
      outcome: "completed",
      completion: "upstream",
      finishReason: end.result.finishReason,
      ...executedBy(run),
      usage: end.usage,
    };
  }
  const error = { code: end.result.code, message: end.result.message, retryable: false };
  const started = run.state !== "accepted";
  return {
    outcome: "failed",
    started,
    error,
    ...(started ? executedBy(run) : {}),
    usage: end.usage,
  };
}

function failureTerminal(
  run: AttemptRun,
  err: unknown,
  code: ExecutionErrorCode,
): ExecutionTerminal {
  const started = run.state !== "accepted";
  const message = err instanceof Error ? err.message : String(err);
  return {
    outcome: "failed",
    started,
    error: { code, message, retryable: false },
    ...(started ? executedBy(run) : {}),
    usage: UNKNOWN_USAGE,
  };
}

/**
 * X2 again at the dial: a restart between acceptance and the stream would
 * send the request to whatever process now holds the endpoint and report
 * the accepted deployment as what ran. Only the accepted deployment's own
 * workload is re-read: its pid is the one a restart changes, and the
 * identity pass over every workload would block the event loop at every
 * stream start. Advertisements are admitted against that workload's routes
 * alone, so for an advertisement-owned deployment the answer can differ
 * from the full catalog's either way: another workload's alias no longer
 * rejects an advertisement, which can then shadow a later one. That
 * matters only once the worker host is given advertisements.
 */
function movedSinceAcceptance(
  state: HostState,
  accepted: Deployment,
  routes: readonly LocalRoute[],
): string | null {
  const { owned } = ownedDeployments(state, routes);
  const current = new Map(owned.map((d) => [d.deploymentId, d])).get(accepted.deploymentId);
  if (current === undefined) {
    return `the worker no longer owns deployment '${accepted.deploymentId}'`;
  }
  const epoch = epochOf(current);
  if (epoch === epochOf(accepted)) return null;
  return epoch === null ? "the deployment epoch is unknown" : `deployment epoch is now '${epoch}'`;
}

function refuseUnstarted(
  state: HostState,
  record: AttemptRecord,
  message: string,
): ExecutionTerminal {
  return settle(state, record, {
    outcome: "failed",
    started: false,
    error: { code: "target-unavailable", message, retryable: false },
    usage: UNKNOWN_USAGE,
  });
}

function guardedLocalDial(
  state: HostState,
  run: AttemptRun,
  binding: Extract<LocalServingBinding, { kind: "local" }>,
): () => void {
  return () => {
    run.controller.signal.throwIfAborted();
    if (!bindingStillCurrent(state, run.deployment, binding.route)) {
      const reason = "local serving route changed before the engine dial";
      run.dialRefusal = reason;
      throw new Error(reason);
    }
    run.state = "started";
  };
}

async function startBackend(
  state: HostState,
  record: AttemptRecord,
  run: AttemptRun,
): Promise<BackendExecution | null> {
  // Stopped between acceptance and the first pull: nothing starts.
  if (record.terminal !== undefined) return null;
  const routes = currentRoutes(state, run.deployment);
  const moved = movedSinceAcceptance(state, run.deployment, routes);
  if (moved !== null) {
    refuseUnstarted(state, record, moved);
    return null;
  }
  const binding = findServingBinding(state, run.deployment, run.envelope.publicModelId, routes);
  if (
    binding.kind === "refused" ||
    (binding.kind === "local" &&
      binding.guarded &&
      !(await verifiesServingReadiness(state, run.deployment, binding)))
  ) {
    refuseUnstarted(state, record, "the declared local serving route is unavailable");
    return null;
  }
  if (run.controller.signal.aborted) return null;
  const beforeDial =
    binding.kind === "local" && binding.guarded ? guardedLocalDial(state, run, binding) : undefined;
  const permit = run.ownerPermit;
  if (permit === undefined && beforeDial === undefined) run.state = "started";
  const backend = run.backend.execute(
    run.deployment,
    run.envelope,
    run.controller.signal,
    permit === undefined
      ? undefined
      : {
          permit,
          onDial: (): void => {
            run.state = "started";
          },
        },
    beforeDial,
  );
  const iterator = backend[Symbol.asyncIterator]();
  const execution = { iterator, read: undefined, closed: false };
  run.execution = execution;
  return execution;
}

async function readBackendExecution(
  execution: BackendExecution,
): Promise<IteratorResult<WorkerRpcBackendEvent>> {
  const read = Promise.resolve(execution.iterator.next());
  execution.read = read;
  try {
    const next = await read;
    execution.closed = next.done === true;
    return next;
  } finally {
    execution.read = undefined;
  }
}

/** Runs `fn` at most once across every caller that shares the closure. */
function once(fn: () => void): () => void {
  let done = false;
  return (): void => {
    if (done) return;
    done = true;
    fn();
  };
}

/**
 * The first-frame typed rejection for an immediate admission refusal. It
 * mirrors chat-admission's 429/503/504 split: QueueFull,
 * PrincipalShareExceeded or QueueBytesExceeded with a retry hint is an
 * `overloaded` (429) with `retryAfterMs`; a passed deadline is
 * `deadline-exceeded` (504); everything else is `target-unavailable`. A
 * QueueBytesExceeded with no retry hint is a 413 at the HTTP ingress but a
 * 503 here, because the rejection protocol has no oversize code.
 */
function immediateRejection(err: RequestAdmissionError): Rejection {
  const message = `worker admission refused: ${err.code}`;
  const retryableOverload =
    err.code === "QueueFull" ||
    err.code === "PrincipalShareExceeded" ||
    err.code === "QueueBytesExceeded";
  if (retryableOverload && err.retryAfterMs !== null) {
    return { code: "overloaded", message, retryAfterMs: err.retryAfterMs };
  }
  if (err.code === "DeadlineExceeded") return { code: "deadline-exceeded", message };
  return { code: "target-unavailable", message };
}

interface AdmissionWait {
  pending: Promise<unknown>;
}

/**
 * Settles the queue wait that follows 'accepted'. A grant (or an abort that
 * already ended the attempt) returns null so the backend may start; a late
 * QueueWaitExceeded or LoadFailed is a failed terminal (502 at the client),
 * not the ingress's 503, and a non-admission rejection is a fault.
 */
async function lateRefusal(
  state: HostState,
  record: AttemptRecord,
  admission: AdmissionWait | undefined,
): Promise<ExecutionTerminal | null> {
  if (admission === undefined) return null;
  const refusal = await admission.pending.then(
    () => null,
    (e: unknown) => e,
  );
  if (refusal === null || record.terminal !== undefined) return null;
  if (refusal instanceof RequestAdmissionError) {
    if (refusal.code === "Aborted" && record.run?.controller.signal.aborted === true) return null;
    const hint =
      refusal.retryAfterMs !== null ? `; retry after ${String(refusal.retryAfterMs)} ms` : "";
    return settle(state, record, {
      outcome: "failed",
      started: false,
      error: {
        code: "target-unavailable",
        message: `worker admission refused: ${refusal.code}${hint}`,
        retryable: true,
      },
      usage: UNKNOWN_USAGE,
    });
  }
  const message =
    refusal instanceof Error
      ? refusal.message
      : typeof refusal === "string"
        ? refusal
        : "the shared admission rejected unexpectedly";
  return settle(state, record, {
    outcome: "failed",
    started: false,
    error: { code: "internal-error", message, retryable: false },
    usage: UNKNOWN_USAGE,
  });
}

type EventIdentity = Pick<ExecutionEventV1, "v" | "requestId" | "attemptId" | "sequence">;

async function* emitBackend(
  state: HostState,
  record: AttemptRecord,
  run: AttemptRun,
  identity: () => EventIdentity,
): AsyncGenerator<StreamFrame, ExecutionTerminal> {
  const execution = await startBackend(state, record, run);
  let completed: ExecutionTerminal | undefined;
  while (execution !== null && record.terminal === undefined) {
    const next = await readBackendExecution(execution);
    if (run.dialRefusal !== undefined) return refuseUnstarted(state, record, run.dialRefusal);
    if (next.done === true || run.controller.signal.aborted) break;
    const out = next.value;
    if (out.type === "end") {
      completed ??= endTerminal(run, out);
    } else if (completed === undefined) {
      run.state = "emitting";
      yield { frame: "event", event: { ...identity(), type: "content", payload: out.payload } };
    }
  }
  return settle(
    state,
    record,
    completed ?? failureTerminal(run, "no backend result", "internal-error"),
  );
}

async function* runAttempt(
  state: HostState,
  record: AttemptRecord,
  run: AttemptRun,
  signal: AbortSignal,
  admission?: AdmissionWait,
): AsyncGenerator<StreamFrame> {
  let sequence = 0;
  const identity = (): EventIdentity => ({
    v: 1,
    requestId: record.requestId,
    attemptId: record.attemptId,
    sequence: sequence++,
  });
  const onDisconnect = (): void => {
    stopAttempt(state, record, "disconnect");
  };
  // Registered before the 'accepted' yield, so an abort while queued stops
  // the attempt, which aborts the controller, which rejects the waiter Aborted.
  signal.addEventListener("abort", onDisconnect, { once: true });
  if (signal.aborted) onDisconnect();
  let terminal: ExecutionTerminal;
  try {
    // 'accepted' precedes the queue wait: the remote client's first-frame
    // timer (DEFAULT_CALL_TIMEOUT_MS, 10 s) is shorter than the chat queue
    // wait (30 s), so a queued attempt must not look like a stalled stream.
    yield {
      frame: "event",
      event: { ...identity(), type: "accepted", acceptedAt: run.acceptedAt },
    };
    // Never start the backend before pending has fulfilled: on 'Aborted'
    // (or an already-terminal attempt) the aborted controller makes
    // startBackend return [], so the recorded terminal is reported.
    const refused = await lateRefusal(state, record, admission);
    terminal = refused ?? (yield* emitBackend(state, record, run, identity));
  } catch (err) {
    terminal =
      run.dialRefusal === undefined
        ? settle(state, record, failureTerminal(run, err, "upstream-error"))
        : refuseUnstarted(state, record, run.dialRefusal);
  } finally {
    signal.removeEventListener("abort", onDisconnect);
    // The consumer left mid-stream: that is a disconnect, never an orphan.
    if (record.terminal === undefined) stopAttempt(state, record, "disconnect");
  }
  const last = identity();
  record.terminalSequence = last.sequence;
  yield { frame: "event", event: { ...last, type: "terminal", terminal } };
  await run.cleanup;
}

/**
 * An attempt belongs to the service and credential scope that submitted
 * it, and only while its tenant is still inside the presented claims.
 */
function ownedBy(record: AttemptRecord, claims: Claims): boolean {
  return (
    record.owner.serviceId === claims.serviceId &&
    record.owner.credentialScopeId === claims.credentialScopeId &&
    claims.tenants.includes(record.tenantId)
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
  options?: { embedded?: boolean },
): AsyncGenerator<StreamFrame> {
  const claims = authorized(claimsIn, "stream");
  if (claims === null) {
    yield { frame: "rejected", rejection: NO_SCOPE };
    return;
  }
  const record = ownedRecord(state, claims, input.attemptId);
  const run = record?.run;
  if (record === undefined || run === undefined || run.streamed) {
    const status =
      record === undefined
        ? { attemptId: input.attemptId, state: "unknown" as const }
        : statusOf(record);
    yield { frame: "unavailable", status };
    return;
  }
  run.streamed = true;
  state.streams += 1;
  try {
    const ownerPermit = acquireOwnerPermit(state, record, run);
    if (ownerPermit !== undefined) {
      yield* streamOwnerAdmission(state, record, run, signal, ownerPermit);
      return;
    }
    if (state.admission === undefined || options?.embedded === true) {
      yield* runAttempt(state, record, run, signal);
      return;
    }
    const wait = yield* acquireAdmission(state, state.admission, record, run);
    if (wait === null) return;
    yield* runAttempt(state, record, run, signal, wait);
  } finally {
    state.streams -= 1;
    notifyIdle(state);
  }
}

async function* streamOwnerAdmission(
  state: HostState,
  record: AttemptRecord,
  run: AttemptRun,
  signal: AbortSignal,
  reservation: OwnerReservation,
): AsyncGenerator<StreamFrame> {
  if ("refusal" in reservation) {
    if (reservation.refusal.code !== "Aborted" || !run.controller.signal.aborted) {
      yield rejectAdmission(state, record, reservation.refusal);
      return;
    }
  }
  const pending = "pending" in reservation ? reservation.pending : Promise.resolve();
  void pending.catch(() => undefined);
  yield* runAttempt(state, record, run, signal, { pending });
}

function acquireOwnerPermit(
  state: HostState,
  record: AttemptRecord,
  run: AttemptRun,
): OwnerReservation | undefined {
  const admission = state.ownerAdmission;
  if (admission === undefined || run.backend !== localModelBackend) return undefined;
  const workload = routingCatalog.workloadOfDeployment(run.deployment.deploymentId, state.workerId);
  const permit = admission.acquire({
    target: `${engineBaseUrl(run.deployment.endpoint)}/chat/completions`,
    body: JSON.stringify(localBackendRequest(run.deployment, run.envelope)),
    deadlineMs: run.envelope.deadline,
    clientSignal: run.controller.signal,
    principal: { service: record.owner.serviceId, scope: record.owner.credentialScopeId },
    ...(workload === null ? {} : { workload }),
    ...(run.lease === undefined ? {} : { engineSignal: run.lease.signal }),
  });
  if (permit === undefined || "refusal" in permit) return permit;
  return {
    pending: permit.pending.then((granted) => {
      if (record.terminal !== undefined) granted.releaseUnused();
      else run.ownerPermit = granted;
      return granted;
    }),
  };
}

/**
 * Reserves a shared-cap slot for a Worker RPC stream and reports an
 * immediate refusal as a rejected frame. Returns null when a frame was
 * already yielded and the attempt must not run the backend.
 *
 * Same key and principal as chat-admission, so Worker RPC and the HTTP
 * ingresses share one cap.
 */
async function* acquireAdmission(
  state: HostState,
  admission: RequestAdmission,
  record: AttemptRecord,
  run: AttemptRun,
): AsyncGenerator<StreamFrame, AdmissionWait | null> {
  const pending = admission.acquire(
    {
      requestId: `worker-rpc:${record.attemptId}`,
      principal: "agent",
      priority: "interactive",
      model: CHAT_INGRESS_MODEL,
      bytes: Buffer.byteLength(JSON.stringify(run.envelope.nativeBody)),
      promptTokens: 0,
      maxCompletionTokens: 0,
    },
    { signal: run.controller.signal },
  );
  // Store or release the slot even if the generator never resumes.
  pending.then(
    (release) => {
      if (record.terminal !== undefined || record.run !== run) release();
      else run.admissionRelease = once(release);
    },
    () => undefined,
  );
  return yield* presentAdmission(state, record, pending);
}

async function* presentAdmission(
  state: HostState,
  record: AttemptRecord,
  pending: Promise<unknown>,
): AsyncGenerator<StreamFrame, AdmissionWait | null> {
  // Both an enqueue refusal (rejected promise) and a resident grant
  // (resolved in pump) are already settled, so the race returns them
  // before the sentinel.
  const queuedProbe = Symbol("queued");
  let first: unknown;
  try {
    first = await Promise.race([pending, Promise.resolve(queuedProbe)]);
  } catch (err) {
    first = err;
  }
  if (first instanceof RequestAdmissionError && first.code !== "Aborted") {
    yield rejectAdmission(state, record, first);
    return null;
  }
  return { pending };
}

function rejectAdmission(
  state: HostState,
  record: AttemptRecord,
  error: RequestAdmissionError,
): StreamFrame {
  settle(state, record, {
    outcome: "failed",
    started: false,
    error: {
      code: "target-unavailable",
      message: `worker admission refused: ${error.code}`,
      retryable: true,
    },
    usage: UNKNOWN_USAGE,
  });
  return { frame: "rejected", rejection: immediateRejection(error) };
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

/**
 * Each presented tenant indexes its own attempt under `cancelId`; of those,
 * the latest admitted is the one the caller last named by it.
 */
function cancelTarget(
  state: HostState,
  claims: Claims,
  cancelId: string,
): AttemptRecord | undefined {
  const owner = ownerKey(claims);
  let latest: AttemptRecord | undefined;
  for (const tenantId of claims.tenants) {
    const attemptId = state.cancelIds.get(cancelKey(owner, tenantId, cancelId));
    const record = attemptId === undefined ? undefined : ownedRecord(state, claims, attemptId);
    if (record !== undefined && (latest === undefined || record.admission > latest.admission)) {
      latest = record;
    }
  }
  return latest;
}

function cancelAttempt(
  state: HostState,
  claimsIn: Claims | undefined,
  input: inferenceRpc.InferenceRpcCancelRequestV1,
): inferenceRpc.InferenceRpcCancelResultV1 {
  const claims = authorized(claimsIn, "cancel");
  if (claims === null) return rejectedWith(NO_SCOPE);
  const record =
    "attemptId" in input
      ? ownedRecord(state, claims, input.attemptId)
      : cancelTarget(state, claims, input.cancelId);
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

/** Falls back at call time, so a function that stops returning a share restores the whole cap. */
function activeShareOf(opts: WorkerRpcHostOptions): () => number {
  const maxActive = opts.maxActiveAttempts ?? DEFAULT_MAX_ACTIVE;
  const share = opts.maxActiveAttemptsPerOwner;
  return () => (typeof share === "function" ? share() : share) ?? maxActive;
}

const hostStates = new WeakMap<WorkerRpcHost, HostState>();

/** How many cancelIds `host` indexes; undefined for a host createWorkerRpcHost did not make. */
export function __workerRpcCancelIdIndexSizeForTests(host: WorkerRpcHost): number | undefined {
  return hostStates.get(host)?.cancelIds.size;
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
    pidIdentity: opts.pidIdentity,
    backends: opts.backends ?? DEFAULT_BACKENDS,
    maxActive: opts.maxActiveAttempts ?? DEFAULT_MAX_ACTIVE,
    maxActivePerOwner: activeShareOf(opts),
    maxRecords: opts.maxAttemptRecords ?? DEFAULT_MAX_RECORDS,
    maxRecordsPerOwner: opts.maxAttemptRecordsPerOwner ?? DEFAULT_MAX_RECORDS_PER_OWNER,
    attachTimeoutMs: opts.streamAttachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS,
    now: opts.now ?? ((): number => Date.now()),
    monotonicNow: opts.monotonicNow ?? ((): number => performance.now()),
    records: new Map(),
    owners: new Map(),
    retained: [],
    retainedHead: 0,
    awaitingDeadline: [],
    cancelIds: new Map(),
    admissions: 0,
    active: 0,
    streams: 0,
    idle: [],
    leases: opts.residencyLeases,
    admission: opts.admission,
    ownerAdmission: opts.ownerAdmission,
  };
  const host: WorkerRpcHost = {
    workerId: state.workerId,
    incarnation: state.incarnation,
    resolveClaims: opts.resolveClaims ?? ((ctx): Claims | undefined => ctx.inferenceClaims),
    negotiate: (claims, input) => negotiate(state, claims, input),
    catalog: (claims) => listCatalog(state, claims),
    servingCatalog: (claims) => listServingCatalog(state, claims),
    submit: (claims, input) => submit(state, claims, input),
    stream: (claims, input, signal, options) =>
      streamAttempt(state, claims, input, signal, options),
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
  hostStates.set(host, state);
  return host;
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
    return host.servingCatalog?.(claims) ?? host.catalog(claims);
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
      yield* host.stream(claims, input, signal ?? new AbortController().signal, {
        embedded: ctx.embeddedCaller === true,
      });
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
