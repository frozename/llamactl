import type { PeerNode } from "@llamactl/core/config/peers";
import type { ResidencyPolicy } from "@llamactl/core/residency/admission";
import type { ColdEngineForwarder } from "@llamactl/core/residency/engine-forwarder";
import type { ResolvedEnv } from "@llamactl/core/types";

/**
 * Remote createProxy composition factory (P0.2, design §3/§4.2).
 * Gated by LLAMACTL_UNIFIED_PROXY=0|1, default off — unset or "0" leaves
 * every request on the legacy passthrough, so rollback is a flag flip.
 * With it on, JSON model requests run catalog lookup → capability
 * filtering → credential resolution → executor acquisition → execution,
 * in that order. The default executor delegates to the existing core
 * forwarding path, so local and peer behavior is unchanged.
 */
import {
  inferenceContracts,
  openaiProxy,
  routingCapabilities,
  routingCatalog,
  routingRanking,
} from "@llamactl/core";
import { currentContext, loadConfig } from "@llamactl/core/config/kubeconfig";
import { LOCAL_NODE_ENDPOINT, LOCAL_NODE_NAME } from "@llamactl/core/config/schema";
import { resolveEnv } from "@llamactl/core/env";
import {
  catalogQualificationStages,
  listClusterRoutes,
  listLocalRoutes,
  PEER_ROUTE_STALE_MS,
  type PeerSnapshot,
} from "@llamactl/core/workloadRuntime";
import { createHash, randomUUID } from "node:crypto";

import type { ResidencyStoreSnapshot } from "../residency/store.js";
import type { NodeRun } from "../workload/noderun-schema.js";

import { acquireWorkerRpcExecutor } from "../inference/client.js";
import { createLegacyLocalExecutor } from "../inference/legacy-local-executor.js";
import { PEER_COLD_MAX_BODY_BYTES, readPeerText } from "../residency/peer-cold.js";
import { dispatchPinnedPeerCold } from "./peer-cold-client.js";
import { selectPeerColdOwner } from "./peer-cold-selection.js";
import { createResidencyRankingSource } from "./residency-ranking.js";

export interface BackendExecutorDescription {
  id: string;
  backendKinds: routingCatalog.BackendKind[];
  transports: routingCatalog.RouteTransport[];
}

export interface BackendExecutionContext {
  req: Request;
  resolved: ResolvedEnv;
  attemptId: string;
  deadline: number;
  signal?: AbortSignal;
  /**
   * #518 (c): the ranked local-http replica the unified ranker picked over
   * catalog order, so the legacy executor can forward it to `proxyOpenAI` as
   * `preferredWorkload`. Absent for the default pick, a single candidate, a
   * non-local transport, a remote owner or absent ranking signals.
   */
  preferredLocalWorkload?: string;
}

export interface BackendExecutor {
  describe(): BackendExecutorDescription;
  execute(
    envelope: inferenceContracts.InferenceEnvelopeV1,
    ctx: BackendExecutionContext,
  ): Promise<Response>;
  cancel(attemptId: string): boolean;
  drain(): Promise<void>;
  close(): Promise<void>;
}

export interface UnifiedProxyOptions {
  env?: NodeJS.ProcessEnv;
  resolved?: ResolvedEnv | (() => ResolvedEnv);
  executor?: BackendExecutor;
  passthrough?: (req: Request) => Promise<Response>;
  catalog?: () => routingCatalog.RouteCatalog | Promise<routingCatalog.RouteCatalog>;
  resolveCredentials?: (candidate: routingCatalog.RouteCandidate) => Promise<unknown>;
  acquireExecutor?: (
    candidate: routingCatalog.RouteCandidate,
  ) => Promise<BackendExecutor> | BackendExecutor;
  peers?: PeerNode[];
  peerSnapshots?: Map<string, PeerSnapshot>;
  /** Dedicated service credentials. Programmatic opt-in uses an explicit complete peers set. */
  peerCold?: {
    models: readonly string[];
    credentialFor: (ownerNodeId: string) => string | undefined;
  };
  advertisements?: readonly routingCatalog.RouteAdvertisementV1[];
  nodeId?: string;
  now?: () => number;
  rankingSignals?: routingRanking.RankingSignals | (() => routingRanking.RankingSignals);
  residencyPolicy?:
    | Partial<ResidencyPolicy>
    | null
    | (() => Partial<ResidencyPolicy> | null | undefined);
}

