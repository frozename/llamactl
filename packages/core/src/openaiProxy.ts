import type { ModelInfo, ModelListResponse } from '@nova/contracts';
import { statSync } from 'node:fs';
import { resolveEnv } from './env.js';
import { endpoint as llamaEndpoint, readServerState, readServerPid } from './server.js';
import type { ResolvedEnv } from './types.js';
import { listLocalWorkloads, type WorkloadKey, workloadRuntimeRoot } from './workloadRuntime.js';

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
  key: WorkloadKey,
  resolved: ResolvedEnv = resolveEnv(),
): ModelListResponse {
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

let routeMapCache: { mtimeNs: bigint; map: Map<string, RouteEntry> } | null = null;

function buildRouteMap(resolved: ResolvedEnv): Map<string, RouteEntry> {
  const out = new Map<string, RouteEntry>();
  for (const entry of listLocalWorkloads(resolved)) {
    if (!entry.alive) continue;
    const state = readServerState({ name: entry.name }, resolved);
    if (!state?.rel || !state.host || state.port == null) continue;
    out.set(state.rel, { host: state.host, port: state.port });
  }
  return out;
}

function getRouteMap(resolved: ResolvedEnv): Map<string, RouteEntry> {
  try {
    const mtimeNs = statSync(workloadRuntimeRoot(resolved), { bigint: true }).mtimeNs;
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
  const url = new URL(req.url);
  const fallbackTarget = `${llamaEndpoint(resolved)}${url.pathname}${url.search}`;
  let target = fallbackTarget;

  // Strip hop-by-hop headers llama-server wouldn't like. We also drop
  // the agent's own `authorization` — llama-server has no bearer auth
  // and a Bearer token confuses it (some builds 401 unknown tokens).
  const headers = new Headers();
  for (const [key, value] of req.headers.entries()) {
    const lower = key.toLowerCase();
    if (
      lower === 'host' ||
      lower === 'connection' ||
      lower === 'content-length' ||
      lower === 'authorization'
    ) {
      continue;
    }
    headers.set(key, value);
  }

  const init: RequestInit = {
    method: req.method,
    headers,
  };
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
      const bodyText = await req.text();
      if (bodyText.length > MAX_JSON_BODY_BYTES) {
        return new Response('Payload Too Large', { status: 413 });
      }
      const model = requestedModelFromBody(bodyText);
      init.body = bodyText;
      if (model) {
        const routedTarget = routedEndpointForModel(model, req, resolved);
        if (routedTarget) target = routedTarget;
      }
    } else {
      init.body = req.body;
      // Streaming bodies in Node/Bun fetch require the duplex hint.
      (init as unknown as { duplex: string }).duplex = 'half';
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
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

  // Rebuild the response so we can hand Bun a fresh ReadableStream —
  // passing `upstream.body` directly triggers "already used" errors
  // on some runtimes when the client disconnects mid-stream.
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
