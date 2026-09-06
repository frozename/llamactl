/**
 * Translate an OpenAI Responses API request (/v1/responses) into a
 * chat-completions request (/v1/chat/completions) so it can flow through
 * the KV-gated proxy path. Mirrors the anthropic/translateRequest pattern.
 */

import type {
  ResponsesApiRequest,
  ResponsesContentPart,
  ResponsesFunctionCallItem,
  ResponsesFunctionCallOutputItem,
  ResponsesInputItem,
  ResponsesInputMessage,
  ResponsesTool,
  ResponsesToolChoice,
} from "./types.js";

import { ResponsesTranslationError } from "./types.js";

interface OpenAIChatMessage {
  role: string;
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  tools?: OpenAIToolDefinition[];
  tool_choice?: "auto" | "required" | "none" | { type: "function"; function: { name: string } };
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  seed?: number;
  stream?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInputMessage(item: unknown): item is ResponsesInputMessage {
  return (
    isRecord(item) &&
    typeof item["role"] === "string" &&
    (typeof item["content"] === "string" || Array.isArray(item["content"]))
  );
}

function isFunctionCallItem(item: unknown): item is ResponsesFunctionCallItem {
  return (
    isRecord(item) &&
    item["type"] === "function_call" &&
    typeof item["name"] === "string" &&
    typeof item["arguments"] === "string"
  );
}

function isFunctionCallOutputItem(item: unknown): item is ResponsesFunctionCallOutputItem {
  return (
    isRecord(item) &&
    item["type"] === "function_call_output" &&
    typeof item["call_id"] === "string" &&
    typeof item["output"] === "string"
  );
}

function textFromContentPart(part: unknown): string {
  if (!isRecord(part)) return "";
  const text = part["text"];
  return typeof text === "string" ? text : "";
}

function contentToString(content: string | ResponsesContentPart[]): string {
  if (typeof content === "string") return content;
  return content.map(textFromContentPart).join("");
}

function messageFromInputMessage(msg: ResponsesInputMessage): OpenAIChatMessage {
  const content = contentToString(msg.content);
  if (msg.role === "assistant") {
    return { role: "assistant", content };
  }
  return { role: msg.role, content };
}

function messageFromFunctionCall(item: ResponsesFunctionCallItem): OpenAIChatMessage {
  return {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: item.call_id,
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments,
        },
      },
    ],
  };
}

function messageFromFunctionCallOutput(item: ResponsesFunctionCallOutputItem): OpenAIChatMessage {
  return {
    role: "tool",
    tool_call_id: item.call_id,
    content: item.output,
  };
}

function translateInputItems(items: ResponsesInputItem[]): OpenAIChatMessage[] {
  const messages: OpenAIChatMessage[] = [];
  for (const item of items) {
    if (isInputMessage(item)) {
      messages.push(messageFromInputMessage(item));
    } else if (isFunctionCallItem(item)) {
      messages.push(messageFromFunctionCall(item));
    } else if (isFunctionCallOutputItem(item)) {
      messages.push(messageFromFunctionCallOutput(item));
    } else {
      const raw: unknown = item;
      throw new ResponsesTranslationError(
        `unsupported input item type: ${isRecord(raw) ? String(raw["type"]) : "unknown"}`,
      );
    }
  }
  return messages;
}

function translateTools(tools: ResponsesTool[] | undefined): OpenAIToolDefinition[] | undefined {
  if (!tools) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters,
    },
  }));
}

function translateToolChoice(
  choice: ResponsesToolChoice | undefined,
): OpenAIChatRequest["tool_choice"] {
  if (choice === undefined) return undefined;
  if (choice === "auto") return "auto";
  if (choice === "required") return "required";
  if (choice === "none") return "none";
  return {
    type: "function",
    function: { name: choice.name },
  };
}

function messagesFromInput(input: ResponsesApiRequest["input"]): OpenAIChatMessage[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (Array.isArray(input)) return translateInputItems(input);
  throw new ResponsesTranslationError("input must be a string or an array of input items");
}

export function translateResponsesRequest(req: ResponsesApiRequest): OpenAIChatRequest {
  const messages: OpenAIChatMessage[] = [];

  if (typeof req.instructions === "string" && req.instructions.length > 0) {
    messages.push({ role: "system", content: req.instructions });
  }

  messages.push(...messagesFromInput(req.input));

  const tools = translateTools(req.tools);
  const toolChoice = translateToolChoice(req.tool_choice);

  return {
    model: req.model,
    messages,
    ...(req.max_output_tokens !== undefined ? { max_tokens: req.max_output_tokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
    ...(req.stop !== undefined ? { stop: req.stop } : {}),
    ...(req.seed !== undefined ? { seed: req.seed } : {}),
    ...(req.stream !== undefined ? { stream: req.stream } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
  };
}
