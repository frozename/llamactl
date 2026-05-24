import type { ModelInfo, ModelListResponse } from '@nova/contracts';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { statSync } from 'node:fs';
import {
  AnthropicTranslationError,
  translateAnthropicRequest,
} from './anthropic/translateRequest.js';
import { translateOpenAIResponse } from './anthropic/translateResponse.js';
import { translateOpenAIStreamToAnthropic } from './anthropic/translateStream.js';
import type { AnthropicMessagesRequest } from './anthropic/types.js';
import { resolveEnv } from './env.js';
import { ctxForModel } from './ctx.js';
import { endpoint as llamaEndpoint, readServerState, readServerPid } from './server.js';
import { readModelHostState } from './engines/state.js';
import type { ResolvedEnv } from './types.js';
import * as workloadRuntime from './workloadRuntime.js';
import type { WorkloadKey } from './workloadRuntime.js';
import {
  EXT_FLAG_SESSION_TITLE,
  EXT_FLAG_TOOL_MAP,
  KvRegistry,
  SlotAllocator,
  UpstreamSlotClient,
  longestPrefixLookup,
  openKvStorage,
  readTrailer,
  readWorkloadEpoch,
  runEvictionIfOverBudget,
  writeTrailer,
  type KvTrailer,
  type KvStorage,
} from './kvstore/index.js';

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
export function listOpenAIModels(
  resolved?: ResolvedEnv,
): ModelListResponse;
export function listOpenAIModels(
  key: WorkloadKey,
  resolved?: ResolvedEnv,
): ModelListResponse;
export function listOpenAIModels(
  keyOrResolved: WorkloadKey | ResolvedEnv = resolveEnv(),
  resolved: ResolvedEnv = resolveEnv(),
): ModelListResponse {
  if ('name' in keyOrResolved) {
    const key = keyOrResolved;
    const state = readServerState(key, resolved);
    const pid = readServerPid(key, resolved);
    const data: ModelInfo[] = [];
    if (state && pid !== null) {
      data.push({
        id: state.rel,
        object: 'model',
        created: Math.floor(new Date(state.startedAt).getTime() / 1000),
        owned_by: 'llamactl-agent',
        capabilities: ['chat'],
      });
    }
    return { object: 'list', data };
  }

  return getCachedModelsResponse(keyOrResolved);
}

function createdAtForRoute(route: workloadRuntime.LocalRoute, resolved: ResolvedEnv): number {
  if (route.kind === 'ModelHost') {
    const state = readModelHostState({ name: route.workload }, resolved);
    if (state?.startedAt) return Math.floor(new Date(state.startedAt).getTime() / 1000);
  } else {
    const state = readServerState({ name: route.workload }, resolved);
    if (state?.startedAt) return Math.floor(new Date(state.startedAt).getTime() / 1000);
  }
  return 0;
}

function buildListOpenAIModels(resolved: ResolvedEnv): ModelListResponse {
  const data: ModelInfo[] = [];
  const winners = new Map<string, { kind: string; workload: string }>();
  const routes = [...workloadRuntime.listLocalRoutes(resolved)].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'ModelRun' ? -1 : 1;
    return a.workload.localeCompare(b.workload);
  });
  for (const route of routes) {
    if (winners.has(route.model)) {
      const prior = winners.get(route.model)!;
      console.warn(
        `[openaiProxy] route-map collision on model='${route.model}': keeping ${prior.kind}:${prior.workload}, ignoring ${route.kind}:${route.workload}`,
      );
      continue;
    }
    winners.set(route.model, { kind: route.kind, workload: route.workload });
    data.push({
      id: route.model,
      object: 'model',
      created: createdAtForRoute(route, resolved),
      owned_by: route.kind === 'ModelHost' ? 'llamactl-host' : 'llamactl-agent',
      capabilities: ['chat'],
    });
  }
  return { object: 'list', data };
}

let modelsResponseCache: { mtimeNs: bigint; response: ModelListResponse } | null = null;

