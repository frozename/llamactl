import { describe, expect, test } from "bun:test";

import {
  buildTunnelSubscribe,
  callViaTunnelRelay,
  type FetchLike,
} from "../src/tunnel-dispatch.js";

/**
 * Issue #335 — deterministic pins for the tunnel-relay SSE path in
 * `tunnel-dispatch.ts` (frame parsing, HTTP error surfacing,
 * settle-once callback rules) plus the HTTP error surface of
 * `callViaTunnelRelay` re-exported through the CLI dispatcher.
 *
 * Every case drives `buildTunnelSubscribe` with a fake `fetchImpl`
 * that hands back a controlled `ReadableStream` body — no server is
 * started, no socket is opened and no wall-clock timer races the
 * parser.
 */

const CENTRAL_URL = "https://central.invalid";

interface CapturedCall {
  url: string;
  init: Parameters<FetchLike>[1];
}

interface Harness {
  events: unknown[];
  errors: Error[];
  completes: number[];
  starts: number[];
  captured: CapturedCall[];
  throwOnData: { value: boolean };
  unsubscribeOnData: { value: boolean };
  push(text: string): void;
  close(): void;
  unsubscribe(): void;
}

async function flush(rounds: number): Promise<void> {
  let left = rounds;
  while (left > 0) {
    left -= 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function openSsePipe(): {
  response: Response;
  controller: ReadableStreamDefaultController<Uint8Array>;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(c): void {
        controller = c;
      },
    }),
    { status: 200, statusText: "OK" },
  );
  return { response, controller };
}

function makeHarness(
  fetchImpl?: FetchLike,
  opts?: { centralUrl?: string; insecure?: boolean },
): Harness {
  const pipe = openSsePipe();
  const encoder = new TextEncoder();
  const events: unknown[] = [];
  const errors: Error[] = [];
  const completes: number[] = [];
  const starts: number[] = [];
  const captured: CapturedCall[] = [];
  const throwOnData = { value: false };
  const unsubscribeOnData = { value: false };
  const inner: FetchLike =
    fetchImpl ??
    ((): Promise<Response> => {
      return Promise.resolve(pipe.response);
    });
  const recording: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    captured.push({ url, init });
    return await inner(input, init);
  };
  const subscribe = buildTunnelSubscribe({
    centralUrl: opts?.centralUrl ?? CENTRAL_URL,
    bearer: "relay-bearer",
    nodeName: "node 1",
    fetchImpl: recording,
    ...(opts?.insecure !== undefined ? { insecure: opts.insecure } : { insecure: true }),
  });
  const handle = subscribe(
    "tick",
    { n: 1 },
    {
      onData: (e): void => {
        events.push(e);
        if (throwOnData.value) {
          throw new Error("consumer-broke");
        }
        if (unsubscribeOnData.value) {
          unsubscribeOnData.value = false;
          handle.unsubscribe();
        }
      },
      onError: (err): void => {
        errors.push(err as Error);
      },
      onComplete: (): void => {
        completes.push(1);
      },
      onStarted: (): void => {
        starts.push(1);
      },
    },
  );
  return {
    events,
    errors,
    completes,
    starts,
    captured,
    throwOnData,
    unsubscribeOnData,
    push(text: string): void {
      pipe.controller.enqueue(encoder.encode(text));
    },
    close(): void {
      pipe.controller.close();
    },
    unsubscribe(): void {
      handle.unsubscribe();
    },
  };
}

function relayCall(fetchImpl: FetchLike): Promise<unknown> {
  return callViaTunnelRelay({
    centralUrl: CENTRAL_URL,
    nodeName: "node-1",
    method: "ping",
    input: null,
    bearer: "relay-bearer",
    fetchImpl,
    insecure: true,
  });
}

