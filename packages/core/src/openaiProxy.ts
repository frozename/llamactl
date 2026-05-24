import type { ModelInfo, ModelListResponse } from '@nova/contracts';
import { statSync } from 'node:fs';
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
  req: Request,
  resolved: ResolvedEnv,
): string | null {
  const url = new URL(req.url);
  const routeMap = getRouteMap(resolved);
  const entry = routeMap.get(model);
  if (!entry) return null;
  return `http://${entry.host}:${entry.port}${url.pathname}${url.search}`;
}

type RouteEntry = { host: string; port: number };

type ProxyContext = {
  req: Request;
  resolved: ResolvedEnv;
  target: string;
  init: RequestInit;
  bodyText?: string;
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

function parseIncoming(req: Request, resolved: ResolvedEnv): ProxyContext | Response {
  const url = new URL(req.url);
  if (url.pathname === '/v1/messages') {
    return new Response('Not Implemented', { status: 501 });
  }
  const fallbackTarget = `${llamaEndpoint(resolved)}${url.pathname}${url.search}`;
  const headers = new Headers();
  for (const [key, value] of req.headers.entries()) {
    const lower = key.toLowerCase();
    if (lower === 'host' || lower === 'connection' || lower === 'content-length' || lower === 'authorization') {
      continue;
    }
    headers.set(key, value);
  }
  return {
    req,
    resolved,
    target: fallbackTarget,
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
      const next: ProxyContext = {
        ...context,
        bodyText,
        init: {
          ...context.init,
          body: bodyText,
        },
      };
      const model = requestedModelFromBody(bodyText);
      if (model) {
        const routedTarget = routedEndpointForModel(model, req, resolved);
        if (routedTarget) next.target = routedTarget;
      }
      return next;
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

function maybeTranslateResponse(upstream: Response): Response {
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
  const parsed = parseIncoming(req, resolved);
  if (parsed instanceof Response) return parsed;
  const translated = maybeTranslate(parsed);
  const routed = await resolveRoute(translated);
  if (routed instanceof Response) return routed;
  const upstream = await forward(routed);
  return maybeTranslateResponse(upstream);
}
