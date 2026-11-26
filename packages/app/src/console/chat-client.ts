import { consoleSessionStore } from "./session-store";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatChunk {
  choices?: {
    delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
    finish_reason?: string | null;
  }[];
  usage?: {
    completion_tokens?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
  timings?: { predicted_per_second?: unknown };
  error?: unknown;
}

export interface ChatProgress {
  reply: string;
  reasoning: string;
  outputTokens?: number;
  reasoningTokens?: number;
  rate?: { value: number; source: "engine" | "stream" };
}

interface ChatStreamState {
  progress: ChatProgress;
  firstTextAt?: number;
  lastTextAt?: number;
}

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  chat_request_too_large: "This conversation is too large. Start a new chat.",
  model_busy: "The model is busy. Try again in a moment.",
  model_unavailable: "The model is no longer available on this node.",
  model_rejected_chat:
    "The model rejected this conversation. Try a shorter message or another model.",
};

async function chatFetch(
  node: string,
  resource: string,
  init: RequestInit,
  onStatus?: (status: number) => void,
): Promise<Response> {
  const response = await fetch(`/api/n/${encodeURIComponent(node)}/chat/${resource}`, init);
  onStatus?.(response.status);
  if (response.ok) return response;
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (response.status === 401 && body?.error === "invalid_session") {
    consoleSessionStore.markInvalid();
  }
  throw new Error(
    ERROR_MESSAGES[body?.error ?? ""] ??
      (resource === "models"
        ? "Could not load models for this node."
        : "Could not reach the model."),
  );
}

export async function loadChatModels(node: string, signal: AbortSignal): Promise<string[]> {
  const response = await chatFetch(node, "models", { signal });
  const data = (await response.json()) as { models: string[] };
  return data.models;
}

function readChatFrame(frame: string): ChatChunk | "done" | null {
  const payload = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (payload === "[DONE]") return "done";
  if (!payload) return null;
  try {
    return JSON.parse(payload) as ChatChunk;
  } catch {
    throw new Error("The model sent an invalid stream frame.");
  }
}

async function readChatStream(
  stream: ReadableStream<Uint8Array>,
  onProgress: (progress: ChatProgress) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  const state: ChatStreamState = { progress: { reply: "", reasoning: "" } };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      if (buffer.length > 1024 * 1024) throw new Error("The model sent an oversized stream frame.");
      for (const frame of frames) {
        const event = readChatFrame(frame);
        if (event === "done") return;
        const completed = applyChatEvent(event, state, onProgress);
        finished ||= completed;
      }
    }
    if (!finished) throw new Error("The connection closed before the reply finished.");
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function nonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function appendText(
  state: ChatStreamState,
  delta: NonNullable<ChatChunk["choices"]>[number]["delta"],
): void {
  const text = delta?.content;
  const reasoning = delta?.reasoning_content ?? delta?.reasoning;
  const replyDelta = typeof text === "string" ? text : "";
  const reasoningDelta = typeof reasoning === "string" ? reasoning : "";
  if (!replyDelta && !reasoningDelta) return;
  state.progress.reply += replyDelta;
  state.progress.reasoning += reasoningDelta;
  state.lastTextAt = performance.now();
  state.firstTextAt ??= state.lastTextAt;
}

function applyUsage(state: ChatStreamState, event: ChatChunk): void {
  const { progress, firstTextAt, lastTextAt } = state;
  const output = nonnegative(event.usage?.completion_tokens);
  const reasoning = nonnegative(event.usage?.completion_tokens_details?.reasoning_tokens);
  if (output !== undefined) progress.outputTokens = output;
  if (reasoning !== undefined) progress.reasoningTokens = reasoning;
  const engineRate = nonnegative(event.timings?.predicted_per_second);
  if (engineRate !== undefined && engineRate > 0) {
    progress.rate = { value: engineRate, source: "engine" };
    return;
  }
  if (progress.rate?.source === "engine" || output === undefined || output < 2) return;
  const duration = (lastTextAt ?? 0) - (firstTextAt ?? 0);
  // A buffered response can deliver many tokens at once. A near-zero window
  // doesn't tell the browser anything about generation speed.
  if (duration >= 100) {
    progress.rate = { value: ((output - 1) * 1000) / duration, source: "stream" };
  }
}

function applyChatEvent(
  event: ChatChunk | null,
  state: ChatStreamState,
  onProgress: (progress: ChatProgress) => void,
): boolean {
  if (event === null) return false;
  if (event.error !== undefined) throw new Error("The model stopped with an error.");
  const choice = event.choices?.[0];
  appendText(state, choice?.delta);
  applyUsage(state, event);
  onProgress({ ...state.progress });
  return Boolean(choice?.finish_reason);
}

export async function streamChat(
  node: string,
  model: string,
  messages: readonly ChatMessage[],
  signal: AbortSignal,
  onProgress: (progress: ChatProgress) => void,
  onStatus?: (status: number) => void,
): Promise<void> {
  const response = await chatFetch(
    node,
    "completions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages }),
      signal,
    },
    onStatus,
  );
  if (response.body === null) throw new Error("The model returned an empty stream.");
  await readChatStream(response.body, onProgress);
}
