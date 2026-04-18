import { resolveEnv } from './env.js';
import { endpoint as llamaEndpoint, readServerState, readServerPid } from './server.js';
import type { ResolvedEnv } from './types.js';

/**
 * OpenAI-compatible gateway in front of the local llama-server.
 * Any `/v1/*` request (except `/v1/models`) is forwarded transparently
 * to the llama-server that the agent is tracking, streaming body and
 * headers in both directions. Callers can point any OpenAI SDK at the
 * agent's URL + bearer token and get llama.cpp's built-in OpenAI
 * response shape back unchanged.
 *
 * Scope today: one workload per node — the proxy targets whichever
 * server is started via `llamactl server start` (or a workload
 * manifest). Multi-workload routing by `model` is a follow-up that
 * needs multi-server orchestration on a single node.
 */

export interface OpenAIModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface OpenAIModelsResponse {
  object: 'list';
  data: OpenAIModel[];
}

/**
 * List the models this agent currently exposes. For now that's the
 * single llama-server that's running (identified by its rel), or an
 * empty list when nothing is tracked.
 */
export function listOpenAIModels(
  resolved: ResolvedEnv = resolveEnv(),
): OpenAIModelsResponse {
  const state = readServerState(resolved);
  const pid = readServerPid(resolved);
  const data: OpenAIModel[] = [];
  if (state && pid !== null) {
    data.push({
      id: state.rel,
      object: 'model',
      created: Math.floor(new Date(state.startedAt).getTime() / 1000),
      owned_by: 'llamactl',
    });
  }
  return { object: 'list', data };
}

/**
 * Proxy an OpenAI-style request (chat/completions, completions,
 * embeddings, etc.) to the local llama-server. Bun/Node fetch returns
 * a ReadableStream body; we pipe that back unchanged so SSE streams
 * work out of the box.
 */
export async function proxyOpenAI(
  req: Request,
  resolved: ResolvedEnv = resolveEnv(),
): Promise<Response> {
  const url = new URL(req.url);
  const target = `${llamaEndpoint(resolved)}${url.pathname}${url.search}`;

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
    init.body = req.body;
    // Streaming bodies in Node/Bun fetch require the duplex hint.
    (init as unknown as { duplex: string }).duplex = 'half';
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
