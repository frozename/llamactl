import * as novaContracts from "@nova/contracts";
import { afterEach, describe, expect, test } from "bun:test";

import { providerForCloudNode } from "../src/providers/factory.js";

/**
 * Pin: `applyProviderQuirks` must forward the trailing
 * `ProviderExecutionContext` into the wrapped `createResponse` /
 * `createEmbeddings` calls — dropping it severs caller cancellation
 * for every quirk-wrapped provider (gemini, anthropic) while leaving
 * the suite green. Proven against a real Bun.serve fixture: an aborted
 * signal must cancel the in-flight upstream fetch.
 *
 * The behaviour only exists on @nova/contracts 0.2.0 — under the
 * workspace's 0.1.0 install `createResponse` ignores the context arg
 * entirely, so the test is skipped there and exercised by the sibling
 * harness.
 */
const NOVA_02 =
  typeof (novaContracts as Record<string, unknown>)["projectUsageRecordV2ToV1"] === "function";

let upstream: ReturnType<typeof Bun.serve> | undefined;

afterEach(async () => {
  if (upstream !== undefined) {
    await upstream.stop(true);
    upstream = undefined;
  }
});

describe("applyProviderQuirks — context forwarding", () => {
  test.skipIf(!NOVA_02)(
    "gemini createResponse forwards context.signal — abort cancels the upstream fetch",
    async () => {
      let sawRequestResolve: (() => void) | null = null;
      let sawAbortResolve: (() => void) | null = null;
      const sawRequest = new Promise<void>((r) => {
        sawRequestResolve = r;
      });
      const sawAbort = new Promise<void>((r) => {
        sawAbortResolve = r;
      });
      upstream = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req): Response {
          sawRequestResolve?.();
          // The request signal fires when the client aborts the
          // fetch — the observable wire proof that context.signal
          // reached the upstream call.
          req.signal.addEventListener("abort", () => sawAbortResolve?.(), { once: true });
          return new Response(
            new ReadableStream<Uint8Array>({
              start(): void {
                /* held open */
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      });
      const provider = providerForCloudNode({
        name: "gem",
        endpoint: "",
        kind: "gateway",
        cloud: {
          provider: "gemini",
          baseUrl: `http://127.0.0.1:${String(upstream.port)}/v1`,
        },
      });

      const caller = new AbortController();
      // Settle handler attached eagerly — an abort-rejected provider
      // promise must never surface as an unhandled rejection.
      const pending = provider
        .createResponse(
          { model: "models/gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] },
          { signal: caller.signal },
        )
        .then(
          () => "resolved" as const,
          (e: unknown) => e,
        );
      await sawRequest;
      caller.abort();
      await Promise.race([
        sawAbort,
        new Promise((_, rej) => {
          setTimeout(() => {
            rej(new Error("abort never reached the upstream fetch"));
          }, 8_000);
        }),
      ]);
      const settled = await pending;
      expect((settled as { name?: string }).name).toBe("AbortError");
    },
  );
});
