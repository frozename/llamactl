import { z } from "zod";

/**
 * Wire schema for the reverse-tunnel (I.3).
 *
 * Minimal request/reply frame over a single WebSocket. Intentionally
 * simpler than tRPC-over-WS for the transport proof — the next phase
 * (I.3.2) bolts correlation-id heartbeats + reconnect on top; I.3.3
 * lifts tRPC requests into this envelope.
 *
 * Numeric codes we send in WebSocket `close()` calls (4xxx is the
 * "application" band per RFC 6455; LBs and proxies pass them
 * through unchanged):
 *   4401 — bearer missing or invalid
 *   4400 — malformed hello frame
 *   4408 — hello not received within timeout
 */
export const TUNNEL_CLOSE_UNAUTHORIZED = 4401;
export const TUNNEL_CLOSE_BAD_HELLO = 4400;
export const TUNNEL_CLOSE_HELLO_TIMEOUT = 4408;

/**
 * Frame and queue bounds (P4.1 X3). A frame above
 * TUNNEL_MAX_FRAME_BYTES is malformed; the cap matches Bun's default
 * WebSocket maxPayloadLength, so nothing larger crossed the wire before.
 * Subscription streams are tighter: one event may carry at most
 * `maxFrameBytes`, and a consumer may fall at most `maxQueuedBytes`
 * behind its producer. Past either cap the stream ends with a typed
 * `stream-overflow` error and its producer is cancelled; events are never
 * dropped silently. 1 MiB per event admits a large single-chunk tool-call
 * argument; 4 MiB of backlog is minutes of token output, so only a stalled
 * consumer overflows.
 */
export const TUNNEL_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export interface StreamLimits {
  maxFrameBytes: number;
  maxQueuedBytes: number;
}

export const DEFAULT_STREAM_LIMITS: Readonly<StreamLimits> = Object.freeze({
  maxFrameBytes: 1024 * 1024,
  maxQueuedBytes: 4 * 1024 * 1024,
});

/** `stream-done` error code: a frame or queued-byte cap was exceeded. */
export const TUNNEL_STREAM_OVERFLOW = "stream-overflow";

/** `stream-done` error code acknowledging a `stream-cancel`. */
export const TUNNEL_STREAM_CANCELLED = "stream-cancelled";

export function frameBytes(raw: string): number {
  return Buffer.byteLength(raw, "utf8");
}

export const TunnelHelloSchema = z.object({
  type: z.literal("hello"),
  bearer: z.string().min(1),
  nodeName: z.string().min(1),
});
export type TunnelHello = z.infer<typeof TunnelHelloSchema>;

export const TunnelHelloAckSchema = z.object({
  type: z.literal("hello-ack"),
  serverTime: z.string(),
});
export type TunnelHelloAck = z.infer<typeof TunnelHelloAckSchema>;

export const TunnelReqSchema = z.object({
  type: z.literal("req"),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type TunnelReq = z.infer<typeof TunnelReqSchema>;

export const TunnelResSchema = z.object({
  type: z.literal("res"),
  id: z.string().min(1),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});
export type TunnelRes = z.infer<typeof TunnelResSchema>;

export const TunnelPingSchema = z.object({
  type: z.literal("ping"),
  nonce: z.string().min(1),
});
export const TunnelPongSchema = z.object({
  type: z.literal("pong"),
  nonce: z.string().min(1),
});
export type TunnelPing = z.infer<typeof TunnelPingSchema>;
export type TunnelPong = z.infer<typeof TunnelPongSchema>;

/**
 * Streaming frames for subscriptions (Slice B / I.3.4). A subscription
 * req frame (`params.type === 'subscription'`) opens a stream; the
 * node side ships zero or more `stream-event` frames with a
 * monotonic `index` per subscription `id`, then exactly one
 * `stream-done`. The central → node `stream-cancel` frame tells the
 * node to unsubscribe early (SSE client disconnect propagation).
 *
 * `id` collates with the originating `req.id`, but subscription
 * state lives in a separate map from req/res pending so a late
 * stream-event never resolves a req/res promise.
 */
export const TunnelStreamEventSchema = z.object({
  type: z.literal("stream-event"),
  id: z.string().min(1),
  index: z.number().int().min(0),
  data: z.unknown(),
});
export type TunnelStreamEvent = z.infer<typeof TunnelStreamEventSchema>;

export const TunnelStreamDoneSchema = z.object({
  type: z.literal("stream-done"),
  id: z.string().min(1),
  ok: z.boolean(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});
export type TunnelStreamDone = z.infer<typeof TunnelStreamDoneSchema>;

export const TunnelStreamCancelSchema = z.object({
  type: z.literal("stream-cancel"),
  id: z.string().min(1),
});
export type TunnelStreamCancel = z.infer<typeof TunnelStreamCancelSchema>;

/**
 * The node acknowledges a `stream-cancel` with the stream's one
 * `stream-done`, typed `stream-cancelled` when the cancel stopped it. The
 * acknowledgement rides `stream-done` because that is the only terminal
 * frame a node ships. A `stream-done` of any other shape means the stream
 * had already ended; no acknowledgement before the link drops is `unknown`.
 */
export const TunnelStreamCancelAckSchema = TunnelStreamDoneSchema.extend({
  ok: z.literal(false),
  error: z.object({ code: z.literal(TUNNEL_STREAM_CANCELLED), message: z.string() }),
});
export type TunnelStreamCancelAck = z.infer<typeof TunnelStreamCancelAckSchema>;

export type TunnelCancelOutcome = "cancelled" | "already-terminal" | "unknown";

export function cancelOutcomeOf(done: TunnelStreamDone): Exclude<TunnelCancelOutcome, "unknown"> {
  return TunnelStreamCancelAckSchema.safeParse(done).success ? "cancelled" : "already-terminal";
}

export const TunnelMessageSchema = z.discriminatedUnion("type", [
  TunnelHelloSchema,
  TunnelHelloAckSchema,
  TunnelReqSchema,
  TunnelResSchema,
  TunnelPingSchema,
  TunnelPongSchema,
  TunnelStreamEventSchema,
  TunnelStreamDoneSchema,
  TunnelStreamCancelSchema,
]);
export type TunnelMessage = z.infer<typeof TunnelMessageSchema>;

export function parseTunnelMessage(raw: string): TunnelMessage | null {
  if (frameBytes(raw) > TUNNEL_MAX_FRAME_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = TunnelMessageSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export function encodeTunnelMessage(msg: TunnelMessage): string {
  return JSON.stringify(msg);
}
