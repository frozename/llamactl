import { verifyBearer } from './auth.js';
import type { TunnelServer } from '../tunnel/index.js';

/**
 * HTTP bridge from the CLI to a tunneled node.
 *
 * POST /tunnel-relay/<nodeName>
 * Body: { method: string, type?: 'query' | 'mutation', input?: unknown }
 *  - 200 { type: 'res', id, result | error }
 *  - 502 when the tunnel isn't connected or send() throws
 *  - 400 on malformed input
 *  - 401 without valid bearer
 *  - 405 on non-POST verbs
 *
 * Note: nodeName is URL-decoded. Bearer is the agent's tokenHash
 * (same one guarding /trpc); the tunnel bearer is separate and
 * guards only the inbound /tunnel WS upgrade.
 *
 * TODO: rate-limit relay calls per node — currently unbounded.
 */
export async function handleTunnelRelay(
  req: Request,
  url: URL,
  tunnelServer: TunnelServer,
  tokenHash: string,
): Promise<Response> {
  if (!verifyBearer(req, tokenHash)) {
    return new Response('unauthorized', {
      status: 401,
      headers: { 'www-authenticate': 'Bearer realm="llamactl-agent"' },
    });
  }
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }
  const nodeName = decodeURIComponent(
    url.pathname.slice('/tunnel-relay/'.length),
  );
  if (!nodeName) return new Response('missing node name', { status: 400 });

  let body: { method?: string; type?: 'query' | 'mutation'; input?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response('invalid json', { status: 400 });
  }
  if (!body.method || typeof body.method !== 'string') {
    return new Response('missing or invalid method', { status: 400 });
  }

  try {
    const res = await tunnelServer.send(nodeName, {
      id: crypto.randomUUID(),
      method: body.method,
      params: { type: body.type ?? 'query', input: body.input },
    });
    return Response.json(res);
  } catch (err) {
    return Response.json(
      {
        type: 'res' as const,
        id: '',
        error: {
          code: 'tunnel-send-failed',
          message: (err as Error).message,
        },
      },
      { status: 502 },
    );
  }
}
