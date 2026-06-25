import type { ModelInfo, ModelListResponse } from "@nova/contracts";

import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { AnthropicMessagesRequest } from "./anthropic/types.js";
import type { ResolvedEnv } from "./types.js";
import type { WorkloadKey } from "./workloadRuntime.js";

import {
  AnthropicTranslationError,
  translateAnthropicRequest,
} from "./anthropic/translateRequest.js";
import { translateOpenAIResponse } from "./anthropic/translateResponse.js";
import { translateOpenAIStreamToAnthropic } from "./anthropic/translateStream.js";
import { boundaryNaiveBytePrefixSha, canonicalRequestSha } from "./cache-identity/canonical.js";
import { listPeers, type PeerNode } from "./config/peers.js";
import { ctxForModel } from "./ctx.js";
import { readModelHostState } from "./engines/state.js";
import { resolveEnv } from "./env.js";
import {
  EXT_FLAG_SESSION_TITLE,
  EXT_FLAG_TOOL_MAP,
  KvRegistry,
  type KvStorage,
  type KvTrailer,
  longestPrefixLookup,
  openKvStorage,
  parseAbsoluteSlotSavePath,
  readTrailer,
  readWorkloadEpoch,
  runEvictionIfOverBudget,
  SlotAllocator,
  sweepOrphanSlotFiles,
  UpstreamSlotClient,
  writeTrailer,
} from "./kvstore/index.js";
import { omitUndefined } from "./object.js";
import {
  isDeterministic,
  openResponseCacheStorage,
  type ResponseCacheEntry,
  ResponseCacheRegistry,
  type ResponseCacheStorage,
  runResponseCacheEvictionIfOverBudget,
} from "./responsecache/index.js";
import { mkdirSync, readdirSync, statSync } from "./safe-fs.js";
import { endpoint as llamaEndpoint, readServerPid, readServerState } from "./server.js";
import * as workloadRuntime from "./workloadRuntime.js";

const MAX_JSON_BODY_BYTES = 10 * 1024 * 1024;

/**
 * OpenAI-compatible gateway in front of the local llama-server.
 * Any `/v1/*` request (except `/v1/models`) is forwarded transparently
 * to the llama-server that the agent is tracking, streaming body and
 * headers in both directions. Callers can point any OpenAI SDK at the
 * agent's URL + bearer token and get llama.cpp's built-in OpenAI
 * response shape back unchanged.
 *
 * `listOpenAIModels` returns `nova.ModelListResponse` — the
 * canonical shape every AI provider in this family publishes.
 *
 * JSON requests can route by request-body `model` across live
 * workloads on the node. When no model matches, or the body is not
 * parseable JSON, the proxy falls back to the node's default endpoint
 * for back-compat.
 */

/**
 * List the models this agent currently exposes. For now that's the
 * single llama-server that's running (identified by its rel), or an
 * empty list when nothing is tracked.
 */
export function listOpenAIModels(resolved?: ResolvedEnv): ModelListResponse;
export function listOpenAIModels(key: WorkloadKey, resolved?: ResolvedEnv): ModelListResponse;
export function listOpenAIModels(
  keyOrResolved: WorkloadKey | ResolvedEnv = resolveEnv(),
  resolved: ResolvedEnv = resolveEnv(),
): ModelListResponse {
  if ("name" in keyOrResolved) {
    const key = keyOrResolved;
    const state = readServerState(key, resolved);
    const pid = readServerPid(key, resolved);
    const data: ModelInfo[] = [];
    if (state && pid !== null) {
      data.push({
        id: state.rel,
        object: "model",
        created: Math.floor(new Date(state.startedAt).getTime() / 1000),
        owned_by: "llamactl-agent",
        capabilities: ["chat"],
      });
    }
    return { object: "list", data };
  }

  return getCachedModelsResponse(keyOrResolved);
}

function createdAtForRoute(route: workloadRuntime.ClusterRoute, resolved: ResolvedEnv): number {
  if (isPeerClusterRoute(route)) return 0;
  if (route.kind === "ModelHost") {
    const state = readModelHostState({ name: route.workload }, resolved);
    if (state?.startedAt) return Math.floor(new Date(state.startedAt).getTime() / 1000);
  } else {
    const state = readServerState({ name: route.workload }, resolved);
    if (state?.startedAt) return Math.floor(new Date(state.startedAt).getTime() / 1000);
  }
  return 0;
}

function listRoutesForProxy(resolved: ResolvedEnv): workloadRuntime.ClusterRoute[] {
  const localRoutes = workloadRuntime.listLocalRoutes(resolved);
  const peers = clusterRoutingOverrideForTests?.clusterPeers ?? listPeers();
  const clusterConfig = {
    peers,
  };
  const peerSnapshots = clusterRoutingOverrideForTests?.peerSnapshots ?? productionPeerSnapshots;
  return workloadRuntime.listClusterRoutes(localRoutes, peerSnapshots, clusterConfig);
}

function buildListOpenAIModels(resolved: ResolvedEnv): ModelListResponse {
  const data: ModelInfo[] = [];
  const winners = new Map<string, { kind: string; workload: string }>();
  const routes = [...listRoutesForProxy(resolved)].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "ModelRun" ? -1 : 1;
    return a.workload.localeCompare(b.workload);
  });
  for (const route of routes) {
    if (winners.has(route.model)) {
      const prior = winners.get(route.model);
      if (!prior) continue;
      console.warn(
        `[openaiProxy] route-map collision on model='${route.model}': keeping ${prior.kind}:${prior.workload}, ignoring ${route.kind}:${route.workload}`,
      );
      continue;
    }
    winners.set(route.model, { kind: route.kind, workload: route.workload });
    data.push({
      id: route.model,
      object: "model",
      created: createdAtForRoute(route, resolved),
      owned_by: route.kind === "ModelHost" ? "llamactl-host" : "llamactl-agent",
      capabilities: ["chat"],
    });
  }
  return { object: "list", data };
}

const WORKLOAD_STATE_FILES = [
  "llama-server.pid",
  "server.state",
  "modelhost.pid",
  "modelhost.state",
];

function statMtimeNs(path: string): string {
  try {
    return statSync(path, { bigint: true }).mtimeNs.toString();
  } catch {
    return "-";
  }
}

// Cache key for the route/models caches. The parent workloads/ dir mtime alone
// is stale-prone: a model restart rewrites workloads/<name>/{modelhost,server}.state
// in place, which bumps the FILE mtime but not the parent dir's — so the caches
// kept serving the old route until a manual `touch` of the workloads dir. Fold
// each workload subdir AND its pid/state files into the signature so any restart
// invalidates the cache automatically.
function workloadRuntimeCacheSignature(resolved: ResolvedEnv): string {
  const root = workloadRuntime.workloadRuntimeRoot(resolved);
  const parts: string[] = [statMtimeNs(root)];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      parts.push(entry.name, statMtimeNs(dir));
      for (const file of WORKLOAD_STATE_FILES) parts.push(statMtimeNs(join(dir, file)));
    }
  } catch {
    // workloads root missing/unreadable — signature is just the root stat.
  }
  return parts.join("|");
}

let modelsResponseCache: { sig: string; response: ModelListResponse } | null = null;

function getCachedModelsResponse(resolved: ResolvedEnv): ModelListResponse {
  try {
    const sig = workloadRuntimeCacheSignature(resolved);
    if (modelsResponseCache?.sig === sig) return modelsResponseCache.response;
    const response = buildListOpenAIModels(resolved);
    modelsResponseCache = { sig, response };
    return response;
  } catch {
    return buildListOpenAIModels(resolved);
  }
}

function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return lower.includes("application/json") || lower.includes("+json");
}

function isPeerClusterRoute(
  route: workloadRuntime.ClusterRoute,
): route is Extract<workloadRuntime.ClusterRoute, { isPeer: true }> {
  return "isPeer" in route;
}

function peerTlsForRoute(route: RoutedEntry | undefined): { ca: string } | undefined {
  if (!route?.isPeer || !route.certificate) return undefined;
  return { ca: route.certificate };
}

