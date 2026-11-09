import { expect, test } from "bun:test";

import type { OpenAIChatResponse } from "../src/anthropic/types.js";

import { AnthropicTranslationError } from "../src/anthropic/translateRequest.js";
import { translateOpenAIResponse } from "../src/anthropic/translateResponse.js";

test.each([
  ["stop", "end_turn"],
  ["length", "max_tokens"],
  ["tool_calls", "tool_use"],
  ["stop_sequence", "stop_sequence"],
  ["unknown", "end_turn"],
] as const)("maps finish_reason %s to %s", (finishReason, expected) => {
  const translated = translateOpenAIResponse({
    id: "msg_1",
    model: "claude-3-7-sonnet",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hello" },
        finish_reason: finishReason === "unknown" ? "something_else" : finishReason,
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 22 },
  });

  expect(translated.stop_reason).toBe(expected);
});

test("translates text-only responses", () => {
  expect(
    translateOpenAIResponse({
      id: "msg_1",
      model: "claude-3-7-sonnet",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    }),
  ).toEqual({
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    model: "claude-3-7-sonnet",
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 2 },
  });
});

test("translates tool calls into tool_use blocks", () => {
  expect(
    translateOpenAIResponse({
      id: "msg_2",
      model: "claude-3-7-sonnet",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup_weather", arguments: '{"city":"Sao Paulo"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    }),
  ).toEqual({
    id: "msg_2",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "call_1",
        name: "lookup_weather",
        input: { city: "Sao Paulo" },
      },
    ],
    model: "claude-3-7-sonnet",
    stop_reason: "tool_use",
    usage: { input_tokens: 3, output_tokens: 4 },
  });
});

test("preserves text before tool calls", () => {
  expect(
    translateOpenAIResponse({
      id: "msg_3",
      model: "claude-3-7-sonnet",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Calling tool.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup_weather", arguments: '{"city":"Sao Paulo"}' },
              },
              {
                id: "call_2",
                type: "function",
                function: { name: "lookup_time", arguments: '{"tz":"UTC"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 8 },
    }),
  ).toEqual({
    id: "msg_3",
    type: "message",
    role: "assistant",
    content: [
      { type: "text", text: "Calling tool." },
      { type: "tool_use", id: "call_1", name: "lookup_weather", input: { city: "Sao Paulo" } },
      { type: "tool_use", id: "call_2", name: "lookup_time", input: { tz: "UTC" } },
    ],
    model: "claude-3-7-sonnet",
    stop_reason: "tool_use",
    usage: { input_tokens: 7, output_tokens: 8 },
  });
});

test("maps non-streaming reasoning_content to a thinking block before text", () => {
  expect(
    translateOpenAIResponse({
      id: "msg_reasoning_1",
      model: "claude-3-7-sonnet",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "hello",
            reasoning_content: "let me think",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 5 },
    } as unknown as OpenAIChatResponse),
  ).toEqual({
    id: "msg_reasoning_1",
    type: "message",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "let me think" },
      { type: "text", text: "hello" },
    ],
    model: "claude-3-7-sonnet",
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 5 },
  });
});

test("reasoning_content before tool calls yields thinking then tool_use", () => {
  expect(
    translateOpenAIResponse({
      id: "msg_reasoning_2",
      model: "claude-3-7-sonnet",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            reasoning_content: "plan",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: '{"q":"x"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 5 },
    } as unknown as OpenAIChatResponse),
  ).toEqual({
    id: "msg_reasoning_2",
    type: "message",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "plan" },
      { type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } },
    ],
    model: "claude-3-7-sonnet",
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 5 },
  });
});

test("reasoning-only response (content null) yields a single thinking block", () => {
  expect(
    translateOpenAIResponse({
      id: "msg_reasoning_3",
      model: "claude-3-7-sonnet",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            reasoning_content: "only thoughts",
          },
          finish_reason: "length",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 5 },
    } as unknown as OpenAIChatResponse),
  ).toEqual({
    id: "msg_reasoning_3",
    type: "message",
    role: "assistant",
    content: [{ type: "thinking", thinking: "only thoughts" }],
    model: "claude-3-7-sonnet",
    stop_reason: "max_tokens",
    usage: { input_tokens: 1, output_tokens: 5 },
  });
});

test.each([[null], [""]] as const)(
  "does not emit a thinking block for empty reasoning_content %s",
  (reasoningContent) => {
    expect(
      translateOpenAIResponse({
        id: "msg_reasoning_empty",
        model: "claude-3-7-sonnet",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "hello",
              reasoning_content: reasoningContent,
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 5 },
      } as unknown as OpenAIChatResponse),
    ).toEqual({
      id: "msg_reasoning_empty",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      model: "claude-3-7-sonnet",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 5 },
    });
  },
);

test("throws for malformed responses", () => {
  expect(() =>
    translateOpenAIResponse({
      id: "msg_4",
      model: "claude-3-7-sonnet",
      choices: [],
    }),
  ).toThrow(AnthropicTranslationError);

  expect(() =>
    translateOpenAIResponse({
      id: "msg_5",
      model: "claude-3-7-sonnet",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup_weather", arguments: "{oops" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    } as unknown as OpenAIChatResponse),
  ).toThrow(AnthropicTranslationError);
});