export interface UnifiedProxy {
  unifiedEnabled: boolean;
  describe(): { unified: boolean; executors: string[] };
  handleRequest(req: Request, trustedColdOwner?: ColdEngineForwarder): Promise<Response>;
  shadowCatalog(): Promise<routingCatalog.RouteCatalog>;
}

const UNIFIED_PROXY_FLAG = "LLAMACTL_UNIFIED_PROXY";
const DEFAULT_DEADLINE_MS = 300_000;
const EMBEDDED_SCOPE = "local";
const SEMANTIC_HEADER_ALLOWLIST = ["content-type", "anthropic-version", "anthropic-beta"];

export function unifiedProxyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[UNIFIED_PROXY_FLAG] === "1";
}

function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return lower.includes("application/json") || lower.includes("+json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ingressFor(pathname: string): routingCapabilities.IngressProtocol {
  if (pathname.endsWith("/v1/messages")) return "anthropic-messages";
  if (pathname.endsWith("/v1/responses")) return "openai-responses";
  return "openai-chat";
}

function operationFor(pathname: string): routingCapabilities.InferenceOperation {
  if (pathname.includes("/embeddings")) return "embed";
  if (pathname.endsWith("/tokenize")) return "count-tokens";
  return "generate";
}

function headerFingerprint(req: Request): { allowlist: string[]; fingerprint: string } {
  const parts = SEMANTIC_HEADER_ALLOWLIST.map((name) => `${name}=${req.headers.get(name) ?? ""}`);
  const fingerprint = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
  return { allowlist: [...SEMANTIC_HEADER_ALLOWLIST], fingerprint };
}

function capabilityError(
  rejection: routingCapabilities.CapabilityRejection,
  protocol: routingCapabilities.IngressProtocol,
): Response {
  const message = `no candidate route satisfies the request: ${rejection.reason}`;
  if (protocol === "anthropic-messages") {
    return Response.json(
      { type: "error", error: { type: "invalid_request_error", message } },
      { status: 400 },
    );
  }
  return Response.json(
    {
      error: {
        type: "invalid_request_error",
        code: rejection.reason,
        message,
      },
    },
    { status: 400 },
  );
}

interface GateInput {
  bodyText: string | null;
  body: Record<string, unknown> | null;
  model: string | null;
}

async function readGateInput(req: Request, peerCold: boolean): Promise<GateInput | Response> {
  if (req.method === "GET" || req.method === "HEAD") {
    return { bodyText: null, body: null, model: null };
  }
  if (req.body === null || !isJsonContentType(req.headers.get("content-type"))) {
    return { bodyText: null, body: null, model: null };
  }
  const bodyText = peerCold
    ? await readPeerText(req, PEER_COLD_MAX_BODY_BYTES, req.signal)
    : await req.text();
  if (bodyText === undefined) {
    return Response.json(
      { error: { type: "invalid_request_error", code: "request_body_too_large" } },
      { status: 413 },
    );
  }
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (isRecord(parsed)) body = parsed;
  } catch {
    body = null;
  }
  const rawModel = body?.["model"];
  const model = typeof rawModel === "string" && rawModel !== "" ? rawModel : null;
  return { bodyText, body, model };
}

function rebuildRequest(req: Request, bodyText: string | null): Request {
  if (bodyText === null) return req;
  return new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: bodyText,
    signal: req.signal,
  });
}

interface UnifiedDeps {
  executor: BackendExecutor;
  resolve: () => ResolvedEnv;
  now: () => number;
  nodeId: string;
  catalogForGate: () => Promise<routingCatalog.RouteCatalog | null>;
  unroutedPeerAlias: (model: string) => PeerAliasEvidence;
  boundedColdGateway: boolean;
  tryPeerCold: (
    model: string,
    ctx: BackendExecutionContext,
    bodyText: string | undefined,
    canSubmit: boolean,
    confirmNoOtherRoute: () => Promise<boolean>,
  ) => Promise<Response> | undefined;
  resolveCredentials?: UnifiedProxyOptions["resolveCredentials"];
  acquireExecutor?: UnifiedProxyOptions["acquireExecutor"];
  rankingSignals: () => routingRanking.RankingSignals;
  residencyPolicy: () => Partial<ResidencyPolicy> | null | undefined;
}

