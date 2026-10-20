import { describe, expect, test } from "bun:test";

import { SERVICE_TOKEN_MAX_LENGTH } from "../src/server/auth.js";
import {
  cancelOutcomeOf,
  encodeTunnelMessage,
  frameBytes,
  INFERENCE_RPC_STREAM_LIMITS,
  parseTunnelMessage,
  streamLimitsFor,
  SUBSCRIPTION_STREAM_LIMITS,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_STREAM_CANCELLED,
  type TunnelMessage,
  TunnelMessageSchema,
  type TunnelStreamCancel,
  TunnelStreamCancelAckSchema,
  type TunnelStreamDone,
  type TunnelStreamEvent,
} from "../src/tunnel/messages.js";

/**
 * Wire-schema round-trip coverage for the streaming variants added in
 * Slice B. The three new frames ride inside the existing
 * discriminated-union `TunnelMessageSchema`, so parseTunnelMessage
 * must recognise them the same way as the six req/res frames.
 */
describe("tunnel message: streaming variants", () => {
  test("stream-event round-trips through parse/encode", () => {
    const msg: TunnelStreamEvent = {
      type: "stream-event",
      id: "sub-123",
      index: 0,
      data: { progress: 42, file: "q4_k_m.gguf" },
    };
    const encoded = encodeTunnelMessage(msg);
    const decoded = parseTunnelMessage(encoded);
    expect(decoded).toEqual(msg);
  });

  test("stream-event permits arbitrary data shapes", () => {
    const cases: unknown[] = [
      null,
      0,
      "string",
      { nested: { deeply: { value: true } } },
      [1, 2, 3],
    ];
    for (const data of cases) {
      const msg: TunnelStreamEvent = {
        type: "stream-event",
        id: "sub-x",
        index: 7,
        data,
      };
      const decoded = parseTunnelMessage(encodeTunnelMessage(msg));
      expect(decoded).toEqual(msg);
    }
  });

  test("stream-event rejects negative index", () => {
    const bad = {
      type: "stream-event",
      id: "sub",
      index: -1,
      data: {},
    };
    const parsed = parseTunnelMessage(JSON.stringify(bad));
    expect(parsed).toBeNull();
  });

  test("stream-event rejects empty id", () => {
    const bad = {
      type: "stream-event",
      id: "",
      index: 0,
      data: {},
    };
    const parsed = parseTunnelMessage(JSON.stringify(bad));
    expect(parsed).toBeNull();
  });

  test("stream-done with ok:true round-trips", () => {
    const msg: TunnelStreamDone = {
      type: "stream-done",
      id: "sub-456",
      ok: true,
    };
    const decoded = parseTunnelMessage(encodeTunnelMessage(msg));
    expect(decoded).toEqual(msg);
  });

  test("stream-done with ok:false + error round-trips", () => {
    const msg: TunnelStreamDone = {
      type: "stream-done",
      id: "sub-789",
      ok: false,
      error: { code: "TIMEOUT", message: "subscription timed out" },
    };
    const decoded = parseTunnelMessage(encodeTunnelMessage(msg));
    expect(decoded).toEqual(msg);
  });

  test("stream-cancel round-trips", () => {
    const msg: TunnelStreamCancel = {
      type: "stream-cancel",
      id: "sub-cancel",
    };
    const decoded = parseTunnelMessage(encodeTunnelMessage(msg));
    expect(decoded).toEqual(msg);
  });

  test("discriminated union narrows type in TypeScript", () => {
    const parsed = parseTunnelMessage(
      encodeTunnelMessage({
        type: "stream-event",
        id: "sub",
        index: 0,
        data: "payload",
      }),
    );
    expect(parsed).not.toBeNull();
    const narrow: TunnelMessage = parsed!;
    if (narrow.type === "stream-event") {
      // Accessing index + data compile-time-safe via discrimination.
      expect(narrow.index).toBe(0);
      expect(narrow.data).toBe("payload");
    } else {
      throw new Error("discriminated union did not narrow");
    }
  });

  test("schema parses all three new frames in list", () => {
    const frames: TunnelMessage[] = [
      { type: "stream-event", id: "a", index: 0, data: 1 },
      { type: "stream-event", id: "a", index: 1, data: 2 },
      { type: "stream-done", id: "a", ok: true },
      { type: "stream-cancel", id: "b" },
    ];
    for (const f of frames) {
      expect(TunnelMessageSchema.safeParse(f).success).toBe(true);
    }
  });
});

