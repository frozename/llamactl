import type {
  AnthropicContentBlock,
  AnthropicImageContentBlock,
  AnthropicImageSource,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicTool,
  AnthropicToolChoice,
  AnthropicToolResultContentBlockBase,
  AnthropicToolUseContentBlock,
} from "./types.js";

export interface OpenAIImagePart {
  type: "image_url";
  image_url: {
    url: string;
  };
}

export interface OpenAITextPart {
  type: "text";
  text: string;
}

export interface OpenAIAssistantToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAIFunctionToolChoice {
  type: "function";
  function: {
    name: string;
  };
}

export interface OpenAISystemMessage {
  role: "system";
  content: string;
}

export interface OpenAIUserMessage {
  role: "user";
  content: string | (OpenAITextPart | OpenAIImagePart)[];
}

export interface OpenAIAssistantMessage {
  role: "assistant";
  content: string | (OpenAITextPart | OpenAIImagePart)[];
  tool_calls?: OpenAIAssistantToolCall[];
}

export interface OpenAIToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type OpenAIChatMessage =
  | OpenAISystemMessage
  | OpenAIUserMessage
  | OpenAIAssistantMessage
  | OpenAIToolMessage;

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  tools?: OpenAIToolDefinition[];
  tool_choice?: "auto" | "required" | "none" | OpenAIFunctionToolChoice;
  stop?: string[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
}

export interface TranslateAnthropicRequestOptions {
  toolMap?: Record<string, string>;
}

export class AnthropicTranslationError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "AnthropicTranslationError";
    this.statusCode = statusCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function blockType(block: unknown): string {
  return isRecord(block) && typeof block.type === "string" ? block.type : "unknown";
}

function toDataUrl(source: AnthropicImageSource): string {
  if (source.type !== "base64") {
    throw new AnthropicTranslationError(`unsupported image source type: ${source.type}`);
  }
  return `data:${source.media_type};base64,${source.data}`;
}

function toImagePart(block: AnthropicImageContentBlock): OpenAIImagePart {
  return {
    type: "image_url",
    image_url: {
      url: toDataUrl(block.source),
    },
  };
}

function toolCallFromExactBytes(raw: string): OpenAIAssistantToolCall {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new AnthropicTranslationError("toolMap entry must decode to a tool call object");
  }
  const id = parsed.id;
  const kind = parsed.type;
  const fn = parsed.function;
  if (typeof id !== "string" || kind !== "function" || !isRecord(fn)) {
    throw new AnthropicTranslationError("toolMap entry missing required tool call fields");
  }
  const name = fn.name;
  const args = fn.arguments;
  if (typeof name !== "string" || typeof args !== "string") {
    throw new AnthropicTranslationError("toolMap entry function payload is invalid");
  }
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: args,
    },
  };
}

function toolCallFromBlock(
  block: AnthropicToolUseContentBlock,
  options?: TranslateAnthropicRequestOptions,
): OpenAIAssistantToolCall {
  const exact = options?.toolMap?.[block.id];
  if (typeof exact === "string" && exact.length > 0) {
    return toolCallFromExactBytes(exact);
  }
  return {
    id: block.id,
    type: "function",
    function: {
      name: block.name,
      arguments: JSON.stringify(block.input),
    },
  };
}

function toolMessageFromBlock(block: AnthropicToolResultContentBlockBase): OpenAIToolMessage {
  if (typeof block.content === "string") {
    return {
      role: "tool",
      tool_call_id: block.tool_use_id,
      content: block.content,
    };
  }
  const parts: string[] = [];
  for (const item of block.content) {
    if (item.type !== "text") {
      throw new AnthropicTranslationError(
        `unsupported tool_result content block type: ${item.type}`,
      );
    }
    parts.push(item.text);
  }
  return {
    role: "tool",
    tool_call_id: block.tool_use_id,
    content: parts.join(""),
  };
}

function normalizeSystemContent(system: AnthropicMessagesRequest["system"]): string | null {
  if (system === undefined) return null;
  if (typeof system === "string") return system;
  const parts: string[] = [];
  for (const block of system) {
    parts.push(block.text);
  }
  return parts.join("");
}

interface CollectedMessageParts {
  textParts: string[];
  imageParts: OpenAIImagePart[];
  toolCalls: OpenAIAssistantToolCall[];
}

function collectMessageParts(
  blocks: AnthropicContentBlock[],
  options?: TranslateAnthropicRequestOptions,
): CollectedMessageParts {
  const textParts: string[] = [];
  const imageParts: OpenAIImagePart[] = [];
  const toolCalls: OpenAIAssistantToolCall[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        textParts.push(block.text);
        break;
      case "image":
        imageParts.push(toImagePart(block));
        break;
      case "tool_use":
        toolCalls.push(toolCallFromBlock(block, options));
        break;
      case "tool_result":
        throw new AnthropicTranslationError(
          "tool_result blocks must appear in user messages without mixed content",
        );
      default:
        throw new AnthropicTranslationError(`unsupported content block type: ${blockType(block)}`);
    }
  }

  return { textParts, imageParts, toolCalls };
}

function translateMessageContent(
  message: AnthropicMessage,
  options?: TranslateAnthropicRequestOptions,
): OpenAIChatMessage[] {
  if (typeof message.content === "string") {
    return [{ role: message.role, content: message.content }];
  }

  if (
    message.role === "user" &&
    message.content.length > 0 &&
    message.content.every((block) => block.type === "tool_result")
  ) {
    return message.content.map((block) => toolMessageFromBlock(block));
  }

  const { textParts, imageParts, toolCalls } = collectMessageParts(message.content, options);

  const joinedText = textParts.join("");
  const content: string | (OpenAITextPart | OpenAIImagePart)[] =
    imageParts.length > 0
      ? [
          ...(joinedText.length > 0 ? [{ type: "text" as const, text: joinedText }] : []),
          ...imageParts,
        ]
      : joinedText;

  if (message.role === "assistant") {
    return [
      { role: "assistant", content, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) },
    ];
  }

  if (toolCalls.length > 0) {
    throw new AnthropicTranslationError("tool_use blocks are only supported in assistant messages");
  }

  return [{ role: "user", content }];
}

function translateTools(tools: AnthropicTool[] | undefined): OpenAIToolDefinition[] | undefined {
  if (!tools) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.input_schema,
    },
  }));
}

function translateToolChoice(
  choice: AnthropicToolChoice | undefined,
): OpenAIChatRequest["tool_choice"] {
  if (choice === undefined) return undefined;
  if (choice === "auto") return "auto";
  if (choice === "any") return "required";
  if (choice === "none") return "none";
  return {
    type: "function",
    function: {
      name: choice.name,
    },
  };
}

export function translateAnthropicRequest(
  req: AnthropicMessagesRequest,
  options?: TranslateAnthropicRequestOptions,
): OpenAIChatRequest {
  const messages: OpenAIChatMessage[] = [];
  const system = normalizeSystemContent(req.system);
  if (system !== null) {
    messages.push({ role: "system", content: system });
  }

  for (const message of req.messages) {
    messages.push(...translateMessageContent(message, options));
  }

  return {
    model: req.model,
    messages,
    ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
    ...(req.top_k !== undefined ? { top_k: req.top_k } : {}),
    ...(req.stop_sequences !== undefined ? { stop: req.stop_sequences } : {}),
    ...(translateTools(req.tools) !== undefined ? { tools: translateTools(req.tools) } : {}),
    ...(translateToolChoice(req.tool_choice) !== undefined
      ? { tool_choice: translateToolChoice(req.tool_choice) }
      : {}),
  };
}
