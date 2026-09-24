import type { PeerNode } from "@llamactl/core/config/peers";
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
} from "@llamactl/core";
import { currentContext, loadConfig } from "@llamactl/core/config/kubeconfig";
import { LOCAL_NODE_ENDPOINT, LOCAL_NODE_NAME } from "@llamactl/core/config/schema";
import { resolveEnv } from "@llamactl/core/env";
import {
  listClusterRoutes,
  listLocalRoutes,
  type PeerSnapshot,
} from "@llamactl/core/workloadRuntime";
import { createHash, randomUUID } from "node:crypto";

import { createLegacyLocalExecutor } from "../inference/legacy-local-executor.js";

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
  advertisements?: readonly routingCatalog.RouteAdvertisementV1[];
  nodeId?: string;
  now?: () => number;
}

export interface UnifiedProxy {
  unifiedEnabled: boolean;
  describe(): { unified: boolean; executors: string[] };
  handleRequest(req: Request): Promise<Response>;
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

async function readGateInput(req: Request): Promise<GateInput> {
  if (req.method === "GET" || req.method === "HEAD") {
    return { bodyText: null, body: null, model: null };
  }
  if (!isJsonContentType(req.headers.get("content-type"))) {
    return { bodyText: null, body: null, model: null };
  }
  const bodyText = await req.text();
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
  catalogForGate: () => Promise<routingCatalog.RouteCatalog | null>;
  resolveCredentials?: UnifiedProxyOptions["resolveCredentials"];
  acquireExecutor?: UnifiedProxyOptions["acquireExecutor"];
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

async function gatedExecute(
  deps: UnifiedDeps,
  model: string,
  features: routingCapabilities.RequiredFeatures,
  envelope: inferenceContracts.InferenceEnvelopeV1,
  ctx: BackendExecutionContext,
): Promise<Response> {
  const catalog = await deps.catalogForGate();
  const candidates = catalog === null ? [] : routingCatalog.catalogCandidatesFor(catalog, model);
  if (candidates.length === 0) return await deps.executor.execute(envelope, ctx);

  const { eligible, rejected } = routingCapabilities.filterCandidatesByCapabilities(
    features,
    candidates,
    (candidate) => candidate.advertisement.capabilities,
  );
  const candidate = eligible.at(0);
  if (candidate === undefined) {
    const rejection = rejected.at(0)?.rejection;
    return rejection === undefined
      ? await deps.executor.execute(envelope, ctx)
      : capabilityError(rejection, envelope.ingressProtocol);
  }

  if (deps.resolveCredentials !== undefined) await deps.resolveCredentials(candidate);
  const selected =
    deps.acquireExecutor !== undefined ? await deps.acquireExecutor(candidate) : deps.executor;
  return await selected.execute(envelope, ctx);
}

async function handleUnifiedRequest(deps: UnifiedDeps, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const gate = await readGateInput(req);
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
  return await gatedExecute(deps, gate.model, features, envelope, ctx);
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

  function configuredPeers(): PeerNode[] {
    if (opts.peers !== undefined) return opts.peers;
    return discoverPeers();
  }

  function buildShadowCatalog(): routingCatalog.RouteCatalog {
    const routes = listClusterRoutes(
      listLocalRoutes(resolve()),
      opts.peerSnapshots ?? publishedPeerSnapshots,
      { peers: configuredPeers() },
    );
    return routingCatalog.buildRouteCatalog({
      routes,
      nodeId: opts.nodeId ?? LOCAL_NODE_NAME,
      now: now(),
      ...(opts.advertisements !== undefined ? { advertisements: opts.advertisements } : {}),
    });
  }

  const deps: UnifiedDeps = {
    executor,
    resolve,
    now,
    catalogForGate: async () => {
      try {
        return opts.catalog !== undefined ? await opts.catalog() : buildShadowCatalog();
      } catch {
        return null;
      }
    },
    ...(opts.resolveCredentials !== undefined
      ? { resolveCredentials: opts.resolveCredentials }
      : {}),
    ...(opts.acquireExecutor !== undefined ? { acquireExecutor: opts.acquireExecutor } : {}),
  };

  return {
    unifiedEnabled: enabled,
    describe: () => ({ unified: enabled, executors: [executor.describe().id] }),
    shadowCatalog: () => Promise.resolve(buildShadowCatalog()),
    handleRequest: async (req: Request): Promise<Response> =>
      enabled ? await handleUnifiedRequest(deps, req) : await passthrough(req),
  };
}

let sharedProxy: UnifiedProxy | null = null;

/**
 * The shared flag-gated dispatch every production ingress calls. The
 * flag is read per request: unset or "0" returns the exact legacy
 * `openaiProxy.proxyOpenAI` call — no extra awaits, allocations or
 * catalog construction — while "1" routes through the lazily created
 * shared unified composition.
 */
export function dispatchProxyRequest(req: Request): Promise<Response> {
  if (!unifiedProxyEnabled()) return openaiProxy.proxyOpenAI(req);
  sharedProxy ??= createProxy();
  return sharedProxy.handleRequest(req);
}

export function __setSharedUnifiedProxyForTests(proxy: UnifiedProxy | null): void {
  sharedProxy = proxy;
}