function getCachedModelsResponse(resolved: ResolvedEnv): ModelListResponse {
  try {
    const mtimeNs = statSync(workloadRuntime.workloadRuntimeRoot(resolved), { bigint: true }).mtimeNs;
    if (modelsResponseCache && modelsResponseCache.mtimeNs === mtimeNs) return modelsResponseCache.response;
    const response = buildListOpenAIModels(resolved);
    modelsResponseCache = { mtimeNs, response };
    return response;
  } catch {
    return buildListOpenAIModels(resolved);
  }
}

function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return lower.includes('application/json') || lower.includes('+json');
}

function requestedModelFromBody(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as { model?: unknown };
    return typeof parsed.model === 'string' ? parsed.model : undefined;
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
  return {
    ...entry,
    target: `http://${entry.host}:${entry.port}${pathname}${search}`,
  };
}

type RouteEntry = {
  host: string;
  port: number;
  workload: string;
  kind: 'ModelRun' | 'ModelHost';
  engine: workloadRuntime.LocalRoute['engine'];
  model: string;
};

type RoutedEntry = RouteEntry & { target: string };

interface KvRuntime {
  storage: KvStorage;
  registry: KvRegistry;
  allocators: Map<string, SlotAllocator>;
  slotClients: Map<string, { endpoint: string; client: UpstreamSlotClient }>;
}

interface KvRequestState {
  runtime: KvRuntime;
  workload: string;
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
};

let routeMapCache: { mtimeNs: bigint; map: Map<string, RouteEntry> } | null = null;
let routeMapBuildCount = 0;

function buildRouteMap(resolved: ResolvedEnv): Map<string, RouteEntry> {
  routeMapBuildCount += 1;
  const out = new Map<string, RouteEntry>();
  const winners = new Map<string, { kind: string; workload: string }>();
  const routes = [...workloadRuntime.listLocalRoutes(resolved)].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'ModelRun' ? -1 : 1;
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
    winners.set(route.model, { kind: route.kind, workload: route.workload });
    out.set(route.model, {
      host: route.host,
      port: route.port,
      workload: route.workload,
      kind: route.kind,
      engine: route.engine,
      model: route.model,
    });
  }
  return out;
}

function getRouteMap(resolved: ResolvedEnv): Map<string, RouteEntry> {
  try {
    const mtimeNs = statSync(workloadRuntime.workloadRuntimeRoot(resolved), { bigint: true }).mtimeNs;
    if (routeMapCache && routeMapCache.mtimeNs === mtimeNs) return routeMapCache.map;
    const map = buildRouteMap(resolved);
    routeMapCache = { mtimeNs, map };
    return map;
  } catch {
    return buildRouteMap(resolved);
  }
}