function requestedModelFromBody(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as { model?: unknown };
    return typeof parsed.model === "string" ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

function routedEndpointForModel(
  model: string,
  pathname: string,
  search: string,
  resolved: ResolvedEnv,
): RoutedEntry | null {
  const routeMap = getRouteMap(resolved);
  const entry = routeMap.get(model);
  if (!entry) return null;
  const target =
    entry.isPeer && entry.peerEndpoint
      ? `${entry.peerEndpoint}${pathname}${search}`
      : `http://${entry.host}:${String(entry.port)}${pathname}${search}`;
  return {
    ...entry,
    target,
  };
}

type RouteEntry = {
  host: string;
  port: number;
  workload: string;
  kind: "ModelRun" | "ModelHost";
  engine: workloadRuntime.LocalRoute["engine"];
  model: string;
  isPeer?: true;
  peerEndpoint?: string;
  certificate?: string;
  token?: string;
  targetNodeId?: string;
  /** Peer boot token (the peer server's /v1/models `created`); folded into the
   *  response-cache epoch so a peer restart/swap invalidates cross-node entries. */
  revision?: string | null;
};

type RoutedEntry = RouteEntry & { target: string };

interface KvRuntime {
  storage: KvStorage;
  registry: KvRegistry;
  allocators: Map<string, SlotAllocator>;
  slotClients: Map<string, { endpoint: string; client: UpstreamSlotClient }>;
}

interface ResponseCacheRuntime {
  storage: ResponseCacheStorage;
  registry: ResponseCacheRegistry;
}

interface KvRequestState {
  runtime: KvRuntime;
  workload: string;
  slotDir: string;
  model?: string | null;
  host: string;
  port: number;
  quantBits: number;
  ctxSize: number;
  workloadEpoch: string;
  sha: string;
  prefixMetric: number;
  shouldPersist: boolean;
  warmHitSha: string | null;
  warmHitLease: { slotId: number; release: () => void } | null;
  warmHitExpectedFirstResponseToken: string | null;
  enforceFirstTokenEquivalence: boolean;
}

interface ResponseCacheRequestState {
  runtime: ResponseCacheRuntime;
  sha: string;
  model: string;
  workload: string;
  workloadEpoch: string;
  protocolVariant: "openai" | "anthropic";
  deterministic: boolean;
  requestBodyBytes: number;
}

type ProxyContext = {
  req: Request;
  resolved: ResolvedEnv;
  target: string;
  pathname: string;
  search: string;
  init: RequestInit;
  bodyText?: string;
  isAnthropic?: boolean;
  anthropicModel?: string;
  anthropicRequest?: AnthropicMessagesRequest;
  route?: RoutedEntry;
  kv?: KvRequestState;
  responseCache?: ResponseCacheRequestState;
  responseCacheHit?: Response;
  /**
   * Captured by maybeInjectOmlxSaveHandle BEFORE the save-handle injection
   * forces stream:false on the upstream request. If the client originally
   * asked for SSE, the response path synthesizes an OpenAI-compatible
   * text/event-stream body from the upstream JSON completion so the client's
   * SDK does not crash parsing JSON when it expected events.
   */
  clientRequestedStream?: boolean;
};

let routeMapCache: { sig: string; map: Map<string, RouteEntry> } | null = null;
let routeMapBuildCount = 0;
let clusterRoutingOverrideForTests: {
  clusterPeers?: PeerNode[];
  peerSnapshots?: Map<string, workloadRuntime.PeerSnapshot>;
} | null = null;
// Production peer-snapshot store, refreshed by the peer-snapshot poller running
// in the proxy process (startAgentServer). Empty until the poller publishes —
// so a node with no peers (or before the first poll) routes only local models.
let productionPeerSnapshots = new Map<string, workloadRuntime.PeerSnapshot>();

/**
 * Publish the latest peer fleet snapshots so cross-node (peer) models become
 * routable through this proxy. listClusterRoutes already filters stale entries
 * (>30s by fetchedAt) and HIGH-pressure peers; the poller just keeps the map
 * fresh. Invalidates the route-map cache since its signature does not track
 * peer-snapshot changes.
 */
export function setPeerSnapshots(snapshots: Map<string, workloadRuntime.PeerSnapshot>): void {
  productionPeerSnapshots = snapshots;
  routeMapCache = null;
  modelsResponseCache = null;
}
function invalidateRouteCacheEntry(model: string): void {
  if (routeMapCache) {
    routeMapCache.map.delete(model);
  }
  routeMapCache = null;
  modelsResponseCache = null;
}

function buildRouteMap(resolved: ResolvedEnv): Map<string, RouteEntry> {
  routeMapBuildCount += 1;
  const out = new Map<string, RouteEntry>();
  const winners = new Map<string, { kind: string; workload: string }>();
  const routes = [...listRoutesForProxy(resolved)].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "ModelRun" ? -1 : 1;
    return a.workload.localeCompare(b.workload);
  });
  for (const route of routes) {
    const prior = winners.get(route.model);
    if (prior) {
      console.warn(
        `[openaiProxy] route-map collision on model='${route.model}': keeping ${prior.kind}:${prior.workload}, ignoring ${route.kind}:${route.workload}`,
      );
      continue;
    }
    const peerFields = isPeerClusterRoute(route)
      ? {
          isPeer: true as const,
          peerEndpoint: route.peerEndpoint,
          ...omitUndefined({ certificate: route.certificate }),
          ...omitUndefined({ token: route.token }),
          targetNodeId: route.targetNodeId,
          ...omitUndefined({ revision: route.revision }),
        }
      : {};
    winners.set(route.model, { kind: route.kind, workload: route.workload });
    out.set(route.model, {
      host: route.host,
      port: route.port,
      workload: route.workload,
      kind: route.kind,
      engine: route.engine,
      model: route.model,
      ...peerFields,
    });
  }
  return out;
}

function getRouteMap(resolved: ResolvedEnv): Map<string, RouteEntry> {
  try {
    const sig = workloadRuntimeCacheSignature(resolved);
    if (routeMapCache?.sig === sig) return routeMapCache.map;
    const map = buildRouteMap(resolved);
    routeMapCache = { sig, map };
    return map;
  } catch {
    return buildRouteMap(resolved);
  }
}

export function __resetOpenAIProxyRouteMapCacheForTests(): void {
  routeMapCache = null;
  modelsResponseCache = null;
  routeMapBuildCount = 0;
  clusterRoutingOverrideForTests = null;
  for (const runtime of kvRuntimeByDataRoot.values()) {
    runtime.storage.close();
  }
  for (const runtime of responseCacheRuntimeByDataRoot.values()) {
    runtime.storage.close();
  }
  kvRuntimeByDataRoot.clear();
  responseCacheRuntimeByDataRoot.clear();
}

export function __setOpenAIProxyClusterRoutingForTests(input: {
  clusterPeers?: PeerNode[];
  peerSnapshots?: Map<string, workloadRuntime.PeerSnapshot>;
}): void {
  clusterRoutingOverrideForTests = {
    ...omitUndefined({ clusterPeers: input.clusterPeers }),
    ...omitUndefined({ peerSnapshots: input.peerSnapshots }),
  };
  routeMapCache = null;
  modelsResponseCache = null;
}

export function __getOpenAIProxyRouteMapBuildCountForTests(): number {
  return routeMapBuildCount;
}

export function __getOpenAIProxyKvFalseHitTotalForTests(resolved: ResolvedEnv): number {
  return kvRuntimeFor(resolved).storage.kv_false_hit_total;
}

export function __getOpenAIProxyKvReplayMismatchTotalForTests(resolved: ResolvedEnv): number {
  return kvRuntimeFor(resolved).storage.kv_replay_mismatch_total;
}

export function __getOpenAIProxyKvModelMismatchTotalForTests(resolved: ResolvedEnv): number {
  return kvRuntimeFor(resolved).storage.kv_model_mismatch_total;
}

export function __getOpenAIProxyResponseCacheHitTotalForTests(resolved: ResolvedEnv): number {
  return responseCacheRuntimeFor(resolved).storage.response_cache_hit_total;
}

export function __getOpenAIProxyResponseCacheMissTotalForTests(resolved: ResolvedEnv): number {
  return responseCacheRuntimeFor(resolved).storage.response_cache_miss_total;
}

export function __getOpenAIProxyResponseCacheEvictTotalForTests(resolved: ResolvedEnv): number {
  return responseCacheRuntimeFor(resolved).storage.response_cache_evict_total;
}

export function __getOpenAIProxySlotAllocatorInUseForTests(
  resolved: ResolvedEnv,
  workload: string,
): number {
  return slotAllocatorFor(kvRuntimeFor(resolved), workload).inUse().length;
}

function anthropicTranslationErrorResponse(error: unknown): Response {
  return Response.json(
    {
      error: {
        message: error instanceof Error ? error.message : "anthropic request translation failed",
        type: "anthropic_translation_error",
      },
    },
    { status: error instanceof AnthropicTranslationError ? error.statusCode : 400 },
  );
}

function isOversizedJsonBody(req: Request): boolean {
  const contentLength = req.headers.get("content-length");
  if (!contentLength) return false;
  const parsedContentLength = Number.parseInt(contentLength, 10);
  return Number.isFinite(parsedContentLength) && parsedContentLength > MAX_JSON_BODY_BYTES;
}

async function parseIncoming(
  req: Request,
  resolved: ResolvedEnv,
): Promise<ProxyContext | Response> {
  const url = new URL(req.url);
  const headers = new Headers();
  for (const [key, value] of req.headers.entries()) {
    const lower = key.toLowerCase();
    if (
      lower === "host" ||
      lower === "connection" ||
      lower === "content-length" ||
      lower === "authorization"
    ) {
      continue;
    }
    headers.set(key, value);
  }
  if (url.pathname === "/v1/messages") {
    if (isOversizedJsonBody(req)) {
      return new Response("Payload Too Large", { status: 413 });
    }
    try {
      const bodyText = await req.text();
      const incoming = JSON.parse(bodyText) as AnthropicMessagesRequest;
      const translated = translateAnthropicRequest(incoming);
      const translatedBodyText = JSON.stringify(translated);
      const translatedUrl = new URL(req.url);
      translatedUrl.pathname = "/v1/chat/completions";
      return {
        req,
        resolved,
        target: `${llamaEndpoint(resolved)}${translatedUrl.pathname}${translatedUrl.search}`,
        pathname: translatedUrl.pathname,
        search: translatedUrl.search,
        isAnthropic: true,
        anthropicModel: incoming.model,
        anthropicRequest: incoming,
        bodyText: translatedBodyText,
        init: {
          method: req.method,
          headers,
          body: translatedBodyText,
        },
      };
    } catch (error) {
      if (error instanceof AnthropicTranslationError || error instanceof SyntaxError) {
        return anthropicTranslationErrorResponse(error);
      }
      return anthropicTranslationErrorResponse(
        new AnthropicTranslationError("anthropic request translation failed"),
      );
    }
  }
  const fallbackTarget = `${llamaEndpoint(resolved)}${url.pathname}${url.search}`;
  return {
    req,
    resolved,
    target: fallbackTarget,
    pathname: url.pathname,
    search: url.search,
    isAnthropic: false,
    init: {
      method: req.method,
      headers,
    },
  };
}

