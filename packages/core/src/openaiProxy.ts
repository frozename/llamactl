import type { ModelInfo, ModelListResponse } from '@nova/contracts';
import { statSync } from 'node:fs';
import {
  AnthropicTranslationError,
  translateAnthropicRequest,
} from './anthropic/translateRequest.js';
import { translateOpenAIResponse } from './anthropic/translateResponse.js';
import { translateOpenAIStreamToAnthropic } from './anthropic/translateStream.js';
import type { AnthropicMessagesRequest } from './anthropic/types.js';
import { resolveEnv } from './env.js';
import { endpoint as llamaEndpoint, readServerState, readServerPid } from './server.js';
import { readModelHostState } from './engines/state.js';
import type { ResolvedEnv } from './types.js';
import * as workloadRuntime from './workloadRuntime.js';
import type { WorkloadKey } from './workloadRuntime.js';

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
): string | null {
  const routeMap = getRouteMap(resolved);
  const entry = routeMap.get(model);
  if (!entry) return null;
  return `http://${entry.host}:${entry.port}${pathname}${search}`;
}

type RouteEntry = { host: string; port: number };

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
    out.set(route.model, { host: route.host, port: route.port });
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
}

export function __getOpenAIProxyRouteMapBuildCountForTests(): number {
  return routeMapBuildCount;
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
        if (routedTarget) context.target = routedTarget;
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
  const upstream = await forward(routed);
  return maybeTranslateResponse(routed, upstream);
}
