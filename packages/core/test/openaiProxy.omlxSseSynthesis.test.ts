import { expect, setSystemTime, test } from "bun:test";

import {
  __jsonCompletionToSseForTests,
  __maybeSynthesizeOmlxSseResponseForTests,
} from "../src/openaiProxy.js";

type Frame = {
  id?: unknown;
  object?: unknown;
  created?: unknown;
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
};

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

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function parseFrames(sse: string): Frame[] {
  const frames: Frame[] = [];
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length);
    if (payload === "[DONE]") continue;
    frames.push(JSON.parse(payload) as Frame);
  }
  return frames;
}

function firstChoice(frame: Frame): Record<string, unknown> {
  const choices = Array.isArray(frame.choices) ? frame.choices : [];
  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null) {
    throw new Error("frame has no choice object");
  }
  return first as Record<string, unknown>;
}

function deltaOf(frame: Frame): Record<string, unknown> {
  const delta: unknown = firstChoice(frame)["delta"];
  if (typeof delta !== "object" || delta === null) {
    throw new Error("choice has no delta object");
  }
  return delta as Record<string, unknown>;
}

test("jsonCompletionToSse: emits role chunk, stop chunk, usage chunk then [DONE] with exact shape", () => {
  const expected =
    sseFrame({
      id: "chatcmpl-abc",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "qwen3-coder",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "Hello, world!" },
          finish_reason: null,
        },
      ],
    }) +
    sseFrame({
      id: "chatcmpl-abc",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "qwen3-coder",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }) +
    sseFrame({
      id: "chatcmpl-abc",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "qwen3-coder",
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }) +
    "data: [DONE]\n\n";
  expect(__jsonCompletionToSseForTests(sampleCompletion)).toBe(expected);
});

test("jsonCompletionToSse: defaults missing id and model to chatcmpl-stream and unknown", () => {
  const frames = parseFrames(__jsonCompletionToSseForTests({ choices: [] }));
  expect(frames).toHaveLength(1);
  expect(frames[0]?.id).toBe("chatcmpl-stream");
  expect(frames[0]?.model).toBe("unknown");
});

test("jsonCompletionToSse: defaults missing created to the current wall-clock second", () => {
  setSystemTime(1_700_000_000_500);
  try {
    const frames = parseFrames(__jsonCompletionToSseForTests({ choices: [] }));
    expect(frames[0]?.created).toBe(1_700_000_000);
  } finally {
    setSystemTime();
  }
});

test("jsonCompletionToSse: delta always carries role, defaulting a missing role to assistant", () => {
  const sse = __jsonCompletionToSseForTests({
    id: "chatcmpl-role",
    created: 1,
    model: "m",
    choices: [
      { index: 0, message: { content: "hi" }, finish_reason: "stop" },
      { index: 1, message: { role: "assistant", content: "yo" }, finish_reason: "stop" },
    ],
  });
  const roleChunks = parseFrames(sse).filter(
    (frame) => (firstChoice(frame)["finish_reason"] ?? null) === null,
  );
  expect(roleChunks).toHaveLength(2);
  expect(deltaOf(roleChunks[0]!)["role"]).toBe("assistant");
  expect(deltaOf(roleChunks[1]!)["role"]).toBe("assistant");
});