function makeEnvelope(input: {
  operation: routingCapabilities.InferenceOperation;
  protocol: routingCapabilities.IngressProtocol;
  features: routingCapabilities.RequiredFeatures;
  stream: boolean;
  model: string | null;
  body: Record<string, unknown> | null;
  req: Request;
  attemptId: string;
  deadline: number;
}): inferenceContracts.InferenceEnvelopeV1 {
  return inferenceContracts.parseInferenceEnvelope({
    requestId: `req-${randomUUID()}`,
    attemptId: input.attemptId,
    deadline: input.deadline,
    tenantId: EMBEDDED_SCOPE,
    projectId: EMBEDDED_SCOPE,
    credentialScopeId: EMBEDDED_SCOPE,
    operation: input.operation,
    ingressProtocol: input.protocol,
    publicModelId: input.model ?? "unrouted",
    features: input.features,
    stream: input.stream,
    nativeBody: input.body ?? {},
    headerFingerprint: headerFingerprint(input.req),
  });
}

/**
 * #518 (c): the local workload the ranked pick names, or null when the pick
 * needs no preference. The hint is computed only when the winner differs from
 * catalog order (`eligible.at(0)`) — so the default choice, a single candidate
 * and absent signals all leave everything byte-identical — and only for a
 * local-http replica owned by this node whose deployment id names a workload.
 */
function preferredLocalWorkloadHint(
  candidate: routingCatalog.RouteCandidate,
  eligible: readonly routingCatalog.RouteCandidate[],
  nodeId: string,
): string | null {
  if (candidate === eligible.at(0)) return null;
  const advertisement = candidate.advertisement;
  if (advertisement.transport !== "local-http") return null;
  if (advertisement.ownerNodeId !== nodeId) return null;
  return routingCatalog.workloadOfDeployment(advertisement.deploymentId, nodeId);
}

/**
 * #520: whether the request carries a session id. The rule matches the one
 * `proxyOpenAI` uses (openaiProxy.ts): the header must be present and
 * non-blank once trimmed, so an empty or whitespace-only value is not a session.
 */
function carriesSessionHeader(req: Request): boolean {
  const header = req.headers.get(openaiProxy.SESSION_HEADER);
  return header !== null && header.trim() !== "";
}

function matchesDeclaredOwner(
  candidate: routingCatalog.RouteCandidate,
  declaration: routingCatalog.DeclaredModelEntryV1,
): boolean {
  const ad = candidate.advertisement;
  return (
    candidate.source === "legacy" &&
    ad.transport === "local-http" &&
    ad.ownerNodeId === declaration.ownerNodeId &&
    routingCatalog.workloadOfDeployment(ad.deploymentId, ad.ownerNodeId) === declaration.workload
  );
}

interface PeerAliasEvidence {
  declared?: routingCatalog.DeclaredModelEntryV1;
  denied?: routingCatalog.DeclaredModelEntryV1;
  warm: boolean;
}

function tryUnroutedLocalColdCompletion(
  peer: PeerAliasEvidence,
  selection: ReturnType<typeof routingCatalog.selectCatalogCandidates> | null,
  ctx: BackendExecutionContext,
  declaration: routingCatalog.DeclaredModelEntryV1 | undefined,
  bodyText: string | undefined,
  owner: ColdEngineForwarder | undefined,
): Promise<Response> | undefined {
  if (
    selection === null ||
    selection.rejected.length > 0 ||
    peer.declared !== undefined ||
    peer.denied !== undefined ||
    peer.warm ||
    declaration?.ownerNodeId !== LOCAL_NODE_NAME ||
    declaration.kind !== "ModelRun" ||
    declaration.state === "ready" ||
    new URL(ctx.req.url).pathname !== "/v1/completions" ||
    owner === undefined ||
    bodyText === undefined
  )
    return undefined;
  return openaiProxy.forwardExactLocalColdCompletion(
    ctx.req,
    ctx.resolved,
    declaration,
    bodyText,
    owner,
  );
}