const kvRuntimeByDataRoot = new Map<string, KvRuntime>();
const responseCacheRuntimeByDataRoot = new Map<string, ResponseCacheRuntime>();

function resolveKvDataRoot(resolved: ResolvedEnv): string {
  // KV state is rooted beside workload runtime files to avoid route-map cache churn on each KV write.
  const runtimeRoot = (resolved as Partial<ResolvedEnv>).LOCAL_AI_RUNTIME_DIR;
  if (typeof runtimeRoot === "string" && runtimeRoot.length > 0) return runtimeRoot;
  return join(homedir(), ".llamactl", "data");
}

function kvRuntimeFor(resolved: ResolvedEnv): KvRuntime {
  const dataRoot = resolveKvDataRoot(resolved);
  const cached = kvRuntimeByDataRoot.get(dataRoot);
  if (cached) return cached;
  const storage = openKvStorage(dataRoot);
  const runtime: KvRuntime = {
    storage,
    registry: new KvRegistry(storage),
    allocators: new Map(),
    slotClients: new Map(),
  };
  kvRuntimeByDataRoot.set(dataRoot, runtime);
  return runtime;
}

function responseCacheRuntimeFor(resolved: ResolvedEnv): ResponseCacheRuntime {
  const dataRoot = resolveKvDataRoot(resolved);
  const cached = responseCacheRuntimeByDataRoot.get(dataRoot);
  if (cached) return cached;
  const storage = openResponseCacheStorage(dataRoot);
  const runtime: ResponseCacheRuntime = {
    storage,
    registry: new ResponseCacheRegistry(storage),
  };
  responseCacheRuntimeByDataRoot.set(dataRoot, runtime);
  return runtime;
}

function slotAllocatorFor(runtime: KvRuntime, workload: string): SlotAllocator {
  let allocator = runtime.allocators.get(workload);
  if (!allocator) {
    allocator = new SlotAllocator(1);
    runtime.allocators.set(workload, allocator);
  }
  return allocator;
}

function slotClientFor(
  runtime: KvRuntime,
  workload: string,
  host: string,
  port: number,
  engine?: string,
): UpstreamSlotClient {
  const endpoint = `http://${host}:${String(port)}`;
  const cached = runtime.slotClients.get(workload);
  if (cached?.endpoint === endpoint) return cached.client;
  const client = new UpstreamSlotClient(
    endpoint,
    engine === "omlx" ? { engine: "omlx" } : undefined,
  );
  runtime.slotClients.set(workload, { endpoint, client });
  return client;
}

/** Integer value from an inline `<flag>=<value>` token, if any flag matches. */
function inlineFlagInteger(token: string, flags: readonly string[]): number | null {
  for (const flag of flags) {
    if (!token.startsWith(`${flag}=`)) continue;
    const value = token.slice(flag.length + 1);
    if (Number.isInteger(Number.parseInt(value, 10))) return Number.parseInt(value, 10);
  }
  return null;
}

/** First integer following one of `flags` (separate or inline form). */
function readIntegerAfterFlag(
  extraArgs: readonly string[],
  flags: readonly string[],
): number | null {
  for (let i = 0; i < extraArgs.length; i += 1) {
    const token = extraArgs[i];
    if (token === undefined) continue;
    if (flags.includes(token)) {
      const value = extraArgs[i + 1];
      if (value && Number.isInteger(Number.parseInt(value, 10))) {
        return Number.parseInt(value, 10);
      }
      continue;
    }
    const inline = inlineFlagInteger(token, flags);
    if (inline !== null) return inline;
  }
  return null;
}

function parseContextWindow(extraArgs: readonly string[] | undefined, fallback: number): number {
  if (!extraArgs || extraArgs.length === 0) return fallback;
  return readIntegerAfterFlag(extraArgs, ["-c", "--ctx-size"]) ?? fallback;
}

function quantBitsFromModelId(model: string): number {
  if (/Q8_0\.gguf$/i.test(model) || /(?:^|[-_/])q8(?:$|[-_/])/i.test(model)) return 8;
  if (/Q6_[A-Z0-9_]+\.gguf$/i.test(model) || /(?:^|[-_/])q6(?:$|[-_/])/i.test(model)) return 6;
  if (/Q5_[A-Z0-9_]+\.gguf$/i.test(model) || /(?:^|[-_/])q5(?:$|[-_/])/i.test(model)) return 5;
  if (/Q4_[A-Z0-9_]+\.gguf$/i.test(model) || /(?:^|[-_/])q4(?:$|[-_/])/i.test(model)) return 4;
  if (/Q3_[A-Z0-9_]+\.gguf$/i.test(model) || /(?:^|[-_/])q3(?:$|[-_/])/i.test(model)) return 3;
  if (/Q2_[A-Z0-9_]+\.gguf$/i.test(model) || /(?:^|[-_/])q2(?:$|[-_/])/i.test(model)) return 2;
  return 0;
}

function resolveRouteKvMetadata(context: ProxyContext): {
  model: string;
  workload: string;
  host: string;
  port: number;
  quantBits: number;
  ctxSize: number;
  workloadEpoch: string;
  slotDir: string;
} | null {
  const route = context.route;
  if (!route) return null;
  if (route.isPeer === true) return null;
  if (!isRouteKvEligible(route)) return null;

  const key = { name: route.workload };
  const workloadEpoch = readWorkloadEpoch(key, context.resolved);
  if (!workloadEpoch) return null;

  const state = readServerState(key, context.resolved);
  const modelHostState =
    route.kind === "ModelHost" ? readModelHostState(key, context.resolved) : null;
  const rel = state?.rel ?? route.model;
  const defaultCtx = Number.parseInt(ctxForModel(rel, context.resolved), 10);
  const ctxSize = parseContextWindow(
    state?.extraArgs,
    Number.isFinite(defaultCtx) ? defaultCtx : 32768,
  );
  const slotDir =
    route.kind === "ModelRun"
      ? (state?.slotSavePath ?? parseAbsoluteSlotSavePath(state?.extraArgs ?? []))
      : (modelHostState?.slotSavePath ?? null);
  if (slotDir === null) return null;
  return {
    model: route.model,
    workload: route.workload,
    host: route.host,
    port: route.port,
    quantBits: quantBitsFromModelId(rel),
    ctxSize,
    workloadEpoch,
    slotDir,
  };
}

export function isRouteKvEligible(route: {
  kind: "ModelRun" | "ModelHost";
  engine: string;
}): boolean {
  // llama-server (ModelRun/llamacpp) always participates in the proxy slot cache.
  if (route.kind === "ModelRun" && route.engine === "llamacpp") return true;
  // oMLX ModelHosts always participate too, symmetric with llama.cpp. The proxy
  // injects x_omlx_save_handle on the chat so the server records the prompt
  // token-ids and can serialize the slot on the subsequent save (L4). Activation
  // is guarded at runtime by the supports_save_handle capability probe
  // (/v1/slots/capabilities), so a server that can't save-by-handle is a no-op.
  if (route.kind === "ModelHost" && route.engine === "omlx") return true;
  return false;
}

function kvBudgetBytes(): number {
  const raw = process.env["LLAMACTL_KV_WORKLOAD_BUDGET_MB"];
  if (!raw) return 8192 * 1024 * 1024;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 8192 * 1024 * 1024;
  return parsed * 1024 * 1024;
}

function shouldUseKvPath(context: ProxyContext): boolean {
  return (
    context.req.method === "POST" &&
    context.pathname === "/v1/chat/completions" &&
    typeof context.bodyText === "string"
  );
}

function shouldUseResponseCachePath(context: ProxyContext): boolean {
  return (
    context.req.method === "POST" &&
    context.pathname === "/v1/chat/completions" &&
    typeof context.bodyText === "string"
  );
}

function responseCacheProtocolVariant(context: ProxyContext): "openai" | "anthropic" {
  return context.isAnthropic ? "anthropic" : "openai";
}

function responseCacheBudgetBytes(): number {
  const raw = process.env["LLAMACTL_RESPONSE_CACHE_BUDGET_MB"];
  if (!raw) return 1024 * 1024 * 1024;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1024 * 1024 * 1024;
  return parsed * 1024 * 1024;
}

function responseCacheMaxEntryBytes(): number {
  const raw = process.env["LLAMACTL_RESPONSE_CACHE_MAX_ENTRY_MB"];
  if (!raw) return 8 * 1024 * 1024;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 8 * 1024 * 1024;
  return parsed * 1024 * 1024;
}

function responseCacheTtlMs(): number {
  const raw = process.env["LLAMACTL_RESPONSE_CACHE_TTL_HOURS"];
  if (!raw) return 24 * 60 * 60 * 1000;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 24 * 60 * 60 * 1000;
  return parsed * 60 * 60 * 1000;
}

function requestModel(parsedBody: unknown): string | null {
  if (!parsedBody || typeof parsedBody !== "object") return null;
  const maybeModel = (parsedBody as { model?: unknown }).model;
  return typeof maybeModel === "string" ? maybeModel : null;
}

function cacheHitResponse(entry: ResponseCacheEntry): Response {
  const headers = new Headers();
  headers.set("content-type", entry.contentType);
  if (entry.contentType.toLowerCase().startsWith("text/event-stream")) {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(new Uint8Array(entry.responseBody));
          controller.close();
        },
      }),
      {
        status: entry.statusCode,
        headers,
      },
    );
  }
  return new Response(new Uint8Array(entry.responseBody), {
    status: entry.statusCode,
    headers,
  });
}