test("jsonCompletionToSse: delta omits content when the message content is empty or not a string", () => {
  const sse = __jsonCompletionToSseForTests({
    id: "chatcmpl-nocontent",
    created: 1,
    model: "m",
    choices: [
      { index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" },
      { index: 1, message: { role: "assistant", content: null }, finish_reason: "stop" },
    ],
  });
  const roleChunks = parseFrames(sse).filter(
    (frame) => (firstChoice(frame)["finish_reason"] ?? null) === null,
  );
  expect(roleChunks).toHaveLength(2);
  expect(deltaOf(roleChunks[0]!)).toEqual({ role: "assistant" });
  expect(deltaOf(roleChunks[1]!)).toEqual({ role: "assistant" });
});

test("jsonCompletionToSse: passes a tool_calls array through to the role chunk delta", () => {
  const toolCalls = [
    { id: "call-1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } },
  ];
  const sse = __jsonCompletionToSseForTests({
    id: "chatcmpl-tools",
    created: 1,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", tool_calls: toolCalls } }],
  });
  const roleChunk = parseFrames(sse)[0]!;
  expect(deltaOf(roleChunk)["tool_calls"]).toEqual(toolCalls);
  expect(deltaOf(roleChunk)["content"]).toBeUndefined();
});

test("jsonCompletionToSse: uses an explicit choice index and falls back to array position including skipped entries", () => {
  const sse = __jsonCompletionToSseForTests({
    id: "chatcmpl-index",
    created: 1,
    model: "m",
    choices: [
      "not-a-choice",
      { message: { role: "assistant", content: "b" } },
      { index: 7, message: { role: "assistant", content: "c" } },
    ],
  });
  const roleChunks = parseFrames(sse).filter(
    (frame) => (firstChoice(frame)["finish_reason"] ?? null) === null,
  );
  expect(roleChunks).toHaveLength(2);
  expect(firstChoice(roleChunks[0]!)["index"]).toBe(1);
  expect(firstChoice(roleChunks[1]!)["index"]).toBe(7);
});

test("jsonCompletionToSse: skips choice entries that are not objects", () => {
  const sse = __jsonCompletionToSseForTests({
    id: "chatcmpl-skip",
    created: 1,
    model: "m",
    choices: ["nope", null, 42],
  });
  expect(parseFrames(sse)).toHaveLength(0);
  expect(sse).toBe("data: [DONE]\n\n");
});

test("jsonCompletionToSse: defaults a missing finish_reason to stop and preserves a non-stop value", () => {
  const sse = __jsonCompletionToSseForTests({
    id: "chatcmpl-finish",
    created: 1,
    model: "m",
    choices: [
      { index: 0, message: { role: "assistant", content: "a" } },
      { index: 1, message: { role: "assistant", content: "b" }, finish_reason: "length" },
    ],
  });
  const stopChunks = parseFrames(sse).filter(
    (frame) => firstChoice(frame)["finish_reason"] !== null,
  );
  expect(stopChunks).toHaveLength(2);
  expect(firstChoice(stopChunks[0]!)["finish_reason"]).toBe("stop");
  expect(firstChoice(stopChunks[1]!)["finish_reason"]).toBe("length");
});

test("jsonCompletionToSse: emits a single empty-choices frame when choices is missing or empty", () => {
  const empty = parseFrames(__jsonCompletionToSseForTests({ id: "e", created: 1, model: "m" }));
  expect(empty).toHaveLength(1);
  expect(empty[0]).toEqual({
    id: "e",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [],
  });
  const defaultsSse = __jsonCompletionToSseForTests({ choices: [] });
  const defaultsCreated = parseFrames(defaultsSse)[0]?.created;
  expect(defaultsSse).toBe(
    sseFrame({
      id: "chatcmpl-stream",
      object: "chat.completion.chunk",
      created: defaultsCreated,
      model: "unknown",
      choices: [],
    }) + "data: [DONE]\n\n",
  );
});

test("jsonCompletionToSse: treats a non-object JSON payload as an empty completion", () => {
  const sse = __jsonCompletionToSseForTests("just a string");
  const frames = parseFrames(sse);
  expect(frames).toHaveLength(1);
  expect(frames[0]?.id).toBe("chatcmpl-stream");
  expect(frames[0]?.model).toBe("unknown");
  expect(sse.endsWith("data: [DONE]\n\n")).toBe(true);
});

test("jsonCompletionToSse: omits the usage frame when usage is absent or null", () => {
  const withUsageNull = parseFrames(
    __jsonCompletionToSseForTests({
      id: "u",
      created: 1,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "x" } }],
      usage: null,
    }),
  );
  expect(withUsageNull).toHaveLength(2);
  expect(withUsageNull.some((frame) => frame.usage !== undefined)).toBe(false);

  const withoutUsage = parseFrames(
    __jsonCompletionToSseForTests({
      id: "u",
      created: 1,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "x" } }],
    }),
  );
  expect(withoutUsage).toHaveLength(2);
  expect(withoutUsage.some((frame) => frame.usage !== undefined)).toBe(false);
});

