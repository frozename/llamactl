import { afterEach, describe, expect, test } from "bun:test";

import { __peerSnapshotInternals } from "../src/server/peer-snapshot-poller.js";

const CAP = 2 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const originalFetch = globalThis.fetch;
const directPeer = { id: "mac-mini", endpoint: "https://127.0.0.1:7843", token: "peer-token" };

function paddedSnapshot(totalBytes: number): Uint8Array {
  const withoutPad = {
    node_mem: { free_mb: 1024, inactive_mb: 2048 },
    workloads: [
      {
        models: ["granite-mini-3b"],
        endpoint: "http://127.0.0.1:8086",
        reachable: true,
        revision: "rev-1",
      },
    ],
    pad: "",
  };
  const encoder = new TextEncoder();
  const emptyPadBytes = encoder.encode(JSON.stringify(withoutPad)).byteLength;
  const padLength = totalBytes - emptyPadBytes;
  if (padLength < 0) throw new Error(`snapshot prefix already exceeds ${String(totalBytes)} bytes`);
  const bytes = encoder.encode(JSON.stringify({ ...withoutPad, pad: "x".repeat(padLength) }));
  if (bytes.byteLength !== totalBytes) {
    throw new Error(
      `snapshot is ${String(bytes.byteLength)} bytes, expected ${String(totalBytes)}`,
    );
  }
  return bytes;
}

function meteredResponse(
  bytes: Uint8Array,
  headers?: Record<string, string>,
): { response: Response; pulled: () => number; cancelled: () => boolean } {
  let offset = 0;
  let pulledBytes = 0;
  let cancelCalled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller): void {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + CHUNK_BYTES, bytes.byteLength);
        const chunk = bytes.subarray(offset, end);
        offset = end;
        controller.enqueue(chunk);
        pulledBytes += chunk.byteLength;
      },
      cancel(): void {
        cancelCalled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    response: new Response(body, {
      status: 200,
      headers: { "content-type": "application/json", ...headers },
    }),
    pulled(): number {
      return pulledBytes;
    },
    cancelled(): boolean {
      return cancelCalled;
    },
  };
}

function stalledResponse(firstChunk: Uint8Array): Response {
  let sent = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller): Promise<void> | undefined {
        if (!sent) {
          sent = true;
          controller.enqueue(firstChunk);
          return undefined;
        }
        // Never enqueue or close again: the peer stalls mid-body.
        return new Promise<void>(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

function capturingFetch(response: Response): { fetch: typeof fetch; signal: () => AbortSignal } {
  let captured: AbortSignal | undefined;
  const stub = ((_input: Request | string | URL, init?: RequestInit) => {
    captured = init?.signal ?? undefined;
    return Promise.resolve(response);
  }) as typeof fetch;
  return {
    fetch: stub,
    signal(): AbortSignal {
      if (captured === undefined) throw new Error("fetch was not called with an AbortSignal");
      return captured;
    },
  };
}

describe("peer snapshot body bound", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("a streamed peer snapshot over the byte cap is refused and not read to the end (#367)", async () => {
    const { response, pulled } = meteredResponse(paddedSnapshot(CAP * 4));
    globalThis.fetch = ((_input: Request | string | URL, _init?: RequestInit) =>
      Promise.resolve(response)) as typeof fetch;

    const snapshot = await __peerSnapshotInternals.fetchPeerSnapshot(directPeer, 1234);

    expect(snapshot).toBeNull();
    expect(pulled()).toBeLessThanOrEqual(CAP + 2 * CHUNK_BYTES);
  });

  test("a declared Content-Length over the cap is refused without reading the body (#367)", async () => {
    const contentLength = String(CAP + 1024);
    const { response, pulled } = meteredResponse(paddedSnapshot(CAP + 1024), {
      "content-length": contentLength,
    });

    expect(response.headers.get("content-length")).toBe(contentLength);
    expect(pulled()).toBe(0);

    globalThis.fetch = ((_input: Request | string | URL, _init?: RequestInit) =>
      Promise.resolve(response)) as typeof fetch;
    const snapshot = await __peerSnapshotInternals.fetchPeerSnapshot(directPeer, 1234);

    expect(snapshot).toBeNull();
    expect(pulled()).toBe(0);
  });

  test("the peer snapshot byte cap is exported for operators and tests", () => {
    const exportedCap = (__peerSnapshotInternals as Record<string, unknown>)[
      "PEER_SNAPSHOT_MAX_BODY_BYTES"
    ];
    expect(exportedCap).toBe(CAP);
  });

  test("a streamed peer snapshot under the byte cap is still accepted", async () => {
    const { response } = meteredResponse(paddedSnapshot(CAP - 4096));
    globalThis.fetch = ((_input: Request | string | URL, _init?: RequestInit) =>
      Promise.resolve(response)) as typeof fetch;

    const snapshot = await __peerSnapshotInternals.fetchPeerSnapshot(directPeer, 1234);

    expect(snapshot).toEqual({
      workloads: [{ modelId: "granite-mini-3b", port: 8086, revision: "rev-1" }],
      pressure: "NORMAL",
      fetchedAt: 1234,
    });
  });

  test("an over-cap streamed body cancels the stream and aborts the request (#367)", async () => {
    const { response, cancelled } = meteredResponse(paddedSnapshot(CAP * 4));
    const stub = capturingFetch(response);
    globalThis.fetch = stub.fetch;

    const snapshot = await __peerSnapshotInternals.fetchPeerSnapshot(directPeer, 1234);

    expect(snapshot).toBeNull();
    expect(cancelled()).toBe(true);
    expect(stub.signal().aborted).toBe(true);
  });

  test("a stalled peer body is abandoned at the timeout and the request is aborted (#367)", async () => {
    const stub = capturingFetch(stalledResponse(new TextEncoder().encode('{"workloads":[')));
    globalThis.fetch = stub.fetch;

    const snapshot = await __peerSnapshotInternals.fetchPeerSnapshot(directPeer, 1234, 50);

    expect(snapshot).toBeNull();
    expect(stub.signal().aborted).toBe(true);
  });
});
