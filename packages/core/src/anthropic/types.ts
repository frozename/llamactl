export type AnthropicRole = "user" | "assistant";

export interface AnthropicTextContentBlock {
  type: "text";
  text: string;
}

export interface AnthropicImageSourceBase64 {
  type: "base64";
  media_type: string;
  data: string;
}

export interface AnthropicImageSourceUrl {
  type: "url";
  url: string;
}

export type AnthropicImageSource = AnthropicImageSourceBase64 | AnthropicImageSourceUrl;

export interface AnthropicImageContentBlock {
  type: "image";
  source: AnthropicImageSource;
}

export interface AnthropicToolUseContentBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type AnthropicToolResultContentBlock =
  | AnthropicTextContentBlock
  | AnthropicImageContentBlock;

export interface AnthropicToolResultContentBlockBase {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicToolResultContentBlock[];
}

export interface AnthropicContentBlockByType {
  text: AnthropicTextContentBlock;
  image: AnthropicImageContentBlock;
  tool_use: AnthropicToolUseContentBlock;
  tool_result: AnthropicToolResultContentBlockBase;
}

export type AnthropicContentBlock = AnthropicContentBlockByType[keyof AnthropicContentBlockByType];

export interface AnthropicMessage {
  role: AnthropicRole;
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export type AnthropicToolChoice =
  | "auto"
  | "any"
  | "none"
  | {
      type: "tool";
      name: string;
    };

export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens?: number;
  system?: string | AnthropicTextContentBlock[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  stop_sequences?: string[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
}

export interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";
  stop_sequence?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface OpenAIChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIChatMessageResponse {
  role: "assistant";
  content: string | null;
  tool_calls?: OpenAIChatToolCall[];
}

export interface OpenAIChatChoice {
  index: number;
  message: OpenAIChatMessageResponse;
  finish_reason: string | null;
}

export interface OpenAIChatResponse {
  id: string;
  model: string;
  choices: OpenAIChatChoice[];
  usage?: OpenAIUsage;
}
