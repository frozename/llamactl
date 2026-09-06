import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedEnv } from "../src/types.js";

import { resolveEnv } from "../src/env.js";
import { openaiProxy } from "../src/index.js";
import {
  ResponsesTranslationError,
  translateChatCompletionToResponses,
  translateResponsesRequest,
} from "../src/responses/index.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

function tempEnv(): { env: ResolvedEnv; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-responses-translate-"));
  return {
    env: resolveEnv({
      DEV_STORAGE: dir,
      LOCAL_AI_RUNTIME_DIR: dir,
      LLAMA_CPP_MODELS: join(dir, "models"),
      LLAMA_CPP_MACHINE_PROFILE: "balanced",
      LLAMA_CPP_QWEN_CTX_SIZE: "32768",
    }),
    dir,
    cleanup: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// translateToolChoice — all branches
// ---------------------------------------------------------------------------

test("translateToolChoice: undefined → omitted from chat request", () => {
  const result = translateResponsesRequest({
    model: "m",
    input: "hi",
  });
  expect(result).not.toHaveProperty("tool_choice");
});

test("translateToolChoice: 'auto' → 'auto'", () => {
  const result = translateResponsesRequest({
    model: "m",
    input: "hi",
    tool_choice: "auto",
  });
  expect(result.tool_choice).toBe("auto");
});

test("translateToolChoice: 'required' → 'required'", () => {
  const result = translateResponsesRequest({
    model: "m",
    input: "hi",
    tool_choice: "required",
  });
  expect(result.tool_choice).toBe("required");
});

test("translateToolChoice: 'none' → 'none'", () => {
  const result = translateResponsesRequest({
    model: "m",
    input: "hi",
    tool_choice: "none",
  });
  expect(result.tool_choice).toBe("none");
});

test("translateToolChoice: named {type:'function', name} → {type:'function', function:{name}}", () => {
  const result = translateResponsesRequest({
    model: "m",
    input: "hi",
    tool_choice: { type: "function", name: "get_weather" },
  });
  expect(result.tool_choice).toEqual({
    type: "function",
    function: { name: "get_weather" },
  });
});

// ---------------------------------------------------------------------------
// translateTools — tools array in /v1/responses body
// ---------------------------------------------------------------------------

test("translateTools: undefined → omitted from chat request", () => {
  const result = translateResponsesRequest({
    model: "m",
    input: "hi",
  });
  expect(result).not.toHaveProperty("tools");
});

test("translateTools: array of function tools → chat-completions tools shape", () => {
  const result = translateResponsesRequest({
    model: "m",
    input: "hi",
    tools: [
      {
        type: "function",
        name: "get_weather",
        description: "Get the weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
      {
        type: "function",
        name: "no_desc",
        parameters: { type: "object" },
      },
    ],
  });
  expect(result.tools).toEqual([
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get the weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    },
    {
      type: "function",
      function: {
        name: "no_desc",
        parameters: { type: "object" },
      },
    },
  ]);
});

// ---------------------------------------------------------------------------
// translateInputItems — per-item dispatch
// ---------------------------------------------------------------------------

test("translateInputItems: function_call item → assistant message with tool_calls", () => {
  const result = translateResponsesRequest({
    model: "m",
    input: [
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"city":"SF"}',
      },
    ],
  });
  expect(result.messages).toEqual([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "get_weather",
            arguments: '{"city":"SF"}',
          },
        },
      ],
    },
  ]);
});

test("translateInputItems: function_call_output item → tool message", () => {
  const result = translateResponsesRequest({
    model: "m",
    input: [
      {
        type: "function_call_output",
        call_id: "call_1",
        output: '{"temp":72}',
      },
    ],
  });
  expect(result.messages).toEqual([
    {
      role: "tool",
      tool_call_id: "call_1",
      content: '{"temp":72}',
    },
  ]);
});

