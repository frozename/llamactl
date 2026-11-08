import { afterEach, describe, expect, setSystemTime, test } from "bun:test";

/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
import {
  ResponsesTranslationError,
  translateChatCompletionToResponses,
  translateResponsesRequest,
} from "../../src/responses/index.js";

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected throw");
}

afterEach(() => {
  setSystemTime();
});

// ---------------------------------------------------------------------------
// translateResponsesRequest — sampling params passthrough + renaming
// ---------------------------------------------------------------------------

describe("translateResponsesRequest edges", () => {
  test("passes sampling params through and renames max_output_tokens", () => {
    const result = translateResponsesRequest({
      model: "m",
      input: "hi",
      max_output_tokens: 128,
      temperature: 0.25,
      top_p: 0.9,
      stop: ["END"],
      seed: 42,
      stream: true,
      previous_response_id: "resp_1",
    });
    expect(result).toStrictEqual({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 128,
      temperature: 0.25,
      top_p: 0.9,
      stop: ["END"],
      seed: 42,
      stream: true,
    });
  });

  test("keeps defined falsy sampling values", () => {
    const result = translateResponsesRequest({
      model: "m",
      input: "hi",
      temperature: 0,
      top_p: 0,
      max_output_tokens: 0,
      seed: 0,
      stream: false,
      stop: [],
    });
    expect(result).toStrictEqual({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 0,
      temperature: 0,
      top_p: 0,
      stop: [],
      seed: 0,
      stream: false,
    });
  });

  test("skips an empty instructions string", () => {
    const result = translateResponsesRequest({
      model: "m",
      input: "hi",
      instructions: "",
    });
    expect(result).toStrictEqual({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
  });

  test("puts non-empty instructions before translated array items", () => {
    const result = translateResponsesRequest({
      model: "m",
      input: [
        { role: "developer", content: "dev" },
        {
          role: "assistant",
          content: [
            { type: "output_text", text: "a" },
            { type: "output_text", text: "b" },
          ],
        },
      ],
      instructions: "sys",
    });
    expect(result).toStrictEqual({
      model: "m",
      messages: [
        { role: "system", content: "sys" },
        { role: "developer", content: "dev" },
        { role: "assistant", content: "ab" },
      ],
    });
  });

  test("concatenates text parts and drops parts without text", () => {
    const result = translateResponsesRequest({
      model: "m",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "x" },
            { type: "input_image", image_url: "u" },
            { type: "input_text", text: "y" },
          ] as never,
        },
      ],
    });
    expect(result).toStrictEqual({
      model: "m",
      messages: [{ role: "user", content: "xy" }],
    });
  });

  test("omits an empty tool description", () => {
    const result = translateResponsesRequest({
      model: "m",
      input: "hi",
      tools: [
        {
          type: "function",
          name: "f",
          description: "",
          parameters: { type: "object" },
        },
      ],
    });
    expect(result.tools).toStrictEqual([
      {
        type: "function",
        function: { name: "f", parameters: { type: "object" } },
      },
    ]);
  });

  test("rejects input that is neither a string nor an array", () => {
    const err = thrown(() =>
      translateResponsesRequest({
        model: "m",
        input: {} as never,
      }),
    );
    expect(err).toBeInstanceOf(ResponsesTranslationError);
    expect((err as ResponsesTranslationError).message).toBe(
      "input must be a string or an array of input items",
    );
    expect((err as ResponsesTranslationError).statusCode).toBe(400);
  });

  test("names the unsupported item type in the error", () => {
    const reasoning = thrown(() =>
      translateResponsesRequest({
        model: "m",
        input: [{ type: "reasoning", id: "r" }] as never,
      }),
    );
    expect(reasoning).toBeInstanceOf(ResponsesTranslationError);
    expect((reasoning as ResponsesTranslationError).message).toBe(
      "unsupported input item type: reasoning",
    );

    const numeric = thrown(() =>
      translateResponsesRequest({
        model: "m",
        input: [42] as never,
      }),
    );
    expect(numeric).toBeInstanceOf(ResponsesTranslationError);
    expect((numeric as ResponsesTranslationError).message).toBe(
      "unsupported input item type: unknown",
    );

    const badContent = thrown(() =>
      translateResponsesRequest({
        model: "m",
        input: [{ role: "user", content: 5 }] as never,
      }),
    );
    expect(badContent).toBeInstanceOf(ResponsesTranslationError);
    expect((badContent as ResponsesTranslationError).message).toBe(
      "unsupported input item type: undefined",
    );
  });

  test("treats a function_call without string arguments as unsupported", () => {
    const err = thrown(() =>
      translateResponsesRequest({
        model: "m",
        input: [
          {
            type: "function_call",
            id: "fc",
            call_id: "c",
            name: "n",
            arguments: {},
          },
        ] as never,
      }),
    );
    expect(err).toBeInstanceOf(ResponsesTranslationError);
    expect((err as ResponsesTranslationError).message).toBe(
      "unsupported input item type: function_call",
    );
  });
});

// ---------------------------------------------------------------------------
// translateChatCompletionToResponses — edge cases
// ---------------------------------------------------------------------------

