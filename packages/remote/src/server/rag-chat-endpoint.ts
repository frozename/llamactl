import { TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";

import type { AppRouter } from "../router.js";

/**
 * Thin server-side wrapper over the OpenAI-compatible
 * `POST /v1/chat/completions` surface. Accepts a plain OpenAI request
 * body with two llamactl-specific extension fields:
 *
 *   via: "<node>"            // required — gateway / agent / cloud node
 *                            //            to route the chat through.
 *   rag: {                   // optional — retrieve + inject context.
 *     node: "<rag-node>",
 *     topK: 4,
 *     collection: "<name>",
 *     system_prompt_prefix: "..."
 *   }
 *
 * Flow:
 *   1. Parse JSON body.
 *   2. If neither `via` nor `rag` present, fall through to the legacy
 *      openai-proxy path (preserves plain OpenAI-client behavior).
 *   3. Otherwise `via` is mandatory (400 without).
 *   4. When `rag` is present, call `ragSearch` on that node with the
 *      last user message, then prepend a synthesized system message
 *      with the retrieved docs.
 *   5. Forward through `chatComplete({ node: via, request: ... })`.
 *   6. Return the OpenAI-shaped response as JSON. When rag was
 *      applied, add `x-llamactl-rag: retrieved=<N>` to the response
 *      headers for transparency.
 *
 * The Chat module + `llamactl rag ask` keep their client-side
 * retrieval + disclosure UX — this endpoint is for external clients
 * that can't run ragSearch themselves.
 */

export interface RagChatEndpointContext {
  appRouter: AppRouter;
  /**
   * Fallback invoked when the body has neither `rag` nor `via`. Serves
   * the legacy "proxy straight to local llama-server" behavior that
   * plain OpenAI clients rely on. The caller supplies this so
   * serve.ts keeps the openaiProxy wiring (and its metrics /
   * auth-already-verified lifecycle) in one place.
   *
   * The handler constructs a fresh Request with the already-read body
   * text and passes it here. Responses bubble up verbatim.
   */
  fallback?: (req: Request) => Promise<Response> | Response;
  /**
   * Test seam — injected so unit tests can count ragSearch/chatComplete
   * calls without spinning up a real tRPC caller. Production wiring
   * uses `context.appRouter.createCaller({})`.
   */
  caller?: {
    ragSearch: (input: RagSearchInput) => Promise<RagSearchResponse>;
    chatComplete: (input: ChatCompleteInput) => Promise<unknown>;
  };
  /**
   * Optional structured logger. Defaults to `console.error`. Handler
   * logs ONLY metadata — never the retrieved document contents (may
   * contain PII).
   */
  log?: (line: string) => void;
}

export interface RagExtensionField {
  node: string;
  topK?: number;
  collection?: string;
  system_prompt_prefix?: string;
}

interface ChatMessage {
  role: string;
  content: string | unknown[] | null;
}

interface RagChatRequestBody {
  model?: unknown;
  messages?: unknown;
  max_tokens?: unknown;
  temperature?: unknown;
  providerOptions?: unknown;
  rag?: unknown;
  via?: unknown;
  [k: string]: unknown;
}

export interface RagSearchInput {
  node: string;
  query: string;
  topK: number;
  collection?: string;
}

export interface RagSearchDocument {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface RagSearchResult {
  document: RagSearchDocument;
  score: number;
  distance?: number;
}

export interface RagSearchResponse {
  collection: string;
  results: RagSearchResult[];
}

export interface ChatCompleteInput {
  node: string;
  request: {
    model: string;
    messages: ChatMessage[];
    max_tokens?: number;
    temperature?: number;
    providerOptions?: Record<string, unknown>;
  };
}

const DEFAULT_TOP_K = 3;
const DEFAULT_SYSTEM_PROMPT_PREFIX =
  "Answer from the provided context. If the answer isn't there, say \"I don't know.\" Be concise.";

function jsonError(status: number, message: string, type: string): Response {
  return new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Scan `messages` backward for the first `role === 'user'` entry and
 * return its content as a plain string. Multipart content arrays
 * (OpenAI vision-style `[{type:'text',text:...},{type:'image_url',...}]`)
 * are collapsed to their text parts joined by a newline.
 *
 * Returns null when no user message exists.
 */
export function lastUserMessageContent(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return collapseMultipartText(c);
    // null / other — treat as empty; keep looking back for a useful
    // one in case the last user turn was a media-only placeholder.
  }
  return null;
}

/** Collapse a multipart content array to its text parts joined by newlines. */
function collapseMultipartText(parts: unknown[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (part && typeof part === "object") {
      const p = part as Record<string, unknown>;
      // OpenAI-style `{type:'text', text:'...'}` — other shapes
      // (image_url, input_audio) carry no retrieval query, skip.
      const text = p["text"];
      if (typeof text === "string") texts.push(text);
    }
  }
  return texts.join("\n");
}

/**
 * Build the RAG system message from retrieved docs. Matches the prompt
 * shape in `llamactl rag ask` + the Chat module so downstream LLMs
 * see the same grounding format regardless of which client path ran
 * the retrieval.
 */
export function buildRagSystemMessage(results: RagSearchResult[], prefix: string): string {
  const blocks = results.map((r, i) => `[${String(i + 1)}] ${r.document.content}`).join("\n");
  return `${prefix}\n\nContext:\n${blocks}`;
}

function parseRagField(
  raw: unknown,
): { ok: true; rag: RagExtensionField } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: false, error: "rag is null" };
  if (typeof raw !== "object") return { ok: false, error: "rag must be an object" };
  const r = raw as Record<string, unknown>;
  if (typeof r["node"] !== "string" || r["node"].trim() === "") {
    return { ok: false, error: "rag.node is required (string)" };
  }
  const out: RagExtensionField = { node: r["node"] };
  const error =
    validateRagTopK(r, out) ??
    validateRagStringField(r, out, "collection") ??
    validateRagStringField(r, out, "system_prompt_prefix");
  if (error !== null) return { ok: false, error };
  return { ok: true, rag: out };
}