/**
 * Workload epoch used in the response-cache key:
 *  - local workloads use their tracked epoch (changes on restart);
 *  - peer routes have no local epoch, so key on a synthetic epoch
 *    (peer node + model id + the peer's boot token `revision`). The revision
 *    is the peer server's /v1/models `created` (start time), carried in the
 *    peer snapshot; it changes when the peer restarts — including a model/quant
 *    swap under the same alias — so the cache invalidates automatically. When a
 *    peer doesn't advertise a revision (older node / engine without `created`),
 *    the epoch falls back to node+model (today's behaviour: stable, no
 *    restart-invalidation).
 */
function responseCacheEpochForRoute(route: RoutedEntry, resolved: ResolvedEnv): string | null {
  const isPeer = "isPeer" in route && route.isPeer;
  if (!isPeer) return readWorkloadEpoch({ name: route.workload }, resolved);
  const peerRevision = "revision" in route && route.revision ? `:${route.revision}` : "";
  return `peer:${route.targetNodeId ?? route.workload}:${route.model}${peerRevision}`;
}

// eslint-disable-next-line @typescript-eslint/require-await -- Pipeline stages share an async contract.
async function maybeResponseCacheLookup(context: ProxyContext): Promise<ProxyContext> {
  if (!shouldUseResponseCachePath(context)) return context;
  // Response-cache metadata is resolved independently of the KV *slot* path
  // (resolveRouteKvMetadata, local-only) so this can also cover cross-node peer
  // routes. The key needs a workload epoch for invalidation — see
  // responseCacheEpochForRoute.
  const route = context.route;
  if (!route || !isRouteKvEligible(route)) return context;
  const workloadEpoch = responseCacheEpochForRoute(route, context.resolved);
  if (!workloadEpoch) return context;
  let bodyText = context.bodyText;
  if (bodyText === undefined) return context;
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(bodyText);
  } catch {
    return context;
  }
  if (!isDeterministic(parsedBody)) return context;
  const model = requestModel(parsedBody);
  if (!model) return context;
  // oMLX save-handle always forces stream:false upstream; normalize before
  // computing the cache key so stream:true and stream:false callers share an entry.
  if (
    route.kind === "ModelHost" &&
    route.engine === "omlx" &&
    isRecord(parsedBody) &&
    parsedBody["stream"] !== false
  ) {
    parsedBody["stream"] = false;
    bodyText = JSON.stringify(parsedBody);
    context.bodyText = bodyText;
    context.init = { ...context.init, body: bodyText };
  }
  const runtime = responseCacheRuntimeFor(context.resolved);
  const sha = canonicalRequestSha(bodyText);
  const protocolVariant = responseCacheProtocolVariant(context);
  const requestBodyBytes = Buffer.byteLength(bodyText, "utf8");
  context.responseCache = {
    runtime,
    sha,
    model,
    workload: route.workload,
    workloadEpoch,
    protocolVariant,
    deterministic: true,
    requestBodyBytes,
  };
  const lookup = {
    sha,
    model,
    workload: route.workload,
    workloadEpoch,
    protocolVariant,
  } as const;
  const hit = runtime.registry.findBySha(lookup);
  if (!hit) {
    runtime.storage.response_cache_miss_total += 1;
    return context;
  }
  if (Date.now() - hit.createdAt > responseCacheTtlMs()) {
    runtime.storage.safeWrite(() => runtime.registry.tryDelete(lookup));
    runtime.storage.response_cache_miss_total += 1;
    return context;
  }
  runtime.storage.response_cache_hit_total += 1;
  runtime.storage.safeWrite(() => {
    runtime.registry.bumpHit(lookup, Date.now());
  });
  context.responseCacheHit = cacheHitResponse(hit);
  return context;
}