function planUnroutedCompletion(
  deps: UnifiedDeps,
  model: string,
  selection: ReturnType<typeof routingCatalog.selectCatalogCandidates> | null,
  pinned: boolean,
  ctx: BackendExecutionContext,
  declaration: routingCatalog.DeclaredModelEntryV1 | undefined,
  bodyText: string | undefined,
  localOwner: ColdEngineForwarder | undefined,
): {
  dispatch: Promise<Response> | undefined;
  declaration: routingCatalog.DeclaredModelEntryV1 | undefined;
} {
  const peer = deps.unroutedPeerAlias(model);
  const bound = declaration ?? (pinned ? (peer.declared ?? peer.denied) : peer.denied);
  if (!pinned) return { dispatch: undefined, declaration: bound };
  const local = tryUnroutedLocalColdCompletion(
    peer,
    selection,
    ctx,
    declaration,
    bodyText,
    localOwner,
  );
  if (local !== undefined) return { dispatch: local, declaration: bound };
  return { dispatch: undefined, declaration: bound };
}

async function exactColdStillUnrouted(
  deps: UnifiedDeps,
  model: string,
  resolved: ResolvedEnv,
): Promise<boolean> {
  const catalog = await deps.catalogForGate();
  if (
    catalog === null ||
    openaiProxy.declaredModelBinding(model, resolved) !== undefined ||
    openaiProxy.defaultTargetModelIds(resolved).has(model)
  )
    return false;
  const selection = routingCatalog.selectCatalogCandidates(catalog, model, { pinned: true });
  return selection.eligible.length === 0 && selection.rejected.length === 0;
}

async function gatedExecute(
  deps: UnifiedDeps,
  model: string,
  features: routingCapabilities.RequiredFeatures,
  envelope: inferenceContracts.InferenceEnvelopeV1,
  ctx: BackendExecutionContext,
  declaration: routingCatalog.DeclaredModelEntryV1 | undefined,
  bodyText: string | undefined,
  trustedColdOwner: ColdEngineForwarder | undefined,
): Promise<Response> {
  const catalog = await deps.catalogForGate();
  // #518: a default-target id is an implicit fall-through, not an exact
  // client pin, so experimental candidates for it stay excluded.
  const pinned = !openaiProxy.defaultTargetModelIds(ctx.resolved).has(model);
  const selection =
    catalog === null ? null : routingCatalog.selectCatalogCandidates(catalog, model, { pinned });
  const routes = selection?.eligible ?? [];
  const remote =
    routes.length === 0
      ? deps.tryPeerCold(
          model,
          ctx,
          bodyText,
          pinned && declaration === undefined && selection?.rejected.length === 0,
          () => exactColdStillUnrouted(deps, model, ctx.resolved),
        )
      : undefined;
  if (remote !== undefined) return await remote;
  if (routes.length === 0) {
    const unrouted = planUnroutedCompletion(
      deps,
      model,
      selection,
      pinned,
      ctx,
      declaration,
      bodyText,
      trustedColdOwner,
    );
    if (unrouted.dispatch !== undefined) return await unrouted.dispatch;
    declaration = unrouted.declaration;
  }
  const candidates =
    declaration === undefined
      ? routes
      : routes.filter((candidate) => matchesDeclaredOwner(candidate, declaration));
  const refusal = openaiProxy.declaredRouteRejection(declaration, candidates.length > 0, bodyText);
  if (refusal !== null) return refusal;
  if (selection === null || (candidates.length === 0 && selection.rejected.length === 0)) {
    return await deps.executor.execute(envelope, ctx);
  }

  return await executeRouteCandidates(deps, features, envelope, ctx, candidates);
}