test("translateInputItems: unsupported item type throws ResponsesTranslationError", () => {
  expect(() =>
    translateResponsesRequest({
      model: "m",
      input: [
        {
          type: "reasoning",
          id: "r_1",
          summary: "thinking about it",
        },
      ] as never,
    }),
  ).toThrow(ResponsesTranslationError);
});

test("translateInputItems: mixed conversation with function_call + function_call_output", () => {
  const result = translateResponsesRequest({
    model: "m",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "what's the weather?" }],
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"city":"SF"}',
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: '{"temp":72}',
      },
      {
        role: "user",
        content: [{ type: "input_text", text: "great, thanks" }],
      },
    ],
  });
  expect(result.messages).toEqual([
    { role: "user", content: "what's the weather?" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"SF"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: '{"temp":72}' },
    { role: "user", content: "great, thanks" },
  ]);
});

// ---------------------------------------------------------------------------
// statusFromFinishReason — 'failed' branch
// ---------------------------------------------------------------------------

test("statusFromFinishReason: 'error' → status 'failed'", () => {
  const result = translateChatCompletionToResponses({
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "m",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "" },
        finish_reason: "error",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  expect(result.status).toBe("failed");
});

test("statusFromFinishReason: 'content_filter' → status 'failed'", () => {
  const result = translateChatCompletionToResponses({
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "m",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "" },
        finish_reason: "content_filter",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  expect(result.status).toBe("failed");
});

test("statusFromFinishReason: 'stop' → status 'completed' (regression)", () => {
  const result = translateChatCompletionToResponses({
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "m",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hi" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  expect(result.status).toBe("completed");
});

test("statusFromFinishReason: null → status 'completed' (regression)", () => {
  const result = translateChatCompletionToResponses({
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "m",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hi" },
        finish_reason: null,
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  expect(result.status).toBe("completed");
});

// ---------------------------------------------------------------------------
// /v1/responses SSE streaming path
// ---------------------------------------------------------------------------

test("maybeSynthesizeOmlxSseResponse: isResponsesApi guard returns null (no SSE synthesis for responses)", async () => {
  const upstream = Response.json(
    {
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "m",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
    { headers: { "content-type": "application/json" } },
  );

  const result = await openaiProxy.__maybeSynthesizeOmlxSseResponseForTests(
    { clientRequestedStream: true, isResponsesApi: true },
    upstream,
  );
  expect(result).toBeNull();
});

test("maybeSynthesizeOmlxSseResponse: non-responses, clientRequestedStream → synthesized SSE (regression)", async () => {
  const upstream = Response.json(
    {
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "m",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
    { headers: { "content-type": "application/json" } },
  );

  const result = await openaiProxy.__maybeSynthesizeOmlxSseResponseForTests(
    { clientRequestedStream: true, isResponsesApi: false },
    upstream,
  );
  expect(result).not.toBeNull();
  expect(result!.headers.get("content-type")).toBe("text/event-stream");
});

test("/v1/responses with stream:true and upstream SSE → fail-closed error (translateResponsesSseResponse branch)", async () => {
  const t = tempEnv();
  try {
    const sseBody = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");

    let capturedUrl: string | null = null;
    globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      capturedUrl = url;
      void init;
      return new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          input: "hi",
          stream: true,
        }),
      }),
      t.env,
    );

    expect(capturedUrl!).toContain("/v1/chat/completions");
    expect(res.status).toBe(501);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      error: {
        message: "streaming is not supported for /v1/responses",
        type: "responses_translation_error",
      },
    });
  } finally {
    t.cleanup();
  }
});

test("/v1/responses with stream:true and upstream JSON → translates to responses JSON (not SSE synthesis)", async () => {
  const t = tempEnv();
  try {
    globalThis.fetch = (() =>
      Response.json(
        {
          id: "chatcmpl-1",
          object: "chat.completion",
          model: "test-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hello" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        },
        { headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          input: "hi",
          stream: true,
        }),
      }),
      t.env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["object"]).toBe("response");
    expect(body["status"]).toBe("completed");
  } finally {
    t.cleanup();
  }
});
