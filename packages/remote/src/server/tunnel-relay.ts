import type { TunnelServer } from "../tunnel/index.js";

import { appendTunnelJournal, type TunnelJournalEntry } from "../tunnel/journal.js";
import { isInferenceRpcProcedure } from "../tunnel/messages.js";
import { unauthorizedResponse, verifyBearer } from "./auth.js";

function relayOnlyRefusal(): Response {
  return Response.json(
    { error: { code: "FORBIDDEN", message: "this credential relays inferenceRpc.* calls only" } },
    { status: 403 },
  );
}

/** Every hash is compared, in constant time, whichever matches. */
function relayCredentialMatches(req: Request, hashes: readonly string[]): boolean {
  let matched = false;
  for (const hash of hashes) if (verifyBearer(req, hash)) matched = true;
  return matched;
}

type RelayAccess = "operator" | "relay-only";

/**
 * Who is relaying: the operator bearer, for anything, or a relay-only
 * credential, for `inferenceRpc.*` POSTs only. Otherwise the HTTP-layer
 * rejection (401, 403 or 405), which is not a tunnel event.
 */
function relayAccess(
  req: Request,
  tokenHash: string,
  relayCredentialHashes: readonly string[],
): RelayAccess | Response {
  if (verifyBearer(req, tokenHash)) {
    return req.method === "POST" ? "operator" : new Response("method not allowed", { status: 405 });
  }
  if (!relayCredentialMatches(req, relayCredentialHashes)) return unauthorizedResponse();
  return req.method === "POST" ? "relay-only" : relayOnlyRefusal();
}

/**
 * HTTP bridge from the CLI to a tunneled node.
 *
 * POST /tunnel-relay/<nodeName>
 *   Body: { method, type?: 'query'|'mutation'|'subscription', input? }
 *   - 200 { type: 'res', id, result | error } (non-streaming)
 *   - 502 when the tunnel isn't connected or send() throws
 *   - 400 on malformed input
 *   - 401 without valid bearer
 *   - 403 for a relay-only credential asking for anything else than an
 *     `inferenceRpc.*` procedure
 *   - 405 on non-POST verbs
 *
 * POST /tunnel-relay/<nodeName>?stream=true
 *   Body: same shape as above; `type` should be `'subscription'`.
 *   Returns an SSE response (`text/event-stream`). Each stream-event
 *   frame from the node ships as one `data:` line; the terminal
 *   `stream-done` ships as an `event: done\ndata: {...}\n\n` frame
 *   then the stream closes.
 *
 * Cancellation: the SSE handler races each read of
 * `tunnelServer.sendSubscribe` against `req.signal` from Bun's fetch
 * API; on client disconnect the iterator's `return()` ships a
 * `stream-cancel` frame to the node so it can release observer
 * resources. Same enforcement as POSTs: bearer + (optional) journal
 * entries.
 *
 * Note: nodeName is URL-decoded. Bearer is the agent's tokenHash
 * (same one guarding /trpc); the tunnel bearer is separate and
 * guards only the inbound /tunnel WS upgrade. A relay-only credential
 * (P4.1, `relayCredentialHashes`) relays exactly the `inferenceRpc.*`
 * procedures, POSTed by name; anything else it asks for is a 403, and it
 * opens no other route on the agent.
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
 * Deferred: rate-limit relay calls per node — currently unbounded.
 */
