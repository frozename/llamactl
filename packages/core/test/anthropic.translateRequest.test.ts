import { expect, test } from "bun:test";
import {
  AnthropicTranslationError,
  translateAnthropicRequest,
} from "../src/anthropic/translateRequest.js";
import type { AnthropicMessagesRequest } from "../src/anthropic/types.js";

test("translates a full anthropic request payload into openai chat completions shape", () => {
  const request: AnthropicMessagesRequest = {
    model: "claude-3-7-sonnet",
    max_tokens: 256,
    temperature: 0.2,
    top_p: 0.8,
    top_k: 32,
    stop_sequences: ["\n\nHuman:"],
    system: [
      { type: "text", text: "You are helpful." },
      { type: "text", text: " Answer briefly." },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
            },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Calling tool." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "lookup_weather",
            input: { city: "Sao Paulo" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "72F",
          },
        ],
      },
    ],
    tools: [
      {
        name: "lookup_weather",
        description: "Get weather by city",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "lookup_weather" },
  };

  const translated = translateAnthropicRequest(request);
  expect(translated).toEqual({
    model: "claude-3-7-sonnet",
    max_tokens: 256,
    temperature: 0.2,
    top_p: 0.8,
    top_k: 32,
    stop: ["\n\nHuman:"],
    messages: [
      { role: "system", content: "You are helpful. Answer briefly." },
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          {
            type: "image_url",
            image_url: {
              url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
            },
          },
        ],
      },
      {
        role: "assistant",
        content: "Calling tool.",
        tool_calls: [
          {
            id: "toolu_1",
            type: "function",
            function: {
              name: "lookup_weather",
              arguments: '{"city":"Sao Paulo"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "toolu_1",
        content: "72F",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "lookup_weather",
          description: "Get weather by city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ],
    tool_choice: {
      type: "function",
      function: {
        name: "lookup_weather",
      },
    },
  });
});

test("fans out a single user tool_result message into ordered tool messages", () => {
  const translated = translateAnthropicRequest({
    model: "claude-3-7-sonnet",
    messages: [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool_1", content: "first" },
          { type: "tool_result", tool_use_id: "tool_2", content: "second" },
          { type: "tool_result", tool_use_id: "tool_3", content: "third" },
        ],
      },
    ],
  });

  expect(translated.messages).toEqual([
    { role: "tool", tool_call_id: "tool_1", content: "first" },
    { role: "tool", tool_call_id: "tool_2", content: "second" },
    { role: "tool", tool_call_id: "tool_3", content: "third" },
  ]);
});

test("translates tool_choice permutations", () => {
  const base: Omit<AnthropicMessagesRequest, "tool_choice"> = {
    model: "claude-3-7-sonnet",
    messages: [{ role: "user", content: "hello" }],
  };

  expect(translateAnthropicRequest({ ...base, tool_choice: "auto" }).tool_choice).toBe("auto");
  expect(translateAnthropicRequest({ ...base, tool_choice: "any" }).tool_choice).toBe("required");
  expect(translateAnthropicRequest({ ...base, tool_choice: "none" }).tool_choice).toBe("none");
  expect(
    translateAnthropicRequest({ ...base, tool_choice: { type: "tool", name: "foo" } }).tool_choice,
  ).toEqual({
    type: "function",
    function: { name: "foo" },
  });
  expect(translateAnthropicRequest(base)).not.toHaveProperty("tool_choice");
});

test("throws 400 for unsupported content block type", () => {
  expect(() =>
    translateAnthropicRequest({
      model: "claude-3-7-sonnet",
      messages: [
        {
          role: "user",
          content: [{ type: "video", src: "x" } as unknown as any],
        },
      ],
    }),
  ).toThrow(AnthropicTranslationError);

  try {
    translateAnthropicRequest({
      model: "claude-3-7-sonnet",
      messages: [
        {
          role: "user",
          content: [{ type: "video", src: "x" } as unknown as any],
        },
      ],
    });
  } catch (error) {
    expect(error).toBeInstanceOf(AnthropicTranslationError);
    expect((error as AnthropicTranslationError).statusCode).toBe(400);
  }
});

test("converts base64 image blocks into data URLs", () => {
  const translated = translateAnthropicRequest({
    model: "claude-3-7-sonnet",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: "abc123",
            },
          },
        ],
      },
    ],
  });

  const firstMessage = translated.messages[0];
  expect(firstMessage).toEqual({
    role: "user",
    content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,abc123" } }],
  });
});

test("uses exact toolMap bytes for tool_use blocks when provided", () => {
  const request: AnthropicMessagesRequest = {
    model: "claude-3-7-sonnet",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Calling tool" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "lookup_weather",
            input: { city: "Sao Paulo", units: "c" },
          },
        ],
      },
    ],
  };

  const translated = translateAnthropicRequest(request, {
    toolMap: {
      toolu_1:
        '{"id":"toolu_1","type":"function","function":{"name":"lookup_weather","arguments":"{\\n  \\"city\\": \\"Sao Paulo\\",\\n  \\"units\\": \\"c\\"\\n}"}}',
    },
  });
  expect(translated.messages).toEqual([
    {
      role: "assistant",
      content: "Calling tool",
      tool_calls: [
        {
          id: "toolu_1",
          type: "function",
          function: {
            name: "lookup_weather",
            arguments: '{\n  "city": "Sao Paulo",\n  "units": "c"\n}',
          },
        },
      ],
    },
  ]);
});

test("defaults to canonical tool_use translation when toolMap is absent", () => {
  const translated = translateAnthropicRequest({
    model: "claude-3-7-sonnet",
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "lookup_weather",
            input: { city: "Sao Paulo", units: "c" },
          },
        ],
      },
    ],
  });

  expect(translated.messages).toEqual([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "toolu_1",
          type: "function",
          function: {
            name: "lookup_weather",
            arguments: '{"city":"Sao Paulo","units":"c"}',
          },
        },
      ],
    },
  ]);
});