function shouldEnforceFirstTokenEquivalence(bodyText: string): boolean {
  try {
    const parsed = JSON.parse(bodyText) as { temperature?: unknown; seed?: unknown };
    if (typeof parsed.seed === "number" && Number.isFinite(parsed.seed)) return true;
    if (
      typeof parsed.temperature === "number" &&
      Number.isFinite(parsed.temperature) &&
      parsed.temperature > 0
    ) {
      // First-token checks are unstable under sampled decoding without a fixed seed.
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

const FIRST_RESPONSE_TOKEN_FINGERPRINT_CHARS = 20;

function normalizeFirstResponseToken(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, FIRST_RESPONSE_TOKEN_FINGERPRINT_CHARS);
}

function firstTokenFromContentPart(part: unknown): string | null {
  if (typeof part === "string") return normalizeFirstResponseToken(part);
  if (!part || typeof part !== "object") return null;
  const partText = (part as { text?: unknown }).text;
  if (typeof partText !== "string") return null;
  return normalizeFirstResponseToken(partText);
}

function firstTokenTextFromContent(content: unknown): string | null {
  if (typeof content === "string") return normalizeFirstResponseToken(content);
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    const token = firstTokenFromContentPart(part);
    if (token) return token;
  }
  return null;
}

function extractFirstResponseTokenFromJson(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const firstChoice: unknown = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") return null;
  const message = (firstChoice as { message?: unknown }).message;
  if (message && typeof message === "object") {
    const content = (message as { content?: unknown }).content;
    const fromMessage = firstTokenTextFromContent(content);
    if (fromMessage) return fromMessage;
  }
  const delta = (firstChoice as { delta?: unknown }).delta;
  if (delta && typeof delta === "object") {
    const content = (delta as { content?: unknown }).content;
    return firstTokenTextFromContent(content);
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function collectToolCallEntries(toolCalls: unknown[], out: Record<string, string>): void {
  for (const rawCall of toolCalls) {
    if (!isRecord(rawCall)) continue;
    if (rawCall["type"] !== "function" || typeof rawCall["id"] !== "string") continue;
    const fn = rawCall["function"];
    if (!isRecord(fn) || typeof fn["name"] !== "string" || typeof fn["arguments"] !== "string")
      continue;
    out[rawCall["id"]] = JSON.stringify({
      id: rawCall["id"],
      type: "function",
      function: {
        name: fn["name"],
        arguments: fn["arguments"],
      },
    });
  }
}

function extractToolMapFromJson(payload: unknown): Record<string, string> {
  if (!isRecord(payload)) return {};
  const choices = payload["choices"];
  if (!Array.isArray(choices)) return {};
  const out: Record<string, string> = {};
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const message = choice["message"];
    if (!isRecord(message)) continue;
    const toolCalls = message["tool_calls"];
    if (!Array.isArray(toolCalls)) continue;
    collectToolCallEntries(toolCalls, out);
  }
  return out;
}

function deriveSessionTitle(req: AnthropicMessagesRequest | undefined): string | undefined {
  if (!req) return undefined;
  const firstUser = req.messages.find((message) => message.role === "user");
  if (!firstUser) return undefined;
  if (typeof firstUser.content === "string") {
    const text = firstUser.content.trim();
    return text.length > 0 ? text.slice(0, 80) : undefined;
  }
  const text = firstUser.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  return text.length > 0 ? text.slice(0, 80) : undefined;
}

async function readFirstResponseToken(upstream: Response): Promise<string | null> {
  const contentType = upstream.headers.get("content-type");
  if (!contentType || !isJsonContentType(contentType)) return null;
  try {
    return extractFirstResponseTokenFromJson(await upstream.clone().json());
  } catch {
    return null;
  }
}

function basenameStripKvslot(path: string): string {
  const file = basename(path);
  return file.endsWith(".kvslot") ? file.slice(0, -".kvslot".length) : file;
}

function logSlotInjectionEvent(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- Structured debug event consumed by tests and local diagnostics.
  console.debug(JSON.stringify({ event, ...fields }));
}

function prefixForRestoreEpoch(restoreEpoch: string): string {
  return `${restoreEpoch.slice(0, 8)}...`;
}

/**
 * User requests must not be able to supply oMLX vendor fields directly.
 * The proxy is the only trusted writer for `x_omlx_request_handle` and
 * `x_omlx_restore_epoch`; stripping at ingress preserves response-cache
 * locality while preventing stale or mismatched restore metadata from
 * replaying across requests.
 */
function stripUserSuppliedOmlxVendorFields(
  body: Record<string, unknown>,
  model: string,
  workload: string,
): boolean {
  const hadRequestHandle = Object.prototype.hasOwnProperty.call(body, "x_omlx_request_handle");
  const hadRestoreEpoch = Object.prototype.hasOwnProperty.call(body, "x_omlx_restore_epoch");
  const hadSaveHandle = Object.prototype.hasOwnProperty.call(body, "x_omlx_save_handle");
  if (!hadRequestHandle && !hadRestoreEpoch && !hadSaveHandle) return false;
  delete body["x_omlx_request_handle"];
  delete body["x_omlx_restore_epoch"];
  delete body["x_omlx_save_handle"];
  logSlotInjectionEvent("slot_injection_user_supplied_stripped", {
    model,
    workload,
    had_handle: hadRequestHandle,
    had_epoch: hadRestoreEpoch,
    had_save_handle: hadSaveHandle,
  });
  return true;
}

function injectVendorFields(
  body: Record<string, unknown>,
  fields: { x_omlx_request_handle: string; x_omlx_restore_epoch: string },
): boolean {
  const hadRequestHandle = Object.prototype.hasOwnProperty.call(body, "x_omlx_request_handle");
  const hadRestoreEpoch = Object.prototype.hasOwnProperty.call(body, "x_omlx_restore_epoch");
  body["x_omlx_request_handle"] = fields.x_omlx_request_handle;
  body["x_omlx_restore_epoch"] = fields.x_omlx_restore_epoch;
  return hadRequestHandle || hadRestoreEpoch;
}

async function maybeInjectOmlxRestoreBind(
  context: ProxyContext,
  slotClient: UpstreamSlotClient,
  workload: string,
  model: string,
  hitSha: string,
  upstreamSlotFile: string,
  restoreEpoch: string | null,
): Promise<void> {
  if (restoreEpoch === null || context.bodyText === undefined) {
    logSlotInjectionEvent("slot_injection_skipped", {
      workload,
      model,
      reason: "no_restore_epoch",
    });
    return;
  }
  const handleSupported = await slotClient.supportsRequestHandle();
  if (!handleSupported) {
    logSlotInjectionEvent("slot_injection_skipped", {
      workload,
      model,
      reason: "capability_missing",
    });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(context.bodyText);
  } catch {
    return;
  }
  if (!isRecord(parsed)) return;
  const userValue = parsed["x_omlx_request_handle"];
  const overwritten = injectVendorFields(parsed, {
    x_omlx_request_handle: basenameStripKvslot(upstreamSlotFile),
    x_omlx_restore_epoch: restoreEpoch,
  });
  if (overwritten) {
    logSlotInjectionEvent("slot_injection_overwrote_user_field", {
      workload,
      model,
      had_user_value: userValue !== undefined,
      user_value_len: typeof userValue === "string" ? userValue.length : 0,
      proxy_value_prefix: prefixForRestoreEpoch(restoreEpoch),
    });
  }
  const injectedBody = JSON.stringify(parsed);
  context.bodyText = injectedBody;
  context.init = {
    ...context.init,
    body: injectedBody,
  };
  logSlotInjectionEvent("slot_injection_applied", {
    workload,
    model,
    request_handle: basenameStripKvslot(upstreamSlotFile),
    restore_epoch_prefix: prefixForRestoreEpoch(restoreEpoch),
  });
}

/**
 * Inject the save-intent handle on a save-eligible oMLX chat (L4). The handle is
 * this request's sha, which becomes the slot filename on save (`<sha>.kvslot` ->
 * server request_handle=sha), so the server records the prompt token-ids under it
 * and can serialize the slot when the proxy later calls save. Forces non-stream
 * (streaming never records). Gated on the upstream advertising supports_save_handle.
 */
async function maybeInjectOmlxSaveHandle(
  context: ProxyContext,
  slotClient: UpstreamSlotClient,
  workload: string,
  model: string,
  sha: string,
): Promise<void> {
  if (context.bodyText === undefined) return;
  if (!(await slotClient.supportsSaveHandle())) {
    logSlotInjectionEvent("save_handle_skipped", { workload, model, reason: "capability_missing" });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(context.bodyText);
  } catch {
    return;
  }
  if (!isRecord(parsed)) return;
  // Capture original stream intent BEFORE we overwrite it. The response
  // path uses this to synthesize SSE when the client asked for it.
  context.clientRequestedStream = parsed["stream"] === true;
  parsed["x_omlx_save_handle"] = sha;
  parsed["stream"] = false;
  const injectedBody = JSON.stringify(parsed);
  context.bodyText = injectedBody;
  context.init = { ...context.init, body: injectedBody };
  logSlotInjectionEvent("save_handle_injected", { workload, model, request_handle: sha });
}

interface OpenAiChatChunkChoice {
  index: number;
  delta: Record<string, unknown>;
  finish_reason: string | null;
}

interface OpenAiChatChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAiChatChunkChoice[];
  usage?: unknown;
}

/**
 * Convert a non-streamed OpenAI chat-completion JSON body into a valid
 * text/event-stream body. Used on the oMLX save-handle path: the proxy
 * forced the upstream to stream:false so it could persist the slot, but
 * the client originally asked for SSE. The output emits one or more
 * `data: {chat.completion.chunk ...}` events carrying role + content (and
 * a final chunk with finish_reason), then `data: [DONE]\n\n`. Preserves
 * id, model, and usage where present. Scoped to the OpenAI completion
 * format (not Anthropic).
 */
interface SseHeader {
  id: string;
  created: number;
  model: string;
}

function sseHeaderFromCompletion(completion: Record<string, unknown>): SseHeader {
  const id = typeof completion["id"] === "string" ? completion["id"] : "chatcmpl-stream";
  const created =
    typeof completion["created"] === "number"
      ? completion["created"]
      : Math.floor(Date.now() / 1000);
  const model = typeof completion["model"] === "string" ? completion["model"] : "unknown";
  return { id, created, model };
}

function buildChoiceDelta(
  message: Record<string, unknown>,
  content: string,
): Record<string, unknown> {
  const role = typeof message["role"] === "string" ? message["role"] : "assistant";
  const delta: Record<string, unknown> = { role };
  if (content.length > 0) delta["content"] = content;
  if (Array.isArray(message["tool_calls"])) delta["tool_calls"] = message["tool_calls"];
  return delta;
}

function chunksForChoice(header: SseHeader, choice: unknown, fallbackIndex: number): string[] {
  if (!isRecord(choice)) return [];
  const idx = typeof choice["index"] === "number" ? choice["index"] : fallbackIndex;
  const message = isRecord(choice["message"]) ? choice["message"] : {};
  const content = typeof message["content"] === "string" ? message["content"] : "";
  const finishReason =
    typeof choice["finish_reason"] === "string" ? choice["finish_reason"] : "stop";
  const roleChunk: OpenAiChatChunk = {
    id: header.id,
    object: "chat.completion.chunk",
    created: header.created,
    model: header.model,
    choices: [{ index: idx, delta: buildChoiceDelta(message, content), finish_reason: null }],
  };
  const stopChunk: OpenAiChatChunk = {
    id: header.id,
    object: "chat.completion.chunk",
    created: header.created,
    model: header.model,
    choices: [{ index: idx, delta: {}, finish_reason: finishReason }],
  };
  return [`data: ${JSON.stringify(roleChunk)}\n\n`, `data: ${JSON.stringify(stopChunk)}\n\n`];
}

function jsonCompletionToSse(json: unknown): string {
  const completion = isRecord(json) ? json : {};
  const header = sseHeaderFromCompletion(completion);
  const rawChoices: unknown[] = Array.isArray(completion["choices"])
    ? (completion["choices"] as unknown[])
    : [];

  const lines: string[] = [];

  if (rawChoices.length === 0) {
    const empty: OpenAiChatChunk = {
      id: header.id,
      object: "chat.completion.chunk",
      created: header.created,
      model: header.model,
      choices: [],
    };
    lines.push(`data: ${JSON.stringify(empty)}\n\n`);
  }

  for (const [i, choice] of rawChoices.entries()) {
    lines.push(...chunksForChoice(header, choice, i));
  }

  const usage = completion["usage"];
  if (usage !== undefined && usage !== null) {
    const usageChunk: OpenAiChatChunk = {
      id: header.id,
      object: "chat.completion.chunk",
      created: header.created,
      model: header.model,
      choices: [],
      usage,
    };
    lines.push(`data: ${JSON.stringify(usageChunk)}\n\n`);
  }

  lines.push("data: [DONE]\n\n");
  return lines.join("");
}

/**
 * If the client originally requested SSE (oMLX save-handle path forced the
 * upstream to non-stream so the KV save could persist) and the upstream
 * returned a 200 application/json chat completion that is not an error
 * envelope, convert it to a text/event-stream response so the client's
 * OpenAI SDK sees the event shape it asked for. Returns null when no
 * synthesis should happen and the caller should pass through normally.
 */
async function maybeSynthesizeOmlxSseResponse(
  context: Pick<ProxyContext, "clientRequestedStream" | "isAnthropic">,
  upstream: Response,
): Promise<Response | null> {
  if (context.clientRequestedStream !== true) return null;
  if (context.isAnthropic === true) return null;
  if (upstream.status !== 200) return null;
  const contentType = upstream.headers.get("content-type");
  if (!isJsonContentType(contentType)) return null;
  let json: unknown;
  try {
    json = await upstream.clone().json();
  } catch {
    return null;
  }
  if (isRecord(json) && json["error"] !== undefined && json["error"] !== null) return null;
  const sseBody = jsonCompletionToSse(json);
  const respHeaders = sanitizedResponseHeaders(upstream);
  respHeaders.set("content-type", "text/event-stream");
  respHeaders.delete("content-length");
  return new Response(sseBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

export function __jsonCompletionToSseForTests(json: unknown): string {
  return jsonCompletionToSse(json);
}

export async function __maybeSynthesizeOmlxSseResponseForTests(
  context: { clientRequestedStream?: boolean; isAnthropic?: boolean },
  upstream: Response,
): Promise<Response | null> {
  return await maybeSynthesizeOmlxSseResponse(context, upstream);
}

function buildKvRequestState(
  metadata: ReturnType<typeof resolveRouteKvMetadata> & object,
  runtime: KvRuntime,
  sha: string,
  prefixMetric: number,
  enforceFirstTokenEquivalence: boolean,
  overrides?: Partial<KvRequestState>,
): KvRequestState {
  return {
    runtime,
    workload: metadata.workload,
    slotDir: metadata.slotDir,
    host: metadata.host,
    port: metadata.port,
    quantBits: metadata.quantBits,
    ctxSize: metadata.ctxSize,
    workloadEpoch: metadata.workloadEpoch,
    sha,
    prefixMetric,
    shouldPersist: false,
    warmHitSha: null,
    warmHitLease: null,
    warmHitExpectedFirstResponseToken: null,
    enforceFirstTokenEquivalence,
    ...overrides,
  };
}

type WarmHitReplay =
  | { kind: "none" }
  | { kind: "mismatch" }
  | { kind: "replayed"; sha: string; prefixMetric: number };

/**
 * For Anthropic requests whose warm hit recorded a tool map, re-translate
 * the request with the exact recorded tool-call bytes and swap the proxy
 * body to the replay text. `mismatch` means the replayed bytes no longer
 * hash to the hit's sha — the caller must abandon (and drop) the hit.
 */
function applyAnthropicToolMapReplay(
  context: ProxyContext,
  runtime: KvRuntime,
  hit: NonNullable<ReturnType<typeof longestPrefixLookup>>,
  workload: string,
): WarmHitReplay {
  if (
    !context.isAnthropic ||
    !context.anthropicRequest ||
    (hit.extFlags & EXT_FLAG_TOOL_MAP) === 0
  ) {
    return { kind: "none" };
  }
  const trailer = readTrailer(hit.upstreamSlotFile);
  const toolMap = trailer?.toolMap;
  if (!toolMap || Object.keys(toolMap).length === 0) return { kind: "none" };

  const replayBodyText = JSON.stringify(
    translateAnthropicRequest(context.anthropicRequest, { toolMap }),
  );
  const replaySha = boundaryNaiveBytePrefixSha(replayBodyText);
  if (replaySha !== hit.sha) {
    runtime.storage.kv_replay_mismatch_total += 1;
    console.warn(
      JSON.stringify({
        event: "kv_replay_mismatch",
        workload,
        expected: hit.sha,
        got: replaySha,
      }),
    );
    return { kind: "mismatch" };
  }
  context.bodyText = replayBodyText;
  context.init = {
    ...context.init,
    body: replayBodyText,
  };
  return {
    kind: "replayed",
    sha: replaySha,
    prefixMetric: Buffer.byteLength(replayBodyText, "utf8"),
  };
}

async function applyWarmKvHit(
  context: ProxyContext,
  metadata: NonNullable<ReturnType<typeof resolveRouteKvMetadata>>,
  runtime: KvRuntime,
  hit: NonNullable<ReturnType<typeof longestPrefixLookup>>,
  sha: string,
  prefixMetric: number,
  enforceFirstTokenEquivalence: boolean,
): Promise<ProxyContext | null> {
  const reserveState = { reserved: false };
  const reserveWrite = runtime.storage.safeWrite(() => {
    reserveState.reserved = runtime.registry.reserve(hit.sha);
  });
  if (!reserveWrite.ok || !reserveState.reserved) return null;
  const lease = slotAllocatorFor(runtime, metadata.workload).acquire();
  if (!lease) {
    runtime.storage.safeWrite(() => runtime.registry.release(hit.sha));
    return null;
  }
  const slotClient = slotClientFor(
    runtime,
    metadata.workload,
    metadata.host,
    metadata.port,
    context.route?.engine,
  );
  const restore = await slotClient.restore(
    lease.slotId,
    basename(hit.upstreamSlotFile),
    context.route?.engine === "omlx" ? { model: metadata.model } : undefined,
  );
  const activateState = { activated: false };
  const activateWrite = runtime.storage.safeWrite(() => {
    activateState.activated = runtime.registry.activate(hit.sha);
  });
  if (!(activateWrite.ok && restore.ok && activateState.activated)) {
    runtime.storage.safeWrite(() => runtime.registry.release(hit.sha));
    lease.release();
    if (!restore.ok) runtime.storage.safeWrite(() => runtime.registry.delete(hit.sha));
    return null;
  }
  const replay = applyAnthropicToolMapReplay(context, runtime, hit, metadata.workload);
  if (replay.kind === "mismatch") {
    runtime.storage.safeWrite(() => runtime.registry.release(hit.sha));
    lease.release();
    runtime.storage.safeWrite(() => runtime.registry.tryDelete(hit.sha));
    return null;
  }
  const effectiveSha = replay.kind === "replayed" ? replay.sha : sha;
  const effectivePrefixMetric = replay.kind === "replayed" ? replay.prefixMetric : prefixMetric;
  await maybeInjectOmlxRestoreBind(
    context,
    slotClient,
    metadata.workload,
    metadata.model,
    hit.sha,
    hit.upstreamSlotFile,
    restore.restore_epoch,
  );
  // Best-effort recency/analytics bump — must never throw past this point, or
  // the lease acquired above would be skipped from context.kv (below) and
  // orphaned (releaseWarmHitLease short-circuits on `!kv`), permanently
  // disabling the single-slot allocator. Mirror the response-cache sibling.
  runtime.storage.safeWrite(() => {
    runtime.registry.bumpHit(hit.sha, Date.now());
  });
  context.kv = buildKvRequestState(
    metadata,
    runtime,
    effectiveSha,
    effectivePrefixMetric,
    enforceFirstTokenEquivalence,
    {
      warmHitSha: hit.sha,
      warmHitLease: lease,
      warmHitExpectedFirstResponseToken: hit.firstResponseToken,
    },
  );
  return context;
}

async function maybeKvLookup(context: ProxyContext): Promise<ProxyContext> {
  if (!shouldUseKvPath(context)) return context;
  const metadata = resolveRouteKvMetadata(context);
  if (!metadata) return context;
  const runtime = kvRuntimeFor(context.resolved);
  const bodyText = context.bodyText;
  if (bodyText === undefined) return context;
  const enforceFirstTokenEquivalence = shouldEnforceFirstTokenEquivalence(bodyText);
  const prefixMetric = Buffer.byteLength(bodyText, "utf8");
  const sha = boundaryNaiveBytePrefixSha(bodyText);

  // Phase 6 is boundary-naive: use byte length as both byte prefix and token guard until token accounting lands.
  let hit = longestPrefixLookup(runtime.registry, {
    candidatePrefixes: [{ sha, prefixByteLength: prefixMetric, tokenCount: prefixMetric }],
    workload: metadata.workload,
    quantBits: metadata.quantBits,
    ctxSize: metadata.ctxSize,
    workloadEpoch: metadata.workloadEpoch,
  });

  if (hit && hit.model !== null && hit.model !== metadata.model) {
    runtime.storage.kv_model_mismatch_total += 1;
    console.warn(
      JSON.stringify({
        event: "kv_model_mismatch",
        workload: metadata.workload,
        sha: hit.sha,
        expected: hit.model,
        got: metadata.model,
      }),
    );
    hit = null;
  }

  if (hit) {
    const warmResult = await applyWarmKvHit(
      context,
      metadata,
      runtime,
      hit,
      sha,
      prefixMetric,
      enforceFirstTokenEquivalence,
    );
    if (warmResult) return warmResult;
  }

  // L4: cold-miss path for a save-eligible oMLX route — inject the save handle
  // (= this request's sha, which becomes the slot filename on save) so the server
  // records the prompt token-ids for the upcoming save. No-op for llama.cpp.
  if (context.route?.engine === "omlx") {
    const saveSlotClient = slotClientFor(
      runtime,
      metadata.workload,
      metadata.host,
      metadata.port,
      context.route.engine,
    );
    await maybeInjectOmlxSaveHandle(
      context,
      saveSlotClient,
      metadata.workload,
      metadata.model,
      sha,
    );
  }

  context.kv = {
    runtime,
    workload: metadata.workload,
    model: metadata.model,
    slotDir: metadata.slotDir,
    host: metadata.host,
    port: metadata.port,
    quantBits: metadata.quantBits,
    ctxSize: metadata.ctxSize,
    workloadEpoch: metadata.workloadEpoch,
    sha,
    prefixMetric,
    shouldPersist: true,
    warmHitSha: null,
    warmHitLease: null,
    warmHitExpectedFirstResponseToken: null,
    enforceFirstTokenEquivalence,
  };
  return context;
}

/** True when a 200 JSON body is actually an error envelope (never cached). */
function isErrorEnvelope(bodyBytes: Uint8Array, responseCache: ResponseCacheRequestState): boolean {
  try {
    const parsed = JSON.parse(Buffer.from(bodyBytes).toString("utf8")) as { error?: unknown };
    if (typeof parsed === "object" && parsed.error) {
      console.warn(
        JSON.stringify({
          event: "response_cache_skip_error_envelope",
          sha: responseCache.sha,
          model: responseCache.model,
        }),
      );
      return true;
    }
  } catch {
    // Invalid JSON responses are still replayed but not cached as JSON envelopes.
  }
  return false;
}

/** True when an SSE body carries a terminal marker (partial streams are never cached). */
function isCompleteSseBody(
  bodyBytes: Uint8Array,
  responseCache: ResponseCacheRequestState,
): boolean {
  const sseBody = Buffer.from(bodyBytes).toString("utf8");
  const hasOpenAiDone = sseBody.includes("data: [DONE]\n");
  const hasAnthropicDone = sseBody.includes("event: message_stop");
  if (!hasOpenAiDone && !hasAnthropicDone) {
    console.warn(
      JSON.stringify({
        event: "response_cache_skip_partial_sse",
        sha: responseCache.sha,
        model: responseCache.model,
      }),
    );
    return false;
  }
  return true;
}

async function maybePersistResponseCache(
  context: ProxyContext,
  upstream: Response,
): Promise<Response> {
  const responseCache = context.responseCache;
  if (!responseCache) return upstream;
  if (context.responseCacheHit) return upstream;

  const contentType = upstream.headers.get("content-type") ?? "";
  const isJson = isJsonContentType(contentType);
  const isSse = contentType.toLowerCase().startsWith("text/event-stream");
  const cacheableType = isJson || isSse;
  const bodyBytes = new Uint8Array(await upstream.arrayBuffer());
  const replay = new Response(bodyBytes, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
  if (upstream.status !== 200 || !responseCache.deterministic || !cacheableType) return replay;
  if (isJson && isErrorEnvelope(bodyBytes, responseCache)) return replay;
  if (isSse && !isCompleteSseBody(bodyBytes, responseCache)) return replay;

  const totalBytes = responseCache.requestBodyBytes + bodyBytes.byteLength;
  if (totalBytes > responseCacheMaxEntryBytes()) return replay;

  const now = Date.now();
  const wrote = responseCache.runtime.storage.safeWrite(() => {
    responseCache.runtime.registry.insert({
      sha: responseCache.sha,
      model: responseCache.model,
      workload: responseCache.workload,
      workloadEpoch: responseCache.workloadEpoch,
      protocolVariant: responseCache.protocolVariant,
      contentType: isSse ? "text/event-stream" : "application/json",
      statusCode: upstream.status,
      responseBody: bodyBytes,
      requestBodyBytes: responseCache.requestBodyBytes,
      responseBodyBytes: bodyBytes.byteLength,
      createdAt: now,
      lastUsed: now,
      hits: 0,
    });
  });
  if (!wrote.ok) return replay;

  try {
    const eviction = runResponseCacheEvictionIfOverBudget(
      responseCache.runtime.registry,
      responseCacheBudgetBytes(),
      now,
    );
    responseCache.runtime.storage.response_cache_evict_total += eviction.deleted.length;
  } catch (error) {
    // The body was already read and the replay built; an eviction-sweep DB
    // failure must not cost the served response. Degrade by skipping eviction.
    warnResponseCacheStageFailure("persist", error);
  }
  return replay;
}

function releaseWarmHitLease(context: ProxyContext): void {
  const kv = context.kv;
  if (!kv) return;
  const warmHitSha = kv.warmHitSha;
  const warmHitLease = kv.warmHitLease;
  kv.warmHitSha = null;
  kv.warmHitLease = null;
  if (warmHitSha) kv.runtime.storage.safeWrite(() => kv.runtime.registry.release(warmHitSha));
  warmHitLease?.release();
}

/**
 * Route a JSON request by its body `model` field. Reads (and size-caps)
 * the body when it hasn't been read yet; leaves the default target in
 * place when the model is absent or unrouted.
 */
async function resolveJsonBodyRoute(context: ProxyContext): Promise<ProxyContext | Response> {
  if (context.bodyText === undefined) {
    if (isOversizedJsonBody(context.req)) {
      return new Response("Payload Too Large", { status: 413 });
    }
    const bodyText = await context.req.text();
    if (bodyText.length > MAX_JSON_BODY_BYTES) {
      return new Response("Payload Too Large", { status: 413 });
    }
    context = {
      ...context,
      bodyText,
      init: {
        ...context.init,
        body: bodyText,
      },
    };
  }
  const bodyText = context.bodyText;
  const model = bodyText ? requestedModelFromBody(bodyText) : undefined;
  if (model) {
    const routedTarget = routedEndpointForModel(
      model,
      context.pathname,
      context.search,
      context.resolved,
    );
    if (routedTarget) {
      context.target = routedTarget.target;
      context.route = routedTarget;
    }
  }
  return context;
}

async function resolveRoute(context: ProxyContext): Promise<ProxyContext | Response> {
  const { req } = context;
  if (req.method === "GET" || req.method === "HEAD") return context;

  const contentType = req.headers.get("content-type");
  if (isJsonContentType(contentType)) {
    return await resolveJsonBodyRoute(context);
  }

  context.init = {
    ...context.init,
    body: req.body,
  };
  (context.init as unknown as { duplex: string }).duplex = "half";
  return context;
}

function requestBodyContainsOmlxRequestHandle(bodyText: string | undefined): boolean {
  if (!bodyText) return false;
  try {
    const parsed = JSON.parse(bodyText) as { x_omlx_request_handle?: unknown };
    return Object.prototype.hasOwnProperty.call(parsed, "x_omlx_request_handle");
  } catch {
    return false;
  }
}

async function forward(context: ProxyContext): Promise<Response> {
  if (context.route?.isPeer && requestBodyContainsOmlxRequestHandle(context.bodyText)) {
    return Response.json({ error: "cross-node slot ops not supported" }, { status: 400 });
  }

  const init: RequestInit & { headers: Headers; tls?: { ca: string } } = {
    ...context.init,
    headers: new Headers(context.init.headers ?? {}),
  };
  if (context.route?.isPeer && context.route.token) {
    init.headers.set("authorization", `Bearer ${context.route.token}`);
  }
  const peerTls = peerTlsForRoute(context.route);
  if (peerTls) (init as RequestInit & { tls?: { ca: string } }).tls = peerTls;

  let upstream: Response;
  try {
    upstream = await fetch(context.target, init);
  } catch (err) {
    return Response.json(
      {
        error: {
          message: `upstream llama-server unreachable: ${(err as Error).message}`,
          type: "llamactl_upstream_error",
        },
      },
      { status: 502 },
    );
  }
  if (context.route?.isPeer && upstream.status === 502) {
    invalidateRouteCacheEntry(context.route.model);
  }
  return upstream;
}

function checkFalseHit(kv: KvRequestState, firstResponseToken: string | null): boolean {
  if (
    !kv.warmHitSha ||
    !kv.enforceFirstTokenEquivalence ||
    kv.warmHitExpectedFirstResponseToken === null ||
    firstResponseToken === null ||
    kv.warmHitExpectedFirstResponseToken === firstResponseToken
  ) {
    return false;
  }
  kv.runtime.storage.kv_false_hit_total += 1;
  console.warn(
    JSON.stringify({
      event: "kv_false_hit",
      workload: kv.workload,
      sha: kv.warmHitSha,
      expected: kv.warmHitExpectedFirstResponseToken,
      got: firstResponseToken,
    }),
  );
  const staleSha = kv.warmHitSha;
  kv.runtime.storage.safeWrite(() => {
    kv.runtime.registry.release(staleSha);
    kv.runtime.registry.tryDelete(staleSha);
  });
  kv.warmHitLease?.release();
  kv.warmHitSha = null;
  kv.warmHitLease = null;
  return true;
}

/**
 * Write the slot trailer + registry row for a freshly saved slot.
 * Returns the insert timestamp, or null when the registry write
 * failed (callers skip eviction/sweep in that case).
 */
function commitSlotToRegistry(
  context: ProxyContext,
  kv: KvRequestState,
  slotFile: string,
  firstResponseToken: string | null,
  upstreamJson: unknown,
): { now: number } | null {
  const now = Date.now();
  const trailer: KvTrailer = { extFlags: 0 };
  let extFlags = 0;
  const toolMap = extractToolMapFromJson(upstreamJson);
  if (Object.keys(toolMap).length > 0) {
    extFlags |= EXT_FLAG_TOOL_MAP;
    trailer.toolMap = toolMap;
  }
  const sessionTitle = deriveSessionTitle(context.anthropicRequest);
  if (sessionTitle) {
    extFlags |= EXT_FLAG_SESSION_TITLE;
    trailer.sessionTitle = sessionTitle;
  }
  if (extFlags !== 0) {
    trailer.extFlags = extFlags;
    const wroteTrailer = writeTrailer(slotFile, trailer, kv.runtime.storage);
    if (!wroteTrailer.ok) {
      extFlags = 0;
      console.warn(
        `[kvstore] trailer save skipped for workload='${kv.workload}' sha='${kv.sha}': ${wroteTrailer.reason}`,
      );
    }
  }
  const wrote = kv.runtime.storage.safeWrite(() => {
    kv.runtime.registry.insert({
      sha: kv.sha,
      workload: kv.workload,
      model: kv.model ?? null,
      upstreamSlotFile: slotFile,
      quantBits: kv.quantBits,
      tokens: kv.prefixMetric,
      ctxSize: kv.ctxSize,
      hits: 0,
      createdAt: now,
      lastUsed: now,
      payloadBytes: ((): number => {
        try {
          return statSync(slotFile).size;
        } catch {
          return kv.prefixMetric;
        }
      })(),
      textBytes: kv.prefixMetric,
      reason: "cold",
      prefixByteLength: kv.prefixMetric,
      workloadEpoch: kv.workloadEpoch,
      quarantined: 0,
      state: "idle",
      firstResponseToken,
      extFlags,
    });
  });
  if (!wrote.ok) return null;
  return { now };
}

/**
 * Serialize the upstream KV slot to disk for the given lease slot.
 * Returns the absolute slot file path, or null when the upstream
 * save was skipped or failed.
 */
async function saveSlotUpstream(
  context: ProxyContext,
  kv: KvRequestState,
  slotId: number,
): Promise<string | null> {
  const slotDir = kv.slotDir;
  mkdirSync(slotDir, { recursive: true });
  const slotBasename = `${kv.sha}.kvslot`;
  const slotFile = join(slotDir, slotBasename);
  const slotClient = slotClientFor(
    kv.runtime,
    kv.workload,
    kv.host,
    kv.port,
    context.route?.engine,
  );
  // llama-server's slot API only accepts a bare filename (relative to its
  // --slot-save-path). We store the absolute path in the registry for
  // orphan sweep + integrity scan, but pass basename to the upstream call.
  // oMLX additionally requires `model` in the payload (HTTP 400 otherwise).
  const saved = await slotClient.save(
    slotId,
    slotBasename,
    context.route?.engine === "omlx" ? { model: context.route.model } : undefined,
  );
  if (!saved.ok) {
    console.warn(
      `[kvstore] slot save skipped for workload='${kv.workload}' sha='${kv.sha}': ${saved.reason}`,
    );
    return null;
  }
  return slotFile;
}

async function parseUpstreamJsonBody(upstream: Response, shouldParse: boolean): Promise<unknown> {
  if (!shouldParse) return null;
  try {
    return await upstream.clone().json();
  } catch {
    return null;
  }
}

/**
 * oMLX save requires the save-by-handle path; if this server can't do it,
 * skip before acquiring a lease (avoids the slot_serialize_failed noise that
 * 4e101c7 removed, and a leaked lease). Gate the probe to the omlx engine.
 */
async function saveHandleSupportedForRoute(
  context: ProxyContext,
  kv: KvRequestState,
): Promise<boolean> {
  if (context.route?.engine !== "omlx") return true;
  const saveProbeClient = slotClientFor(
    kv.runtime,
    kv.workload,
    kv.host,
    kv.port,
    context.route.engine,
  );
  return await saveProbeClient.supportsSaveHandle();
}

function purgeStaleEpochEntries(kv: KvRequestState): void {
  try {
    kv.runtime.registry.deleteEpochStale(kv.workload, kv.workloadEpoch);
  } catch (error) {
    console.warn(
      `[kvstore] stale epoch purge failed for workload='${kv.workload}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function sweepOrphanSlots(kv: KvRequestState, now: number): void {
  try {
    sweepOrphanSlotFiles({
      slotDir: kv.slotDir,
      registry: kv.runtime.registry,
      ttlMs: 24 * 60 * 60 * 1000,
      now,
    });
  } catch (error) {
    console.warn(
      `[kvstore] orphan sweep failed for workload='${kv.workload}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Save the slot upstream, commit it to the registry, then run eviction + maintenance. */
async function persistSlotAndMaintain(
  context: ProxyContext,
  kv: KvRequestState,
  slotId: number,
  firstResponseToken: string | null,
  upstreamJson: unknown,
): Promise<void> {
  const slotFile = await saveSlotUpstream(context, kv, slotId);
  if (slotFile === null) return;
  const committed = commitSlotToRegistry(context, kv, slotFile, firstResponseToken, upstreamJson);
  if (committed === null) return;
  const { now } = committed;

  const eviction = runEvictionIfOverBudget(kv.runtime.registry, kv.workload, kvBudgetBytes(), now);
  for (const blockedSha of eviction.blockedActive) {
    logSlotInjectionEvent("slot_eviction_blocked_active_request", {
      workload: kv.workload,
      sha: blockedSha,
    });
  }
  purgeStaleEpochEntries(kv);
  sweepOrphanSlots(kv, now);
}

async function maybePersistKv(context: ProxyContext, upstream: Response): Promise<void> {
  const kv = context.kv;
  if (!kv) return;
  const contentType = upstream.headers.get("content-type");
  const shouldParseJson = upstream.status === 200 && isJsonContentType(contentType);
  const upstreamJson: unknown = await parseUpstreamJsonBody(upstream, shouldParseJson);
  const firstResponseToken = upstreamJson
    ? extractFirstResponseTokenFromJson(upstreamJson)
    : await readFirstResponseToken(upstream);
  try {
    checkFalseHit(kv, firstResponseToken);

    if (!kv.shouldPersist) return;
    // Deferred (phase9): defer KV save for streams until exact replay boundaries are captured.
    if (contentType?.toLowerCase().startsWith("text/event-stream")) return;
    if (upstream.status !== 200 || !isJsonContentType(contentType) || upstreamJson === null) return;
    if (!(await saveHandleSupportedForRoute(context, kv))) return;

    const allocator = slotAllocatorFor(kv.runtime, kv.workload);
    const lease = allocator.acquire();
    if (!lease) return;
    try {
      await persistSlotAndMaintain(context, kv, lease.slotId, firstResponseToken, upstreamJson);
    } finally {
      lease.release();
    }
  } finally {
    releaseWarmHitLease(context);
  }
}

/** Copy upstream headers, dropping the hop-by-hop ones the proxy must not forward. */
function sanitizedResponseHeaders(upstream: Response): Headers {
  const respHeaders = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    const lower = key.toLowerCase();
    if (lower === "transfer-encoding" || lower === "connection") continue;
    respHeaders.set(key, value);
  }
  return respHeaders;
}

function translateAnthropicSseResponse(context: ProxyContext, upstream: Response): Response {
  if (!upstream.body) return upstream;
  const respHeaders = sanitizedResponseHeaders(upstream);
  respHeaders.set("content-type", "text/event-stream");
  return new Response(
    translateOpenAIStreamToAnthropic(upstream.body, {
      model: context.anthropicModel ?? "claude-compatible",
    }),
    {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    },
  );
}

async function translateAnthropicJsonResponse(upstream: Response): Promise<Response> {
  try {
    const translated = translateOpenAIResponse((await upstream.clone().json()) as never);
    const respHeaders = sanitizedResponseHeaders(upstream);
    return Response.json(translated, { status: upstream.status, headers: respHeaders });
  } catch (error) {
    return Response.json(
      {
        error: {
          message: error instanceof Error ? error.message : "anthropic response translation failed",
          type: "anthropic_response_translation_error",
        },
      },
      { status: 502 },
    );
  }
}

async function maybeTranslateResponse(
  context: ProxyContext,
  upstream: Response,
): Promise<Response> {
  const contentType = upstream.headers.get("content-type");
  if (context.isAnthropic && contentType?.toLowerCase().startsWith("text/event-stream")) {
    return translateAnthropicSseResponse(context, upstream);
  }
  if (context.isAnthropic && upstream.ok && contentType && isJsonContentType(contentType)) {
    return await translateAnthropicJsonResponse(upstream);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: sanitizedResponseHeaders(upstream),
  });
}

/**
 * Resolve the model string for vendor-field stripping from the ALREADY-parsed
 * body, avoiding a second JSON.parse of the same text. Mirrors the prior chain
 * `requestedModelFromBody(bodyText) ?? route?.model ?? "unknown"` exactly:
 * requestedModelFromBody returned `parsed.model` only when it was a string, so
 * a non-string `model` falls through to the route model and then "unknown".
 */
function resolveStripVendorModel(
  parsedBody: Record<string, unknown>,
  routeModel: string | undefined,
): string {
  const bodyModel = parsedBody["model"];
  return (typeof bodyModel === "string" ? bodyModel : undefined) ?? routeModel ?? "unknown";
}

export function __resolveStripVendorModelForTests(
  parsedBody: Record<string, unknown>,
  routeModel: string | undefined,
): string {
  return resolveStripVendorModel(parsedBody, routeModel);
}

/** Strip user-supplied oMLX vendor fields from a JSON body in place on the context. */
function stripVendorFieldsFromBody(routed: ProxyContext): void {
  if (!routed.bodyText) return;
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(routed.bodyText);
  } catch {
    parsedBody = null;
  }
  if (!isRecord(parsedBody)) return;
  stripUserSuppliedOmlxVendorFields(
    parsedBody,
    resolveStripVendorModel(parsedBody, routed.route?.model),
    routed.route?.workload ?? "unknown",
  );
  const strippedBodyText = JSON.stringify(parsedBody);
  if (strippedBodyText !== routed.bodyText) {
    routed.bodyText = strippedBodyText;
    routed.init = {
      ...routed.init,
      body: strippedBodyText,
    };
  }
}

function warnKvStageFailure(stage: "lookup" | "persist", error: unknown): void {
  console.warn(
    `[openaiProxy] kv ${stage} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function warnResponseCacheStageFailure(stage: "lookup" | "persist", error: unknown): void {
  console.warn(
    `[openaiProxy] response-cache ${stage} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * Proxy an OpenAI-style request (chat/completions, completions,
 * embeddings, etc.) to the local llama-server. JSON bodies can route
 * by `model` across live workloads, and Bun/Node fetch responses are
 * returned as a fresh ReadableStream so SSE streams work out of the box.
 */
export async function proxyOpenAI(
  req: Request,
  resolved: ResolvedEnv = resolveEnv(),
): Promise<Response> {
  const parsed = await parseIncoming(req, resolved);
  if (parsed instanceof Response) return parsed;
  const routed = await resolveRoute(parsed);
  if (routed instanceof Response) return routed;
  if (routed.route?.isPeer && requestBodyContainsOmlxRequestHandle(routed.bodyText)) {
    return Response.json({ error: "cross-node slot ops not supported" }, { status: 400 });
  }
  stripVendorFieldsFromBody(routed);
  let withResponseCacheLookup = routed;
  try {
    withResponseCacheLookup = await maybeResponseCacheLookup(routed);
  } catch (error) {
    // A cache DB failure (e.g. SQLITE_BUSY) must never 500 a chat — degrade to
    // a cold miss using the unchanged routed context and fall through to upstream.
    warnResponseCacheStageFailure("lookup", error);
  }
  if (withResponseCacheLookup.responseCacheHit) {
    return withResponseCacheLookup.responseCacheHit;
  }

  let withKvLookup = withResponseCacheLookup;
  try {
    withKvLookup = await maybeKvLookup(withResponseCacheLookup);
  } catch (error) {
    warnKvStageFailure("lookup", error);
  }
  try {
    const upstream = await forward(withKvLookup);
    try {
      await maybePersistKv(withKvLookup, upstream);
    } catch (error) {
      warnKvStageFailure("persist", error);
    }
    const synthesizedSse = await maybeSynthesizeOmlxSseResponse(withKvLookup, upstream);
    const translatedResponse =
      synthesizedSse ?? (await maybeTranslateResponse(withKvLookup, upstream));
    return await maybePersistResponseCache(withKvLookup, translatedResponse);
  } finally {
    releaseWarmHitLease(withKvLookup);
  }
}
