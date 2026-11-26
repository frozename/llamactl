import { consoleSessionStore } from "./session-store";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatChunk {
  choices?: { delta?: { content?: unknown }; finish_reason?: string | null }[];
  error?: unknown;
}

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  chat_request_too_large: "This conversation is too large. Start a new chat.",
  model_busy: "The model is busy. Try again in a moment.",
  model_unavailable: "The model is no longer available on this node.",
  model_rejected_chat:
    "The model rejected this conversation. Try a shorter message or another model.",
};

async function chatFetch(node: string, resource: string, init: RequestInit): Promise<Response> {
  const response = await fetch(`/api/n/${encodeURIComponent(node)}/chat/${resource}`, init);
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
  onDelta: (text: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
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
        const completed = applyChatEvent(event, onDelta);
        finished ||= completed;
      }
    }
    if (!finished) throw new Error("The connection closed before the reply finished.");
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function applyChatEvent(event: ChatChunk | null, onDelta: (text: string) => void): boolean {
  if (event?.error !== undefined) throw new Error("The model stopped with an error.");
  const choice = event?.choices?.[0];
  const text = choice?.delta?.content;
  if (typeof text === "string") onDelta(text);
  return Boolean(choice?.finish_reason);
}

export async function streamChat(
  node: string,
  model: string,
  messages: readonly ChatMessage[],
  signal: AbortSignal,
  onDelta: (text: string) => void,
): Promise<void> {
  const response = await chatFetch(node, "completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages }),
    signal,
  });
  if (response.body === null) throw new Error("The model returned an empty stream.");
  await readChatStream(response.body, onDelta);
}