test("jsonCompletionToSse: emits one role chunk and one stop chunk per choice", () => {
  const sse = __jsonCompletionToSseForTests({
    id: "multi",
    created: 1,
    model: "m",
    choices: [
      { index: 0, message: { role: "assistant", content: "a" }, finish_reason: "stop" },
      { index: 1, message: { role: "assistant", content: "b" }, finish_reason: "stop" },
    ],
  });
  expect(parseFrames(sse)).toHaveLength(4);
});

async function synthesize(context: {
  clientRequestedStream?: boolean;
  isAnthropic?: boolean;
  isResponsesApi?: boolean;
}): Promise<Response | null> {
  const upstream = new Response(JSON.stringify(sampleCompletion), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  return await __maybeSynthesizeOmlxSseResponseForTests(context, upstream);
}

test("maybeSynthesizeOmlxSseResponse: returns null when the responses-api flag is set", async () => {
  const synthesized = await synthesize({
    clientRequestedStream: true,
    isAnthropic: false,
    isResponsesApi: true,
  });
  expect(synthesized).toBeNull();
});

test("maybeSynthesizeOmlxSseResponse: returns null when clientRequestedStream is absent", async () => {
  const synthesized = await synthesize({ isAnthropic: false, isResponsesApi: false });
  expect(synthesized).toBeNull();
});

test("maybeSynthesizeOmlxSseResponse: synthesizes when the protocol flags are omitted", async () => {
  const synthesized = await synthesize({ clientRequestedStream: true });
  expect(synthesized).not.toBeNull();
  expect(synthesized?.headers.get("content-type")).toBe("text/event-stream");
  expect((await synthesized?.text())?.endsWith("data: [DONE]\n\n")).toBe(true);
});

test("maybeSynthesizeOmlxSseResponse: accepts json content types with a charset or a +json suffix", async () => {
  for (const contentType of ["application/json; charset=utf-8", "application/vnd.api+json"]) {
    const upstream = new Response(JSON.stringify(sampleCompletion), {
      status: 200,
      headers: { "content-type": contentType },
    });
    const synthesized = await __maybeSynthesizeOmlxSseResponseForTests(
      { clientRequestedStream: true, isAnthropic: false, isResponsesApi: false },
      upstream,
    );
    expect(synthesized).not.toBeNull();
    expect(synthesized?.headers.get("content-type")).toBe("text/event-stream");
  }
});

test("maybeSynthesizeOmlxSseResponse: returns null when the json body cannot be parsed", async () => {
  const upstream = new Response("this is not json", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const synthesized = await __maybeSynthesizeOmlxSseResponseForTests(
    { clientRequestedStream: true, isAnthropic: false, isResponsesApi: false },
    upstream,
  );
  expect(synthesized).toBeNull();
});

test("maybeSynthesizeOmlxSseResponse: an explicit null error key does not block synthesis", async () => {
  const upstream = new Response(JSON.stringify({ ...sampleCompletion, error: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const synthesized = await __maybeSynthesizeOmlxSseResponseForTests(
    { clientRequestedStream: true, isAnthropic: false, isResponsesApi: false },
    upstream,
  );
  expect(synthesized).not.toBeNull();
  expect((await synthesized?.text())?.endsWith("data: [DONE]\n\n")).toBe(true);
});

test("maybeSynthesizeOmlxSseResponse: copies passthrough headers and replaces content-type", async () => {
  const upstream = new Response(JSON.stringify(sampleCompletion), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "req-42" },
  });
  const synthesized = await __maybeSynthesizeOmlxSseResponseForTests(
    { clientRequestedStream: true, isAnthropic: false, isResponsesApi: false },
    upstream,
  );
  expect(synthesized?.headers.get("x-request-id")).toBe("req-42");
  expect(synthesized?.headers.get("content-type")).toBe("text/event-stream");
});

test("maybeSynthesizeOmlxSseResponse: preserves the upstream status and statusText", async () => {
  const upstream = new Response(JSON.stringify(sampleCompletion), {
    status: 200,
    statusText: "All Good",
    headers: { "content-type": "application/json" },
  });
  const synthesized = await __maybeSynthesizeOmlxSseResponseForTests(
    { clientRequestedStream: true, isAnthropic: false, isResponsesApi: false },
    upstream,
  );
  expect(synthesized?.status).toBe(200);
  expect(synthesized?.statusText).toBe("All Good");
});