async function executeRouteCandidates(
  deps: UnifiedDeps,
  features: routingCapabilities.RequiredFeatures,
  envelope: inferenceContracts.InferenceEnvelopeV1,
  ctx: BackendExecutionContext,
  candidates: readonly routingCatalog.RouteCandidate[],
): Promise<Response> {
  const { eligible, rejected } = routingCapabilities.filterCandidatesByCapabilities(
    features,
    candidates,
    (candidate) => candidate.advertisement.capabilities,
  );
  const candidate = routingRanking.pickRouteCandidate(eligible, {
    now: deps.now(),
    signals: deps.rankingSignals(),
    policy: deps.residencyPolicy(),
  });
  if (candidate === undefined) {
    const rejection = rejected.at(0)?.rejection;
    if (rejection !== undefined) return capabilityError(rejection, envelope.ingressProtocol);
    // #518: every candidate was experimental-excluded. Mirror legacy: a
    // default-target id falls through to the node's default endpoint.
    return await deps.executor.execute(envelope, ctx);
  }

  if (deps.resolveCredentials !== undefined) await deps.resolveCredentials(candidate);
  // #520: the worker RPC is sessionless — `fenceFeatures` in
  // packages/remote/src/inference/procedures.ts refuses `envelope.session` and
  // `makeEnvelope` does not carry the header — so a session request sent there
  // would take a lease on the owner, this node or a peer, but bind no session:
  // the owner's stop fence and eviction could unload it mid-session and affinity
  // is lost. The legacy executor runs `proxyOpenAI`, which binds the session
  // locally or forwards the header to the peer, whose own `proxyOpenAI` binds
  // it. The ranked pick is discarded on this path: the legacy route map, with
  // its session affinity, picks the replica. A request without the header keeps
  // the worker RPC.
  const sessionOnWorkerRpc =
    candidate.advertisement.transport === "worker-rpc" && carriesSessionHeader(ctx.req);
  const selected =
    sessionOnWorkerRpc || deps.acquireExecutor === undefined
      ? deps.executor
      : await deps.acquireExecutor(candidate);
  const hint = preferredLocalWorkloadHint(candidate, eligible, deps.nodeId);
  return await selected.execute(
    envelope,
    hint === null ? ctx : { ...ctx, preferredLocalWorkload: hint },
  );
}

async function handleUnifiedRequest(
  deps: UnifiedDeps,
  req: Request,
  trustedColdOwner: ColdEngineForwarder | undefined,
): Promise<Response> {
  const url = new URL(req.url);
  const gate = await readGateInput(req, deps.boundedColdGateway);
  if (gate instanceof Response) return gate;
  const forwarded = rebuildRequest(req, gate.bodyText);
  const operation = operationFor(url.pathname);
  const protocol = ingressFor(url.pathname);
  const stream = gate.body?.["stream"] === true;
  const features = routingCapabilities.deriveRequestFeatures({
    operation,
    ingressProtocol: protocol,
    stream,
    nativeBody: gate.body ?? {},
  });
  const attemptId = `att-${randomUUID()}`;
  const deadline = deps.now() + DEFAULT_DEADLINE_MS;
  const envelope = makeEnvelope({
    operation,
    protocol,
    features,
    stream,
    model: gate.model,
    body: gate.body,
    req,
    attemptId,
    deadline,
  });
  const ctx: BackendExecutionContext = {
    req: forwarded,
    resolved: deps.resolve(),
    attemptId,
    deadline,
  };
  if (gate.model === null) return await deps.executor.execute(envelope, ctx);
  const binding = openaiProxy.declaredModelBinding(gate.model, ctx.resolved);
  const isDefault = openaiProxy.defaultTargetModelIds(ctx.resolved).has(gate.model);
  const declaration =
    isDefault &&
    !routingCatalog.isDeclaredStaleReason(binding?.reason) &&
    !openaiProxy.requiresManagedDefaultOwner(gate.model, ctx.resolved, binding)
      ? undefined
      : binding;
  const bodyText = gate.bodyText ?? undefined;
  const refusal = openaiProxy.declaredRouteRejection(declaration, true, bodyText);
  if (refusal !== null) return refusal;
  return await gatedExecute(
    deps,
    gate.model,
    features,
    envelope,
    ctx,
    declaration,
    bodyText,
    trustedColdOwner,
  );
}

let publishedPeerSnapshots = new Map<string, PeerSnapshot>();

/**
 * Publish the peer snapshot map the unified catalog consumes — called
 * alongside `openaiProxy.setPeerSnapshots` by the agent's snapshot
 * poller so both routing paths observe identical peer state.
 */
export function publishUnifiedPeerSnapshots(snapshots: Map<string, PeerSnapshot>): void {
  publishedPeerSnapshots = snapshots;
}

function isHttpsEndpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Peer discovery for catalog building. Mirrors `listPeers` but never
 * resolves tokens — credential materialization belongs to the
 * credential stage after capability filtering, not catalog build.
 */
