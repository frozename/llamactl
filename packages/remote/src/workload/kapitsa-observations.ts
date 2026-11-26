import type { SlotProgress } from "@llamactl/fleet-supervisor";

import { join } from "node:path";
import { z } from "zod";

import type { InferenceRun, ModelCapacity } from "./inference-observations.js";

const count = z.number().int().nonnegative();
const elapsed = z.number().nonnegative();
const requestId = z.string().regex(/^req-\d{1,15}$/);
const Status = z.object({
  protocol: z.literal(1),
  config: z.object({ port: count }),
  model: z.object({ id: z.string(), slots: count.positive(), context_length: count.positive() }),
  run_id: z.string().regex(/^[a-f0-9]{16}$/),
  last_event_id: z.string().max(40),
  requests: z
    .array(
      z.object({
        request_id: requestId,
        phase: z.enum(["waiting", "prefill", "writing"]),
        completion_tokens: count,
      }),
    )
    .max(1024),
  engine: z
    .object({
      slots: z
        .array(
          z.object({
            index: count,
            busy: z.boolean(),
            tokens: count,
            request_id: requestId.optional(),
          }),
        )
        .max(128),
      memory: z.object({ allocated_bytes: count, kv_bytes: count }),
    })
    .optional(),
});

const Completion = z.object({
  request_id: requestId,
  finish_reason: z.enum(["stop", "length", "tool_calls", "cancelled", "error"]),
  prompt_tokens: count,
  cached_tokens: count,
  completion_tokens: count,
  queue_ms: elapsed,
  prefill_ms: elapsed,
  decode_ms: elapsed,
  tokens_per_second: elapsed,
  prefill_tokens_per_second: elapsed,
});

interface KapitsaStatus {
  runId: string;
  eventSequence: number;
  capacity: ModelCapacity;
  slots: SlotProgress[] | null;
  waiting: number;
  allocatedBytes: number | null;
  kvBytes: number | null;
}

export interface KapitsaObservation extends KapitsaStatus {
  runs: InferenceRun[];
}

export function parseKapitsaStatus(
  value: unknown,
  port: number,
  model: string,
): KapitsaStatus | null {
  const parsed = Status.safeParse(value);
  if (!parsed.success || parsed.data.config.port !== port || parsed.data.model.id !== model)
    return null;
  const data = parsed.data;
  const [runId, sequence, extra] = data.last_event_id.split(".");
  const eventSequence = Number(sequence);
  if (
    runId !== data.run_id ||
    extra !== undefined ||
    !Number.isSafeInteger(eventSequence) ||
    eventSequence < 1
  ) {
    return null;
  }
  const requests = new Map(data.requests.map((row) => [row.request_id, row]));
  return {
    runId,
    eventSequence,
    capacity: { slots: data.model.slots, context: data.model.context_length },
    slots:
      data.engine?.slots.map(
        (slot): SlotProgress => ({
          id: slot.index,
          state: null,
          processing: slot.busy,
          nPast: slot.tokens,
          nDecoded:
            slot.request_id === undefined
              ? null
              : (requests.get(slot.request_id)?.completion_tokens ?? null),
        }),
      ) ?? null,
    waiting: data.requests.filter((request) => request.phase === "waiting").length,
    allocatedBytes: data.engine?.memory.allocated_bytes ?? null,
    kvBytes: data.engine?.memory.kv_bytes ?? null,
  };
}

export function parseKapitsaCompletion(json: string): InferenceRun | null {
  try {
    const parsed = Completion.safeParse(JSON.parse(json));
    if (!parsed.success) return null;
    const data = parsed.data;
    const completed = data.finish_reason !== "cancelled" && data.finish_reason !== "error";
    return {
      id: data.request_id,
      at: null,
      state: data.finish_reason === "cancelled" ? "cancelled" : completed ? "completed" : "failed",
      promptN: data.prompt_tokens,
      cachedN: data.cached_tokens,
      generatedN: data.completion_tokens,
      prefillTps: data.prompt_tokens > data.cached_tokens ? data.prefill_tokens_per_second : null,
      decodeTps: data.completion_tokens > 1 ? data.tokens_per_second : null,
      ttftMs: null,
      // The last prefill pass samples the first token. Engine timing omits
      // input processing outside prefill and transport to the client.
      engineFirstMs:
        completed && data.completion_tokens > 0 ? data.queue_ms + data.prefill_ms : null,
      queueMs: data.queue_ms,
      durationMs: null,
    };
  } catch {
    return null;
  }
}

const MAX_EVENT_BYTES = 512 * 1024;
const REPLAY_EVENTS = 128;

function unixGet(socket: string, path: "/status" | "/events", cursor?: string): Promise<Response> {
  return fetch(`http://localhost${path}`, {
    unix: socket,
    redirect: "error",
    signal: AbortSignal.timeout(800),
    ...(cursor === undefined ? {} : { headers: { "Last-Event-ID": cursor } }),
  } as RequestInit);
}

function frameLines(frame: string): Map<string, string> {
  return new Map(
    frame.split("\n").flatMap((line) => {
      const colon = line.indexOf(":");
      return colon > 0 ? [[line.slice(0, colon), line.slice(colon + 1).trimStart()]] : [];
    }),
  );
}

class KapitsaReplay {
  readonly runs: InferenceRun[] = [];
  private pending = "";

  constructor(private readonly status: KapitsaStatus) {}

  append(chunk: string): boolean {
    const frames = (this.pending + chunk).split("\n\n");
    this.pending = frames.pop() ?? "";
    return frames.every((frame) => this.appendFrame(frame));
  }

  private appendFrame(frame: string): boolean {
    const fields = frameLines(frame);
    if (fields.get("event") === "reset") return false;
    const id = fields.get("id")?.split(".");
    if (id?.[0] !== this.status.runId) return true;
    const seq = Number(id[1]);
    if (!Number.isSafeInteger(seq)) return true;
    if (seq > this.status.eventSequence) return false;
    if (fields.get("event") === "request_finished") {
      const run = parseKapitsaCompletion(fields.get("data") ?? "");
      if (run) this.runs.push(run);
    }
    return seq < this.status.eventSequence;
  }
}

async function replayCompletions(socket: string, status: KapitsaStatus): Promise<InferenceRun[]> {
  if (status.eventSequence <= 1) return [];
  const replay = new KapitsaReplay(status);
  const cursor = `${status.runId}.${String(Math.max(1, status.eventSequence - REPLAY_EVENTS))}`;
  try {
    const response = await unixGet(socket, "/events", cursor);
    if (response.body === null) return [];
    const reader = response.body.getReader();
    try {
      if (!response.ok) return [];
      const decoder = new TextDecoder();
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_EVENT_BYTES || !replay.append(decoder.decode(value, { stream: true })))
          break;
      }
    } finally {
      await reader.cancel();
    }
  } catch {
    // Keep complete frames already received if the control socket closes.
  }
  return replay.runs.reverse().slice(0, 50);
}

export async function readKapitsaObservation(
  directory: string,
  port: number,
  model: string,
): Promise<KapitsaObservation | null> {
  const socket = join(directory, ".kapitsa", "run", "default.sock");
  try {
    const response = await unixGet(socket, "/status");
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const status = parseKapitsaStatus(await response.json(), port, model);
    return status === null ? null : { ...status, runs: await replayCompletions(socket, status) };
  } catch {
    return null;
  }
}