describe("tunnel frame bounds and the cancel acknowledgement (P4.1 X3, X4)", () => {
  test("a frame above TUNNEL_MAX_FRAME_BYTES is malformed; a frame at the cap still parses", () => {
    const frame = (data: string): string =>
      encodeTunnelMessage({ type: "stream-event", id: "s", index: 0, data });
    const fill = TUNNEL_MAX_FRAME_BYTES - frameBytes(frame(""));
    const atCap = frame("x".repeat(fill));
    expect(frameBytes(atCap)).toBe(TUNNEL_MAX_FRAME_BYTES);
    expect(parseTunnelMessage(atCap)).not.toBeNull();
    expect(parseTunnelMessage(frame("x".repeat(fill + 1)))).toBeNull();
  });

  test("frame bytes are UTF-8 bytes, so multi-byte text cannot slip under a cap", () => {
    expect(frameBytes("\u00e9")).toBe(2);
    expect(frameBytes("\u{1F999}")).toBe(4);
  });

  test("the stream caps fit one frame and admit at least one full event of backlog", () => {
    for (const limits of [INFERENCE_RPC_STREAM_LIMITS, SUBSCRIPTION_STREAM_LIMITS]) {
      expect(limits.maxFrameBytes).toBeLessThanOrEqual(TUNNEL_MAX_FRAME_BYTES);
      expect(limits.maxFrameBytes).toBeLessThanOrEqual(limits.maxQueuedBytes);
    }
    expect(INFERENCE_RPC_STREAM_LIMITS.maxQueuedBytes).toBeLessThan(TUNNEL_MAX_FRAME_BYTES);
  });

  test("the default policy keeps the 1 MiB event cap to the worker RPC; other streams keep the frame cap", () => {
    expect(streamLimitsFor("inferenceRpc.stream")).toEqual(INFERENCE_RPC_STREAM_LIMITS);
    expect(INFERENCE_RPC_STREAM_LIMITS.maxFrameBytes).toBe(1024 * 1024);
    for (const method of ["serverLogs", "opsSessionWatch", "chatStream", "inferenceRpcX"]) {
      expect(streamLimitsFor(method)).toEqual(SUBSCRIPTION_STREAM_LIMITS);
    }
    expect(SUBSCRIPTION_STREAM_LIMITS.maxFrameBytes).toBe(TUNNEL_MAX_FRAME_BYTES);
  });

  test("a stream-done typed stream-cancelled acknowledges a cancel; any other end is already-terminal", () => {
    const ack: TunnelStreamDone = {
      type: "stream-done",
      id: "s",
      ok: false,
      error: { code: TUNNEL_STREAM_CANCELLED, message: "cancelled by central" },
    };
    expect(parseTunnelMessage(encodeTunnelMessage(ack))).toEqual(ack);
    expect(TunnelStreamCancelAckSchema.safeParse(ack).success).toBe(true);
    expect(cancelOutcomeOf(ack)).toBe("cancelled");
    expect(cancelOutcomeOf({ type: "stream-done", id: "s", ok: true })).toBe("already-terminal");
    expect(
      cancelOutcomeOf({
        type: "stream-done",
        id: "s",
        ok: false,
        error: { code: "subscription-error", message: "boom" },
      }),
    ).toBe("already-terminal");
  });
});

describe("worker-RPC auth on req frames (P4.1 X5)", () => {
  const req = {
    type: "req",
    id: "r1",
    method: "inferenceRpc.status",
    params: { type: "query", input: { attemptId: "att-1" } },
  } as const;

  test("a req frame carries a bounded single-use token and its relay principal", () => {
    const auth = { serviceToken: "v1.1.nonce.c3ViamVjdA.mac", relayPrincipal: "principal" };
    expect(parseTunnelMessage(JSON.stringify({ ...req, auth }))).toEqual({ ...req, auth });
    const oversized = { ...auth, serviceToken: "x".repeat(SERVICE_TOKEN_MAX_LENGTH + 1) };
    expect(parseTunnelMessage(JSON.stringify({ ...req, auth: oversized }))).toBeNull();
  });

  test("a reusable credential field is no part of the frame", () => {
    const parsed = parseTunnelMessage(
      JSON.stringify({ ...req, auth: { serviceCredential: "ll_agt_secret" } }),
    );
    expect(JSON.stringify(parsed)).not.toContain("ll_agt_secret");
  });
});
