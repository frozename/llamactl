/**
 * #281 (DF-08) wires the #683 RequestAdmission into the agent's chat
 * ingresses, opt-in.
 *
 * COVERED: POST /v1/chat/completions, POST /v1/messages and POST
 * /v1/responses; generic POST /v1/completions (the serve.ts create-proxy
 * dispatchProxyRequest branch); router chatComplete/chatStream on
 * inproc://local, whether reached over /trpc or relayed through the tunnel
 * client's contextFor. The in-process RAG via-forward (createCaller({})) is
 * covered by its outer slot.
 *
 * UNCOUNTED BY DESIGN: /v1/embeddings and RAG embedding, because an embedder
 * call nested inside an admitted chat would self-deadlock.
 *
 * DEFERRED:
 * - /v1/rerank and other generic /v1/* POSTs;
 * - the planner local provider (router.ts resolvePlannerProvider), which is
 *   a separate non-nested consumer and so just deferred;
 * - fairness between the ingresses that share the cap;
 * - physical per-node accounting;
 * - per-model keys with real load coalescing (composing with the #278 leases);
 * - per-principal shares, which is why maxPerPrincipal is unbounded here;
 * - a total request deadline;
 * - Anthropic-shaped error bodies.
 *
 * Worker RPC (inference/procedures.ts) now shares this cap. Two differences
 * from the HTTP ingresses are deliberate: the embedded (in-process
 * unified-proxy) attempt is exempt so an already-admitted HTTP request is not
 * counted twice; and a refusal that lands after the RPC's 'accepted' event is
 * a failed terminal (502 at the client), not the 503 this ingress returns
 * before anything is accepted.
 */

import { modelKeyOf } from "@llamactl/core/residency/queue-policy";
import { type TRPC_ERROR_CODE_KEY, TRPCError } from "@trpc/server";

import {
  createRequestAdmission,
  type Release,
  type RequestAdmission,
  RequestAdmissionError,
} from "../residency/request-admission.js";

export const CHAT_INGRESS_MODEL = { name: "chat-completions", revision: "agent" } as const;

const CHAT_MAX_QUEUED_BYTES = 33_554_432;
const CHAT_MAX_QUEUE_WAIT_MS = 30_000;
const CHAT_STARVATION_BOUND_MS = 30_000;
const CHAT_RETRY_AFTER_MS = 1_000;

export function createChatCompletionsAdmission(caps: {
  maxExecutions: number;
  maxQueued: number;
}): RequestAdmission {
  // maxPerPrincipal is unbounded on purpose: enqueue() checks the principal
  // share (step 6) BEFORE QueueFull (step 7), and every request shares one
  // principal, so a finite exec+queued cap would make every overload report
  // PrincipalShareExceeded instead of QueueFull.
  return createRequestAdmission({
    limits: {
      maxExecutions: caps.maxExecutions,
      maxQueued: caps.maxQueued,
      maxQueuedBytes: CHAT_MAX_QUEUED_BYTES,
      maxQueueWaitMs: CHAT_MAX_QUEUE_WAIT_MS,
      maxPerPrincipal: Number.MAX_SAFE_INTEGER,
      starvationBoundMs: CHAT_STARVATION_BOUND_MS,
      maxContextTokens: Number.MAX_SAFE_INTEGER,
      retryAfterMs: CHAT_RETRY_AFTER_MS,
    },
    resident: [modelKeyOf(CHAT_INGRESS_MODEL)],
    load: (): Promise<void> => Promise.resolve(),
  });
}

/**
 * Refusal status mapping. 429 means the client is sending too much; 503 means
 * the agent is overloaded:
 * - QueueFull (and PrincipalShareExceeded) is 429 + Retry-After;
 * - QueueWaitExceeded is 503 + Retry-After: the request was admitted to the
 *   queue but the agent could not start it within the queue wait;
 * - a single oversized request (QueueBytesExceeded with no Retry-After) is 413.
 * Every 429 and 503 carries error.type "overloaded_error".
 */
function admissionStatus(code: RequestAdmissionError["code"], retryAfterMs: number | null): number {
  switch (code) {
    case "QueueFull":
    case "PrincipalShareExceeded":
      return retryAfterMs === null ? 503 : 429;
    case "QueueBytesExceeded":
      return retryAfterMs === null ? 413 : 429;
    case "QueueWaitExceeded":
    case "LoadFailed":
      return 503;
    case "DeadlineExceeded":
      return 504;
    case "InvalidRequest":
    case "ContextLimitExceeded":
      return 400;
    case "DuplicateRequest":
      return 409;
    case "Aborted":
      return 499;
  }
}

