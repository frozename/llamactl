import { randomUUID } from "node:crypto";

import { configuredCapture, pruneCaptures, storeCapture } from "./store.js";

const BYTE_CAP = 64 * 1024;
const paths = new Set(["/v1/chat/completions", "/v1/completions", "/v1/responses", "/v1/messages"]);
const secretKey =
  /^(?:authorization|cookie|set-cookie|x-api-key|api[_-]?key|(?:.*[_-])?(?:password|secret|token)|accessToken|refreshToken|clientSecret)$/i;
const bearer = /\bBearer\s+[^\s"'\\]+/gi;
const userInfo = /(?<=:\/\/)[^\s/?#@]*@/g;
let reaper: ReturnType<typeof setInterval> | undefined;

class Prefix {
  private readonly buffer = new Uint8Array(BYTE_CAP);
  private used = 0;
  truncated = false;

  append(value: Uint8Array): void {
    const prefix = value.subarray(0, BYTE_CAP - this.used);
    this.buffer.set(prefix, this.used);
    this.used += prefix.length;
    this.truncated ||= prefix.length < value.length;
  }

  text(): string {
    return new TextDecoder().decode(this.buffer.subarray(0, this.used));
  }
}

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replaceAll(bearer, "Bearer [redacted]").replaceAll(userInfo, "");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        secretKey.test(key) ? "[redacted]" : redact(inner),
      ]),
    );
  }
  return value;
}

function json(text: string): unknown {
  try {
    return redact(JSON.parse(text));
  } catch {
    return null;
  }
}

interface StreamEvent {
  id?: unknown;
  type?: string;
  choices?: {
    delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
    text?: unknown;
    finish_reason?: unknown;
  }[];
  delta?: { type?: string; text?: unknown; thinking?: unknown } | string;
  usage?: unknown;
  response?: { usage?: unknown; id?: unknown };
  error?: unknown;
}

function streamEvent(frame: string): StreamEvent | null {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function streamOutput(event: StreamEvent): { reply: string; reasoning: string } {
  const choice = event.choices?.[0];
  if (choice)
    return {
      reply: text(choice.delta?.content ?? choice.text),
      reasoning: text(choice.delta?.reasoning_content ?? choice.delta?.reasoning),
    };
  if (event.type === "response.output_text.delta")
    return { reply: text(event.delta), reasoning: "" };
  if (event.type === "response.reasoning_summary_text.delta")
    return { reply: "", reasoning: text(event.delta) };
  const delta = typeof event.delta === "object" ? event.delta : undefined;
  return { reply: text(delta?.text), reasoning: text(delta?.thinking) };
}

function parseStream(prefix: Prefix): unknown {
  let reply = "";
  let reasoning = "";
  let id: unknown;
  let usage: unknown;
  let finishReason: unknown;
  let error: unknown;
  for (const frame of prefix.text().split(/\r?\n\r?\n/)) {
    const event = streamEvent(frame);
    if (event === null) continue;
    const delta = streamOutput(event);
    reply += delta.reply;
    reasoning += delta.reasoning;
    id = event.id ?? event.response?.id ?? id;
    usage = event.usage ?? event.response?.usage ?? usage;
    finishReason = event.choices?.[0]?.finish_reason ?? finishReason;
    error = event.error ?? error;
  }
  // Redact the reassembled text after joining frames so split credentials
  // get the same treatment as credentials sent in a single frame.
  return redact({ id, reply, reasoning, usage, finishReason, error });
}

function parseResponse(prefix: Prefix, type: string | null): unknown {
  if (type?.includes("text/event-stream")) return parseStream(prefix);
  return type?.includes("json") ? json(prefix.text()) : null;
}

async function readRequestPrefix(
  body: ReturnType<Request["clone"]>["body"],
  prefix: Prefix,
): Promise<void> {
  const reader = body?.getReader();
  if (!reader) return;
  try {
    while (!prefix.truncated) {
      const chunk = await reader.read();
      if (chunk.done) return;
      prefix.append(chunk.value);
    }
  } catch {
    prefix.truncated = true;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function scheduleCaptureExpiry(): void {
  if (reaper !== undefined || configuredCapture() === undefined) return;
  reaper = setInterval(() => {
    const path = configuredCapture();
    if (!path) return;
    try {
      pruneCaptures(path);
    } catch {
      // Capture is optional, including while the store is locked or unavailable.
    }
  }, 30_000);
  reaper.unref();
}

interface Recording {
  started: number;
  finish: (
    response: Response,
    prefix: Prefix,
    firstByteMs: number | null,
    cancelled: boolean,
  ) => void;
}

function createRecording(req: Request, path: string, store: string): Recording {
  const at = Date.now();
  const started = performance.now();
  const requestPrefix = new Prefix();
  const requestReady = readRequestPrefix(req.clone().body, requestPrefix);
  let finished = false;
  return {
    started,
    finish(response, prefix, firstByteMs, cancelled): void {
      if (finished) return;
      finished = true;
      const durationMs = Math.round(performance.now() - started);
      void requestReady
        .then(() => {
          const request = json(requestPrefix.text());
          const candidate = (request as { model?: unknown } | null)?.model;
          storeCapture(store, {
            id: randomUUID(),
            at,
            path,
            model: typeof candidate === "string" ? candidate.slice(0, 512) : null,
            status: response.status,
            durationMs,
            firstByteMs,
            cancelled,
            truncated: requestPrefix.truncated || prefix.truncated,
            request,
            response: parseResponse(prefix, response.headers.get("content-type")),
          });
        })
        .catch(() => undefined);
    },
  };
}

function recordResponse(response: Response, recording: Recording): Response {
  const prefix = new Prefix();
  if (response.body === null) {
    recording.finish(response, prefix, null, false);
    return response;
  }
  const reader = response.body.getReader();
  let firstByte: number | null = null;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller): Promise<void> {
        try {
          const next = await reader.read();
          if (next.done) {
            recording.finish(response, prefix, firstByte, false);
            controller.close();
            return;
          }
          firstByte ??= Math.round(performance.now() - recording.started);
          prefix.append(next.value);
          controller.enqueue(next.value);
        } catch (error) {
          recording.finish(response, prefix, firstByte, true);
          controller.error(error);
        }
      },
      async cancel(reason): Promise<void> {
        recording.finish(response, prefix, firstByte, true);
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function captureInference(
  req: Request,
  path: string,
  invoke: () => Response | Promise<Response>,
): Promise<Response> {
  const store = configuredCapture();
  if (!store || req.method !== "POST" || !paths.has(path)) return await invoke();
  let recording: Recording;
  try {
    recording = createRecording(req, path, store);
    scheduleCaptureExpiry();
  } catch {
    return await invoke();
  }
  return recordResponse(await invoke(), recording);
}
