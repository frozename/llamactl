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
): { response: Response; pulled: () => number } {
  let offset = 0;
  let pulledBytes = 0;
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
});
