import { verifyBearer } from './auth.js';
import { appendTunnelJournal, type TunnelJournalEntry } from '../tunnel/journal.js';
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
 * Journal policy: the `tunnel-relay-call` / `tunnel-relay-error`
 * entries fire ONLY for the actual tunnel-send path (the inner
 * try/catch around `tunnelServer.send`). The 401/405/400 HTTP-layer
 * rejections above are client-side errors that never touch the
 * tunnel; journaling them would just produce operator noise and
 * possibly leak bearer-probe patterns from unauth'd scanners.
 *
 * TODO: rate-limit relay calls per node — currently unbounded.
 */
export async function handleTunnelRelay(
  req: Request,
  url: URL,
  tunnelServer: TunnelServer,
  tokenHash: string,
  journalPath?: string,
): Promise<Response> {
  const journal = (entry: TunnelJournalEntry): void => {
    try {
      appendTunnelJournal(entry, journalPath);
    } catch {
      // swallowed; appendTunnelJournal already stderr-warns once.
    }
  };
  if (!verifyBearer(req, tokenHash)) {
    // 401 — HTTP-layer rejection, not a tunnel event. See module doc.
    return new Response('unauthorized', {
      status: 401,
      headers: { 'www-authenticate': 'Bearer realm="llamactl-agent"' },
    });
  }
  if (req.method !== 'POST') {
    // 405 — HTTP-layer rejection, not a tunnel event. See module doc.
    return new Response('method not allowed', { status: 405 });
  }
  const nodeName = decodeURIComponent(
    url.pathname.slice('/tunnel-relay/'.length),
  );
  // 400 branches below — HTTP-layer rejection, not a tunnel event.
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

  const method = body.method;
  const start = performance.now();
  try {
    const res = await tunnelServer.send(nodeName, {
      id: crypto.randomUUID(),
      method,
      params: { type: body.type ?? 'query', input: body.input },
    });
    const durationMs = performance.now() - start;
    // Metadata only — never log `body.input` or `res.result`. Those
    // can carry secrets (bearer headers, PEM blobs, credentials).
    journal({
      kind: 'tunnel-relay-call',
      ts: new Date().toISOString(),
      nodeName,
      method,
      durationMs,
      ok: true,
    });
    return Response.json(res);
  } catch (err) {
    const message = (err as Error).message;
    journal({
      kind: 'tunnel-relay-error',
      ts: new Date().toISOString(),
      nodeName,
      method,
      code: 'tunnel-send-failed',
      message,
    });
    return Response.json(
      {
        type: 'res' as const,
        id: '',
        error: {
          code: 'tunnel-send-failed',
          message,
        },
      },
      { status: 502 },
    );
  }
}
