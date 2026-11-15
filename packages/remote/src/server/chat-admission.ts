/**
 * #281 (DF-08) wires the #683 RequestAdmission into POST
 * /v1/chat/completions only, opt-in.
 *
 * Accounting: this slice counts every POST /v1/chat/completions admitted at
 * this agent — peer-routed and via/RAG included — under ONE constant ingress
 * key and one constant principal.
 *
 * Deferred:
 * - physical per-node accounting;
 * - per-model keys with real load coalescing (composing with the #278 leases);
 * - per-principal shares, which is why maxPerPrincipal is unbounded here;
 * - a total request deadline;
 * - /v1/messages, /v1/responses, Worker RPC (inference/procedures.ts),
 *   create-proxy.ts, and a mixed-ingress cap and fairness.
 */

import { modelKeyOf } from "@llamactl/core/residency/queue-policy";

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

  let release: Release;
  try {
    release = await admission.acquire(
      {
        requestId: crypto.randomUUID(),
        principal: "agent",
        priority: "interactive",
        model: CHAT_INGRESS_MODEL,
        bytes: body.byteLength,
        promptTokens: 0,
        maxCompletionTokens: 0,
      },
      { signal: req.signal },
    );
  } catch (err) {
    return admissionErrorResponse(err);
  }

  let released = false;
  const done = (): void => {
    if (released) {
      return;
    }
    released = true;
    req.signal.removeEventListener("abort", done);
    release();
  };
  req.signal.addEventListener("abort", done, { once: true });
  if (req.signal.aborted) {
    done();
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
