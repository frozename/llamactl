import type { LocalEngineRequest } from "@llamactl/core/residency/engine-forwarder";

export type OwnerRequestBounds = {
  maxQueuedBytes: number;
  maxCompletionTokens?: number | undefined;
  maxContextTokens?: number | undefined;
};

type BoundRequest =
  | { bytes: number; promptTokens: number; completionTokens: number; body?: string }
  | {
      code: "InvalidRequest" | "ContextLimitExceeded" | "ContextUnverified" | "QueueBytesExceeded";
    };

const COMPLETION_FIELDS = ["max_tokens", "max_completion_tokens", "n_predict"] as const;
const SINGLE_COMPLETION_FIELDS = ["n", "best_of", "n_cmpl"] as const;
const PRETOKENIZED_FIELDS = new Set([
  "model",
  "prompt",
  "stream",
  "stream_options",
  ...COMPLETION_FIELDS,
  ...SINGLE_COMPLETION_FIELDS,
]);

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function positiveTokenCap(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isTokenId(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0x7fff_ffff;
}

function explicitCompletionTokens(body: Record<string, unknown>): number | undefined {
  const [field, extra] = COMPLETION_FIELDS.filter((key) => key in body);
  if (field === undefined || extra !== undefined) return undefined;
  if (SINGLE_COMPLETION_FIELDS.some((key) => key in body && body[key] !== 1)) return undefined;
  const tokens = body[field];
  return positiveTokenCap(tokens) ? tokens : undefined;
}

function isFlatTokenPrompt(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every(isTokenId);
}

function promptTokenCount(
  request: LocalEngineRequest,
  path: string,
  body: Record<string, unknown>,
): number | undefined {
  const prompt = body["prompt"];
  // A flat llama.cpp completion token sequence already includes its prompt
  // special tokens. Chat templates, mixed text and media can expand input.
  if (
    request.pretokenizedCompletion !== true ||
    path !== "/v1/completions" ||
    !isFlatTokenPrompt(prompt) ||
    Object.keys(body).some((field) => !PRETOKENIZED_FIELDS.has(field))
  )
    return undefined;
  return prompt.length;
}

export function boundOwnerRequest(
  request: LocalEngineRequest,
  limits: OwnerRequestBounds,
): BoundRequest {
  if (request.body === null) return { code: "InvalidRequest" };
  const bytes = Buffer.byteLength(request.body);
  if (bytes > limits.maxQueuedBytes) return { code: "QueueBytesExceeded" };
  const zero = { bytes, promptTokens: 0, completionTokens: 0 };
  if (limits.maxCompletionTokens === undefined && limits.maxContextTokens === undefined)
    return zero;
  const { pathname } = new URL(request.target);
  if (pathname !== "/v1/chat/completions" && pathname !== "/v1/completions") {
    return limits.maxContextTokens === undefined ? zero : { code: "ContextUnverified" };
  }

  return boundGeneration(request, request.body, pathname, bytes, limits);
}

function boundGeneration(
  request: LocalEngineRequest,
  text: string,
  pathname: string,
  bytes: number,
  limits: OwnerRequestBounds,
): BoundRequest {
  const body = parseObject(text);
  if (body === null) return { code: "InvalidRequest" };
  const prompt = body["prompt"];
  if (pathname === "/v1/completions" && typeof prompt !== "string" && !isFlatTokenPrompt(prompt)) {
    return { code: limits.maxContextTokens === undefined ? "InvalidRequest" : "ContextUnverified" };
  }
  const completionTokens = explicitCompletionTokens(body);
  if (completionTokens === undefined) return { code: "InvalidRequest" };
  if (completionTokens > (limits.maxCompletionTokens ?? Number.MAX_SAFE_INTEGER)) {
    return { code: "ContextLimitExceeded" };
  }
  const promptTokens =
    limits.maxContextTokens === undefined ? 0 : promptTokenCount(request, pathname, body);
  if (promptTokens === undefined) return { code: "ContextUnverified" };
  if (promptTokens + completionTokens > (limits.maxContextTokens ?? Number.MAX_SAFE_INTEGER)) {
    return { code: "ContextLimitExceeded" };
  }

  // Execute the same JSON we validated. One effective max_tokens field also
  // avoids relying on an engine's precedence for competing aliases.
  delete body["max_completion_tokens"];
  delete body["n_predict"];
  body["max_tokens"] = completionTokens;
  const normalized = JSON.stringify(body);
  const effectiveBytes = Math.max(bytes, Buffer.byteLength(normalized));
  if (effectiveBytes > limits.maxQueuedBytes) return { code: "QueueBytesExceeded" };
  return { bytes: effectiveBytes, promptTokens, completionTokens, body: normalized };
}