export function __resetOpenAIProxyRouteMapCacheForTests(): void {
  routeMapCache = null;
  modelsResponseCache = null;
  routeMapBuildCount = 0;
  for (const runtime of kvRuntimeByDataRoot.values()) {
    runtime.storage.close();
  }
  kvRuntimeByDataRoot.clear();
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

function anthropicTranslationErrorResponse(error: unknown): Response {
  return Response.json(
    {
      error: {
        message: error instanceof Error ? error.message : 'anthropic request translation failed',
        type: 'anthropic_translation_error',
      },
    },
    { status: error instanceof AnthropicTranslationError ? error.statusCode : 400 },
  );
}

async function parseIncoming(req: Request, resolved: ResolvedEnv): Promise<ProxyContext | Response> {
  const url = new URL(req.url);
  const headers = new Headers();
  for (const [key, value] of req.headers.entries()) {
    const lower = key.toLowerCase();
    if (lower === 'host' || lower === 'connection' || lower === 'content-length' || lower === 'authorization') {
      continue;
    }
    headers.set(key, value);
  }
  if (url.pathname === '/v1/messages') {
    try {
      const bodyText = await req.text();
      const incoming = JSON.parse(bodyText) as AnthropicMessagesRequest;
      const translated = translateAnthropicRequest(incoming);
      const translatedBodyText = JSON.stringify(translated);
      const translatedUrl = new URL(req.url);
      translatedUrl.pathname = '/v1/chat/completions';
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
      return anthropicTranslationErrorResponse(new AnthropicTranslationError('anthropic request translation failed'));
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

function maybeTranslate(context: ProxyContext): ProxyContext {
  return context;
}

const kvRuntimeByDataRoot = new Map<string, KvRuntime>();

function resolveKvDataRoot(resolved: ResolvedEnv): string {
  // KV state is rooted beside workload runtime files to avoid route-map cache churn on each KV write.
  const runtimeRoot = (resolved as Partial<ResolvedEnv>).LOCAL_AI_RUNTIME_DIR;
  if (typeof runtimeRoot === 'string' && runtimeRoot.length > 0) return runtimeRoot;
  return join(homedir(), '.llamactl', 'data');
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

function slotAllocatorFor(runtime: KvRuntime, workload: string): SlotAllocator {
  let allocator = runtime.allocators.get(workload);
  if (!allocator) {
    allocator = new SlotAllocator(1);
    runtime.allocators.set(workload, allocator);
  }
  return allocator;
}

function slotClientFor(runtime: KvRuntime, workload: string, host: string, port: number): UpstreamSlotClient {
  const endpoint = `http://${host}:${port}`;
  const cached = runtime.slotClients.get(workload);
  if (cached && cached.endpoint === endpoint) return cached.client;
  const client = new UpstreamSlotClient(endpoint);
  runtime.slotClients.set(workload, { endpoint, client });
  return client;
}

function parseContextWindow(extraArgs: readonly string[] | undefined, fallback: number): number {
  if (!extraArgs || extraArgs.length === 0) return fallback;
  const readAfterFlag = (...flags: string[]): number | null => {
    for (let i = 0; i < extraArgs.length; i += 1) {
      const token = extraArgs[i]!;
      if (flags.includes(token)) {
        const value = extraArgs[i + 1];
        if (value && Number.isInteger(Number.parseInt(value, 10))) {
          return Number.parseInt(value, 10);
        }
        continue;
      }
      for (const flag of flags) {
        if (!token.startsWith(`${flag}=`)) continue;
        const value = token.slice(flag.length + 1);
        if (Number.isInteger(Number.parseInt(value, 10))) return Number.parseInt(value, 10);
      }
    }
    return null;
  };
  return readAfterFlag('-c', '--ctx-size') ?? fallback;
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
  workload: string;
  host: string;
  port: number;
  quantBits: number;
  ctxSize: number;
  workloadEpoch: string;
} | null {
  const route = context.route;
  if (!route) return null;
  if (route.kind !== 'ModelRun' || route.engine !== 'llamacpp') return null;

  const key = { name: route.workload };
  const workloadEpoch = readWorkloadEpoch(key, context.resolved);
  if (!workloadEpoch) return null;

  const state = readServerState(key, context.resolved);
  const rel = state?.rel ?? route.model;
  const defaultCtx = Number.parseInt(ctxForModel(rel, context.resolved), 10);
  const ctxSize = parseContextWindow(state?.extraArgs, Number.isFinite(defaultCtx) ? defaultCtx : 32768);
  return {
    workload: route.workload,
    host: route.host,
    port: route.port,
    quantBits: quantBitsFromModelId(rel),
    ctxSize,
    workloadEpoch,
  };
}

function kvBudgetBytes(): number {
  const raw = process.env.LLAMACTL_KV_WORKLOAD_BUDGET_MB;
  if (!raw) return 8192 * 1024 * 1024;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 8192 * 1024 * 1024;
  return parsed * 1024 * 1024;
}

function shouldUseKvPath(context: ProxyContext): boolean {
  return context.req.method === 'POST' && context.pathname === '/v1/chat/completions' && typeof context.bodyText === 'string';
}

function shouldEnforceFirstTokenEquivalence(bodyText: string): boolean {
  try {
    const parsed = JSON.parse(bodyText) as { temperature?: unknown; seed?: unknown };
    if (parsed.seed !== null && parsed.seed !== undefined) return true;
    if (typeof parsed.temperature === 'number' && Number.isFinite(parsed.temperature) && parsed.temperature > 0) {
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

function firstTokenTextFromContent(content: unknown): string | null {
  if (typeof content === 'string') return normalizeFirstResponseToken(content);
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') {
        const fromString = normalizeFirstResponseToken(part);
        if (fromString) return fromString;
        continue;
      }
      if (!part || typeof part !== 'object') continue;
      const partText = (part as { text?: unknown }).text;
      if (typeof partText !== 'string') continue;
      const normalized = normalizeFirstResponseToken(partText);
      if (normalized) return normalized;
    }
  }
  return null;
}

function extractFirstResponseTokenFromJson(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== 'object') return null;
  const message = (firstChoice as { message?: unknown }).message;
  if (message && typeof message === 'object') {
    const content = (message as { content?: unknown }).content;
    const fromMessage = firstTokenTextFromContent(content);
    if (fromMessage) return fromMessage;
  }
  const delta = (firstChoice as { delta?: unknown }).delta;
  if (delta && typeof delta === 'object') {
    const content = (delta as { content?: unknown }).content;
    return firstTokenTextFromContent(content);
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractToolMapFromJson(payload: unknown): Record<string, string> {
  if (!isRecord(payload)) return {};
  const choices = payload.choices;
  if (!Array.isArray(choices)) return {};
  const out: Record<string, string> = {};
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const message = choice.message;
    if (!isRecord(message)) continue;
    const toolCalls = message.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const rawCall of toolCalls) {
      if (!isRecord(rawCall)) continue;
      if (rawCall.type !== 'function' || typeof rawCall.id !== 'string') continue;
      const fn = rawCall.function;
      if (!isRecord(fn) || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') continue;
      out[rawCall.id] = JSON.stringify({
        id: rawCall.id,
        type: 'function',
        function: {
          name: fn.name,
          arguments: fn.arguments,
        },
      });
    }
  }
  return out;
}

function deriveSessionTitle(req: AnthropicMessagesRequest | undefined): string | undefined {
  if (!req) return undefined;
  const firstUser = req.messages.find((message) => message.role === 'user');
  if (!firstUser) return undefined;
  if (typeof firstUser.content === 'string') {
    const text = firstUser.content.trim();
    return text.length > 0 ? text.slice(0, 80) : undefined;
  }
  const text = firstUser.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
  return text.length > 0 ? text.slice(0, 80) : undefined;
}

async function readFirstResponseToken(upstream: Response): Promise<string | null> {
  const contentType = upstream.headers.get('content-type');
  if (!contentType || !isJsonContentType(contentType)) return null;
  try {
    return extractFirstResponseTokenFromJson(await upstream.clone().json());
  } catch {
    return null;
  }
}

async function maybeKvLookup(context: ProxyContext): Promise<ProxyContext> {
  if (!shouldUseKvPath(context)) return context;
  const metadata = resolveRouteKvMetadata(context);
  if (!metadata) return context;
  const runtime = kvRuntimeFor(context.resolved);
  const bodyText = context.bodyText!;
  const enforceFirstTokenEquivalence = shouldEnforceFirstTokenEquivalence(bodyText);
  let prefixMetric = Buffer.byteLength(bodyText, 'utf8');
  let sha = createHash('sha1').update(bodyText).digest('hex');

  // Phase 6 is boundary-naive: use byte length as both byte prefix and token guard until token accounting lands.
  const hit = longestPrefixLookup(runtime.registry, {
    candidatePrefixes: [{ sha, prefixByteLength: prefixMetric, tokenCount: prefixMetric }],
    workload: metadata.workload,
    quantBits: metadata.quantBits,
    ctxSize: metadata.ctxSize,
    workloadEpoch: metadata.workloadEpoch,
  });

  if (hit) {
    let replayMismatch = false;
    let reserved = false;
    const reserveWrite = runtime.storage.safeWrite(() => {
      reserved = runtime.registry.reserve(hit.sha);
    });
    if (reserveWrite.ok && reserved) {
      const lease = slotAllocatorFor(runtime, metadata.workload).acquire();
      if (lease) {
        const slotClient = slotClientFor(runtime, metadata.workload, metadata.host, metadata.port);
        // llama-server's slot API only accepts a bare filename (relative to its
        // --slot-save-path). We store the absolute path in the registry for
        // orphan sweep + integrity scan, but pass basename to the upstream call.
        const restore = await slotClient.restore(lease.slotId, basename(hit.upstreamSlotFile));
        let activated = false;
        const activateWrite = runtime.storage.safeWrite(() => {
          activated = runtime.registry.activate(hit.sha);
        });
        if (restore.ok && activateWrite.ok && activated) {
          if (
            context.isAnthropic
            && context.anthropicRequest
            && (hit.extFlags & EXT_FLAG_TOOL_MAP) !== 0
          ) {
            const trailer = readTrailer(hit.upstreamSlotFile);
            const toolMap = trailer?.toolMap;
            if (toolMap && Object.keys(toolMap).length > 0) {
              const replayBodyText = JSON.stringify(
                translateAnthropicRequest(context.anthropicRequest, { toolMap }),
              );
              const replaySha = createHash('sha1').update(replayBodyText).digest('hex');
              const replayPrefixMetric = Buffer.byteLength(replayBodyText, 'utf8');
              if (replaySha !== hit.sha) {
                runtime.storage.kv_replay_mismatch_total += 1;
                console.warn(JSON.stringify({
                  event: 'kv_replay_mismatch',
                  workload: metadata.workload,
                  expected: hit.sha,
                  got: replaySha,
                }));
                replayMismatch = true;
              } else {
                context.bodyText = replayBodyText;
                context.init = {
                  ...context.init,
                  body: replayBodyText,
                };
                sha = replaySha;
                prefixMetric = replayPrefixMetric;
                runtime.registry.bumpHit(hit.sha, Date.now());
                context.kv = {
                  runtime,
                  workload: metadata.workload,
                  host: metadata.host,
                  port: metadata.port,
                  quantBits: metadata.quantBits,
                  ctxSize: metadata.ctxSize,
                  workloadEpoch: metadata.workloadEpoch,
                  sha,
                  prefixMetric,
                  shouldPersist: false,
                  warmHitSha: hit.sha,
                  warmHitLease: lease,
                  warmHitExpectedFirstResponseToken: hit.firstResponseToken,
                  enforceFirstTokenEquivalence,
                };
                return context;
              }
            } else {
              runtime.registry.bumpHit(hit.sha, Date.now());
              context.kv = {
                runtime,
                workload: metadata.workload,
                host: metadata.host,
                port: metadata.port,
                quantBits: metadata.quantBits,
                ctxSize: metadata.ctxSize,
                workloadEpoch: metadata.workloadEpoch,
                sha,
                prefixMetric,
                shouldPersist: false,
                warmHitSha: hit.sha,
                warmHitLease: lease,
                warmHitExpectedFirstResponseToken: hit.firstResponseToken,
                enforceFirstTokenEquivalence,
              };
              return context;
            }
          } else {
            runtime.registry.bumpHit(hit.sha, Date.now());
            context.kv = {
              runtime,
              workload: metadata.workload,
              host: metadata.host,
              port: metadata.port,
              quantBits: metadata.quantBits,
              ctxSize: metadata.ctxSize,
              workloadEpoch: metadata.workloadEpoch,
              sha,
              prefixMetric,
              shouldPersist: false,
              warmHitSha: hit.sha,
              warmHitLease: lease,
              warmHitExpectedFirstResponseToken: hit.firstResponseToken,
              enforceFirstTokenEquivalence,
            };
            return context;
          }
        }
        runtime.storage.safeWrite(() => runtime.registry.release(hit.sha));
        lease.release();
        if (replayMismatch) runtime.storage.safeWrite(() => runtime.registry.tryDelete(hit.sha));
        if (!restore.ok) runtime.storage.safeWrite(() => runtime.registry.delete(hit.sha));
      } else {
        runtime.storage.safeWrite(() => runtime.registry.release(hit.sha));
      }
    }
  }

  context.kv = {
    runtime,
    workload: metadata.workload,
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

async function resolveRoute(context: ProxyContext): Promise<ProxyContext | Response> {
  const { req, resolved } = context;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const contentType = req.headers.get('content-type');
    if (isJsonContentType(contentType)) {
      if (context.bodyText === undefined) {
        const contentLength = req.headers.get('content-length');
        if (contentLength) {
          const parsedContentLength = Number.parseInt(contentLength, 10);
          if (Number.isFinite(parsedContentLength) && parsedContentLength > MAX_JSON_BODY_BYTES) {
            return new Response('Payload Too Large', { status: 413 });
          }
        }
        const bodyText = await context.req.text();
        if (bodyText.length > MAX_JSON_BODY_BYTES) {
          return new Response('Payload Too Large', { status: 413 });
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
        const routedTarget = routedEndpointForModel(model, context.pathname, context.search, resolved);
        if (routedTarget) {
          context.target = routedTarget.target;
          context.route = routedTarget;
        }
      }
      return context;
    }
    context.init = {
      ...context.init,
      body: req.body,
    };
    (context.init as unknown as { duplex: string }).duplex = 'half';
  }
  return context;
}

async function forward(context: ProxyContext): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(context.target, context.init);
  } catch (err) {
    return Response.json(
      {
        error: {
          message: `upstream llama-server unreachable: ${(err as Error).message}`,
          type: 'llamactl_upstream_error',
        },
      },
      { status: 502 },
    );
  }
  return upstream;
}

async function maybePersistKv(context: ProxyContext, upstream: Response): Promise<void> {
  const kv = context.kv;
  if (!kv) return;
  const contentType = upstream.headers.get('content-type');
  const shouldParseJson = upstream.status === 200 && !!contentType && isJsonContentType(contentType);
  let upstreamJson: unknown | null = null;
  if (shouldParseJson) {
    try {
      upstreamJson = await upstream.clone().json();
    } catch {
      upstreamJson = null;
    }
  }
  const firstResponseToken = upstreamJson ? extractFirstResponseTokenFromJson(upstreamJson) : await readFirstResponseToken(upstream);
  try {
    if (
      kv.warmHitSha &&
      kv.enforceFirstTokenEquivalence &&
      kv.warmHitExpectedFirstResponseToken !== null &&
      firstResponseToken !== null &&
      kv.warmHitExpectedFirstResponseToken !== firstResponseToken
    ) {
      kv.runtime.storage.kv_false_hit_total += 1;
      console.warn(JSON.stringify({
        event: 'kv_false_hit',
        workload: kv.workload,
        sha: kv.warmHitSha,
        expected: kv.warmHitExpectedFirstResponseToken,
        got: firstResponseToken,
      }));
      const staleSha = kv.warmHitSha;
      kv.warmHitSha = null;
      kv.runtime.storage.safeWrite(() => {
        kv.runtime.registry.release(staleSha);
        kv.runtime.registry.tryDelete(staleSha);
      });
      kv.warmHitLease?.release();
      kv.warmHitLease = null;
    }

    if (!kv.shouldPersist) return;
    // TODO(phase9): defer KV save for streams until exact replay boundaries are captured.
    if (contentType?.toLowerCase().startsWith('text/event-stream')) return;
    if (upstream.status !== 200 || !isJsonContentType(contentType) || upstreamJson === null) return;

    const allocator = slotAllocatorFor(kv.runtime, kv.workload);
    const lease = allocator.acquire();
    if (!lease) return;
    try {
      const slotDir = join(resolveKvDataRoot(context.resolved), 'kvstore', 'slots', kv.workload);
      mkdirSync(slotDir, { recursive: true });
      const slotBasename = `${kv.sha}.kvslot`;
      const slotFile = join(slotDir, slotBasename);
      const slotClient = slotClientFor(kv.runtime, kv.workload, kv.host, kv.port);
      // llama-server's slot API only accepts a bare filename (relative to its
      // --slot-save-path). We store the absolute path in the registry for
      // orphan sweep + integrity scan, but pass basename to the upstream call.
      const saved = await slotClient.save(lease.slotId, slotBasename);
      if (!saved.ok) {
        console.warn(`[kvstore] slot save skipped for workload='${kv.workload}' sha='${kv.sha}': ${saved.reason}`);
        return;
      }

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
          upstreamSlotFile: slotFile,
          quantBits: kv.quantBits,
          tokens: kv.prefixMetric,
          ctxSize: kv.ctxSize,
          hits: 0,
          createdAt: now,
          lastUsed: now,
          payloadBytes: kv.prefixMetric,
          textBytes: kv.prefixMetric,
          reason: 'cold',
          prefixByteLength: kv.prefixMetric,
          workloadEpoch: kv.workloadEpoch,
          quarantined: 0,
          state: 'idle',
          firstResponseToken,
          extFlags,
        });
      });
      if (!wrote.ok) return;

      const eviction = runEvictionIfOverBudget(kv.runtime.registry, kv.workload, kvBudgetBytes(), now);
      for (const blockedSha of eviction.blockedActive) {
        console.debug(JSON.stringify({
          event: 'slot_eviction_blocked_active_request',
          workload: kv.workload,
          sha: blockedSha,
        }));
      }
    } finally {
      lease.release();
    }
  } finally {
    if (kv.warmHitSha) kv.runtime.storage.safeWrite(() => kv.runtime.registry.release(kv.warmHitSha!));
    kv.warmHitLease?.release();
  }
}

async function maybeTranslateResponse(context: ProxyContext, upstream: Response): Promise<Response> {
  const contentType = upstream.headers.get('content-type');
  if (context.isAnthropic && contentType?.toLowerCase().startsWith('text/event-stream')) {
    if (!upstream.body) return upstream;
    const respHeaders = new Headers();
    for (const [key, value] of upstream.headers.entries()) {
      const lower = key.toLowerCase();
      if (lower === 'transfer-encoding' || lower === 'connection') continue;
      respHeaders.set(key, value);
    }
    respHeaders.set('content-type', 'text/event-stream');
    return new Response(
      translateOpenAIStreamToAnthropic(upstream.body, {
        model: context.anthropicModel ?? 'claude-compatible',
      }),
      {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      },
    );
  }
  if (context.isAnthropic && upstream.ok && contentType && isJsonContentType(contentType)) {
    try {
      const translated = translateOpenAIResponse((await upstream.clone().json()) as never);
      const respHeaders = new Headers();
      for (const [key, value] of upstream.headers.entries()) {
        const lower = key.toLowerCase();
        if (lower === 'transfer-encoding' || lower === 'connection') continue;
        respHeaders.set(key, value);
      }
      return Response.json(translated, { status: upstream.status, headers: respHeaders });
    } catch (error) {
      return Response.json(
        {
          error: {
            message: error instanceof Error ? error.message : 'anthropic response translation failed',
            type: 'anthropic_response_translation_error',
          },
        },
        { status: 502 },
      );
    }
  }
  const respHeaders = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    const lower = key.toLowerCase();
    if (lower === 'transfer-encoding' || lower === 'connection') continue;
    respHeaders.set(key, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
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
  const translated = maybeTranslate(parsed);
  const routed = await resolveRoute(translated);
  if (routed instanceof Response) return routed;
  const withKvLookup = await maybeKvLookup(routed);
  const upstream = await forward(withKvLookup);
  await maybePersistKv(withKvLookup, upstream);
  return maybeTranslateResponse(withKvLookup, upstream);
}