/** Validate + copy the optional `topK` field; error string when invalid. */
function validateRagTopK(r: Record<string, unknown>, out: RagExtensionField): string | null {
  if (!("topK" in r)) return null;
  const tk = r["topK"];
  if (typeof tk !== "number" || !Number.isInteger(tk) || tk <= 0) {
    return "rag.topK must be a positive integer";
  }
  out.topK = tk;
  return null;
}

/** Validate + copy an optional string field; error string when invalid. */
function validateRagStringField(
  r: Record<string, unknown>,
  out: RagExtensionField,
  key: "collection" | "system_prompt_prefix",
): string | null {
  if (!(key in r) || r[key] === undefined) return null;
  const v = r[key];
  if (typeof v !== "string") return `rag.${key} must be a string`;
  if (key === "collection") {
    out.collection = v;
  } else {
    out.system_prompt_prefix = v;
  }
  return null;
}

function validateMessages(raw: unknown): ChatMessage[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ChatMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") return null;
    const mm = m as Record<string, unknown>;
    if (typeof mm["role"] !== "string") return null;
    const content = mm["content"];
    if (typeof content !== "string" && !Array.isArray(content) && content !== null) {
      return null;
    }
    out.push({ role: mm["role"], content: content as ChatMessage["content"] });
  }
  return out;
}

type RagChatCaller = NonNullable<RagChatEndpointContext["caller"]>;

interface ForwardFields {
  maxTokens: number | undefined;
  temperature: number | undefined;
  providerOptions: Record<string, unknown> | undefined;
}

/** Validate the optional OpenAI forwarding fields we pass through. */
function validateForwardFields(
  body: RagChatRequestBody,
): { ok: true; fields: ForwardFields } | { ok: false; response: Response } {
  let maxTokens: number | undefined;
  if (body.max_tokens !== undefined) {
    if (
      typeof body.max_tokens !== "number" ||
      !Number.isInteger(body.max_tokens) ||
      body.max_tokens <= 0
    ) {
      return {
        ok: false,
        response: jsonError(400, "max_tokens must be a positive integer", "invalid_request_error"),
      };
    }
    maxTokens = body.max_tokens;
  }
  let temperature: number | undefined;
  if (body.temperature !== undefined) {
    if (typeof body.temperature !== "number" || !Number.isFinite(body.temperature)) {
      return {
        ok: false,
        response: jsonError(400, "temperature must be a finite number", "invalid_request_error"),
      };
    }
    temperature = body.temperature;
  }
  let providerOptions: Record<string, unknown> | undefined;
  if (body.providerOptions !== undefined) {
    if (
      !body.providerOptions ||
      typeof body.providerOptions !== "object" ||
      Array.isArray(body.providerOptions)
    ) {
      return {
        ok: false,
        response: jsonError(400, "providerOptions must be an object", "invalid_request_error"),
      };
    }
    providerOptions = body.providerOptions as Record<string, unknown>;
  }
  return { ok: true, fields: { maxTokens, temperature, providerOptions } };
}

/**
 * Run the optional retrieval leg: validate the `rag` field, query the
 * rag node with the last user message, and prepend the synthesized
 * system message to the forwarded conversation.
 */
