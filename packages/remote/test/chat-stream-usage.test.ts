import type { UnifiedAiRequest, UnifiedStreamEvent } from "@nova/contracts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClusterNode } from "../src/config/schema.js";

import { providerForCloudNode } from "../src/providers/factory.js";
import { recordChatUsageSnapshot } from "../src/router.js";

/**
 * Streaming-path cost-corpus coverage. The non-streaming writer
 * (`recordChatUsage`) is exercised by `chat-usage.test.ts`; this file
 * proves the streaming half:
 *
 *   1. `recordChatUsageSnapshot` lands a UsageRecord with the canonical
 *      provider (the snapshot's own `provider` is the adapter name and
 *      must NOT leak into the corpus).
 *   2. The full factory→adapter→onUsage pipeline records when a stream
 *      yields a usage frame: `providerForNode`/`providerForCloudNode`
 *      threads `onUsage` into the OpenAI-compat adapter, which fires it
 *      on the final SSE usage block. We drive that with a stubbed fetch
 *      so no real upstream is needed — the same wiring the `chatStream`
 *      subscription installs.
 */

let dir = "";
const originalEnv = { ...process.env };

function guardedSseFetch(frames: readonly string[]): typeof globalThis.fetch {
  const make = (): Promise<Response> => {
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        let closed = false;
        const enc = new TextEncoder();
        const safeEnqueue = (frame: Uint8Array): void => {
          if (closed) return;
          try {
            controller.enqueue(frame);
          } catch {
            closed = true;
          }
        };
        const safeClose = (): void => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            /* controller already closed */
          }
        };
        for (const f of frames) safeEnqueue(enc.encode(f));
        safeClose();
      },
    });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
  };
  return make as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chat-stream-usage-"));
  process.env.LLAMACTL_USAGE_DIR = dir;
});

afterEach(() => {
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
  rmSync(dir, { recursive: true, force: true });
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function readSoleRecord(): Record<string, unknown> {
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(dir, files[0]!), "utf8").trim()) as Record<string, unknown>;
}

/** Two chat chunks + a trailing usage frame + [DONE] — fires onUsage. */
function usageFrames(usage: {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}): string[] {
  return [
    `data: ${JSON.stringify({
      id: "c1",
      model: "served-model",
      choices: [{ index: 0, delta: { role: "assistant", content: "hel" } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "c1",
      model: "served-model",
      choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }],
    })}\n\n`,
    `data: ${JSON.stringify({ id: "c1", model: "served-model", usage })}\n\n`,
    `data: [DONE]\n\n`,
  ];
}

const cloudNode: ClusterNode = {
  name: "openai-direct",
  endpoint: "",
  kind: "gateway",
  cloud: { provider: "openai", baseUrl: "https://api.openai.com/v1" },
};

const streamReq: UnifiedAiRequest = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "hi" }],
};

async function drain(iter: AsyncIterable<UnifiedStreamEvent>): Promise<number> {
  let count = 0;
  for await (const _ of iter) count += 1;
  return count;
}

describe("recordChatUsageSnapshot", () => {
  test("writes a UsageRecord using the canonical provider, not the adapter name", async () => {
    recordChatUsageSnapshot(
      {
        model: "gpt-4o",
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        latency_ms: 123,
      },
      "openai",
    );
    await flush();

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^openai-\d{4}-\d{2}-\d{2}\.jsonl$/);
    const rec = readSoleRecord();
    expect(rec.provider).toBe("openai");
    expect(rec.model).toBe("gpt-4o");
    expect(rec.kind).toBe("chat");
    expect(rec.prompt_tokens).toBe(11);
    expect(rec.completion_tokens).toBe(7);
    expect(rec.total_tokens).toBe(18);
    expect(rec.latency_ms).toBe(123);
    expect(typeof rec.ts).toBe("string");
  });

  test("attributes the project route when one is supplied", async () => {
    recordChatUsageSnapshot(
      { model: "gpt-4o", prompt_tokens: 5, completion_tokens: 5, total_tokens: 10, latency_ms: 9 },
      "openai",
      "project:novaflow/quick_qna/private-first",
    );
    await flush();
    const rec = readSoleRecord();
    expect(rec.route).toBe("project:novaflow/quick_qna/private-first");
  });
});

describe("chatStream usage capture", () => {
  test("guarded SSE helpers tolerate cancellation during stream setup", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          let closed = false;
          try {
            controller.enqueue(new TextEncoder().encode("data: one\n\n"));
          } catch {
            closed = true;
          }
          if (closed) return;
          try {
            controller.close();
          } catch {
            /* controller already closed */
          }
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    await response.body?.cancel();
    expect(response.status).toBe(200);
  });

  test("a stream that yields a usage frame records a UsageRecord via the onUsage hook", async () => {
    // Mirror exactly what the chatStream subscription installs: derive
    // the canonical provider from the node, then forward an onUsage
    // callback that calls recordChatUsageSnapshot.
    const canonicalProvider = cloudNode.cloud!.provider;
    const provider = providerForCloudNode(
      cloudNode,
      process.env,
      guardedSseFetch(usageFrames({ prompt_tokens: 20, completion_tokens: 13, total_tokens: 33 })),
      (snapshot) => {
        recordChatUsageSnapshot(snapshot, canonicalProvider);
      },
    );

    await drain(provider.streamResponse!(streamReq));
    await flush();

    const rec = readSoleRecord();
    // Canonical pricing-key provider, NOT the adapter name ("openai-direct").
    expect(rec.provider).toBe("openai");
    expect(rec.model).toBe("served-model");
    expect(rec.kind).toBe("chat");
    expect(rec.prompt_tokens).toBe(20);
    expect(rec.completion_tokens).toBe(13);
    expect(rec.total_tokens).toBe(33);
    expect(typeof rec.latency_ms).toBe("number");
  });

  test("a stream without a usage frame records nothing", async () => {
    const noUsageFrames = [
      `data: ${JSON.stringify({
        id: "c1",
        model: "served-model",
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
      })}\n\n`,
      `data: [DONE]\n\n`,
    ];
    const provider = providerForCloudNode(
      cloudNode,
      process.env,
      guardedSseFetch(noUsageFrames),
      (snapshot) => {
        recordChatUsageSnapshot(snapshot, cloudNode.cloud!.provider);
      },
    );
    await drain(provider.streamResponse!(streamReq));
    await flush();
    expect(readdirSync(dir)).toHaveLength(0);
  });
});
