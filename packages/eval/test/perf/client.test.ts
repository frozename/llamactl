import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type {
  PerfEngineClient,
  PerfEngineClientOptions,
  PerfStreamResult,
} from "../../src/perf/client.js";

import { createHttpPerfEngineClient } from "../../src/perf/client.js";
import { createManualClock } from "./fake-engine.js";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

describe("createHttpPerfEngineClient TTFT", () => {
  let clock: ReturnType<typeof createManualClock>;
  let client: PerfEngineClient;

  beforeEach(() => {
    clock = createManualClock(0);
  });

  afterEach(() => {
    client = null as unknown as PerfEngineClient;
  });

  test("measures ttft_ms at first-delta delivery, not at stream completion", async () => {
    const maxTokens = 64;
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < maxTokens; i += 1) {
      chunks.push(
        encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n`),
      );
    }
    chunks.push(
      encoder.encode(
        `data: ${JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: maxTokens } })}\n\n`,
      ),
    );
    chunks.push(encoder.encode("data: [DONE]\n\n"));

    const fetchImpl: FetchLike = async (): Promise<Response> => {
      // Advance the clock synchronously when the request is issued,
      // simulating the time between the client calling clock.now() for
      // `start` and the response being delivered.  The client captures
      // `start` before calling `doFetch`; the fetchImpl advances the
      // clock to 250, so the first delta read by the client sees
      // `clock.now() - start === 250`.
      await Promise.resolve();
      clock.advance(250);

      let index = 0;
      return new Response(
        new ReadableStream({
          pull(controller): void {
            if (index < chunks.length) {
              controller.enqueue(chunks[index]);
              index += 1;
            } else {
              controller.close();
            }
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    };

    const options: PerfEngineClientOptions = { clock, fetchImpl: fetchImpl as typeof fetch };
    client = createHttpPerfEngineClient("http://127.0.0.1:12345", options);

    const result: PerfStreamResult = await client.streamChat({
      messages: [{ role: "user", content: "hello world" }],
      maxTokens: maxTokens,
    });

    expect(result.ttftMs).toBe(250);
  });

  test("reports ttftMs null when no delta is streamed", async () => {
    const fetchImpl: FetchLike = async (): Promise<Response> => {
      await Promise.resolve();
      return new Response(
        JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
        { headers: { "content-type": "application/json" } },
      );
    };

    const options: PerfEngineClientOptions = { clock, fetchImpl: fetchImpl as typeof fetch };
    client = createHttpPerfEngineClient("http://127.0.0.1:12345", options);

    const result: PerfStreamResult = await client.streamCompletion({
      prompt: "hello world",
      maxTokens: 5,
    });

    expect(result.ttftMs).toBeNull();
  });
});
