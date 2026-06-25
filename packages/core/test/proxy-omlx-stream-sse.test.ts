import { expect, test } from "bun:test";

import {
  __jsonCompletionToSseForTests,
  __maybeSynthesizeOmlxSseResponseForTests,
} from "../src/openaiProxy.js";

// The oMLX save-handle path forces the upstream to stream:false so the KV
// save can serialize the slot from one JSON completion. Before this fix, the
// proxy returned that JSON body to a client that had originally asked for
// stream:true — OpenAI SDKs configured for text/event-stream crashed parsing
// JSON. The fix: capture the client's original stream intent, then synthesize
// a valid OpenAI SSE stream from the upstream JSON completion before sending
// it back. The KV save still happens off the JSON.

const sampleCompletion = {
  id: "chatcmpl-abc",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "qwen3-coder",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello, world!" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
};

function parseDataLines(sseBody: string): unknown[] {
  const out: unknown[] = [];
  for (const line of sseBody.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length);
    if (payload === "[DONE]") continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      // Ignore unparseable lines — they would fail downstream tests anyway.
    }
  }
  return out;
}

function extractContentFromChoice(choice: unknown): string {
  if (typeof choice !== "object" || choice === null) return "";
  const delta = (choice as { delta?: unknown }).delta;
  if (typeof delta !== "object" || delta === null) return "";
  const content = (delta as { content?: unknown }).content;
  return typeof content === "string" ? content : "";
}

/** Pull the assistant text back out of an SSE body so we can compare it to the source. */
function reconstituteAssistantContent(sseBody: string): string {
  let text = "";
  for (const chunk of parseDataLines(sseBody)) {
    if (typeof chunk !== "object" || chunk === null) continue;
    const choices = (chunk as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) continue;
    for (const choice of choices) text += extractContentFromChoice(choice);
  }
  return text;
}

test("jsonCompletionToSse: emits at least one chat.completion.chunk carrying the content", () => {
  const sse = __jsonCompletionToSseForTests(sampleCompletion);
  const chunks = parseDataLines(sse);
  expect(chunks.length).toBeGreaterThan(0);
  const objectKinds = new Set<string>();
  for (const chunk of chunks) {
    if (typeof chunk !== "object" || chunk === null) continue;
    const kind = (chunk as { object?: unknown }).object;
    if (typeof kind === "string") objectKinds.add(kind);
  }
  expect(objectKinds.has("chat.completion.chunk")).toBe(true);
});

test("jsonCompletionToSse: terminates with data: [DONE]", () => {
  const sse = __jsonCompletionToSseForTests(sampleCompletion);
  expect(sse.endsWith("data: [DONE]\n\n")).toBe(true);
});

test("jsonCompletionToSse: reconstituting deltas yields the same assistant text", () => {
  const sse = __jsonCompletionToSseForTests(sampleCompletion);
  expect(reconstituteAssistantContent(sse)).toBe("Hello, world!");
});

test("jsonCompletionToSse: preserves id, model, and usage where present", () => {
  const sse = __jsonCompletionToSseForTests(sampleCompletion);
  const chunks = parseDataLines(sse).filter(
    (c): c is Record<string, unknown> => typeof c === "object" && c !== null,
  );
  expect(chunks.every((c) => c["id"] === "chatcmpl-abc")).toBe(true);
  expect(chunks.every((c) => c["model"] === "qwen3-coder")).toBe(true);
  const usageChunk = chunks.find((c) => c["usage"] !== undefined);
  expect(usageChunk).toBeDefined();
  expect(usageChunk?.["usage"]).toEqual({
    prompt_tokens: 5,
    completion_tokens: 3,
    total_tokens: 8,
  });
});

test("jsonCompletionToSse: a final chunk carries finish_reason", () => {
  const sse = __jsonCompletionToSseForTests(sampleCompletion);
  let sawFinish = false;
  for (const chunk of parseDataLines(sse)) {
    const choices = (chunk as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) continue;
    for (const choice of choices) {
      const reason = (choice as { finish_reason?: unknown }).finish_reason;
      if (reason === "stop") sawFinish = true;
    }
  }
  expect(sawFinish).toBe(true);
});

test("jsonCompletionToSse: handles missing/empty content without crashing", () => {
  const sse = __jsonCompletionToSseForTests({
    id: "chatcmpl-empty",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant" }, finish_reason: "stop" }],
  });
  expect(sse.endsWith("data: [DONE]\n\n")).toBe(true);
  expect(reconstituteAssistantContent(sse)).toBe("");
});

test("maybeSynthesizeOmlxSseResponse: client requested stream → upstream JSON becomes text/event-stream", async () => {
  const upstream = new Response(JSON.stringify(sampleCompletion), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const synthesized = await __maybeSynthesizeOmlxSseResponseForTests(
    { clientRequestedStream: true, isAnthropic: false },
    upstream,
  );
  expect(synthesized).not.toBeNull();
  const ct = synthesized?.headers.get("content-type") ?? "";
  expect(ct.toLowerCase()).toContain("text/event-stream");
  const body = (await synthesized?.text()) ?? "";
  expect(body.endsWith("data: [DONE]\n\n")).toBe(true);
  expect(reconstituteAssistantContent(body)).toBe("Hello, world!");
});

test("maybeSynthesizeOmlxSseResponse: client did NOT request stream → returns null (JSON unchanged)", async () => {
  const upstream = new Response(JSON.stringify(sampleCompletion), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const synthesized = await __maybeSynthesizeOmlxSseResponseForTests(
    { clientRequestedStream: false, isAnthropic: false },
    upstream,
  );
  expect(synthesized).toBeNull();
  // The upstream Response must still be readable as JSON — we did not consume it.
  const json = (await upstream.json()) as { choices: unknown[] };
  expect(Array.isArray(json.choices)).toBe(true);
});

test("maybeSynthesizeOmlxSseResponse: anthropic path is skipped even if stream was captured", async () => {
  const upstream = new Response(JSON.stringify(sampleCompletion), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const synthesized = await __maybeSynthesizeOmlxSseResponseForTests(
    { clientRequestedStream: true, isAnthropic: true },
    upstream,
  );
  expect(synthesized).toBeNull();
});

test("maybeSynthesizeOmlxSseResponse: non-200 upstream is not converted (errors pass through)", async () => {
  const upstream = new Response(JSON.stringify({ error: { message: "bad" } }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
  const synthesized = await __maybeSynthesizeOmlxSseResponseForTests(
    { clientRequestedStream: true, isAnthropic: false },
    upstream,
  );
  expect(synthesized).toBeNull();
});

test("maybeSynthesizeOmlxSseResponse: 200 JSON error envelope is not converted", async () => {
  const upstream = new Response(JSON.stringify({ error: { message: "soft fail" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const synthesized = await __maybeSynthesizeOmlxSseResponseForTests(
    { clientRequestedStream: true, isAnthropic: false },
    upstream,
  );
  expect(synthesized).toBeNull();
});

test("maybeSynthesizeOmlxSseResponse: non-JSON upstream is not converted", async () => {
  const upstream = new Response("data: something\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const synthesized = await __maybeSynthesizeOmlxSseResponseForTests(
    { clientRequestedStream: true, isAnthropic: false },
    upstream,
  );
  expect(synthesized).toBeNull();
});
