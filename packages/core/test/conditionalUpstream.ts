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
   * `stream === true`. "always": stream regardless — required by
   * response-side translation tests at 7443403, where the anthropic
   * request translator drops `stream` so the proxy can never ask.
   */
  streamMode?: "honest" | "always";
  /** Override the SSE payload (truncated / erroring stream fixtures). */
  sseBody?: () => ReadableStream<Uint8Array> | string;
  /** Extra fields merged into the JSON chat.completion response. */
  json?: Record<string, unknown>;
}

function sseResponse(opts: UpstreamFixtureOpts | undefined): Response {
  const override = opts?.sseBody?.();
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

export function installConditionalChatUpstream(opts?: UpstreamFixtureOpts): ConditionalUpstream {
  const calls: RecordedUpstreamCall[] = [];
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method =
      init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    const bodyText = typeof init?.body === "string" ? init.body : null;
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
      return Promise.resolve(new Response("", { status: 404 }));
    }

    const wantsStream = opts?.streamMode === "always" || body?.["stream"] === true;
    if (wantsStream) return Promise.resolve(sseResponse(opts));

    return Promise.resolve(
      Response.json({
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
      }),
    );
  }) as unknown as typeof fetch;
  return { calls };
}
