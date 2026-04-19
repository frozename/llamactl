import { z } from 'zod';

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

export const TunnelHelloSchema = z.object({
  type: z.literal('hello'),
  bearer: z.string().min(1),
  nodeName: z.string().min(1),
});
export type TunnelHello = z.infer<typeof TunnelHelloSchema>;

export const TunnelHelloAckSchema = z.object({
  type: z.literal('hello-ack'),
  serverTime: z.string(),
});
export type TunnelHelloAck = z.infer<typeof TunnelHelloAckSchema>;

export const TunnelReqSchema = z.object({
  type: z.literal('req'),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type TunnelReq = z.infer<typeof TunnelReqSchema>;

export const TunnelResSchema = z.object({
  type: z.literal('res'),
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
  type: z.literal('ping'),
  nonce: z.string().min(1),
});
export const TunnelPongSchema = z.object({
  type: z.literal('pong'),
  nonce: z.string().min(1),
});
export type TunnelPing = z.infer<typeof TunnelPingSchema>;
export type TunnelPong = z.infer<typeof TunnelPongSchema>;

export const TunnelMessageSchema = z.discriminatedUnion('type', [
  TunnelHelloSchema,
  TunnelHelloAckSchema,
  TunnelReqSchema,
  TunnelResSchema,
  TunnelPingSchema,
  TunnelPongSchema,
]);
export type TunnelMessage = z.infer<typeof TunnelMessageSchema>;

export function parseTunnelMessage(raw: string): TunnelMessage | null {
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
