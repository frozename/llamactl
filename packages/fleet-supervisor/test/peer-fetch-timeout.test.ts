import { afterEach, describe, expect, test } from "bun:test";

import type { PeerNode } from "../../remote/src/config/peers.js";

import { createPeerFetch } from "../src/peer-fetch.js";

const originalFetch = globalThis.fetch;

function sleep(ms: number): Promise<"pending"> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve("pending");
    }, ms);
  });
}

describe("peer fetch timeout", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("rejects when a peer snapshot request exceeds timeoutMs", async () => {
    globalThis.fetch = ((_input: Request | string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("request aborted"));
        });
      });
    }) as typeof fetch;

    const peer: PeerNode = {
      id: "slow-peer",
      endpoint: "https://slow-peer.local:7843",
      token: "peer-token",
    };

    let thrown: unknown;
    try {
      await Promise.race([createPeerFetch(peer, { timeoutMs: 10 })(), sleep(75)]);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("peer slow-peer snapshot timed out after 10ms");
  });
});