describe("translateChatCompletionToResponses edges", () => {
  function chat(over: Record<string, unknown>): Record<string, unknown> {
    const baseChoices = [
      {
        index: 0,
        message: { role: "assistant", content: "hi" },
        finish_reason: "stop",
      },
    ];
    const baseUsage = { prompt_tokens: 7, completion_tokens: 5 };
    const mergedChoices = (over["choices"] !== undefined ? over["choices"] : baseChoices) as Record<
      string,
      unknown
    >[];
    const hasUsage = "usage" in over;
    const mergedUsage = hasUsage ? (over["usage"] as Record<string, unknown>) : baseUsage;
    const result: Record<string, unknown> = {
      id: "chatcmpl-9",
      object: "chat.completion",
      model: "m",
      choices: mergedChoices,
      ...(hasUsage ? { usage: mergedUsage } : {}),
    };
    const topKeys = new Set(["object", "choices", "usage"]);
    for (const key of Object.keys(over)) {
      if (!topKeys.has(key)) {
        result[key] = over[key];
      }
    }
    if (
      over["message"] !== undefined &&
      typeof over["message"] === "object" &&
      over["message"] !== null &&
      Array.isArray(result["choices"]) &&
      result["choices"].length > 0
    ) {
      const choices = result["choices"] as Record<string, unknown>[];
      if (choices[0]) {
        (choices[0] as Record<string, unknown>)["message"] = over["message"];
      }
    }
    return result;
  }

  test("rejects a response with no choices", () => {
    const err = thrown(() => translateChatCompletionToResponses(chat({ choices: [] }) as never));
    expect(err).toBeInstanceOf(ResponsesTranslationError);
    expect((err as ResponsesTranslationError).message).toBe(
      "chat completion response missing choices",
    );
  });

  test("rejects a response with an empty id or model", () => {
    const errId = thrown(() => translateChatCompletionToResponses(chat({ id: "" }) as never));
    expect(errId).toBeInstanceOf(ResponsesTranslationError);
    expect((errId as ResponsesTranslationError).message).toBe(
      "chat completion response missing choices",
    );

    const errModel = thrown(() => translateChatCompletionToResponses(chat({ model: "" }) as never));
    expect(errModel).toBeInstanceOf(ResponsesTranslationError);
    expect((errModel as ResponsesTranslationError).message).toBe(
      "chat completion response missing choices",
    );
  });

  test("rejects a choice without an assistant message", () => {
    const err = thrown(() =>
      translateChatCompletionToResponses(
        // @ts-expect-error — chat() returns Record<string, unknown>, not OpenAIChatResponse
        chat({
          choices: [{ index: 0, message: null, finish_reason: "stop" }],
        } as never),
      ),
    );
    expect(err).toBeInstanceOf(ResponsesTranslationError);
    expect((err as ResponsesTranslationError).message).toBe(
      "chat completion response missing assistant message",
    );
  });

  test("emits the message before function_call items when both are present", () => {
    const result = translateChatCompletionToResponses(
      // @ts-expect-error — chat() returns Record<string, unknown>, not OpenAIChatResponse
      chat({
        message: {
          role: "assistant",
          content: "checking",
          tool_calls: [
            {
              id: "call_a",
              type: "function",
              function: { name: "f", arguments: "{}" },
            },
            {
              id: "call_b",
              type: "function",
              function: { name: "g", arguments: '{"x":1}' },
            },
          ],
        },
      } as never),
    );
    expect(result.output).toStrictEqual([
      {
        type: "message",
        id: "msg_chatcmpl-9",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "checking" }],
      },
      {
        type: "function_call",
        id: "call_a",
        call_id: "call_a",
        name: "f",
        arguments: "{}",
      },
      {
        type: "function_call",
        id: "call_b",
        call_id: "call_b",
        name: "g",
        arguments: '{"x":1}',
      },
    ]);
  });

  test("emits only function_call items when content is null", () => {
    const result = translateChatCompletionToResponses(
      // @ts-expect-error — chat() returns Record<string, unknown>, not OpenAIChatResponse
      chat({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "f", arguments: "{}" },
            },
          ],
        },
      } as never),
    );
    expect(result.output).toStrictEqual([
      {
        type: "function_call",
        id: "call_1",
        call_id: "call_1",
        name: "f",
        arguments: "{}",
      },
    ]);
  });

  test("emits an empty message when content is empty and there are no tool calls", () => {
    const result = translateChatCompletionToResponses(
      // @ts-expect-error — chat() returns Record<string, unknown>, not OpenAIChatResponse
      chat({ message: { role: "assistant", content: "", tool_calls: [] } }),
    );
    expect(result.output).toStrictEqual([
      {
        type: "message",
        id: "msg_chatcmpl-9",
        role: "assistant",
        status: "completed",
        content: [],
      },
    ]);
  });

  test("reports zero usage when upstream omits usage", () => {
    const noUsage = {
      id: "chatcmpl-9",
      object: "chat.completion",
      model: "m",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi" },
          finish_reason: "stop",
        },
      ],
    } as Record<string, unknown>;
    const result = translateChatCompletionToResponses(
      // @ts-expect-error — noUsage is Record<string, unknown>, not OpenAIChatResponse
      noUsage,
    );
    expect(result.usage).toStrictEqual({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    });
  });

  test("passes through usage when present", () => {
    const result = translateChatCompletionToResponses(
      // @ts-expect-error — chat() returns Record<string, unknown>, not OpenAIChatResponse
      chat({ usage: { prompt_tokens: 7, completion_tokens: 5 } }),
    );
    expect(result.usage).toStrictEqual({
      input_tokens: 7,
      output_tokens: 5,
      total_tokens: 12,
    });
  });

  test("stamps created_at in whole seconds", () => {
    setSystemTime(new Date("2026-01-02T03:04:05.678Z"));
    try {
      const result = translateChatCompletionToResponses(
        // @ts-expect-error — chat() returns Record<string, unknown>, not OpenAIChatResponse
        chat({
          id: "chatcmpl-9",
          object: "chat.completion",
          model: "m",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hi" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 5 },
        }),
      );
      expect(result.created_at).toBe(1767323045);
      expect(result.id).toBe("chatcmpl-9");
      expect(result.object).toBe("response");
    } finally {
      setSystemTime();
    }
  });
});