export async function handleTunnelRelay(
  req: Request,
  url: URL,
  tunnelServer: TunnelServer,
  tokenHash: string,
  journalPath?: string,
  relayCredentialHashes: readonly string[] = [],
): Promise<Response> {
  const journal = (entry: TunnelJournalEntry): void => {
    try {
      appendTunnelJournal(entry, journalPath);
    } catch {
      // swallowed; appendTunnelJournal already stderr-warns once.
    }
  };
  const access = relayAccess(req, tokenHash, relayCredentialHashes);
  // 401/403/405 — HTTP-layer rejections, not tunnel events. See module doc.
  if (access instanceof Response) return access;
  const nodeName = decodeURIComponent(url.pathname.slice("/tunnel-relay/".length));
  // 400 branches below — HTTP-layer rejection, not a tunnel event.
  if (!nodeName) return new Response("missing node name", { status: 400 });

  let body: {
    method?: string;
    type?: "query" | "mutation" | "subscription";
    input?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  if (!body.method || typeof body.method !== "string") {
    return new Response("missing or invalid method", { status: 400 });
  }

  const method = body.method;
  if (access === "relay-only" && !isInferenceRpcProcedure(method)) return relayOnlyRefusal();
  const stream = url.searchParams.get("stream") === "true";
  if (stream) {
    return handleStream(req, tunnelServer, nodeName, method, body.input, journal);
  }
  const start = performance.now();
  try {
    const res = await tunnelServer.send(nodeName, {
      id: crypto.randomUUID(),
      method,
      params: { type: body.type ?? "query", input: body.input },
    });
    const durationMs = performance.now() - start;
    // Metadata only — never log `body.input` or `res.result`. Those
    // can carry secrets (bearer headers, PEM blobs, credentials).
    journal({
      kind: "tunnel-relay-call",
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
      kind: "tunnel-relay-error",
      ts: new Date().toISOString(),
      nodeName,
      method,
      code: "tunnel-send-failed",
      message,
    });
    return Response.json(
      {
        type: "res" as const,
        id: "",
        error: {
          code: "tunnel-send-failed",
          message,
        },
      },
      { status: 502 },
    );
  }
}

function makeStreamFinish(
  journal: (e: TunnelJournalEntry) => void,
  nodeName: string,
  method: string,
  start: number,
): (ok: boolean, code?: string, message?: string) => void {
  let journaled = false;
  return (ok: boolean, code?: string, message?: string): void => {
    if (journaled) return;
    journaled = true;
    const durationMs = performance.now() - start;
    if (ok) {
      journal({
        kind: "tunnel-relay-call",
        ts: new Date().toISOString(),
        nodeName,
        method,
        durationMs,
        ok: true,
      });
    } else {
      journal({
        kind: "tunnel-relay-error",
        ts: new Date().toISOString(),
        nodeName,
        method,
        code: code ?? "tunnel-send-failed",
        message: message ?? "unknown",
      });
    }
  };
}

async function closeIterator<T>(iterator: AsyncIterator<T>): Promise<void> {
  try {
    await iterator.return?.();
  } catch {
    /* ignore */
  }
}

/**
 * One relay step: the subscription's next event, or "aborted" once the
 * client is gone, whichever comes first. The abort listener lives for the
 * step only, so a long stream never accumulates listeners.
 */
export async function nextRelayEvent<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T> | "aborted"> {
  if (signal.aborted) return "aborted";
  let onAbort = (): void => undefined;
  const aborted = new Promise<"aborted">((resolve) => {
    onAbort = (): void => {
      resolve("aborted");
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([iterator.next(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function doneFrame(
  done: { ok: true } | { ok: false; error: { code: string; message: string } },
): string {
  return `event: done\ndata: ${JSON.stringify(done)}\n\n`;
}

function streamErrorOf(err: unknown): { code: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
      ? err.code
      : "tunnel-send-failed";
  return { code, message };
}

/**
 * Stream subscription events over SSE:
 *   data: {...}\n\n              — each event
 *   event: done\ndata: {...}\n\n — terminal frame
 *
 * Pull-driven (P4.1 X3): each read of the body takes one event from
 * `tunnelServer.sendSubscribe(...)`. A client that stops reading stops
 * the pulls, so what it has not read waits in central's per-stream queue,
 * which is bounded and ends the stream typed `stream-overflow` (cancelling
 * the node's stream) instead of growing this body without limit.
 *
 * On client disconnect (`req.signal` or the body's cancel), the
 * iterator's `return()` releases the subscription id and ships a
 * `stream-cancel` to the node.
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
  const finish = makeStreamFinish(journal, nodeName, method, performance.now());
  // A dedicated AbortController lets us close the subscription iter
  // even if `req.signal` isn't supported by the runtime; we still
  // wire req.signal into it when available.
  const abort = new AbortController();
  const onReqAbort = (): void => {
    abort.abort();
  };
  if (req.signal.aborted) abort.abort();
  else req.signal.addEventListener("abort", onReqAbort, { once: true });
  let iterator: AsyncIterator<unknown> | undefined;
  const subscription = (): AsyncIterator<unknown> => {
    iterator ??= tunnelServer
      .sendSubscribe(nodeName, {
        id: crypto.randomUUID(),
        method,
        params: { type: "subscription", input },
      })
      [Symbol.asyncIterator]();
    return iterator;
  };
  const end = (controller: ReadableStreamDefaultController<Uint8Array>, frame?: string): void => {
    req.signal.removeEventListener("abort", onReqAbort);
    try {
      if (frame !== undefined) controller.enqueue(encoder.encode(frame));
      controller.close();
    } catch {
      /* controller closed */
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      const source = subscription();
      let step: IteratorResult<unknown> | "aborted";
      try {
        step = await nextRelayEvent(source, abort.signal);
      } catch (err) {
        const error = streamErrorOf(err);
        finish(false, error.code, error.message);
        end(controller, doneFrame({ ok: false, error }));
        return;
      }
      if (step === "aborted") {
        await closeIterator(source);
        finish(false, "client-aborted", "client disconnected");
        end(controller);
        return;
      }
      if (step.done === true) {
        finish(true);
        end(controller, doneFrame({ ok: true }));
        return;
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(step.value)}\n\n`));
    },
    async cancel(): Promise<void> {
      // Downstream reader aborted (e.g. the HTTP client closed the SSE
      // connection): the iterator's return() ships stream-cancel.
      abort.abort();
      req.signal.removeEventListener("abort", onReqAbort);
      if (iterator !== undefined) await closeIterator(iterator);
      finish(false, "client-aborted", "client disconnected");
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