async function runRagRetrieval(
  rawRag: unknown,
  messages: ChatMessage[],
  caller: RagChatCaller,
  log: (line: string) => void,
): Promise<
  | { ok: true; retrievedCount: number; augmentedMessages: ChatMessage[] }
  | { ok: false; response: Response }
> {
  const parsed = parseRagField(rawRag);
  if (!parsed.ok) {
    return { ok: false, response: jsonError(400, parsed.error, "invalid_request_error") };
  }
  const rag = parsed.rag;
  const query = lastUserMessageContent(messages);
  if (query === null) {
    return {
      ok: false,
      response: jsonError(
        400,
        "no user message found in messages (rag retrieval needs a user query)",
        "invalid_request_error",
      ),
    };
  }
  const topK = rag.topK ?? DEFAULT_TOP_K;
  const ragInput: RagSearchInput = {
    node: rag.node,
    query,
    topK,
  };
  if (rag.collection !== undefined) ragInput.collection = rag.collection;

  const started = Date.now();
  let retrieval: RagSearchResponse;
  try {
    retrieval = await caller.ragSearch(ragInput);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Deliberately vague — retrieval errors are operator-ops concerns,
    // not client ones. The underlying message is surfaced but the
    // HTTP code is a stable 502.
    log(
      JSON.stringify({
        evt: "rag_chat_retrieval_error",
        node: rag.node,
        topK,
        elapsed_ms: Date.now() - started,
        error: msg,
      }),
    );
    return { ok: false, response: jsonError(502, `retrieval failed: ${msg}`, "rag_error") };
  }
  const retrievedCount = retrieval.results.length;
  log(
    JSON.stringify({
      evt: "rag_chat_retrieval_ok",
      node: rag.node,
      topK,
      received: retrievedCount,
      elapsed_ms: Date.now() - started,
    }),
  );

  const prefix = rag.system_prompt_prefix ?? DEFAULT_SYSTEM_PROMPT_PREFIX;
  const systemMessage: ChatMessage = {
    role: "system",
    content: buildRagSystemMessage(retrieval.results, prefix),
  };
  // Our system message goes first so caller-supplied system messages
  // (if any) are honored afterward but visibly contextualized with
  // the retrieved docs first.
  return { ok: true, retrievedCount, augmentedMessages: [systemMessage, ...messages] };
}

/** Forward the (possibly augmented) chat through `chatComplete`. */
async function forwardChat(
  caller: RagChatCaller,
  via: string,
  chatRequest: ChatCompleteInput["request"],
): Promise<{ ok: true; result: unknown } | { ok: false; response: Response }> {
  try {
    const result = await caller.chatComplete({ node: via, request: chatRequest });
    return { ok: true, result };
  } catch (err) {
    // Preserve upstream status + body verbatim when it's a TRPCError
    // (the chatComplete procedure throws TRPCError with a mapped code).
    if (err instanceof TRPCError) {
      const status = getHTTPStatusCodeFromError(err);
      return {
        ok: false,
        response: new Response(
          JSON.stringify({
            error: {
              message: err.message,
              type: "upstream_error",
              code: err.code,
            },
          }),
          {
            status,
            headers: { "content-type": "application/json" },
          },
        ),
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: {
            message: `chat failed: ${msg}`,
            type: "upstream_error",
          },
        }),
        {
          status: 502,
          headers: { "content-type": "application/json" },
        },
      ),
    };
  }
}

/**
 * Handle a `POST /v1/chat/completions` request with optional RAG
 * augmentation. The caller (serve.ts) is responsible for:
 *   - bearer-token auth (already verified)
 *   - routing only POST requests at /v1/chat/completions here
 *
 * Returns a Response. Never throws on caller input — every rejection
 * path resolves with an appropriate HTTP status + JSON error body.
 */