function discoverPeers(): PeerNode[] {
  try {
    const config = loadConfig();
    const context = currentContext(config);
    const cluster = config.clusters.find((candidate) => candidate.name === context.cluster);
    if (!cluster) return [];
    return cluster.nodes
      .filter((node) => (node.kind ?? "agent") === "agent")
      .filter((node) => node.name !== LOCAL_NODE_NAME && node.endpoint !== LOCAL_NODE_ENDPOINT)
      .filter((node) => isHttpsEndpoint(node.endpoint))
      .map((node) => ({
        id: node.name,
        ...(node.tlsServerName !== undefined ? { tlsServerName: node.tlsServerName } : {}),
        endpoint: node.endpoint,
        ...(node.certificate !== undefined ? { certificate: node.certificate } : {}),
        ...(node.certificateFingerprint !== undefined
          ? { fingerprint: node.certificateFingerprint }
          : {}),
        ...(node.tunnelPreferred !== undefined ? { tunnelPreferred: node.tunnelPreferred } : {}),
        ...(context.tunnelCentralUrl !== undefined
          ? { tunnelCentralUrl: context.tunnelCentralUrl }
          : {}),
        ...(context.tunnelCentralCertificate !== undefined
          ? { tunnelCentralCertificate: context.tunnelCentralCertificate }
          : {}),
        ...(context.tunnelCentralFingerprint !== undefined
          ? { tunnelCentralFingerprint: context.tunnelCentralFingerprint }
          : {}),
        ...(node.tunnelNodeName !== undefined ? { tunnelNodeName: node.tunnelNodeName } : {}),
      }));
  } catch {
    return [];
  }
}

function createPeerColdDispatch(
  opts: UnifiedProxyOptions,
  nodeId: string,
  now: () => number,
): UnifiedDeps["tryPeerCold"] {
  const policy = opts.peerCold;
  if (policy === undefined) return () => undefined;
  const peers = (opts.peers ?? []).filter(
    (peer) => peer.id !== LOCAL_NODE_NAME && peer.id !== nodeId,
  );
  const models = new Set(policy.models);
  const unavailable = (): Promise<Response> =>
    Promise.resolve(
      Response.json(
        { error: { type: "model_unavailable", code: "peer_cold_owner_unavailable" } },
        { status: 503 },
      ),
    );
  return (model, ctx, bodyText, canSubmit, confirmNoOtherRoute) => {
    const url = new URL(ctx.req.url);
    if (!models.has(model) || url.pathname !== "/v1/completions") return undefined;
    if (
      !canSubmit ||
      bodyText === undefined ||
      url.search !== "" ||
      ctx.req.method !== "POST" ||
      ctx.req.headers.has(openaiProxy.SESSION_HEADER)
    )
      return unavailable();
    const selected = (): ReturnType<typeof selectPeerColdOwner> =>
      selectPeerColdOwner(model, peers, opts.peerSnapshots ?? publishedPeerSnapshots, now());
    const offer = selected();
    const owner =
      offer === undefined ? undefined : peers.find((peer) => peer.id === offer.ownerNodeId);
    if (offer === undefined || owner === undefined) return unavailable();
    const credential = policy.credentialFor(owner.id);
    const body = JSON.parse(bodyText) as unknown;
    if (credential === undefined || !isRecord(body) || Object.hasOwn(body, "x_omlx_request_handle"))
      return unavailable();
    return dispatchPinnedPeerCold({
      node: peerColdNode(owner),
      serviceCredential: credential,
      declaration: offer,
      path: "/v1/completions",
      body,
      deadlineMs: ctx.deadline,
      signal: ctx.req.signal,
      stillSelected: async () =>
        (await confirmNoOtherRoute()) && samePeerColdOffer(offer, selected()),
    });
  };
}

function samePeerColdOffer(
  offered: NonNullable<ReturnType<typeof selectPeerColdOwner>>,
  current: ReturnType<typeof selectPeerColdOwner>,
): boolean {
  return (
    current?.ownerNodeId === offered.ownerNodeId &&
    current.workload === offered.workload &&
    current.artifactRevision === offered.artifactRevision &&
    current.policyRevision === offered.policyRevision
  );
}

