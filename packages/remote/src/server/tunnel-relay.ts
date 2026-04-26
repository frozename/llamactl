import { unauthorizedResponse, verifyBearer } from './auth.js';
import { appendTunnelJournal, type TunnelJournalEntry } from '../tunnel/journal.js';
import type { TunnelServer } from '../tunnel/index.js';

/**
 * HTTP bridge from the CLI to a tunneled node.
 *
 * POST /tunnel-relay/<nodeName>
 *   Body: { method, type?: 'query'|'mutation'|'subscription', input? }
 *   - 200 { type: 'res', id, result | error } (non-streaming)
 *   - 502 when the tunnel isn't connected or send() throws
 *   - 400 on malformed input
 *   - 401 without valid bearer
 *   - 405 on non-POST verbs
 *
 * POST /tunnel-relay/<nodeName>?stream=true
 *   Body: same shape as above; `type` should be `'subscription'`.
 *   Returns an SSE response (`text/event-stream`). Each stream-event
 *   frame from the node ships as one `data:` line; the terminal
 *   `stream-done` ships as an `event: done\ndata: {...}\n\n` frame
 *   then the stream closes.
 *
 * Cancellation: the SSE handler wires `req.signal` from Bun's fetch
 * API into the `for await` loop consuming `tunnelServer.sendSubscribe`;
 * on client disconnect, `break` triggers the iterator's `return()`
 * which ships a `stream-cancel` frame to the node so it can release
 * observer resources. Same enforcement as POSTs: bearer + (optional)
 * journal entries.
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
 * possibly leak bearer-probe patterns from unauth'd scanners. The
 * streaming path journals once at stream end (success or error),
 * with durationMs measured from stream start — NOT per-event to
 * avoid burning disk on chatty subscriptions.
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
    return unauthorizedResponse();
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

  let body: {
    method?: string;
    type?: 'query' | 'mutation' | 'subscription';
    input?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response('invalid json', { status: 400 });
  }
  if (!body.method || typeof body.method !== 'string') {
    return new Response('missing or invalid method', { status: 400 });
  }

  const method = body.method;
  const stream = url.searchParams.get('stream') === 'true';
  if (stream) {
    return handleStream(
      req,
      tunnelServer,
      nodeName,
      method,
      body.input,
      journal,
    );
  }
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

/**
 * Stream subscription events over SSE. The ReadableStream pulls
 * from `tunnelServer.sendSubscribe(...)` and writes standard SSE
 * frames:
 *   data: {...}\n\n              — each event
 *   event: done\ndata: {...}\n\n — terminal frame
 *
 * On client disconnect (`req.signal.aborted`), the `for await`
 * `break` triggers the iterator's `return()` which releases the
 * subscription id + ships a `stream-cancel` to the node.
 */
function handleStream(
  req: Request,
  tunnelServer: TunnelServer,
  nodeName: string,
  method: string,
  input: unknown,
  journal: (e: TunnelJournalEntry) => void,
): Response {
  const encoder = new TextEncoder();
  const start = performance.now();
  // A dedicated AbortController lets us close the subscription iter
  // even if `req.signal` isn't supported by the runtime; we still
  // wire req.signal into it when available.
  const abort = new AbortController();
  const onReqAbort = (): void => abort.abort();
  if (req.signal) {
    if (req.signal.aborted) abort.abort();
    else req.signal.addEventListener('abort', onReqAbort, { once: true });
  }
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const iter = tunnelServer.sendSubscribe(nodeName, {
        id: crypto.randomUUID(),
        method,
        params: { type: 'subscription', input },
      });
      let journaled = false;
      const finish = (ok: boolean, code?: string, message?: string): void => {
        if (journaled) return;
        journaled = true;
        const durationMs = performance.now() - start;
        if (ok) {
          journal({
            kind: 'tunnel-relay-call',
            ts: new Date().toISOString(),
            nodeName,
            method,
            durationMs,
            ok: true,
          });
        } else {
          journal({
            kind: 'tunnel-relay-error',
            ts: new Date().toISOString(),
            nodeName,
            method,
            code: code ?? 'tunnel-send-failed',
            message: message ?? 'unknown',
          });
        }
      };
      try {
        const iterator = iter[Symbol.asyncIterator]();
        // Race each next() against the abort signal so a mid-stream
        // client disconnect terminates the read loop without waiting
        // for the next event from the node.
        while (true) {
          if (abort.signal.aborted) {
            try { await iterator.return?.(); } catch { /* ignore */ }
            break;
          }
          const nextPromise = iterator.next();
          const abortPromise = new Promise<{ aborted: true }>((resolve) => {
            const handler = (): void => resolve({ aborted: true });
            if (abort.signal.aborted) handler();
            else abort.signal.addEventListener('abort', handler, { once: true });
          });
          const step = await Promise.race([
            nextPromise.then((r) => ({ step: r })),
            abortPromise,
          ]);
          if ('aborted' in step) {
            try { await iterator.return?.(); } catch { /* ignore */ }
            break;
          }
          const { step: result } = step;
          if (result.done) break;
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(result.value)}\n\n`),
            );
          } catch {
            // controller closed (downstream sink gone). Bail out.
            try { await iterator.return?.(); } catch { /* ignore */ }
            break;
          }
        }
        if (!abort.signal.aborted) {
          try {
            controller.enqueue(
              encoder.encode(
                `event: done\ndata: ${JSON.stringify({ ok: true })}\n\n`,
              ),
            );
          } catch { /* controller closed */ }
        }
        finish(true);
      } catch (err) {
        const message = (err as Error).message;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const code = ((err as any).code as string | undefined) ?? 'tunnel-send-failed';
        try {
          controller.enqueue(
            encoder.encode(
              `event: done\ndata: ${JSON.stringify({
                ok: false,
                error: { code, message },
              })}\n\n`,
            ),
          );
        } catch { /* controller closed */ }
        finish(false, code, message);
      } finally {
        if (req.signal) req.signal.removeEventListener('abort', onReqAbort);
        try { controller.close(); } catch { /* ignore */ }
      }
    },
    cancel(): void {
      // Downstream reader aborted (e.g. the HTTP client closed the
      // SSE connection). Mirror into our own abort controller so
      // the iterator.return() path ships stream-cancel to the node.
      abort.abort();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}