export async function handleRagChatCompletions(
  req: Request,
  ctx: RagChatEndpointContext,
): Promise<Response> {
  const log =
    ctx.log ??
    ((line): void => {
      console.error(line);
    });

  // Read the body once. We may need to replay it to the fallback
  // when neither `rag` nor `via` are present.
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const { bodyText, body } = parsed;

  const hasRag = "rag" in body && body.rag !== undefined && body.rag !== null;
  const hasVia = "via" in body && body.via !== undefined && body.via !== null;

  // Plain OpenAI request — fall through to the legacy openai-proxy
  // path so existing callers (plain SDKs, smoke tests) keep working.
  if (!hasRag && !hasVia) {
    return await dispatchPlainOpenAiRequest(req, bodyText, ctx);
  }

  // From here on the request uses the extension — `via` is mandatory.
  const core = validateExtensionRequest(body);
  if (!core.ok) return core.response;
  const { via, model, messages } = core;

  const fields = validateForwardFields(body);
  if (!fields.ok) return fields.response;

  const caller = resolveCaller(ctx);

  // ---- retrieval (optional) --------------------------------------------
  let retrievedCount = 0;
  let augmentedMessages: ChatMessage[] = messages;
  if (hasRag) {
    const retrieved = await runRagRetrieval(body.rag, messages, caller, log);
    if (!retrieved.ok) return retrieved.response;
    retrievedCount = retrieved.retrievedCount;
    augmentedMessages = retrieved.augmentedMessages;
  }

  // ---- chat forwarding --------------------------------------------------
  const chatRequest = buildChatRequest(model, augmentedMessages, fields.fields);
  const forwarded = await forwardChat(caller, via, chatRequest);
  if (!forwarded.ok) return forwarded.response;
  const chatResult: unknown = forwarded.result;

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (hasRag) {
    headers["x-llamactl-rag"] = `retrieved=${String(retrievedCount)}`;
  }
  return new Response(JSON.stringify(chatResult), {
    status: 200,
    headers,
  });
}

/** Read + JSON-decode the request body, keeping the raw text for replay. */
async function readJsonBody(
  req: Request,
): Promise<
  { ok: true; bodyText: string; body: RagChatRequestBody } | { ok: false; response: Response }
> {
  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch (err) {
    return {
      ok: false,
      response: jsonError(
        400,
        `failed to read request body: ${(err as Error).message}`,
        "invalid_request_error",
      ),
    };
  }
  try {
    return { ok: true, bodyText, body: JSON.parse(bodyText) as RagChatRequestBody };
  } catch (err) {
    return {
      ok: false,
      response: jsonError(
        400,
        `invalid JSON body: ${(err as Error).message}`,
        "invalid_request_error",
      ),
    };
  }
}

/** Route a plain OpenAI request (no `rag` / `via`) to the legacy fallback. */
async function dispatchPlainOpenAiRequest(
  req: Request,
  bodyText: string,
  ctx: RagChatEndpointContext,
): Promise<Response> {
  if (ctx.fallback) {
    // Rebuild a fresh Request so the fallback can .text() / .json()
    // the body itself (the original Request's body is already
    // consumed above).
    const forwarded = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: bodyText,
    });
    return await ctx.fallback(forwarded);
  }
  return jsonError(
    400,
    "request must include `via` (node name to route chat through) or the `rag` extension",
    "invalid_request_error",
  );
}

/** Validate the mandatory extension fields: `via`, `model`, `messages`. */
function validateExtensionRequest(
  body: RagChatRequestBody,
):
  | { ok: true; via: string; model: string; messages: ChatMessage[] }
  | { ok: false; response: Response } {
  if (typeof body.via !== "string" || body.via.trim() === "") {
    return {
      ok: false,
      response: jsonError(
        400,
        "via is required — name the llamactl node to route chat through (gateway / agent / cloud)",
        "invalid_request_error",
      ),
    };
  }
  if (typeof body.model !== "string" || body.model === "") {
    return {
      ok: false,
      response: jsonError(400, "model is required (string)", "invalid_request_error"),
    };
  }
  const messages = validateMessages(body.messages);
  if (!messages || messages.length === 0) {
    return {
      ok: false,
      response: jsonError(
        400,
        "messages must be a non-empty array of {role, content}",
        "invalid_request_error",
      ),
    };
  }
  return { ok: true, via: body.via, model: body.model, messages };
}

/**
 * Resolve the caller — tests inject a fake; production builds one
 * from the shared appRouter.
 */
function resolveCaller(ctx: RagChatEndpointContext): RagChatCaller {
  if (ctx.caller) return ctx.caller;
  const c = ctx.appRouter.createCaller({}) as {
    ragSearch: (input: RagSearchInput) => Promise<RagSearchResponse>;
    chatComplete: (input: ChatCompleteInput) => Promise<unknown>;
  };
  return { ragSearch: c.ragSearch, chatComplete: c.chatComplete };
}

/** Assemble the forwarded OpenAI request from the validated fields. */
function buildChatRequest(
  model: string,
  messages: ChatMessage[],
  fields: ForwardFields,
): ChatCompleteInput["request"] {
  const chatRequest: ChatCompleteInput["request"] = { model, messages };
  if (fields.maxTokens !== undefined) chatRequest.max_tokens = fields.maxTokens;
  if (fields.temperature !== undefined) chatRequest.temperature = fields.temperature;
  if (fields.providerOptions !== undefined) chatRequest.providerOptions = fields.providerOptions;
  return chatRequest;
}