function peerColdNode(owner: PeerNode): Parameters<typeof dispatchPinnedPeerCold>[0]["node"] {
  return {
    name: owner.id,
    endpoint: owner.endpoint,
    ...(owner.certificate === undefined ? {} : { certificate: owner.certificate }),
    ...(owner.fingerprint === undefined ? {} : { certificateFingerprint: owner.fingerprint }),
    ...(owner.tlsServerName === undefined ? {} : { tlsServerName: owner.tlsServerName }),
    ...(owner.tunnelPreferred === undefined ? {} : { tunnelPreferred: owner.tunnelPreferred }),
  };
}

export function createProxy(opts: UnifiedProxyOptions = {}): UnifiedProxy {
  const enabled = unifiedProxyEnabled(opts.env ?? process.env);
  const resolvedOpt = opts.resolved;
  const resolve: () => ResolvedEnv =
    typeof resolvedOpt === "function"
      ? resolvedOpt
      : (): ResolvedEnv => resolvedOpt ?? resolveEnv();
  const executor = opts.executor ?? createLegacyLocalExecutor({ resolved: resolve });
  const passthrough =
    opts.passthrough ??
    ((req: Request): Promise<Response> => openaiProxy.proxyOpenAI(req, resolve()));
  const now: () => number = opts.now ?? ((): number => Date.now());
  const nodeId = opts.nodeId ?? LOCAL_NODE_NAME;
  const rankingSignalsOpt = opts.rankingSignals;
  const rankingSignals: () => routingRanking.RankingSignals =
    typeof rankingSignalsOpt === "function"
      ? rankingSignalsOpt
      : (): routingRanking.RankingSignals => rankingSignalsOpt ?? {};
  const residencyPolicyOpt = opts.residencyPolicy;
  const residencyPolicy: () => Partial<ResidencyPolicy> | null | undefined =
    typeof residencyPolicyOpt === "function"
      ? residencyPolicyOpt
      : (): Partial<ResidencyPolicy> | null | undefined => residencyPolicyOpt ?? null;
  // worker-rpc candidates run on the worker RPC, over the transport their
  // declared owner's kubeconfig node selects; everything else keeps the
  // default executor.
  const acquireExecutor =
    opts.acquireExecutor ??
    ((candidate: routingCatalog.RouteCandidate): BackendExecutor =>
      acquireWorkerRpcExecutor(candidate, {
        nodeId,
        scope: EMBEDDED_SCOPE,
        fallback: executor,
        peers: configuredPeers,
      }) ?? executor);

  function configuredPeers(): PeerNode[] {
    if (opts.peers !== undefined) return opts.peers;
    return discoverPeers();
  }

  function freshPeerAlias(
    snapshots: ReadonlyMap<string, PeerSnapshot>,
    model: string,
  ): PeerAliasEvidence {
    let warm = false;
    for (const { id } of configuredPeers()) {
      if (id === LOCAL_NODE_NAME || id === nodeId) continue;
      const snapshot = snapshots.get(id);
      if (snapshot === undefined || now() - snapshot.fetchedAt > PEER_ROUTE_STALE_MS) continue;
      // Only the authenticated snapshot poller can publish a declaration.
      const entry = snapshot.declaredProvenance?.entries.find(
        (candidate) => candidate.id === model,
      );
      if (entry?.ownerNodeId === id) {
        return {
          warm,
          declared: {
            id: entry.id,
            workload: entry.workload,
            kind: entry.kind,
            ownerNodeId: id,
            state: entry.state === "ready" || entry.state === "loading" ? "cold" : entry.state,
            autoLoadEligible: false,
            reason: "peer-owner-required",
          },
        };
      }
      warm ||= snapshot.workloads.some((candidate) => candidate.modelId === model);
    }
    return { warm };
  }

  function unroutedPeerAlias(model: string): PeerAliasEvidence {
    const snapshots = opts.peerSnapshots ?? publishedPeerSnapshots;
    if (snapshots.size === 0) return { warm: false };
    const denied = openaiProxy.retainedPeerDeclaration(model, snapshots, nodeId);
    const fresh = freshPeerAlias(snapshots, model);
    return denied === undefined ? fresh : { ...fresh, denied };
  }

  function buildShadowCatalog(): routingCatalog.RouteCatalog {
    const resolvedEnv = resolve();
    const routes = listClusterRoutes(
      listLocalRoutes(resolvedEnv),
      opts.peerSnapshots ?? publishedPeerSnapshots,
      { peers: configuredPeers() },
      Date.now(),
      { stageByModel: catalogQualificationStages(resolvedEnv) },
    );
    return routingCatalog.buildRouteCatalog({
      routes,
      nodeId,
      now: now(),
      ...(opts.advertisements !== undefined ? { advertisements: opts.advertisements } : {}),
    });
  }

  const deps: UnifiedDeps = {
    executor,
    resolve,
    now,
    nodeId,
    catalogForGate: async () => {
      try {
        return opts.catalog !== undefined ? await opts.catalog() : buildShadowCatalog();
      } catch {
        return null;
      }
    },
    unroutedPeerAlias,
    boundedColdGateway: opts.peerCold !== undefined,
    tryPeerCold: createPeerColdDispatch(opts, nodeId, now),
    ...(opts.resolveCredentials !== undefined
      ? { resolveCredentials: opts.resolveCredentials }
      : {}),
    acquireExecutor,
    rankingSignals,
    residencyPolicy,
  };

  return {
    unifiedEnabled: enabled,
    describe: () => ({ unified: enabled, executors: [executor.describe().id] }),
    shadowCatalog: () => Promise.resolve(buildShadowCatalog()),
    handleRequest: async (req, trustedColdOwner): Promise<Response> =>
      enabled ? await handleUnifiedRequest(deps, req, trustedColdOwner) : await passthrough(req),
  };
}

