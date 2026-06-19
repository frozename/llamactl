import { describe, expect, test } from "bun:test";

import {
  callViaTunnelRelay,
  type FetchLike,
  type TunnelRelayCallOptions,
} from "../src/tunnel-dispatch.js";

/**
 * Timeout guard on the tunnel-relay POST path.
 *
 * `callViaTunnelRelay` must thread an AbortSignal into the fetch so
 * a misbehaving central or network partition cannot hang the caller
 * forever. The SSE path already did this; these tests cover the POST
 * gap.
 */

function baseOpts(): Omit<TunnelRelayCallOptions, "fetchImpl"> {
  return {
    centralUrl: "https://127.0.0.1:7843",
    nodeName: "gpu1",
    method: "env",
    input: { x: 1 },
    bearer: "bearer-abc",
    type: "query",
    // bypass pinning so timeout behaviour is the only variable
    insecure: true,
  };
}

/** Converts an AbortSignal abort reason into a named Error.
 *  AbortSignal.timeout() sets reason to a DOMException(name:"TimeoutError");
 *  copying name onto a plain Error keeps the lint rule happy while preserving
 *  the name that callViaTunnelRelay checks. */
function abortReasonToError(signal: AbortSignal): Error {
  const r = signal.reason as { name?: string; message?: string } | undefined;
  return Object.assign(new Error(r?.message ?? "aborted"), { name: r?.name ?? "AbortError" });
}

/** fetchImpl that never resolves unless the AbortSignal fires. */
function hangingFetch(): FetchLike {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // would hang forever — signal must be present
      if (signal.aborted) {
        reject(abortReasonToError(signal));
        return;
      }
      signal.addEventListener("abort", () => {
        reject(abortReasonToError(signal));
      });
    });
}

/** fetchImpl that resolves immediately with a valid envelope. */
function fastFetch(result: unknown): FetchLike {
  // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
  return async (_url, _init) =>
    new Response(JSON.stringify({ type: "res", id: "r1", result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

describe("callViaTunnelRelay — POST timeout", () => {
  test("never-resolving fetchImpl rejects within timeoutMs with tunnel-timeout error", async () => {
    const start = Date.now();
    const err = await callViaTunnelRelay({
      ...baseOpts(),
      fetchImpl: hangingFetch(),
      timeoutMs: 120,
    }).then(
      () => null,
      // eslint-disable-next-line @typescript-eslint/use-unknown-in-catch-callback-variable -- Preserve existing CLI/test semantics while clearing strict lint debt.
      (e: Error & { code?: string }) => e,
    );
    const elapsed = Date.now() - start;

    expect(err).toBeInstanceOf(Error);
    expect(err?.code).toBe("tunnel-timeout");
    expect(err?.message).toContain("timed out");
    // Must not hang — should settle well inside 2 × timeoutMs.
    expect(elapsed).toBeLessThan(800);
  });

  test("fast response resolves correctly and is not affected by the timeout", async () => {
    const result = await callViaTunnelRelay({
      ...baseOpts(),
      fetchImpl: fastFetch({ value: 42 }),
      timeoutMs: 5000,
    });
    expect(result).toEqual({ value: 42 });
  });
});
