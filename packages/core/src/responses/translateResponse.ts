/**
 * Translate a chat-completions JSON response back into the OpenAI
 * Responses API (/v1/responses) shape. Mirrors the anthropic/translateResponse
 * pattern: the upstream returns a standard chat.completion object, and we
 * project it into the response.output[] array with message + function_call
 * items.
 */

import type {
  ResponsesApiResponse,
  ResponsesFunctionCallOutput,
  ResponsesOutputMessage,
} from "./types.js";

import { ResponsesTranslationError } from "./types.js";

interface OpenAIChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIChatChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenAIChatToolCall[];
  };
  finish_reason: string | null;
}

interface OpenAIChatResponse {
  id: string;
  object: string;
  model: string;
  choices: OpenAIChatChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function statusFromFinishReason(reason: string | null | undefined): "completed" | "failed" {
  if (reason === "error" || reason === "content_filter") return "failed";
  return "completed";
}

function outputMessageFromChoice(
  choice: OpenAIChatChoice,
  messageId: string,
): ResponsesOutputMessage {
  const content: { type: "output_text"; text: string }[] = [];
  if (typeof choice.message.content === "string" && choice.message.content.length > 0) {
    content.push({ type: "output_text", text: choice.message.content });
  }
  return {
    type: "message",
    id: messageId,
    role: "assistant",
    status: "completed",
    content,
  };
}

function functionCallFromToolCall(call: OpenAIChatToolCall): ResponsesFunctionCallOutput {
  return {
    type: "function_call",
    id: call.id,
    call_id: call.id,
    name: call.function.name,
    arguments: call.function.arguments,
  };
}

export function translateChatCompletionToResponses(res: OpenAIChatResponse): ResponsesApiResponse {
  if (!res.id || !res.model || !Array.isArray(res.choices) || res.choices.length === 0) {
    throw new ResponsesTranslationError("chat completion response missing choices");
  }

  const choice = res.choices[0];
  if (!choice || !isRecord(choice.message)) {
    throw new ResponsesTranslationError("chat completion response missing assistant message");
  }

  const output: ResponsesApiResponse["output"] = [];
  const hasTextContent =
    typeof choice.message.content === "string" && choice.message.content.length > 0;
  const toolCalls = choice.message.tool_calls;

  if (hasTextContent || !toolCalls || toolCalls.length === 0) {
    output.push(outputMessageFromChoice(choice, `msg_${res.id}`));
  }

  if (toolCalls) {
    for (const call of toolCalls) {
      output.push(functionCallFromToolCall(call));
    }
  }

  const usage = res.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
  const status = statusFromFinishReason(choice.finish_reason);

  return {
    id: res.id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: res.model,
    output,
    usage: {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      total_tokens: usage.prompt_tokens + usage.completion_tokens,
    },
  };
}