/**
 * #519: the shared composition factory `dispatchProxyRequest` builds.
 * Wraps `createProxy` with a cached `createResidencyRankingSource` for
 * the serving node (`LLAMACTL_NODE_NAME`-selected NodeRun policy, ready
 * lifecycle rows as the resident deploymentIds), unless the caller
 * already supplies the ranking inputs.
 */
export function createSharedUnifiedProxy(
  opts: UnifiedProxyOptions & {
    listNodeRuns?: () => NodeRun[];
    readStore?: () => ResidencyStoreSnapshot;
    residencyTtlMs?: number;
  } = {},
): UnifiedProxy {
  const { listNodeRuns, readStore, residencyTtlMs, ...proxyOpts } = opts;
  const source = createResidencyRankingSource({
    env: proxyOpts.env ?? process.env,
    nodeId: proxyOpts.nodeId ?? LOCAL_NODE_NAME,
    ...(listNodeRuns !== undefined ? { listNodeRuns } : {}),
    ...(readStore !== undefined ? { readStore } : {}),
    ...(residencyTtlMs !== undefined ? { ttlMs: residencyTtlMs } : {}),
    ...(proxyOpts.now !== undefined ? { now: proxyOpts.now } : {}),
  });
  // An explicit caller `residencyPolicy: null` means "no policy" and must
  // not fall through to the NodeRun source, so test `undefined`, not `??`.
  return createProxy({
    ...proxyOpts,
    residencyPolicy:
      proxyOpts.residencyPolicy !== undefined
        ? proxyOpts.residencyPolicy
        : (): Partial<ResidencyPolicy> | null => source.policy(),
    rankingSignals:
      proxyOpts.rankingSignals ?? ((): routingRanking.RankingSignals => source.signals()),
  });
}

export { residencyRankingInputs } from "./residency-ranking.js";

let sharedProxy: UnifiedProxy | null = null;

/**
 * The shared flag-gated dispatch every production ingress calls. The
 * flag is read per request: unset or "0" returns the exact legacy
 * `openaiProxy.proxyOpenAI` call — no extra awaits, allocations or
 * catalog construction — while "1" routes through the lazily created
 * shared unified composition.
 */
export function dispatchProxyRequest(
  req: Request,
  trustedColdOwner?: ColdEngineForwarder,
): Promise<Response> {
  if (!unifiedProxyEnabled()) {
    return trustedColdOwner === undefined
      ? openaiProxy.proxyOpenAI(req)
      : openaiProxy.proxyOpenAI(req, undefined, { trustedColdOwner });
  }
  sharedProxy ??= createSharedUnifiedProxy();
  return sharedProxy.handleRequest(req, trustedColdOwner);
}

export function __setSharedUnifiedProxyForTests(proxy: UnifiedProxy | null): void {
  sharedProxy = proxy;
}
