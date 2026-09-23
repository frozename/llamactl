/**
 * Honest chat-completions upstream fixture. It answers SSE ONLY when
 * the request body it received carries `stream: true`; otherwise a
 * JSON chat.completion. The pre-7443403 /v1/messages stream test used
 * an unconditional-SSE fixture, which can never observe a dropped
 * `stream` flag — keying the response mode off the received request
 * is what lets a test tell "client got SSE" apart from "upstream was
 * asked to stream".
 */

export interface RecordedUpstreamCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Raw request body text when it was a string; null otherwise. */
  bodyText: string | null;
  /** JSON-parsed body, or null when the body wasn't JSON. */
  body: Record<string, unknown> | null;
}

export interface ConditionalUpstream {
  readonly calls: RecordedUpstreamCall[];
}

const DEFAULT_SSE_BODY =
  'data: {"id":"chatcmpl-fixture","object":"chat.completion.chunk","model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","content":"fixture"},"finish_reason":null}]}\n\n' +
  'data: {"id":"chatcmpl-fixture","object":"chat.completion.chunk","model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n' +
  "data: [DONE]\n\n";

interface UpstreamFixtureOpts {
  /**
   * "honest" (default): stream only when the observed body has
   * `stream === true`. "always" exists ONLY for the two P1.3
   * test.failing reproductions in openaiProxy.abort.test.ts — the
   * P1.2 request-translator defect drops `stream`, so an honest
   * fixture could never reach the response-side path under test.
   * Remove "always" when P1.2 (#132) lands.
   */
  streamMode?: "honest" | "always";
  /** Override the SSE payload (truncated / erroring stream fixtures). */
  sseBody?: ReadableStream<Uint8Array> | string | (() => ReadableStream<Uint8Array> | string);
  /** Extra fields merged into the JSON chat.completion response. */
  json?: Record<string, unknown>;
}

function sseResponse(opts: UpstreamFixtureOpts | undefined): Response {
  const override = typeof opts?.sseBody === "function" ? opts.sseBody() : opts?.sseBody;
  const stream =
    override instanceof ReadableStream
      ? override
      : new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(
              new TextEncoder().encode(typeof override === "string" ? override : DEFAULT_SSE_BODY),
            );
            controller.close();
          },
        });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * Fail closed on request bodies the fixture can't decode — recording a
 * non-string body as "no stream" would let a real `stream: true`
 * silently masquerade as non-streaming.
 */
async function readRequestBodyText(
  input: Request | URL | string,
  init: RequestInit | undefined,
): Promise<string | null> {
  const body = init?.body;
  if (body === undefined || body === null) {
    if (input instanceof Request && input.body !== null) return await input.text();
    return null;
  }
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  if (body instanceof Blob) return await body.text();
  throw new Error(
    `conditionalUpstream: unsupported request body type ${Object.prototype.toString.call(body)}`,
  );
}

export function installConditionalChatUpstream(opts?: UpstreamFixtureOpts): ConditionalUpstream {
  const calls: RecordedUpstreamCall[] = [];
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method =
      init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    const bodyText = await readRequestBodyText(input, init);
    let body: Record<string, unknown> | null = null;
    try {
      body = bodyText === null ? null : (JSON.parse(bodyText) as Record<string, unknown>);
    } catch {
      body = null;
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers ?? {})) {
      headers[key] = value;
    }
    calls.push({ url, method, headers, bodyText, body });

    const parsed = new URL(url);
    if (method !== "POST" || parsed.pathname !== "/v1/chat/completions") {
      return new Response("", { status: 404 });
    }

    const wantsStream = opts?.streamMode === "always" || body?.["stream"] === true;
    if (wantsStream) return sseResponse(opts);

    return Response.json({
      id: "chatcmpl-fixture",
      object: "chat.completion",
      model: body?.["model"] ?? "fixture-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "fixture reply" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
      ...opts?.json,
    });
  }) as unknown as typeof fetch;
  return { calls };
}