describe("tunnel-relay SSE frame parsing", () => {
  test("delivers data frames and an ok done frame settles complete", async () => {
    const h = makeHarness();
    h.push('data: {"i":0}\n\ndata: {"i":1}\n\nevent: done\ndata: {"ok":true}\n\n');
    await flush(6);
    expect(h.captured).toHaveLength(1);
    const call = h.captured[0];
    expect(call?.url).toBe("https://central.invalid/tunnel-relay/node%201?stream=true");
    expect(call?.init?.method).toBe("POST");
    const headers = call?.init?.headers as Record<string, string> | undefined;
    expect(headers?.["authorization"]).toBe("Bearer relay-bearer");
    const rawBody = call?.init?.body;
    expect(typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody).toEqual({
      method: "tick",
      type: "subscription",
      input: { n: 1 },
    });
    expect(call?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(h.starts).toHaveLength(1);
    expect(h.events).toEqual([{ i: 0 }, { i: 1 }]);
    expect(h.errors).toHaveLength(0);
    expect(h.completes).toHaveLength(1);
  });

  test("strips a trailing slash from the central URL", async () => {
    const h = makeHarness(undefined, { centralUrl: "https://central.invalid/" });
    await flush(3);
    expect(h.captured[0]?.url).toBe("https://central.invalid/tunnel-relay/node%201?stream=true");
    h.unsubscribe();
  });

  test("buffers a partial frame until the blank-line separator arrives", async () => {
    const h = makeHarness();
    h.push('data: {"i":0}\n');
    await flush(3);
    expect(h.events).toHaveLength(0);
    expect(h.errors).toHaveLength(0);
    h.push('\ndata: {"i":1}\n\n');
    await flush(3);
    expect(h.events).toEqual([{ i: 0 }, { i: 1 }]);
    expect(h.errors).toHaveLength(0);
    h.unsubscribe();
  });

  test("buffers a partial frame split inside the JSON payload", async () => {
    const h = makeHarness();
    h.push('data: {"i":');
    await flush(3);
    expect(h.events).toHaveLength(0);
    h.push("1}\n\n");
    await flush(3);
    expect(h.events).toEqual([{ i: 1 }]);
    expect(h.errors).toHaveLength(0);
    h.unsubscribe();
  });

  test("ignores frames with an unknown event name", async () => {
    const h = makeHarness();
    h.push('event: ping\ndata: {"seq":1}\n\n');
    await flush(3);
    expect(h.events).toHaveLength(0);
    expect(h.errors).toHaveLength(0);
    h.push('event: done\ndata: {"ok":true}\n\n');
    await flush(3);
    expect(h.completes).toHaveLength(1);
  });

  test("a failed done frame settles error with message and code", async () => {
    const h = makeHarness();
    h.push('event: done\ndata: {"ok":false,"error":{"code":"E42","message":"agent-failure"}}\n\n');
    await flush(3);
    const err = h.errors[0] as (Error & { code?: string }) | undefined;
    expect(err?.message).toBe("agent-failure");
    expect(err?.code).toBe("E42");
    expect(h.events).toHaveLength(0);
    expect(h.completes).toHaveLength(0);
  });

  test("a failed done frame without error details uses the default message", async () => {
    const h = makeHarness();
    h.push('event: done\ndata: {"ok":false}\n\n');
    await flush(3);
    expect(h.errors[0]?.message).toBe("subscription error");
    expect((h.errors[0] as (Error & { code?: string }) | undefined)?.code).toBeUndefined();
    expect(h.completes).toHaveLength(0);
  });

  test("a done frame with invalid JSON reports a malformed done frame", async () => {
    const h = makeHarness();
    h.push("event: done\ndata: {ok:true\n\n");
    await flush(3);
    expect(h.errors[0]?.message).toBe("tunnel-relay SSE: malformed done frame");
    expect(h.completes).toHaveLength(0);
  });

  test("a done frame with the wrong JSON shape reports an invalid done frame", async () => {
    const okShape = makeHarness();
    okShape.push('event: done\ndata: {"done":true}\n\n');
    await flush(3);
    expect(okShape.errors[0]?.message).toBe("tunnel-relay SSE: invalid done frame");
    const partialError = makeHarness();
    partialError.push('event: done\ndata: {"ok":false,"error":{"message":"x"}}\n\n');
    await flush(3);
    expect(partialError.errors[0]?.message).toBe("tunnel-relay SSE: invalid done frame");
  });

  test("a data frame with invalid JSON settles error", async () => {
    const h = makeHarness();
    h.push("data: not-json\n\n");
    await flush(3);
    expect(h.errors[0]?.message).toBe("tunnel-relay SSE: malformed data frame");
    expect(h.completes).toHaveLength(0);
  });

  test("empty frames between separators are skipped", async () => {
    const h = makeHarness();
    h.push('data: {"i":0}\n\n\n\ndata: {"i":1}\n\n');
    await flush(3);
    expect(h.events).toEqual([{ i: 0 }, { i: 1 }]);
    expect(h.errors).toHaveLength(0);
    h.unsubscribe();
  });

  test("a throwing onData handler does not break the pump", async () => {
    const h = makeHarness();
    h.throwOnData.value = true;
    h.push('data: {"i":0}\n\ndata: {"i":1}\n\nevent: done\ndata: {"ok":true}\n\n');
    await flush(6);
    expect(h.events).toEqual([{ i: 0 }, { i: 1 }]);
    expect(h.errors).toHaveLength(0);
    expect(h.completes).toHaveLength(1);
  });

  test("frames after a terminal done frame are not drained", async () => {
    const h = makeHarness();
    h.push('data: {"i":0}\n\nevent: done\ndata: {"ok":true}\n\ndata: {"i":1}\n\n');
    await flush(3);
    expect(h.events).toEqual([{ i: 0 }]);
    expect(h.completes).toHaveLength(1);
    expect(h.errors).toHaveLength(0);
  });
});

describe("tunnel-relay HTTP errors", () => {
  test("a non-ok response settles error with status and body text", async () => {
    const h = makeHarness(
      (): Promise<Response> =>
        Promise.resolve(new Response("relay offline", { status: 503, statusText: "unavailable" })),
    );
    await flush(3);
    expect(h.errors[0]?.message).toBe("tunnel-relay 503: relay offline");
    expect(h.starts).toHaveLength(0);
    expect(h.completes).toHaveLength(0);
  });

  test("an empty error body falls back to statusText", async () => {
    const h = makeHarness(
      (): Promise<Response> =>
        Promise.resolve(new Response("", { status: 502, statusText: "Bad Gateway" })),
    );
    await flush(3);
    expect(h.errors[0]?.message).toBe("tunnel-relay 502: Bad Gateway");
    expect(h.starts).toHaveLength(0);
  });

  test("a transport rejection surfaces on onError", async () => {
    const h = makeHarness((): Promise<Response> => Promise.reject(new Error("socket reset")));
    await flush(3);
    expect(h.errors[0]?.message).toBe("socket reset");
    expect(h.starts).toHaveLength(0);
    expect(h.completes).toHaveLength(0);
  });

  test("an ok response without a body settles the empty-body error", async () => {
    const h = makeHarness(
      (): Promise<Response> => Promise.resolve(new Response(null, { status: 200 })),
    );
    await flush(3);
    expect(h.errors[0]?.message).toBe("tunnel-relay SSE returned an empty body");
    expect(h.starts).toHaveLength(1);
    expect(h.completes).toHaveLength(0);
  });

  test("a stream that closes without a done frame settles error", async () => {
    const h = makeHarness();
    h.push('data: {"i":0}\n\n');
    h.close();
    await flush(3);
    expect(h.events).toEqual([{ i: 0 }]);
    expect(h.errors[0]?.message).toBe("tunnel-relay SSE: stream closed without a done frame");
    expect(h.completes).toHaveLength(0);
  });

  test("pinning fails closed before any fetch is issued", async () => {
    const h = makeHarness(undefined, { insecure: false });
    await flush(3);
    expect(h.captured).toHaveLength(0);
    expect(h.errors[0]?.message).toContain("tunnelCentralFingerprint");
    expect(h.starts).toHaveLength(0);
  });

  test("callViaTunnelRelay surfaces a non-ok status with body text", async () => {
    let message = "";
    try {
      await relayCall(
        (): Promise<Response> =>
          Promise.resolve(new Response("boom", { status: 500, statusText: "Server Error" })),
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe("tunnel-relay 500: boom");
  });

  test("callViaTunnelRelay falls back to statusText on an empty error body", async () => {
    let message = "";
    try {
      await relayCall(
        (): Promise<Response> =>
          Promise.resolve(new Response("", { status: 502, statusText: "Bad Gateway" })),
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe("tunnel-relay 502: Bad Gateway");
  });

  test("callViaTunnelRelay throws the envelope error with its code", async () => {
    let caught: unknown;
    try {
      await relayCall(
        (): Promise<Response> =>
          Promise.resolve(
            new Response(
              JSON.stringify({ type: "res", id: "1", error: { code: "E7", message: "denied" } }),
              { status: 200 },
            ),
          ),
      );
    } catch (err) {
      caught = err;
    }
    const e = caught as (Error & { code?: string }) | undefined;
    expect(e?.message).toBe("denied");
    expect(e?.code).toBe("E7");
  });

  test("callViaTunnelRelay returns the envelope result on success", async () => {
    const result = await relayCall(
      (): Promise<Response> =>
        Promise.resolve(
          new Response(JSON.stringify({ type: "res", id: "1", result: { pong: true } }), {
            status: 200,
          }),
        ),
    );
    expect(result).toEqual({ pong: true });
  });
});

describe("tunnel-relay settle-once rules", () => {
  test("an error settles the stream so the stream-end error is suppressed", async () => {
    const h = makeHarness();
    h.push("data: not-json\n\n");
    await flush(3);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.message).toBe("tunnel-relay SSE: malformed data frame");
    h.close();
    await flush(3);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.message).toBe("tunnel-relay SSE: malformed data frame");
    expect(h.completes).toHaveLength(0);
  });

  test("unsubscribe is silent and stops delivering buffered frames", async () => {
    const h = makeHarness();
    h.push('data: {"i":0}\n\n');
    await flush(3);
    expect(h.events).toEqual([{ i: 0 }]);
    h.unsubscribe();
    h.push('data: {"i":1}\n\nevent: done\ndata: {"ok":true}\n\n');
    await flush(3);
    h.close();
    await flush(3);
    expect(h.events).toEqual([{ i: 0 }]);
    expect(h.errors).toHaveLength(0);
    expect(h.completes).toHaveLength(0);
  });

  test("a failed done frame after unsubscribe from onData does not fire onError", async () => {
    const h = makeHarness();
    h.unsubscribeOnData.value = true;
    h.push(
      'data: {"i":0}\n\nevent: done\ndata: {"ok":false,"error":{"code":"E9","message":"late"}}\n\n',
    );
    await flush(3);
    expect(h.events).toEqual([{ i: 0 }]);
    expect(h.errors).toHaveLength(0);
    expect(h.completes).toHaveLength(0);
  });

  test("unsubscribe after a terminal frame is a no-op", async () => {
    const h = makeHarness();
    h.push('event: done\ndata: {"ok":true}\n\n');
    await flush(3);
    h.unsubscribe();
    h.unsubscribe();
    await flush(3);
    expect(h.completes).toHaveLength(1);
    expect(h.errors).toHaveLength(0);
  });
});
