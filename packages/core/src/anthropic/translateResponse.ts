import type {
  AnthropicContentBlock,
  AnthropicMessagesResponse,
  OpenAIChatChoice,
  OpenAIChatResponse,
  OpenAIChatToolCall,
} from "./types.js";

import { AnthropicTranslationError } from "./translateRequest.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeFinishReason(
  finishReason: string | null | undefined,
): AnthropicMessagesResponse["stop_reason"] {
  switch (finishReason) {
    case undefined:
    case null:
      return "end_turn";
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

function toolUseFromCall(call: OpenAIChatToolCall): AnthropicContentBlock {
  let input: Record<string, unknown>;
  try {
    const parsed = JSON.parse(call.function.arguments) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("tool call arguments must decode to an object");
    }
    input = parsed;
  } catch (error) {
    throw new AnthropicTranslationError(
      `invalid tool_call arguments for ${call.function.name}: ${(error as Error).message}`,
    );
  }

  return {
    type: "tool_use",
    id: call.id,
    name: call.function.name,
    input,
  };
}

function choiceFromResponse(res: OpenAIChatResponse): OpenAIChatChoice {
  const choice = res.choices[0];
  if (choice === undefined || !isRecord(choice.message)) {
    throw new AnthropicTranslationError("openai response missing assistant choice");
  }
  return choice;
}

export function translateOpenAIResponse(res: OpenAIChatResponse): AnthropicMessagesResponse {
  if (!res.id || !res.model || !Array.isArray(res.choices) || res.choices.length === 0) {
    throw new AnthropicTranslationError("openai response missing choices");
  }

  const choice = choiceFromResponse(res);
  const content: AnthropicContentBlock[] = [];
  if (typeof choice.message.content === "string" && choice.message.content.length > 0) {
    content.push({ type: "text", text: choice.message.content });
  }
  for (const call of choice.message.tool_calls ?? []) {
    content.push(toolUseFromCall(call));
  }

  const usage = res.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
  return {
    id: res.id,
    type: "message",
    role: "assistant",
    content,
    model: res.model,
    stop_reason: normalizeFinishReason(choice.finish_reason),
    usage: {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
    },
  };
}