export function admissionErrorResponse(err: unknown): Response {
  if (!(err instanceof RequestAdmissionError)) {
    throw err;
  }
  const status = admissionStatus(err.code, err.retryAfterMs);
  const type = status === 429 || status === 503 ? "overloaded_error" : "invalid_request_error";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (err.retryAfterMs !== null) {
    headers["retry-after"] = String(Math.max(1, Math.ceil(err.retryAfterMs / 1000)));
  }
  const body = JSON.stringify({
    error: { message: `chat admission refused: ${err.code}`, type, code: err.code },
  });
  return new Response(body, { status, headers });
}

/**
 * tRPC-side sibling of admissionStatus: the router must refuse with a typed
 * TRPCError, not an HTTP Response. GATEWAY_TIMEOUT is 504 here; TIMEOUT maps
 * to 408 in @trpc/server 11.16.0, so it would be the wrong code.
 */
function trpcCodeForStatus(status: number): TRPC_ERROR_CODE_KEY {
  switch (status) {
    case 429:
      return "TOO_MANY_REQUESTS";
    case 503:
      return "SERVICE_UNAVAILABLE";
    case 413:
      return "PAYLOAD_TOO_LARGE";
    case 504:
      return "GATEWAY_TIMEOUT";
    case 400:
      return "BAD_REQUEST";
    case 409:
      return "CONFLICT";
    case 499:
      return "CLIENT_CLOSED_REQUEST";
    default:
      return "INTERNAL_SERVER_ERROR";
  }
}

export function admissionTrpcError(err: unknown): TRPCError {
  if (!(err instanceof RequestAdmissionError)) {
    throw err;
  }
  const status = admissionStatus(err.code, err.retryAfterMs);
  const retry = err.retryAfterMs === null ? "" : ` (retryAfterMs=${String(err.retryAfterMs)})`;
  return new TRPCError({
    code: trpcCodeForStatus(status),
    message: `chat admission refused: ${err.code}${retry}`,
    cause: err,
  });
}

function invalidRequestResponse(message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

function responseHoldingSlot(res: Response, done: () => void): Response {
  const source = res.body;
  if (source === null) {
    return res;
  }
  const reader = source.getReader();
  const wrapped = new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      try {
        const next = await reader.read();
        if (next.done) {
          done();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (err) {
        done();
        controller.error(err);
      }
    },
    async cancel(reason): Promise<void> {
      done();
      await reader.cancel(reason);
    },
  });
  return new Response(wrapped, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/**
 * Acquire one chat slot on the shared instance under the constant ingress
 * key and principal, and hand back a release-once closure. The closure also
 * fires on signal abort (dropping its listener), and fires immediately when
 * the signal is already aborted. Refusals surface as the admission's own
 * RequestAdmissionError; the HTTP ingress maps them with admissionErrorResponse
 * and the router with admissionTrpcError.
 */
export async function acquireChatSlot(
  admission: RequestAdmission,
  opts: { bytes: number; signal?: AbortSignal },
): Promise<Release> {
  const release = await admission.acquire(
    {
      requestId: crypto.randomUUID(),
      principal: "agent",
      priority: "interactive",
      model: CHAT_INGRESS_MODEL,
      bytes: opts.bytes,
      promptTokens: 0,
      maxCompletionTokens: 0,
    },
    opts.signal !== undefined ? { signal: opts.signal } : {},
  );

  const signal = opts.signal;
  let released = false;
  const done = (): void => {
    if (released) {
      return;
    }
    released = true;
    if (signal !== undefined) {
      signal.removeEventListener("abort", done);
    }
    release();
  };
  if (signal !== undefined) {
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) {
      done();
    }
  }
  return done;
}

export async function admitChatCompletions(
  req: Request,
  admission: RequestAdmission,
  forward: (req: Request) => Promise<Response>,
): Promise<Response> {
  let body: ArrayBuffer;
  try {
    body = await req.arrayBuffer();
  } catch {
    return invalidRequestResponse("failed to read chat request body");
  }

  let done: Release;
  try {
    done = await acquireChatSlot(admission, { bytes: body.byteLength, signal: req.signal });
  } catch (err) {
    return admissionErrorResponse(err);
  }

  let res: Response;
  try {
    res = await forward(
      new Request(req.url, {
        method: req.method,
        headers: req.headers,
        body,
        signal: req.signal,
      }),
    );
  } catch (err) {
    done();
    throw err;
  }

  if (res.body === null) {
    done();
    return res;
  }
  return responseHoldingSlot(res, done);
}
